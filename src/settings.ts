export type CredentialStatus = "empty" | "configured" | "valid" | "invalid";

export interface ObsidianToShimoSettings {
  /** 浏览器 Cookie 中的 shimo_sid，或完整 Cookie 字符串 */
  shimoSid: string;
  /** 最近一次校验结果 */
  credentialStatus: CredentialStatus;
  /** 最近一次校验成功时的用户名/昵称 */
  accountName: string;
  /** 最近一次校验时间 ISO */
  lastVerifiedAt: string;
  /** 最近一次同步的详细日志（设置页可查看/复制） */
  lastSyncLog: string;
}

export const DEFAULT_SETTINGS: ObsidianToShimoSettings = {
  shimoSid: "",
  credentialStatus: "empty",
  accountName: "",
  lastVerifiedAt: "",
  lastSyncLog: "",
};

/** 本地资源 → 石墨远程 URL 映射（按内容哈希复用，避免重复上传） */
export interface AssetMapEntry {
  hash: string;
  remoteUrl: string;
  updatedAt: string;
  /** 可选：原始 vault 相对路径，便于排查 */
  localPath?: string;
}

export type AssetMap = Record<string, AssetMapEntry>;

export interface PluginData {
  settings: ObsidianToShimoSettings;
  /** key = 内容哈希 */
  assetMap: AssetMap;
}
