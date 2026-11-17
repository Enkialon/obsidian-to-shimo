import { requestUrl, RequestUrlParam } from "obsidian";
import { describeHttpError, ShimoApiError } from "./errors";

export const API_BASE = "https://shimo.im/lizard-api";
export const PANDA_BASE = "https://shimo.im/panda-api";
export const APP_ORIGIN = "https://shimo.im";
export const EDIT_BASE = "https://shimo.im/edit";
export const UPLOADER_TOKEN_URL = "https://uploader.shimo.im/token?isAWSDirect=true";

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

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

  /**
   * 原始 GET：需要读响应头（文档内容接口用 x-amz-meta-head / x-amz-meta-length）。
   * 不抛错，由调用方判断状态码。
   */
  async requestRaw(url: string, headers?: Record<string, string>): Promise<RawHttpResponse> {
    const res = await requestUrl({
      url: url.startsWith("http") ? url : `${API_BASE}${url}`,
      method: "GET",
      headers: this.baseHeaders(headers),
      throw: false,
    });

    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers ?? {})) {
      normalized[key.toLowerCase()] = String(value);
    }

    return { status: res.status, headers: normalized, text: res.text ?? "" };
  }
}
