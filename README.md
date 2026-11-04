# Obsidian → 石墨文档 同步插件

把 Obsidian 笔记一键同步到石墨（个人版 / 团队空间）。在笔记 frontmatter 配置 `shimo` 后点击上传即可；插件根据目标是文件夹还是文档自动选择路径。

## 背景

部门用石墨协作，日常写作在 Obsidian。希望：

- frontmatter 绑定石墨地址；**未绑定则不上传**
- 一键同步到远程
- 图片 / Excalidraw 自动处理，内容未变则复用已有资源
- 通过粘贴浏览器 `shimo_sid` 鉴权（个人版暂无官方开放 API）

## 核心能力

| 能力 | 说明 |
|------|------|
| 元数据绑定 | frontmatter `shimo` 指向文档或文件夹 |
| 自动分流 | 文件夹 → 上传 md；文档 → 转换覆盖 |
| 附件复用 | 按内容 SHA-256 映射远程 URL |
| 配置页鉴权 | 粘贴 `shimo_sid`，校验 `/users/me` |

## 使用方式

### 1. 安装（开发版）

```bash
npm install
npm run build
```

将 `main.js` / `manifest.json` / `styles.css` 放到：

```
<你的库>/.obsidian/plugins/obsidian-to-shimo/
```

### 2. 配置 shimo_sid

1. 浏览器打开 https://shimo.im 并登录
2. F12 → Cookies → `shimo_sid`
3. Obsidian → 设置 → Obsidian to Shimo → 粘贴 →「校验」

### 3. 绑定目标

`shimo` 指向什么，决定行为——**无需额外配置**：

```yaml
# 文件夹 → 上传 md（不转换）
---
shimo: https://shimo.im/folder/47kgMDvBPduxba3V
---

# 文档 → 转换覆盖（保留 Markdown 排版）
---
shimo: https://shimo.im/docs/xxxxxxxx
---
```

可选：

```yaml
shimo_title: 同步后的标题
shimo_sync_attachments: true
```

### 4. 上传

功能区图标或命令「上传到石墨」：

1. `GET /files/{guid}` 判断文件夹 / 文档
2. 处理附件（文件夹模式跳过）
3. 按目标类型写入石墨
4. Notice 提示结果

## 自动识别

| 目标 | 判定 | 行为 |
|------|------|------|
| 文件夹 | `isFolder` / `url` 以 `/folder/` 开头 | `postPolicy` 上传 `.md` 云文件 |
| 文档 | 其它 | 上传 → `editImport` 转原生文档 → 删旧 → 回写 frontmatter |

转换落在旧文档同级目录（`/panda-api/.../ancestors` 推导），并轮询 progress，最长 120 秒。

## 项目结构

```
src/
  main.ts                 # 入口、命令、功能区
  settings.ts             # 设置与 assetMap 类型
  settings-tab.ts         # 设置页
  shimo/
    index.ts              # 对外导出
    client.ts             # 石墨 API（上传 / 转换 / 删除）
    http.ts               # Cookie 请求封装
    errors.ts             # ShimoApiError
    multipart.ts          # OBS multipart
    upload-token.ts       # 附件 token 解析
    util.ts               # 文件名 / URL 等小工具
    url.ts                # 解析 guid
    types.ts
  sync/
    sync-service.ts       # 同步主流程（文件夹 / 转换两条路径）
    frontmatter.ts        # 读取 shimo 元数据
    asset-map.ts          # 哈希映射
    asset-processor.ts    # 附件处理
    logger.ts
```

## 接口要点

**文件夹上传**

1. `POST /lizard-api/files/upload/postPolicy`（`x-file-parent-guid`）
2. multipart 上传到 OBS

**文档转换覆盖**

1–2 同上，再：

3. `POST /lizard-api/office-gw/files/editImport`（`type=newdoc`）
4. 轮询 `/editImport/progress`
5. `DELETE /lizard-api/files/{旧guid}`，回写 `shimo`

**附件**

1. `POST https://uploader.shimo.im/token?isAWSDirect=true`（bucket=`images`）
2. multipart 上传 OBS → 公开地址 `uploader.shimo.im/f/...`

## 已知限制

- 转换覆盖时附件以旧 guid 为宿主，旧文档删除后图片链接会失效
- 文件夹模式不处理附件、同名不覆盖（会堆副本）
- 个人版接口可能随官网变更

## 开发状态

`0.1.0`：设置页 + 门控上传 + 目标自动识别 + 附件复用。
