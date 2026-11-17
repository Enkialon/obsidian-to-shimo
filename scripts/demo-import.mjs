// 演示：Markdown 上传后「云文件」与 editImport 转换后的「原生轻文档」差别
// 用法: SHIMO_TEST_FOLDER=<folder guid> node scripts/demo-import.mjs
import { ShimoClient } from "../research-out/plugin-test.mjs";
import { loadSid } from "./sid.mjs";

let ShimoClientImpl = ShimoClient;
if (!ShimoClientImpl) {
  console.error("缺少 research-out/plugin-test.mjs，先按 scripts/README.md 构建");
  process.exit(2);
}

const folderGuid = process.env.SHIMO_TEST_FOLDER;
if (!folderGuid) throw new Error("请设置 SHIMO_TEST_FOLDER=<folder guid>");

const client = new ShimoClientImpl(loadSid());
const stamp = Date.now();

const md = `# 一级标题

普通段落，包含 **加粗**、*斜体*、\`行内代码\` 和 [链接](https://shimo.im)。

## 二级标题

- 无序一
- 无序二

1. 有序一
2. 有序二

> 引用一行

| 列A | 列B |
| --- | --- |
| 1 | 2 |

\`\`\`js
console.log(1);
\`\`\`

![](https://uploader.shimo.im/f/bcU2GgBcDDKzU5Yw.png)
`;

const docs = [];
try {
  console.log("== 1. 只上传 Markdown（postPolicy + OBS），不转换 ==");
  const cloud = await client.uploadMarkdownFile(md, {
    filename: `demo-cloud-${stamp}.md`,
    folderGuid,
  });
  docs.push(cloud.guid);
  const cloudMeta = await client.getFile(cloud.guid);
  console.log("guid:", cloud.guid);
  console.log("type:", cloudMeta.type, "| name:", cloudMeta.name, "| url:", cloudMeta.url);
  console.log("有 contentUrl:", Boolean(cloudMeta.contentUrl));

  console.log("\n== 2. editImport 转换（type=newdoc） ==");
  const doc = await client.uploadMarkdownDocument(md, {
    filename: `demo-native-${stamp}.md`,
    folderGuid,
  });
  docs.push(doc.guid);
  const docMeta = await client.getFile(doc.guid);
  console.log("guid:", doc.guid);
  console.log("type:", docMeta.type, "| name:", docMeta.name, "| url:", docMeta.url);

  console.log("\n== 3. 读转换后的原生内容（全部 op） ==");
  const native = await client.readNativeDocument(doc.guid);
  console.log(`head=${native.head} length=${native.length} ops=${native.ops.length}`);
  native.ops.forEach((op, i) => {
    const code = op[0];
    const action = ["插入", "删除", "保留"][code % 10] ?? "?";
    const data = op[1];
    const attr = op[2] ?? "";
    let dataText;
    if (typeof data === "string") dataText = JSON.stringify(data.length > 24 ? data.slice(0, 24) + "…" : data);
    else if (Array.isArray(data)) {
      const cellKeys = data[0] && typeof data[0] === "object" ? Object.keys(data[0]).length : 0;
      dataText = `[表格 data：${cellKeys} 个单元格]`;
    } else dataText = JSON.stringify(data);
    console.log(`  #${String(i).padStart(2, "0")} [${code}] ${action} ${dataText}${attr ? `  attrs=${attr}` : ""}`);
  });
} finally {
  for (const guid of docs) {
    try {
      await client.deleteFile(guid);
      console.log("cleanup", guid, "ok");
    } catch (e) {
      console.log("cleanup", guid, "failed", e.message);
    }
  }
}
