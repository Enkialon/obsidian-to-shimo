import { App, Notice, TFile } from "obsidian";
import { ShimoApiError, ShimoClient, parseShimoGuid } from "../shimo";
import { buildReplacementOps, NativeDocument, nativeSignature, nativeText } from "../shimo/native-doc";
import { AssetMapStore } from "./asset-map";
import { AssetProcessResult, excalidrawStatusNote, processAttachments } from "./asset-processor";
import { NoteShimoMeta, readShimoMeta } from "./frontmatter";
import { rewriteLinkedNotes } from "./note-link-rewriter";
import { AssetMap, ObsidianToShimoSettings } from "../settings";
import { sleep } from "../shimo/util";
import { SyncLogger } from "./logger";

interface PrepareBodyResult extends AssetProcessResult {
  linksRewritten: number;
  linksSkipped: string[];
}

export interface SyncContext {
  app: App;
  settings: ObsidianToShimoSettings;
  assetMap: AssetMap;
  persistAssetMap: () => Promise<void>;
  saveSyncLog: (log: string) => Promise<void>;
  /** 把覆盖前的正文备份到插件目录，返回可展示的路径 */
  writeBackup: (name: string, data: string) => Promise<string>;
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
 * 两条路径都会先上传本地图片、改写已同步笔记互链，再转换。
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

/** 目标是指向文档：默认原地覆盖（GUID / 链接不变），可切换旧版「新建 + 删旧」 */
async function syncAsConvert(
  ctx: SyncContext,
  log: SyncLogger,
  notice: Notice,
  client: ShimoClient,
  job: SyncJobBase & { oldGuid: string; oldType: string },
): Promise<void> {
  if (ctx.settings.overwriteMode === "legacy") {
    await syncAsLegacyConvert(ctx, log, notice, client, job);
    return;
  }
  await syncAsOverwrite(ctx, log, notice, client, job);
}

/**
 * 原地覆盖（GUID 与访问链接不变）。
 *
 * 1. Markdown → 临时原生文档（复用 editImport）
 * 2. 读临时文档原生 ops；读目标文档原生 ops + rev
 * 3. 把目标正文备份到插件目录
 * 4. compose 提交「删除目标全文 + 插入临时文档全部 ops」
 * 5. 校验服务端内容；不一致则自动回滚
 * 6. 删除临时文档
 *
 * 只改目标文档正文，不碰 frontmatter（URL 不变）。
 */
async function syncAsOverwrite(
  ctx: SyncContext,
  log: SyncLogger,
  notice: Notice,
  client: ShimoClient,
  job: SyncJobBase & { oldGuid: string; oldType: string },
): Promise<void> {
  const { file, body, title, meta, oldGuid, oldType } = job;

  if (oldType && oldType !== "newdoc") {
    throw new ShimoApiError(
      `目标文档类型为 ${oldType}，不是轻文档（newdoc），暂不支持原地覆盖；` +
        `可在设置里改用旧版「新建 + 删旧」模式`,
      400,
      "",
    );
  }

  const folderGuid = await client.getParentFolderGuid(oldGuid);
  if (!folderGuid) {
    throw new ShimoApiError("无法确定目标文档所在文件夹，无法生成临时文档", 400, "");
  }
  log.step("原地覆盖准备", { folderGuid, oldGuid });

  // 用父文件夹 guid 申请图片 token：公开 CDN 链接不随临时文档删除而失效
  const processed = await prepareBodyWithAttachments(ctx, log, client, {
    file,
    body,
    meta,
    hostGuid: folderGuid,
  });

  const target = await client.readNativeDocument(oldGuid);
  if (target.head <= 0 || target.ops.length === 0) {
    throw new ShimoApiError("读取目标文档正文失败（内容为空或版本号为 0），已中止，未做修改", 200, "");
  }
  log.step("读取目标正文", {
    head: target.head,
    length: target.length,
    ops: target.ops.length,
  });

  const temp = await client.uploadMarkdownDocument(processed.markdown, {
    filename: `${title}.md`,
    folderGuid,
  });
  log.step("已生成临时文档", temp);

  let deleted = false;
  try {
    const fresh = await waitForImportedDocument(client, temp.guid);
    const expected = nativeSignature(fresh.ops);
    if (!expected) {
      throw new ShimoApiError("临时文档正文为空，转换可能失败", 200, "");
    }

    const changeset = buildReplacementOps(target.ops, fresh.ops);
    log.step("构造覆盖 changeset", {
      rev: target.head,
      removeLength: target.length,
      insertOps: changeset.length - 1,
      tempHead: fresh.head,
    });

    const backupPayload = JSON.stringify(
      {
        guid: oldGuid,
        name: target.name,
        head: target.head,
        savedAt: new Date().toISOString(),
        ops: target.ops,
      },
      null,
      2,
    );
    let backupPath = "";
    try {
      backupPath = await ctx.writeBackup(`${oldGuid}-${backupStamp()}.json`, backupPayload);
    } catch (err) {
      throw new ShimoApiError(
        `无法写入本地备份，已中止（石墨文档未被修改）：${err instanceof Error ? err.message : String(err)}`,
        400,
        "",
      );
    }
    log.step("已备份目标正文", { path: backupPath, head: target.head });

    try {
      await client.composeDocument(oldGuid, target.head, changeset);
      log.step("已提交覆盖", { rev: target.head });

      const applied = await waitForSignature(client, oldGuid, expected, target.head);
      if (!applied.matched) {
        throw new ShimoApiError(
          "覆盖后校验失败：服务端内容与预期不一致",
          200,
          nativeText(applied.doc.ops).slice(0, 300),
        );
      }
      log.step("覆盖校验通过", { head: applied.doc.head, length: applied.doc.length });
    } catch (err) {
      let restoreState: "already" | "restored" | "failed" = "failed";
      try {
        restoreState = await restoreDocument(client, log, oldGuid, target, backupPath);
      } catch (restoreErr) {
        log.error("自动回滚失败", {
          backupPath,
          error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
        });
      }
      if (restoreState === "restored") {
        log.step("已回滚到覆盖前内容", { head: target.head });
      }
      const reason = err instanceof Error ? err.message : String(err);
      const suffix =
        restoreState === "restored"
          ? "（已自动回滚）"
          : restoreState === "failed"
            ? "（自动回滚失败，请用备份恢复）"
            : "";
      throw new ShimoApiError(
        `${reason}${suffix}；备份：${backupPath}`,
        err instanceof ShimoApiError ? err.status : 200,
        err instanceof ShimoApiError ? err.body : "",
      );
    }

    notice.hide();
    new Notice(
      `已原地覆盖石墨文档「${target.name || title}」，链接与 GUID 不变` +
        `；${formatAssetNotice(processed)}`,
    );
  } finally {
    try {
      await client.deleteFile(temp.guid);
      deleted = true;
    } catch (err) {
      log.step("临时文档清理失败", {
        tempGuid: temp.guid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.step("临时文档清理", { tempGuid: temp.guid, deleted });
  }
}

/** 只有当前内容与备份不一致时才回滚，避免覆盖根本没生效时重复提交 */
async function restoreDocument(
  client: ShimoClient,
  log: SyncLogger,
  guid: string,
  backup: NativeDocument,
  backupPath: string,
): Promise<"already" | "restored"> {
  const current = await client.readNativeDocument(guid);
  const backupSignature = nativeSignature(backup.ops);
  if (nativeSignature(current.ops) === backupSignature) return "already";

  log.step("开始回滚", { rev: current.head, currentLength: current.length, backupLength: backup.length });
  const undo = buildReplacementOps(current.ops, backup.ops);
  await client.composeDocument(guid, current.head, undo);

  const restored = await waitForSignature(client, guid, backupSignature, current.head);
  if (!restored.matched) {
    throw new ShimoApiError(`回滚未生效，请用备份手动恢复：${backupPath}`, 200, "");
  }
  return "restored";
}

/** 转换完成后正文可能稍晚落盘，这里等到有内容为止 */
async function waitForImportedDocument(
  client: ShimoClient,
  guid: string,
  timeoutMs = 60_000,
): Promise<NativeDocument> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const doc = await client.readNativeDocument(guid);
      if (doc.ops.length > 0) return doc;
    } catch {
      // 内容还没写好时可能 404 / 空对象，继续等
    }
    await sleep(1500);
  }
  throw new ShimoApiError("临时文档迟迟没有内容，转换可能失败", 200, "");
}

/** 轮询到 head 前进且内容指纹匹配（服务端对过期 rev 不报错，只能自己校验） */
async function waitForSignature(
  client: ShimoClient,
  guid: string,
  expected: string,
  minHead: number,
  timeoutMs = 20_000,
): Promise<{ doc: NativeDocument; matched: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let doc = await client.readNativeDocument(guid);
  while (Date.now() < deadline) {
    if (doc.head > minHead && nativeSignature(doc.ops) === expected) {
      return { doc, matched: true };
    }
    await sleep(1500);
    doc = await client.readNativeDocument(guid);
  }
  return { doc, matched: doc.head > minHead && nativeSignature(doc.ops) === expected };
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 旧版转换覆盖：新文档生成后删除旧的，并把 frontmatter 指向新地址（GUID 会变） */
async function syncAsLegacyConvert(
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

/** 先上传本地图 → 改写正文图片链接 → 再改写已同步笔记互链 → 返回可上传的 markdown */
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
): Promise<PrepareBodyResult> {
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

  const links = rewriteLinkedNotes({
    app: ctx.app,
    sourceFile: file,
    markdown: processed.markdown,
  });
  log.step("互链改写完成", {
    rewritten: links.rewritten,
    skipped: links.skipped,
  });

  return {
    ...processed,
    markdown: links.markdown,
    linksRewritten: links.rewritten,
    linksSkipped: links.skipped,
  };
}

function formatAssetNotice(processed: PrepareBodyResult): string {
  return (
    `附件上传 ${processed.uploaded}，复用 ${processed.reused}` +
    (processed.skipped.length ? `，跳过 ${processed.skipped.length}` : "") +
    (processed.linksRewritten
      ? `；互链改写 ${processed.linksRewritten}`
      : "") +
    (processed.linksSkipped.length
      ? `，互链跳过 ${processed.linksSkipped.length}`
      : "")
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
