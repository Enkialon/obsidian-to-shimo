# 研究与验证脚本

只用于本地验证石墨接口，**不参与插件构建**（esbuild 只打包 `src/main.ts`）。

共同约定：

- 凭证从 `data.json` 的 `settings.shimoSid` 读取（`sid.mjs`），不落盘、不打印
- 只操作临时文档，验证完删除；不会碰 frontmatter 指向的真实文档
- 需要把临时文档放进某个石墨文件夹时，设置 `SHIMO_TEST_FOLDER=<folder guid>`

## 脚本

| 脚本 | 作用 |
|------|------|
| `load-check.mjs` | 用 mock 的 `obsidian` 模块 require 打包后的 `main.js` 并执行 `onload`，捕获「插件加载即报错」 |
| `demo-import.mjs` | 对比「只上传 md 的云文件」与 `editImport` 转换后的 `newdoc`，并打印原生 op（需要 `SHIMO_TEST_FOLDER`） |
| `plugin-e2e.mjs` | 用**插件真实代码**创建 A/B → 覆盖 B → 校验内容指纹 → 二次覆盖 → 清理 |
| `native-doc-unit.mjs` | `native-doc.ts` 纯函数断言（长度、changeset、内容指纹） |
| `probe-content.mjs <guid>` | 只读：走 `contentUrl`（OBS）打印正文与响应头 |
| `probe-content-endpoint.mjs <guid>` | 对比 `/lizard-api/files/{guid}/content` 与 OBS 快照 |
| `probe-alt-endpoints.mjs <guid>` | 只读：探测 shimo.im 域名下的内容/版本接口 |

## 跑测试

```bash
npm run verify        # 语法检查 + load-check（不需要网络）
```

`plugin-e2e.mjs` / `native-doc-unit.mjs` 依赖一个用 mock `obsidian` 打出来的测试包：

```bash
npx esbuild scripts/plugin-test-entry.ts --bundle --platform=node --format=esm \
  --alias:obsidian=./scripts/mock-obsidian.mjs --outfile=research-out/plugin-test.mjs

SHIMO_TEST_FOLDER=<folder guid> node scripts/plugin-e2e.mjs
node scripts/native-doc-unit.mjs
```

`research-out/` 是临时产物目录（已 gitignore），可以随时删掉重建。
