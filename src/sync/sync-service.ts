import { App, Notice, TFile } from "obsidian";
import { ShimoApiError, ShimoClient, parseShimoGuid } from "../shimo";
import { AssetMapStore } from "./asset-map";
import { AssetProcessResult, excalidrawStatusNote, processAttachments } from "./asset-processor";
import { NoteShimoMeta, readShimoMeta } from "./frontmatter";
import { AssetMap, ObsidianToShimoSettings } from "../settings";
import { SyncLogger } from "./logger";

export interface SyncContext {
  app: App;
  settings: ObsidianToShimoSettings;
  assetMap: AssetMap;
  persistAssetMap: () => Promise<void>;
  saveSyncLog: (log: string) => Promise<void>;
}

export async function syncActiveNote(ctx: SyncContext): Promise<void> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    new Notice("没有打开的笔记");
    return;
  }
  await syncNote(ctx, file);
}

/**
 * 行为完全由 frontmatter 的 shimo 指向决定：
 * - 指向文件夹 → 上传并转换为石墨原生文档，回写 frontmatter 到新文档
 * - 指向文档 → 转换覆盖（生成新文档、删除旧的、回写 frontmatter）
 *
 * 两条路径都会先上传本地图片，把链接写进正文，再转换。
 */
export async function syncNote(ctx: SyncContext, file: TFile): Promise<void> {
  const log = new SyncLogger();
  log.step("开始同步", { note: file.path });

  if (!ctx.settings.shimoSid.trim()) {
    new Notice("请先在插件设置中配置石墨 shimo_sid");
    return;
  }

  const cache = ctx.app.metadataCache.getFileCache(file);
  const meta = readShimoMeta(cache?.frontmatter);
  if (!meta) {
    new Notice("当前笔记未配置 shimo 地址，无法上传");
    return;
  }

  const guid = parseShimoGuid(meta.shimoUrl);
  if (!guid) {
    new Notice(`无法解析石墨地址：${meta.shimoUrl}`);
    return;
  }

  log.step("解析目标", { shimoUrl: meta.shimoUrl, guid });

  const notice = new Notice("正在同步到石墨…", 0);
  try {
    const client = new ShimoClient(ctx.settings.shimoSid);

    log.step("检查目标类型");
    const target = await client.resolveTarget(guid);
    log.step("目标信息", {
      guid,
      kind: target.kind,
      type: target.type,
      name: target.name,
    });

    const raw = await ctx.app.vault.read(file);
    const body = stripFrontmatter(raw);
    log.step("读取本地正文", { chars: body.length });

    const title = meta.title || file.basename;

    if (target.kind === "folder") {
      await syncToFolder(ctx, log, notice, client, {
        file,
        body,
        title,
        meta,
        folderGuid: guid,
        folderName: target.name,
      });
    } else {
      await syncAsConvert(ctx, log, notice, client, {
        file,
        body,
        title,
        meta,
        oldGuid: guid,
        oldType: target.type,
      });
    }

    await ctx.persistAssetMap();
    log.step("同步成功");
    await ctx.saveSyncLog(log.toString());
  } catch (err) {
    notice.hide();
    const message = formatError(err);
    log.error(message, err instanceof ShimoApiError ? { status: err.status, body: err.body } : err);
    await ctx.saveSyncLog(log.toString());
    console.error("[obsidian-to-shimo]", err);
    new Notice(`同步失败：${message}\n详情见：设置 → Obsidian to Shimo → 最近同步日志`, 10000);
  }
}

interface SyncJobBase {
  file: TFile;
  body: string;
  title: string;
  meta: NoteShimoMeta;
}

/** 目标是指向文档：转换覆盖（新文档生成后删除旧的，并把 frontmatter 指向新地址） */
async function syncAsConvert(
  ctx: SyncContext,
  log: SyncLogger,
  notice: Notice,
  client: ShimoClient,
  job: SyncJobBase & { oldGuid: string; oldType: string },
): Promise<void> {
  const { file, body, title, meta, oldGuid, oldType } = job;

  const folderGuid = await client.getParentFolderGuid(oldGuid);
  if (!folderGuid) {
    notice.hide();
    throw new ShimoApiError("无法确定旧文档所在文件夹，无法放置新文档", 400, "");
  }
  log.step("转换覆盖", { folderGuid, oldGuid });

  // 用父文件夹 guid 申请图片 token：公开 CDN 链接不随旧文档删除而失效
  const processed = await prepareBodyWithAttachments(ctx, log, client, {
    file,
    body,
    meta,
    hostGuid: folderGuid,
  });

  const created = await client.uploadMarkdownDocument(processed.markdown, {
    filename: `${title}.md`,
    folderGuid,
  });
  log.step("已生成石墨文档", created);

  let deletedOld = false;
  try {
    await client.deleteFile(oldGuid);
    deletedOld = true;
    log.step("已删除旧文档", { oldGuid });
  } catch (err) {
    log.step("删除旧文档失败", {
      oldGuid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await updateFrontmatterShimoUrl(ctx.app, file, created.url);
  log.step("已回写 frontmatter", { shimo: created.url, deletedOld });

  notice.hide();
  new Notice(
    `已转换为石墨文档「${created.name}」` +
      (deletedOld ? `，旧文档已删除` : `（旧文档 ${oldType || "原文档"} 删除失败，请手动清理）`) +
      `；frontmatter 已更新` +
      `；${formatAssetNotice(processed)}`,
  );
}

/**
 * 目标是指向文件夹：上传 md → editImport 转成石墨原生文档，并回写 shimo。
 * 之后这篇笔记会变成「文档覆盖」路径，不会在文件夹里堆 md 副本。
 */
async function syncToFolder(
  ctx: SyncContext,
  log: SyncLogger,
  notice: Notice,
  client: ShimoClient,
  job: SyncJobBase & { folderGuid: string; folderName: string },
): Promise<void> {
  const { file, body, title, meta, folderGuid, folderName } = job;

  log.step("上传到文件夹并转换", { folderGuid, folderName, title });

  const processed = await prepareBodyWithAttachments(ctx, log, client, {
    file,
    body,
    meta,
    hostGuid: folderGuid,
  });

  const created = await client.uploadMarkdownDocument(processed.markdown, {
    filename: `${title}.md`,
    folderGuid,
  });
  log.step("已生成石墨文档", created);

  await updateFrontmatterShimoUrl(ctx.app, file, created.url);
  log.step("已回写 frontmatter", { shimo: created.url });

  notice.hide();
  new Notice(
    `已在文件夹「${folderName || folderGuid}」生成石墨文档「${created.name}」` +
      `；frontmatter 已更新；${formatAssetNotice(processed)}`,
  );
}

/** 先上传本地图 → 改写正文链接 → 返回可上传的 markdown */
async function prepareBodyWithAttachments(
  ctx: SyncContext,
  log: SyncLogger,
  client: ShimoClient,
  options: {
    file: TFile;
    body: string;
    meta: NoteShimoMeta;
    hostGuid: string;
  },
): Promise<AssetProcessResult> {
  const { file, body, meta, hostGuid } = options;
  log.step("处理附件", {
    hostGuid,
    enabled: meta.syncAttachments,
    excalidraw: excalidrawStatusNote(),
  });

  const processed = await processAttachments({
    app: ctx.app,
    sourceFile: file,
    markdown: body,
    client,
    assetMap: new AssetMapStore(ctx.assetMap),
    enabled: meta.syncAttachments,
    hostGuid,
  });

  log.step("附件处理完成", {
    uploaded: processed.uploaded,
    reused: processed.reused,
    skipped: processed.skipped,
    remoteUrls: processed.remoteUrls,
  });

  return processed;
}

function formatAssetNotice(processed: AssetProcessResult): string {
  return (
    `附件上传 ${processed.uploaded}，复用 ${processed.reused}` +
    (processed.skipped.length ? `，跳过 ${processed.skipped.length}` : "")
  );
}

/** 覆盖后新文档换了 guid，需要把 shimo 字段改写成新地址 */
async function updateFrontmatterShimoUrl(app: App, file: TFile, url: string): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm.shimo = url;
  });
}

export function canUpload(settings: ObsidianToShimoSettings, meta: NoteShimoMeta | null): boolean {
  return !!settings.shimoSid.trim() && !!meta?.shimoUrl;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const after = content.slice(end + 4);
  return after.replace(/^\r?\n/, "");
}

function formatError(err: unknown): string {
  if (err instanceof ShimoApiError) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
