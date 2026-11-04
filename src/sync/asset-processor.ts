import { App, TFile } from "obsidian";
import { ShimoClient } from "../shimo";
import { AssetMapStore, sha256Hex } from "./asset-map";
import {
  findExcalidrawSidecar,
  isExcalidrawAvailable,
  isExcalidrawFile,
  isExcalidrawPath,
  renderExcalidrawFile,
} from "./excalidraw";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

export interface AssetProcessResult {
  markdown: string;
  uploaded: number;
  reused: number;
  skipped: string[];
  remoteUrls: string[];
}

interface UploadableImage {
  cacheKey: string;
  data: ArrayBuffer;
  filename: string;
  mime: string;
  alt: string;
  localPath: string;
}

/**
 * 上传前处理：本地图片 / Excalidraw 渲染图 → 石墨 images 桶 → 改写正文链接。
 */
export async function processAttachments(options: {
  app: App;
  sourceFile: TFile;
  markdown: string;
  client: ShimoClient;
  assetMap: AssetMapStore;
  enabled: boolean;
  hostGuid: string;
}): Promise<AssetProcessResult> {
  const { app, sourceFile, client, assetMap, enabled, hostGuid } = options;
  let markdown = options.markdown;
  let uploaded = 0;
  let reused = 0;
  const skipped: string[] = [];
  const remoteUrls: string[] = [];

  if (!enabled) {
    return { markdown, uploaded, reused, skipped, remoteUrls };
  }
  if (!hostGuid.trim()) {
    skipped.push("（无 hostGuid，无法申请图片上传 token）");
    return { markdown, uploaded, reused, skipped, remoteUrls };
  }

  const refs = collectLocalRefs(markdown);
  const pathToRemote = new Map<string, string>();

  for (const ref of refs) {
    const resolved = resolveLocalFile(app, sourceFile, ref.path);
    if (!resolved) {
      skipped.push(`${ref.path}（未找到本地文件）`);
      continue;
    }

    const { image, skipReason } = await resolveUploadableImage(app, resolved, ref);
    if (!image) {
      skipped.push(skipReason || `${ref.path}（无法上传）`);
      continue;
    }

    let remoteUrl = pathToRemote.get(image.cacheKey);
    if (!remoteUrl) {
      const hash = await sha256Hex(image.data);
      const existing = assetMap.findByHash(hash);

      if (existing?.remoteUrl) {
        remoteUrl = existing.remoteUrl;
        reused += 1;
      } else {
        const result = await client.uploadAttachment(
          image.filename,
          image.data,
          image.mime,
          hostGuid,
        );
        remoteUrl = result.url;
        assetMap.upsert(hash, remoteUrl, image.localPath);
        uploaded += 1;
      }
      pathToRemote.set(image.cacheKey, remoteUrl);
    }

    remoteUrls.push(remoteUrl);
    markdown = replaceRef(markdown, ref.raw, remoteUrl, image.alt);
  }

  return { markdown, uploaded, reused, skipped, remoteUrls };
}

interface LocalRef {
  raw: string;
  path: string;
  alt?: string;
}

function collectLocalRefs(markdown: string): LocalRef[] {
  const refs: LocalRef[] = [];
  const seen = new Set<string>();

  const wikiRe = /!\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(markdown)) !== null) {
    const raw = m[0];
    const inner = m[1] ?? "";
    const path = decodePath(inner.split("|")[0] ?? "");
    if (!path || isRemoteOrData(path) || seen.has(raw)) continue;
    seen.add(raw);
    const alias = inner.includes("|") ? inner.split("|").slice(1).join("|").trim() : undefined;
    refs.push({ raw, path, alt: alias });
  }

  const mdRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
  while ((m = mdRe.exec(markdown)) !== null) {
    const raw = m[0];
    const alt = (m[1] ?? "").trim();
    const path = decodePath((m[2] ?? "").replace(/^<|>$/g, ""));
    if (!path || isRemoteOrData(path) || seen.has(raw)) continue;
    seen.add(raw);
    refs.push({ raw, path, alt: alt || undefined });
  }

  return refs;
}

function decodePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function isRemoteOrData(path: string): boolean {
  return (
    /^https?:\/\//i.test(path) ||
    path.startsWith("data:") ||
    path.startsWith("app://") ||
    path.startsWith("file://")
  );
}

function resolveLocalFile(app: App, sourceFile: TFile, linkPath: string): TFile | null {
  const dest = app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
  return dest instanceof TFile ? dest : null;
}

async function resolveUploadableImage(
  app: App,
  file: TFile,
  ref: LocalRef,
): Promise<{ image: UploadableImage | null; skipReason?: string }> {
  const alt =
    (ref.alt && ref.alt.trim()) ||
    file.basename.replace(/\.excalidraw$/i, "");

  const looksExcalidraw =
    isExcalidrawFile(file) ||
    isExcalidrawPath(file.path) ||
    isExcalidrawPath(file.name) ||
    isExcalidrawPath(ref.path);

  if (looksExcalidraw) {
    const attempt = await renderExcalidrawFile(file);
    if (attempt.image) {
      return {
        image: {
          cacheKey: `${file.path}#ea-png-v2`,
          data: attempt.image.bytes,
          filename: attempt.image.filename,
          mime: attempt.image.mime,
          alt,
          localPath: file.path,
        },
      };
    }

    const sidecar = findExcalidrawSidecar(app, file);
    if (sidecar) {
      const data = await app.vault.readBinary(sidecar);
      return {
        image: {
          cacheKey: sidecar.path,
          data,
          filename: sidecar.name,
          mime: guessMime(sidecar.extension),
          alt,
          localPath: sidecar.path,
        },
      };
    }

    return {
      image: null,
      skipReason: `${ref.path}（Excalidraw 渲染失败：${attempt.error || "未知"}；且无同目录预览图）`,
    };
  }

  if (!isLikelyImagePath(file.path) && !isLikelyImagePath(file.name)) {
    return { image: null, skipReason: `${ref.path}（非图片，暂不上传）` };
  }

  const data = await app.vault.readBinary(file);
  return {
    image: {
      cacheKey: file.path,
      data,
      filename: file.name,
      mime: guessMime(file.extension),
      alt,
      localPath: file.path,
    },
  };
}

function replaceRef(markdown: string, raw: string, remoteUrl: string, alt: string): string {
  const safeAlt = alt.replace(/[\[\]]/g, "");
  return markdown.split(raw).join(`![${safeAlt}](${remoteUrl})`);
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
    avif: "image/avif",
  };
  return map[e] || "application/octet-stream";
}

export function isLikelyImagePath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export function excalidrawStatusNote(): string {
  return isExcalidrawAvailable() ? "ExcalidrawAutomate 可用" : "ExcalidrawAutomate 不可用";
}
