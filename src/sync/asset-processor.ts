import { App, TFile } from "obsidian";
import { ShimoClient } from "../shimo";
import { AssetMapStore, sha256Hex } from "./asset-map";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const EXCALIDRAW_EXPORT_EXTS = [".light.svg", ".dark.svg", ".svg", ".png"];

export interface AssetProcessResult {
  markdown: string;
  uploaded: number;
  reused: number;
  skipped: string[];
}

/**
 * 解析 Markdown 中的本地图片 / 嵌入，未变更则复用石墨 URL，变更则上传。
 */
export async function processAttachments(options: {
  app: App;
  sourceFile: TFile;
  markdown: string;
  client: ShimoClient;
  assetMap: AssetMapStore;
  enabled: boolean;
  /** 目标石墨文档 guid，上传 token 需要绑定到该文档 */
  documentGuid: string;
}): Promise<AssetProcessResult> {
  const { app, sourceFile, client, assetMap, enabled, documentGuid } = options;
  let markdown = options.markdown;
  let uploaded = 0;
  let reused = 0;
  const skipped: string[] = [];

  if (!enabled) {
    return { markdown, uploaded, reused, skipped };
  }

  const refs = collectLocalRefs(markdown);
  for (const ref of refs) {
    const resolved = resolveLocalFile(app, sourceFile, ref.path);
    if (!resolved) {
      skipped.push(ref.path);
      continue;
    }

    const target = await preferExcalidrawExport(app, resolved);
    // 个人版 uploader 仅开放 images 桶；非图片先跳过，避免 files 桶 403
    if (!isLikelyImagePath(target.path) && !isLikelyImagePath(target.name)) {
      skipped.push(`${ref.path}（非图片，暂不上传）`);
      continue;
    }

    const data = await app.vault.readBinary(target);
    const hash = await sha256Hex(data);
    const existing = assetMap.findByHash(hash);

    let remoteUrl: string;
    if (existing?.remoteUrl) {
      remoteUrl = existing.remoteUrl;
      reused += 1;
    } else {
      const mime = guessMime(target.extension);
      const result = await client.uploadAttachment(target.name, data, mime, documentGuid);
      remoteUrl = result.url;
      assetMap.upsert(hash, remoteUrl, target.path);
      uploaded += 1;
    }

    markdown = replaceRef(markdown, ref.raw, remoteUrl, target.basename);
  }

  return { markdown, uploaded, reused, skipped };
}

interface LocalRef {
  raw: string;
  path: string;
}

function collectLocalRefs(markdown: string): LocalRef[] {
  const refs: LocalRef[] = [];
  const seen = new Set<string>();

  const patterns: RegExp[] = [
    /!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g, // ![[path|alias]]
    /!\[([^\]]*)\]\(([^)]+)\)/g, // ![alt](path)
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) {
      const raw = m[0];
      const path = (m[2] ?? m[1]).trim().replace(/^<|>$/g, "");
      if (!path || path.startsWith("http://") || path.startsWith("https://") || path.startsWith("data:")) {
        continue;
      }
      if (seen.has(raw)) continue;
      seen.add(raw);
      refs.push({ raw, path });
    }
  }

  return refs;
}

function resolveLocalFile(app: App, sourceFile: TFile, linkPath: string): TFile | null {
  const dest = app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
  return dest instanceof TFile ? dest : null;
}

/** Excalidraw：优先用已导出的预览图，避免上传源文件 */
async function preferExcalidrawExport(app: App, file: TFile): Promise<TFile> {
  if (!file.name.toLowerCase().endsWith(".excalidraw") && file.extension !== "excalidraw") {
    // 也兼容 xxx.excalidraw.md
    if (!file.name.toLowerCase().includes(".excalidraw")) return file;
  }

  const folder = file.parent;
  if (!folder) return file;
  const stem = file.basename.replace(/\.excalidraw$/i, "");

  for (const ext of EXCALIDRAW_EXPORT_EXTS) {
    const candidate = app.vault.getAbstractFileByPath(`${folder.path}/${stem}${ext}`);
    if (candidate instanceof TFile) return candidate;
  }
  return file;
}

function replaceRef(markdown: string, raw: string, remoteUrl: string, alt: string): string {
  // 统一改成标准 Markdown 图片，石墨侧更友好
  const replacement = `![${alt}](${remoteUrl})`;
  return markdown.split(raw).join(replacement);
}

function guessMime(ext: string): string {
  const e = ext.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    md: "text/markdown",
  };
  return map[e] || "application/octet-stream";
}

export function isLikelyImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}
