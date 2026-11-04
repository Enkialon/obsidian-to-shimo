/**
 * 从石墨文档 URL 或纯 guid 中解析 file guid。
 * 支持常见形态：
 * - https://shimo.im/docs/xxxx
 * - https://shimo.im/docs/xxxx/read
 * - https://shimo.im/office/xxxx
 * - xxxx（纯 guid）
 */
export function parseShimoGuid(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  if (/^[A-Za-z0-9_-]{6,}$/.test(raw) && !raw.includes("/") && !raw.includes(".")) {
    return raw;
  }

  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    // /docs/{guid}/... 或 /office/{guid}/... 或 /sheets/{guid}/... 或 /folder/{guid}
    const markers = [
      "docs",
      "office",
      "sheets",
      "presentation",
      "mindmaps",
      "boards",
      "files",
      "folder",
      "folders",
    ];
    for (let i = 0; i < parts.length - 1; i++) {
      if (markers.includes(parts[i].toLowerCase())) {
        const guid = parts[i + 1];
        if (guid && /^[A-Za-z0-9_-]+$/.test(guid)) return guid;
      }
    }
    // 兜底：取路径最后一段非保留词
    const last = parts[parts.length - 1];
    if (last && /^[A-Za-z0-9_-]{6,}$/.test(last) && !["read", "edit", "MODOC", "new"].includes(last)) {
      return last;
    }
  } catch {
    // not a URL
  }

  return null;
}

