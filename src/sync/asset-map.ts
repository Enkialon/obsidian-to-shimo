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

/** 浏览器 / Electron 环境下对 ArrayBuffer 做 SHA-256 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
