// 用插件真实实现（ShimoClient + native-doc）跑一次跨文档覆盖，验证产物代码而非原型脚本
import { loadSid } from "./sid.mjs";

let mod;
try {
  mod = await import("../research-out/plugin-test.mjs");
} catch {
  console.error("缺少 research-out/plugin-test.mjs：先按 scripts/README.md 用 esbuild 构建测试包");
  process.exit(2);
}
const { ShimoClient, buildReplacementOps, deltaLength, nativeSignature, nativeText } = mod;

const folderGuid = process.env.SHIMO_TEST_FOLDER;
if (!folderGuid) throw new Error("请设置 SHIMO_TEST_FOLDER");

// 观察实际走了哪个内容接口（确认不再依赖 OBS）
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const target = String(url);
  if (target.includes("/content")) {
    console.log("[fetch]", target.replace(/\?.*$/, ""), target.includes("obs") ? "(OBS)" : "(shimo-api)");
  }
  return originalFetch(url, init);
};

const client = new ShimoClient(loadSid());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mdA = `# 插件真实实现覆盖测试

段落包含 **加粗**、*斜体*、\`code\` 和 [链接](https://shimo.im)。

## 列表与表格

- 项一
- 项二

| 列A | 列B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |

\`\`\`ts
const a: number = 1;
\`\`\`

> 引用

![图](https://uploader.shimo.im/f/bcU2GgBcDDKzU5Yw.png)
`;

const mdB = `# 待覆盖文档

旧正文，包含一个表格：

| 旧 | 值 |
| --- | --- |
| a | b |
`;

async function waitContent(guid, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const doc = await client.readNativeDocument(guid);
      if (doc.ops.length > 0) return doc;
    } catch {}
    await sleep(1500);
  }
  throw new Error("等待内容超时 " + guid);
}

async function waitSignature(guid, expected, minHead, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let doc = await client.readNativeDocument(guid);
  while (Date.now() < deadline) {
    if (doc.head > minHead && nativeSignature(doc.ops) === expected) return { doc, ok: true };
    await sleep(1500);
    doc = await client.readNativeDocument(guid);
  }
  return { doc, ok: doc.head > minHead && nativeSignature(doc.ops) === expected };
}

const ts = Date.now();
const docs = [];
let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

try {
  const a = await client.uploadMarkdownDocument(mdA, { filename: `e2e-A-${ts}.md`, folderGuid });
  docs.push(a.guid);
  const b = await client.uploadMarkdownDocument(mdB, { filename: `e2e-B-${ts}.md`, folderGuid });
  docs.push(b.guid);
  check("创建临时文档", !!a.guid && !!b.guid, `${a.guid} / ${b.guid}`);

  const aNative = await waitContent(a.guid);
  const bBefore = await waitContent(b.guid);
  check("读取 A 原生内容", aNative.ops.length > 0, `ops=${aNative.ops.length} len=${aNative.length} head=${aNative.head}`);
  check("读取 B 原生内容", bBefore.ops.length > 0, `ops=${bBefore.ops.length} len=${bBefore.length} head=${bBefore.head}`);
  check("B 覆盖前确实是旧内容", nativeText(bBefore.ops).includes("待覆盖文档"));

  const aTables = aNative.ops.filter((op) => op[0] === 30).length;
  check("A 含表格节点", aTables === 1, `tables=${aTables}`);
  check("A 含图片嵌入", JSON.stringify(aNative.ops).includes("gallery"));

  const changeset = buildReplacementOps(bBefore.ops, aNative.ops);
  check("changeset 首 op 为删除全文", changeset[0][0] === 11 && changeset[0][1] === bBefore.length);

  const res = await client.composeDocument(b.guid, bBefore.head, changeset);
  check("compose 请求被接受", !!res, JSON.stringify(res));

  const expected = nativeSignature(aNative.ops);
  const applied = await waitSignature(b.guid, expected, bBefore.head);
  check("内容指纹与 A 完全一致", applied.ok, `head ${bBefore.head} -> ${applied.doc.head}`);
  check("GUID 不变", applied.doc.guid === b.guid);
  check("覆盖后文本正确", nativeText(applied.doc.ops).includes("插件真实实现覆盖测试"));
  check(
    "覆盖后表格数量正确",
    applied.doc.ops.filter((op) => op[0] === 30).length === aTables,
  );

  // 再覆盖一次，确认 rev 递增后仍可用
  const second = buildReplacementOps(applied.doc.ops, bBefore.ops);
  await client.composeDocument(b.guid, applied.doc.head, second);
  const back = await waitSignature(b.guid, nativeSignature(bBefore.ops), applied.doc.head);
  check("二次覆盖（回滚到旧内容）成功", back.ok, `head -> ${back.doc.head}`);
} catch (err) {
  console.error("ERROR", err);
  failures++;
} finally {
  for (const guid of docs) {
    try {
      await client.deleteFile(guid);
      console.log("cleanup", guid, "ok");
    } catch (e) {
      console.log("cleanup", guid, "FAILED", e.message);
    }
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
