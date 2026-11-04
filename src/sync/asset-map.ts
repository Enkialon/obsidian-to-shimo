import { AssetMap, AssetMapEntry } from "../settings";

export class AssetMapStore {
  constructor(private map: AssetMap) {}

  get raw(): AssetMap {
    return this.map;
  }

  findByHash(hash: string): AssetMapEntry | undefined {
    return this.map[hash];
  }

  upsert(hash: string, remoteUrl: string, localPath?: string): void {
    this.map[hash] = {
      hash,
      remoteUrl,
      localPath,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** 浏览器 / Electron 环境下对二进制做 SHA-256（兼容 ArrayBuffer / TypedArray） */
export async function sha256Hex(data: ArrayBuffer | ArrayBufferView): Promise<string> {
  const buf = toDigestSource(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toDigestSource(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer as ArrayBuffer;
  }
  throw new Error(
    `sha256Hex 需要 ArrayBuffer，实际是 ${Object.prototype.toString.call(data)}`,
  );
}
