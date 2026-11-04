import { App, TFile } from "obsidian";

export interface RenderedImage {
  bytes: ArrayBuffer;
  filename: string;
  mime: string;
}

export interface RenderAttempt {
  image: RenderedImage | null;
  /** 失败原因（成功时为空） */
  error?: string;
}

/** Minimal surface of ExcalidrawAutomate we rely on. */
type ExcalidrawAutomateLike = {
  reset: () => void;
  getAPI?: (view?: unknown) => ExcalidrawAutomateLike;
  isExcalidrawFile?: (f: TFile) => boolean;
  getSceneFromFile: (file: TFile) => Promise<{ elements: unknown[]; appState?: unknown }>;
  copyViewElementsToEAforEditing: (elements: unknown[], copyImages?: boolean) => void;
  createPNG: (
    templatePath?: string,
    scale?: number,
    exportSettings?: unknown,
    loader?: unknown,
    theme?: string,
    padding?: number,
  ) => Promise<unknown>;
  createPNGBase64?: (
    templatePath?: string,
    scale?: number,
    exportSettings?: unknown,
    loader?: unknown,
    theme?: string,
    padding?: number,
  ) => Promise<string | { dataURL?: string; base64?: string } | unknown>;
};

function getGlobalEA(): ExcalidrawAutomateLike | null {
  const w = window as unknown as {
    ExcalidrawAutomate?: ExcalidrawAutomateLike;
    ea?: ExcalidrawAutomateLike;
  };
  return w.ExcalidrawAutomate ?? w.ea ?? null;
}

export function isExcalidrawAvailable(): boolean {
  return !!getGlobalEA();
}

export function isExcalidrawPath(pathOrSrc: string): boolean {
  const lower = pathOrSrc.toLowerCase();
  return lower.includes(".excalidraw");
}

export function isExcalidrawFile(file: TFile): boolean {
  const ea = getGlobalEA();
  if (ea?.isExcalidrawFile) {
    try {
      if (ea.isExcalidrawFile(file)) return true;
    } catch {
      // fall through
    }
  }
  return isExcalidrawPath(file.path) || isExcalidrawPath(file.name);
}

/**
 * 通过 ExcalidrawAutomate 把绘图渲成 PNG。
 * createPNG 在不同版本可能返回 Blob / Canvas / 其它，这里统一转成 ArrayBuffer。
 */
export async function renderExcalidrawFile(
  file: TFile,
  pngScale = 2,
): Promise<RenderAttempt> {
  const globalEa = getGlobalEA();
  if (!globalEa) {
    return { image: null, error: "未找到 window.ExcalidrawAutomate（请启用 Excalidraw 插件）" };
  }

  const ea = globalEa.getAPI ? globalEa.getAPI() : globalEa;

  try {
    ea.reset();
    const scene = await ea.getSceneFromFile(file);
    if (!scene?.elements?.length) {
      return { image: null, error: "绘图场景为空或无法读取" };
    }

    ea.copyViewElementsToEAforEditing(scene.elements, true);

    let bytes: ArrayBuffer | null = null;
    let lastError = "";

    try {
      const png = await ea.createPNG(undefined, pngScale);
      bytes = await coerceToArrayBuffer(png);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (!bytes && ea.createPNGBase64) {
      try {
        const b64 = await ea.createPNGBase64(undefined, pngScale);
        bytes = await coerceToArrayBuffer(b64);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!bytes || bytes.byteLength === 0) {
      return {
        image: null,
        error: lastError || "createPNG 未能得到有效图片数据",
      };
    }

    const stem = file.basename.replace(/\.excalidraw$/i, "") || "excalidraw";
    return {
      image: {
        bytes,
        filename: `${stem}.png`,
        mime: "image/png",
      },
    };
  } catch (err) {
    return {
      image: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      ea.reset();
    } catch {
      // ignore
    }
  }
}

/** 把 EA / vault 各种返回值收成可哈希、可上传的 ArrayBuffer */
export async function coerceToArrayBuffer(data: unknown): Promise<ArrayBuffer> {
  if (data == null) {
    throw new Error("空的图片数据");
  }
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return copy.buffer as ArrayBuffer;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer();
  }
  if (typeof HTMLCanvasElement !== "undefined" && data instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob>((resolve, reject) => {
      data.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 失败"))),
        "image/png",
      );
    });
    return blob.arrayBuffer();
  }
  if (typeof data === "string") {
    return decodeDataUrlOrBase64(data);
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.dataURL === "string") return decodeDataUrlOrBase64(obj.dataURL);
    if (typeof obj.base64 === "string") return decodeDataUrlOrBase64(obj.base64);
    if (typeof obj.data === "string") return decodeDataUrlOrBase64(obj.data);
    if (obj.blob instanceof Blob) return obj.blob.arrayBuffer();
    if (typeof obj.arrayBuffer === "function") {
      const buf = await (obj.arrayBuffer as () => Promise<ArrayBuffer>)();
      return coerceToArrayBuffer(buf);
    }
  }
  throw new Error(`无法识别的图片数据类型：${Object.prototype.toString.call(data)}`);
}

function decodeDataUrlOrBase64(raw: string): ArrayBuffer {
  const trimmed = raw.trim();
  const dataUrl = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  const b64 = dataUrl ? dataUrl[2] : trimmed.replace(/^base64,/i, "");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** 在同目录找 Excalidraw 已导出的预览图 */
export function findExcalidrawSidecar(app: App, file: TFile): TFile | null {
  const folder = file.parent;
  if (!folder) return null;

  const basename = file.basename;
  const stem = basename.replace(/\.excalidraw$/i, "");
  const candidates = [
    `${stem}.light.svg`,
    `${stem}.dark.svg`,
    `${stem}.svg`,
    `${stem}.png`,
    `${basename}.light.svg`,
    `${basename}.dark.svg`,
    `${basename}.svg`,
    `${basename}.png`,
  ];

  for (const name of candidates) {
    const candidate = app.vault.getAbstractFileByPath(`${folder.path}/${name}`);
    if (candidate instanceof TFile) return candidate;
  }
  return null;
}
