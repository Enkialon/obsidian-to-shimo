/** /token 返回项：字段名可能随前端变化，做宽松解析 */
export interface UploadTokenItem {
  server?: string;
  host?: string;
  url?: string;
  fileUrl?: string;
  downloadUrl?: string;
  formData?: Record<string, string | number | boolean>;
  data?: Record<string, string | number | boolean>;
  fileFieldKey?: string;
  [key: string]: unknown;
}

export function resolveUploadHost(token: UploadTokenItem): string | null {
  // 网页实际字段是 serverUrl；旧抓包偶发 server / host
  for (const key of ["serverUrl", "server", "host", "uploadUrl", "upload_url", "action", "endpoint"]) {
    const v = token[key];
    if (typeof v === "string" && /^https?:\/\//.test(v) && isObsUploadEndpoint(v)) {
      return v;
    }
  }
  return null;
}

/** OBS 直传地址；排除 uploader.shimo.im/f/ 这类公开下载 URL */
function isObsUploadEndpoint(url: string): boolean {
  if (url.includes("uploader.shimo.im/f/")) return false;
  return (
    url.includes(".obs.") ||
    url.includes("aliyuncs.com") ||
    url.includes("myhuaweicloud.com") ||
    url.includes("amazonaws.com") ||
    /\/(upload|put)\b/i.test(url)
  );
}

export function resolveFormFields(token: UploadTokenItem): Record<string, string> {
  const raw =
    (token.formData && typeof token.formData === "object" && token.formData) ||
    (token.data && typeof token.data === "object" && token.data) ||
    null;

  const out: Record<string, string> = {};
  if (raw) {
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "object") continue;
      out[k] = String(v);
    }
    return out;
  }

  const known = new Set([
    "AccessKeyId",
    "OSSAccessKeyId",
    "policy",
    "signature",
    "Signature",
    "key",
    "success_action_status",
    "callbackUrl",
    "callbackBody",
    "callbackBodyType",
    "callback",
    "x-obs-meta-filename",
    "x-obs-meta-guid",
    "x-obs-meta-user-id",
    "Content-Type",
    "acl",
    "fileFieldKey",
  ]);
  for (const [k, v] of Object.entries(token)) {
    if (!known.has(k) && !k.startsWith("x-obs-meta-") && !k.startsWith("x-amz-")) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    }
  }
  return out;
}

export function resolvePublicUrl(
  token: UploadTokenItem,
  formFields: Record<string, string>,
  filename: string,
): string | null {
  const direct = pickString(token as Record<string, unknown>, [
    "url",
    "images",
    "fileUrl",
    "downloadUrl",
  ]);
  if (direct && direct.includes("uploader.shimo.im")) return stripThumbnail(direct);

  const cb = formFields.callbackBody;
  if (cb) {
    try {
      const parsed = JSON.parse(cb) as Record<string, unknown>;
      const fromCb = pickString(parsed, ["url"]);
      if (fromCb) return stripThumbnail(fromCb);
      const guid = pickString(parsed, ["GUID", "guid"]);
      if (guid) {
        const ext = extensionOf(filename) || "png";
        return `https://uploader.shimo.im/f/${guid}.${ext}`;
      }
    } catch {
      // ignore
    }
  }

  const key = formFields.key;
  if (key) return `https://uploader.shimo.im/f/${key}`;
  return direct;
}

export function tryParseUrlFromBody(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      return tryParseUrlFromBody(JSON.parse(body));
    } catch {
      const m = body.match(/https:\/\/uploader\.shimo\.im\/f\/[A-Za-z0-9_.-]+/);
      return m ? stripThumbnail(m[0]) : null;
    }
  }
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const direct = pickString(obj, ["url", "fileUrl", "downloadUrl"]);
    if (direct) return stripThumbnail(direct);
    if (obj.data && typeof obj.data === "object") {
      const nested = pickString(obj.data as Record<string, unknown>, ["url", "fileUrl", "downloadUrl"]);
      if (nested) return stripThumbnail(nested);
    }
  }
  return null;
}

export function stripThumbnail(url: string): string {
  return url.replace(/!thumbnail$/i, "");
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}
