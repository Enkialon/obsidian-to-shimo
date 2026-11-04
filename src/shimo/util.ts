import { APP_ORIGIN } from "./http";
import { ShimoFileInfo } from "./types";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 石墨对上传文件名敏感：必须带 .md 扩展名，否则不会走 markdown 转换 */
export function normalizeMarkdownFilename(name: string): string {
  const trimmed = (name || "").trim() || "未命名";
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

export function stripMarkdownExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

export function resolveDocUrl(info: ShimoFileInfo, guid: string): string {
  const raw = typeof info.url === "string" ? info.url : "";
  if (raw.startsWith("http")) return raw;
  if (raw.startsWith("/")) return `${APP_ORIGIN}${raw}`;
  return `${APP_ORIGIN}/docs/${guid}`;
}

export function uint8ToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // TextEncoder 返回的视图可能共享更大底层 buffer，拷贝精确长度
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

export function isImageMimeOrName(mime: string, filename: string): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filename);
}

export function extractGuidFromBody(text: string, json: unknown): string {
  try {
    const parsed = json as { guid?: unknown } | undefined;
    if (parsed && typeof parsed.guid === "string") return parsed.guid;
  } catch {
    // ignore
  }
  const m = (text || "").match(/"guid"\s*:\s*"([A-Za-z0-9_-]+)"/);
  return m ? m[1] : "";
}
