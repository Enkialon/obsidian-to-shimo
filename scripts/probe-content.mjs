// 只读探针：GET /files/{guid}?contentUrl=true，再拉 contentUrl，打印全部响应头与正文
// 用法: node scripts/probe-content.mjs <guid> [--save]
import { API, ORIGIN, baseHeaders, rootDir } from "./sid.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const guid = process.argv[2];
const save = process.argv.includes("--save");
if (!guid) {
  console.error("usage: node scripts/probe-content.mjs <guid> [--save]");
  process.exit(2);
}

const metaRes = await fetch(`${API}/files/${guid}?contentUrl=true`, { headers: baseHeaders() });
const metaText = await metaRes.text();
console.log(`[meta] HTTP ${metaRes.status} ${metaRes.headers.get("content-type")}`);
console.log(metaText.slice(0, 1500));
if (!metaRes.ok) process.exit(1);

let meta;
try {
  meta = JSON.parse(metaText);
} catch {
  console.error("meta 不是 JSON");
  process.exit(1);
}
const contentUrl = meta?.contentUrl ?? meta?.data?.contentUrl;
console.log(`\n[meta] contentUrl = ${contentUrl}`);
console.log(`[meta] name=${meta?.name} type=${meta?.type} url=${meta?.url}`);

// 额外打印所有像 head/rev/version 的字段
const flat = {};
(function walk(o, p = "") {
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    if (/rev|head|version|length|size|guid/i.test(k) && (typeof v !== "object" || v === null)) {
      flat[`${p}${k}`] = v;
    }
    if (v && typeof v === "object" && p.length < 40) walk(v, `${p}${k}.`);
  }
})(meta);
console.log("[meta] rev-ish fields:", flat);

if (!contentUrl) {
  console.log("\n没有 contentUrl，跳过正文拉取");
  process.exit(0);
}

const u = new URL(contentUrl, ORIGIN);
console.log(`\n[content] GET ${u.origin}${u.pathname}?${[...u.searchParams.keys()].join("&")}`);
const res = await fetch(u.toString(), {
  headers: baseHeaders({
    Accept: "application/nd.shimo.v2+json, text/plain, */*",
    Referer: `${ORIGIN}/docs/${guid}`,
  }),
});
const body = await res.text();
console.log(`[content] HTTP ${res.status} ${res.headers.get("content-type")} len=${body.length}`);
console.log("[content] headers:");
for (const [k, v] of res.headers.entries()) console.log(`  ${k}: ${v}`);
console.log("\n[content] body head 3000:");
console.log(body.slice(0, 3000));

if (save) {
  mkdirSync(join(rootDir, "research-out"), { recursive: true });
  const f = join(rootDir, "research-out", `${guid}.content.txt`);
  writeFileSync(f, body, "utf8");
  console.log(`\n[save] ${f}`);
}
