import { requestUrl, RequestUrlParam } from "obsidian";
import { describeHttpError, ShimoApiError } from "./errors";

export const API_BASE = "https://shimo.im/lizard-api";
export const PANDA_BASE = "https://shimo.im/panda-api";
export const APP_ORIGIN = "https://shimo.im";
export const UPLOADER_TOKEN_URL = "https://uploader.shimo.im/token?isAWSDirect=true";

/** 带 Cookie 的石墨 HTTP 封装 */
export class ShimoHttp {
  constructor(private sid: string) {}

  cookieHeader(): string {
    const trimmed = this.sid.trim();
    if (!trimmed) return "";
    if (trimmed.toLowerCase().includes("shimo_sid=")) return trimmed;
    return `shimo_sid=${trimmed}`;
  }

  baseHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: "application/vnd.shimo.v2+json, application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: APP_ORIGIN,
      Referer: `${APP_ORIGIN}/`,
      Cookie: this.cookieHeader(),
      ...extra,
    };
  }

  async request<T>(
    path: string,
    options: {
      method?: string;
      body?: string | ArrayBuffer;
      contentType?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const headers = this.baseHeaders({
      ...(options.contentType ? { "Content-Type": options.contentType } : {}),
      ...options.headers,
    });

    const param: RequestUrlParam = {
      url: path.startsWith("http") ? path : `${API_BASE}${path}`,
      method,
      headers,
      body: options.body,
      throw: false,
    };

    const res = await requestUrl(param);
    if (res.status < 200 || res.status >= 300) {
      throw new ShimoApiError(describeHttpError(res.status, res.text), res.status, res.text);
    }

    if (!res.text) return undefined as T;
    try {
      return res.json as T;
    } catch {
      return res.text as unknown as T;
    }
  }
}
