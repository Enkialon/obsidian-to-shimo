export class ShimoApiError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ShimoApiError";
    this.status = status;
    this.body = body;
  }
}

export function describeHttpError(status: number, body: string): string {
  const lower = (body || "").toLowerCase();
  // 业务 403（如 bucket 限制）不要误报成 sid 失效
  if (lower.includes("bucket is for internal use")) {
    return `上传桶不可用：${extractMessage(body) || body}`;
  }
  if (status === 410 || lower.includes("文件已被删除") || lower.includes('"errorcode":60002')) {
    return "目标石墨文档不存在或已被删除，请在笔记 frontmatter 更新 shimo 地址";
  }
  if (status === 401 || (status === 403 && looksLikeAuthError(lower))) {
    return "石墨鉴权失败，请重新粘贴有效的 shimo_sid";
  }
  const msg = extractMessage(body) || extractErrorField(body);
  return msg ? `石墨请求失败 HTTP ${status}：${msg}` : `石墨请求失败 HTTP ${status}`;
}

function extractErrorField(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string };
    return (j.error || "").trim();
  } catch {
    return "";
  }
}

function looksLikeAuthError(lowerBody: string): boolean {
  return (
    lowerBody.includes("unauthorized") ||
    lowerBody.includes("not login") ||
    lowerBody.includes("not logged") ||
    lowerBody.includes("invalid session") ||
    lowerBody.includes("authentication") ||
    lowerBody.includes("请登录")
  );
}

function extractMessage(body: string): string {
  if (!body) return "";
  try {
    const j = JSON.parse(body) as { message?: string; msg?: string };
    return (j.message || j.msg || "").trim();
  } catch {
    return body.trim().slice(0, 160);
  }
}
