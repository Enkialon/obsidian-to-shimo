// 从 data.json 读取插件配置里的 shimo_sid（仅本地研究脚本使用）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadSid() {
  const raw = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
  const sid = raw?.settings?.shimoSid ?? process.env.SHIMO_SID ?? "";
  if (!sid) throw new Error("data.json 中没有 shimoSid");
  return sid.includes("shimo_sid=") ? sid : `shimo_sid=${sid}`;
}

export function cookieHeader() {
  return loadSid();
}

export const ORIGIN = "https://shimo.im";
export const API = "https://shimo.im/lizard-api";

export function baseHeaders(extra = {}) {
  return {
    Accept: "application/vnd.shimo.v2+json, application/json",
    "X-Requested-With": "XMLHttpRequest",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    Cookie: cookieHeader(),
    ...extra,
  };
}

export const rootDir = root;
