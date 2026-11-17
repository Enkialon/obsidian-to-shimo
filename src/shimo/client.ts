import { requestUrl } from "obsidian";
import { describeHttpError, ShimoApiError } from "./errors";
import {
  API_BASE,
  APP_ORIGIN,
  EDIT_BASE,
  PANDA_BASE,
  ShimoHttp,
  UPLOADER_TOKEN_URL,
} from "./http";
import { buildMultipart, MultipartPart } from "./multipart";
import {
  deltaLength,
  NativeDocument,
  NativeOp,
  parseNativeContent,
} from "./native-doc";
import { ShimoFileInfo, ShimoUploadResult, ShimoUser } from "./types";
import {
  resolveFormFields,
  resolvePublicUrl,
  resolveUploadHost,
  stripThumbnail,
  tryParseUrlFromBody,
  UploadTokenItem,
} from "./upload-token";
import {
  extractGuidFromBody,
  isImageMimeOrName,
  normalizeMarkdownFilename,
  randomAlnum,
  resolveDocUrl,
  safeHost,
  sleep,
  stripMarkdownExt,
  uint8ToArrayBuffer,
} from "./util";

export { ShimoApiError } from "./errors";

interface UploadTokenRequestItem {
  /** 个人版网页插图用 images；files 桶会 403: bucket is for internal use */
  bucket: "images";
  encrypt: string;
  fileGuid: string;
  fileName: string;
  fileSize: number;
}

export interface ShimoTarget {
  kind: "folder" | "file";
  name: string;
  type: string;
  info: ShimoFileInfo;
}

export interface UploadedFile {
  guid: string;
  name: string;
  url: string;
}

/**
 * 个人版网页接口客户端。
 * 鉴权使用浏览器 Cookie 中的 shimo_sid（官方个人版暂不开放 API）。
 *
 * 公开能力：
 * - 读文件 / 判文件夹 vs 文档
 * - 上传图片附件（images 桶）
 * - 上传 Markdown 云文件（postPolicy）
 * - Markdown → 石墨原生文档（editImport）
 * - 查父文件夹、删除文件
 */
export class ShimoClient {
  private http: ShimoHttp;

  constructor(sid: string) {
    this.http = new ShimoHttp(sid);
  }

  async getMe(): Promise<ShimoUser> {
    return this.http.request<ShimoUser>("/users/me");
  }

  async getFile(guid: string): Promise<ShimoFileInfo> {
    return this.http.request<ShimoFileInfo>(`/files/${encodeURIComponent(guid)}?contentUrl=true`);
  }

  /**
   * 判断目标 guid 是文件夹还是文档。
   * 依据 GET /files/{guid} 的 isFolder / url 字段。
   */
  async resolveTarget(guid: string): Promise<ShimoTarget> {
    const info = await this.getFile(guid);
    const url = typeof info.url === "string" ? info.url : "";
    const isFolder =
      info.isFolder === true ||
      info.is_folder === true ||
      url.startsWith("/folder/") ||
      info.isSpace === true;
    return {
      kind: isFolder ? "folder" : "file",
      name: typeof info.name === "string" ? info.name : "",
      type: typeof info.type === "string" ? info.type : "",
      info,
    };
  }

  /**
   * 两步上传图片（与网页一致）：
   * 1) POST uploader.shimo.im/token 拿 OBS 表单凭证
   * 2) multipart POST 到华为 OBS，file 字段放最后
   */
  async uploadAttachment(
    filename: string,
    data: ArrayBuffer,
    mimeType: string,
    documentGuid: string,
  ): Promise<ShimoUploadResult> {
    if (!isImageMimeOrName(mimeType, filename)) {
      throw new ShimoApiError(
        `暂不支持上传非图片附件：${filename}（个人版可用 bucket 仅为 images）`,
        400,
        filename,
      );
    }

    const tokenReq: UploadTokenRequestItem[] = [
      {
        bucket: "images",
        encrypt: "",
        fileGuid: documentGuid,
        fileName: filename,
        fileSize: data.byteLength,
      },
    ];

    const tokenRaw = await this.http.request<UploadTokenItem[] | UploadTokenItem>(
      UPLOADER_TOKEN_URL,
      {
        method: "POST",
        body: JSON.stringify(tokenReq),
        contentType: "application/json;charset=UTF-8",
        headers: {
          Accept: "application/nd.shimo.v2+json",
          "x-api-version": "2",
          Referer: `${APP_ORIGIN}/`,
        },
      },
    );

    const token = Array.isArray(tokenRaw) ? tokenRaw[0] : tokenRaw;
    if (!token || typeof token !== "object") {
      throw new ShimoApiError("获取上传 token 失败：响应为空", 200, JSON.stringify(tokenRaw));
    }

    const uploadHost = resolveUploadHost(token);
    const formFields = resolveFormFields(token);
    const fileFieldKey =
      (typeof token.fileFieldKey === "string" && token.fileFieldKey) ||
      (typeof formFields.fileFieldKey === "string" && String(formFields.fileFieldKey)) ||
      "file";
    delete formFields.fileFieldKey;

    if (!uploadHost) {
      throw new ShimoApiError("获取上传 token 成功，但未解析到 OBS host", 200, JSON.stringify(token));
    }
    if (Object.keys(formFields).length === 0) {
      throw new ShimoApiError("获取上传 token 成功，但未解析到 formData", 200, JSON.stringify(token));
    }

    const publicUrl = resolvePublicUrl(token, formFields, filename);
    const boundary = `----ObsidianShimo${Date.now()}`;
    const parts: MultipartPart[] = Object.entries(formFields).map(([name, value]) => ({
      name,
      text: String(value),
    }));
    parts.push({
      name: fileFieldKey,
      filename,
      contentType: mimeType || "application/octet-stream",
      data,
    });

    const obsRes = await requestUrl({
      url: uploadHost,
      method: "POST",
      headers: {
        Accept: "application/nd.shimo.v2+json, application/json, */*",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Origin: APP_ORIGIN,
        Referer: `${APP_ORIGIN}/`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: buildMultipart(boundary, parts),
      throw: false,
    });

    if (obsRes.status < 200 || obsRes.status >= 300) {
      throw new ShimoApiError(`OBS 上传失败 HTTP ${obsRes.status}`, obsRes.status, obsRes.text);
    }

    const fromObs = tryParseUrlFromBody(obsRes.text) ?? tryParseUrlFromBody(obsRes.json);
    const url = stripThumbnail(fromObs || publicUrl || "");
    if (!url) {
      throw new ShimoApiError(
        "上传完成但未得到资源 URL",
        obsRes.status,
        obsRes.text || JSON.stringify(token),
      );
    }

    return { url, raw: { token, obs: obsRes.json ?? obsRes.text } };
  }

  /** 仅上传 Markdown 到目标文件夹（不转换，保留为 .md 云文件）。 */
  async uploadMarkdownFile(
    markdown: string,
    options: { filename: string; folderGuid: string },
  ): Promise<UploadedFile> {
    const folderGuid = options.folderGuid.trim();
    if (!folderGuid) {
      throw new ShimoApiError("未配置上传目录（石墨文件夹 URL 或 guid）", 400, "");
    }
    const filename = normalizeMarkdownFilename(options.filename);
    const data = new TextEncoder().encode(markdown);

    const policy = await this.http.request<{
      code?: number;
      msg?: string;
      data?: { guid?: string; uploadUrl?: { url?: string; formData?: Record<string, unknown> } };
    }>(`${API_BASE}/files/upload/postPolicy?encodedFileName=${encodeURIComponent(filename)}`, {
      method: "POST",
      body: "{}",
      contentType: "text/plain",
      headers: {
        Accept: "application/nd.shimo.v2+json",
        "x-file-parent-guid": folderGuid,
        "x-file-size": String(data.byteLength),
        "x-file-type": "text/markdown",
        Referer: `${APP_ORIGIN}/folder/${folderGuid}`,
      },
    });

    const uploadUrl = policy?.data?.uploadUrl;
    const host = typeof uploadUrl?.url === "string" ? uploadUrl.url : "";
    const formData = uploadUrl?.formData ?? {};
    if (!host || Object.keys(formData).length === 0) {
      throw new ShimoApiError(
        "获取上传凭证失败（postPolicy 未返回 uploadUrl）",
        200,
        JSON.stringify(policy).slice(0, 300),
      );
    }

    const boundary = `----ObsidianShimo${Date.now()}`;
    const parts: MultipartPart[] = Object.entries(formData).map(([name, value]) => ({
      name,
      text: String(value),
    }));
    parts.push({
      name: "file",
      filename,
      contentType: "text/markdown",
      data: uint8ToArrayBuffer(data),
    });

    const obsRes = await requestUrl({
      url: host,
      method: "POST",
      headers: {
        Accept: "application/json, */*",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Origin: APP_ORIGIN,
        Referer: `${APP_ORIGIN}/`,
      },
      body: buildMultipart(boundary, parts),
      throw: false,
    });
    if (obsRes.status < 200 || obsRes.status >= 300) {
      throw new ShimoApiError(`OBS 上传失败 HTTP ${obsRes.status}`, obsRes.status, obsRes.text);
    }

    const cloudGuid = extractGuidFromBody(obsRes.text ?? "", obsRes.json);
    if (!cloudGuid) {
      throw new ShimoApiError("上传成功但未拿到云端文件 guid", obsRes.status, obsRes.text ?? "");
    }

    const info = await this.getFile(cloudGuid);
    const name = typeof info.name === "string" ? info.name : stripMarkdownExt(filename);
    return { guid: cloudGuid, name, url: resolveDocUrl(info, cloudGuid) };
  }

  /**
   * 上传 Markdown 并转成石墨原生文档。
   * 流程：postPolicy + OBS → editImport(type=newdoc) → 轮询 progress。
   */
  async uploadMarkdownDocument(
    markdown: string,
    options: { filename: string; folderGuid: string },
  ): Promise<UploadedFile> {
    const folderGuid = options.folderGuid.trim();
    const uploaded = await this.uploadMarkdownFile(markdown, {
      filename: options.filename,
      folderGuid,
    });
    const cloudGuid = uploaded.guid;

    const importRes = await this.http.request<{
      status?: number;
      message?: string;
      data?: {
        taskId?: string;
        isContentAsync?: boolean;
        file?: { guid?: string; name?: string; url?: string };
      };
    }>(`${API_BASE}/office-gw/files/editImport`, {
      method: "POST",
      body: JSON.stringify({
        originFileGuid: cloudGuid,
        folder: folderGuid,
        type: "newdoc",
        disablePreCreate: 1,
      }),
      contentType: "application/json",
      headers: {
        Accept: "application/nd.shimo.v2+json",
        Referer: `${APP_ORIGIN}/folder/${folderGuid}`,
      },
    });

    if (importRes?.status !== undefined && importRes.status !== 0) {
      throw new ShimoApiError(
        `转换失败：${importRes.message || importRes.status}`,
        200,
        JSON.stringify(importRes).slice(0, 300),
      );
    }

    const taskId = importRes?.data?.taskId;
    if (taskId) {
      await this.waitForImport(taskId);
    }

    const info = await this.getFile(cloudGuid);
    const name = typeof info.name === "string" ? info.name : stripMarkdownExt(options.filename);
    return { guid: cloudGuid, name, url: resolveDocUrl(info, cloudGuid) };
  }

  /**
   * 读取轻文档的完整原生内容（打包 Delta + 当前 rev）。
   *
   * 优先走 GET /lizard-api/files/{guid}/content：和网页同源，直接返回整篇 Delta，
   * 响应头 x-shimo-head / x-shimo-content-length 给出 rev 与字符数。
   * 该接口不可用时退回 /files/{guid}?contentUrl=true 的 OBS 签名地址
   * （部分公司的网络策略/安全软件会拦 OBS 域名，报 ERR_BLOCKED_BY_CLIENT）。
   *
   * 返回的 ops 是整篇文档快照（全部为插入 op），可直接作为覆盖用的新内容。
   */
  async readNativeDocument(guid: string): Promise<NativeDocument> {
    const viaApi = await this.readNativeViaApi(guid);
    if (viaApi) return viaApi;
    return this.readNativeViaContentUrl(guid);
  }

  /** shimo.im 同源的内容接口；失败返回 null 由调用方兜底 */
  private async readNativeViaApi(guid: string): Promise<NativeDocument | null> {
    let res;
    try {
      res = await this.http.requestRaw(`${API_BASE}/files/${encodeURIComponent(guid)}/content`, {
        Accept: "application/nd.shimo.v2+json, text/plain, */*",
        Referer: `${APP_ORIGIN}/docs/${guid}`,
      });
    } catch {
      return null;
    }
    if (res.status < 200 || res.status >= 300) return null;

    const declared = Number(
      res.headers["x-shimo-content-length"] ?? res.headers["x-amz-meta-length"],
    );
    const text = Number.isFinite(declared) && declared > 0 ? res.text.slice(0, declared) : res.text;

    let ops: NativeOp[];
    try {
      ops = parseNativeContent(text);
    } catch {
      return null;
    }
    if (ops.length === 0) return null;

    return {
      guid,
      head: await this.resolveHead(guid, res.headers),
      length: deltaLength(ops),
      ops,
      raw: text,
    };
  }

  private async resolveHead(guid: string, headers: Record<string, string>): Promise<number> {
    const fromHeader = Number(headers["x-shimo-head"] ?? headers["x-amz-meta-head"]);
    if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;

    try {
      const res = await this.http.request<{ head?: number }>(
        `${EDIT_BASE}/files/${encodeURIComponent(guid)}/head`,
        {
          headers: {
            Accept: "application/json",
            Referer: `${APP_ORIGIN}/docs/${guid}`,
          },
        },
      );
      const head = Number(res?.head);
      return Number.isFinite(head) ? head : 0;
    } catch {
      return 0;
    }
  }

  /** 兜底：文件元信息里的 contentUrl（OBS 签名 URL） */
  private async readNativeViaContentUrl(guid: string): Promise<NativeDocument> {
    const info = await this.getFile(guid);
    const contentUrl = typeof info.contentUrl === "string" ? info.contentUrl : "";
    if (!contentUrl) {
      throw new ShimoApiError(
        `无法读取原生内容：文档 ${guid} 没有 contentUrl（可能不是轻文档）`,
        200,
        JSON.stringify(info).slice(0, 300),
      );
    }

    let res;
    try {
      res = await this.http.requestRaw(contentUrl, {
        Accept: "application/nd.shimo.v2+json, text/plain, */*",
        Referer: `${APP_ORIGIN}/docs/${guid}`,
      });
    } catch (err) {
      const host = safeHost(contentUrl);
      throw new ShimoApiError(
        `读取文档正文失败（${host}）：${err instanceof Error ? err.message : String(err)}。` +
          `若提示 ERR_BLOCKED_BY_CLIENT，通常是本机网络策略/安全软件拦截了 OBS 域名`,
        0,
        "",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ShimoApiError(
        describeHttpError(res.status, res.text),
        res.status,
        res.text.slice(0, 300),
      );
    }

    const declaredLength = Number(res.headers["x-amz-meta-length"]);
    const text =
      Number.isFinite(declaredLength) && declaredLength > 0
        ? res.text.slice(0, declaredLength)
        : res.text;
    const ops = parseNativeContent(text);
    const head = Number(res.headers["x-amz-meta-head"]);

    return {
      guid,
      head: Number.isFinite(head) ? head : 0,
      length: deltaLength(ops),
      ops,
      name: typeof info.name === "string" ? info.name : undefined,
      raw: text,
    };
  }

  /**
   * 提交原生 changeset。rev 必须等于 readNativeDocument 返回的 head。
   * 服务端对过期 rev 不一定报错，所以调用方必须自行校验落盘结果。
   */
  async composeDocument(guid: string, rev: number, ops: NativeOp[]): Promise<unknown> {
    return this.http.request(`${EDIT_BASE}/files/${encodeURIComponent(guid)}/compose`, {
      method: "POST",
      body: JSON.stringify({
        rev,
        changeset: JSON.stringify(ops),
        uuid: randomAlnum(32),
        clientId: `${randomAlnum(17)}_obsidian-sync`,
      }),
      contentType: "application/json",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: `${APP_ORIGIN}/docs/${guid}`,
      },
    });
  }

  /**
   * ancestors 末项是文档自身，倒数第二项是父文件夹。
   */
  async getParentFolderGuid(guid: string): Promise<string | null> {
    try {
      const res = await this.http.request<{
        data?: { ancestors?: Array<{ guid?: string; name?: string }> };
      }>(`${PANDA_BASE}/file/files/${encodeURIComponent(guid)}/ancestors`);
      const ancestors = res?.data?.ancestors;
      if (!Array.isArray(ancestors) || ancestors.length < 2) return null;
      const parent = ancestors[ancestors.length - 2];
      const parentGuid = typeof parent?.guid === "string" ? parent.guid : "";
      return parentGuid || null;
    } catch {
      return null;
    }
  }

  /** 删除文档（进回收站）。 */
  async deleteFile(guid: string): Promise<void> {
    const res = await requestUrl({
      url: `${API_BASE}/files/${encodeURIComponent(guid)}`,
      method: "DELETE",
      headers: this.http.baseHeaders({ Accept: "application/nd.shimo.v2+json" }),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ShimoApiError(
        describeHttpError(res.status, res.text ?? ""),
        res.status,
        res.text ?? "",
      );
    }
  }

  private async waitForImport(taskId: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    let progress = 0;
    while (Date.now() < deadline) {
      const p = await this.http.request<{ data?: { progress?: number } }>(
        `${API_BASE}/office-gw/files/editImport/progress?taskId=${encodeURIComponent(taskId)}`,
      );
      progress = Number(p?.data?.progress) || 0;
      if (progress >= 100) return;
      await sleep(1000);
    }
    throw new ShimoApiError("文档转换超时（石墨未在 120 秒内完成）", 200, String(progress));
  }
}
