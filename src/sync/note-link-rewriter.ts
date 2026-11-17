import { App, TFile } from "obsidian";
import { isShimoDocumentUrl } from "../shimo/url";
import { readShimoMeta } from "./frontmatter";

export interface NoteLinkRewriteResult {
  markdown: string;
  rewritten: number;
  skipped: string[];
}

interface NoteRef {
  raw: string;
  linkpath: string;
  display?: string;
}

/**
 * 上传前改写笔记互链：若目标笔记 frontmatter 已有文档级 shimo 地址，
 * 将 `[[笔记]]` / `[文字](笔记.md)` 替换为 `[标题](石墨URL)`。
 * 仅改写上传用的正文副本，不回写本地 vault。
 */
export function rewriteLinkedNotes(options: {
  app: App;
  sourceFile: TFile;
  markdown: string;
}): NoteLinkRewriteResult {
  const { app, sourceFile } = options;
  let markdown = options.markdown;
  let rewritten = 0;
  const skipped: string[] = [];

  const refs = collectNoteRefs(markdown);
  for (const ref of refs) {
    const target = resolveNoteFile(app, sourceFile, ref.linkpath);
    if (!target) {
      skipped.push(`${ref.linkpath}（未找到本地笔记）`);
      continue;
    }

    const cache = app.metadataCache.getFileCache(target);
    const meta = readShimoMeta(cache?.frontmatter);
    if (!meta) {
      skipped.push(`${target.basename}（无 shimo 地址）`);
      continue;
    }
    if (!isShimoDocumentUrl(meta.shimoUrl)) {
      skipped.push(`${target.basename}（shimo 指向文件夹或无效地址）`);
      continue;
    }

    const title =
      (ref.display && ref.display.trim()) ||
      meta.title ||
      target.basename;
    const safeTitle = title.replace(/[\[\]]/g, "");
    const replacement = `[${safeTitle}](${meta.shimoUrl})`;
    markdown = markdown.split(ref.raw).join(replacement);
    rewritten += 1;
  }

  return { markdown, rewritten, skipped };
}

function collectNoteRefs(markdown: string): NoteRef[] {
  const refs: NoteRef[] = [];
  const seen = new Set<string>();

  // 非图片 wiki 链接：[[path]] / [[path|alias]] / [[path#heading]]
  const wikiRe = /(?<!!)\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(markdown)) !== null) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    const parsed = parseWikiInner(m[1] ?? "");
    if (!parsed.linkpath || isRemoteOrData(parsed.linkpath)) continue;
    // 明显是图片扩展名的双链留给附件处理；这里仍可跳过
    if (looksLikeImagePath(parsed.linkpath)) continue;
    seen.add(raw);
    refs.push({
      raw,
      linkpath: parsed.linkpath,
      display: parsed.alias,
    });
  }

  // 非图片 markdown 链接：[text](path)
  const mdRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
  while ((m = mdRe.exec(markdown)) !== null) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    const display = (m[1] ?? "").trim();
    const path = decodePath(stripHash((m[2] ?? "").replace(/^<|>$/g, "")));
    if (!path || isRemoteOrData(path)) continue;
    if (looksLikeImagePath(path)) continue;
    seen.add(raw);
    refs.push({
      raw,
      linkpath: path,
      display: display || undefined,
    });
  }

  return refs;
}

function parseWikiInner(inner: string): { linkpath: string; alias?: string } {
  const pipe = inner.indexOf("|");
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
  const linkpath = decodePath(stripHash(target));
  return { linkpath, alias: alias || undefined };
}

function stripHash(path: string): string {
  const hash = path.indexOf("#");
  const caret = path.indexOf("^");
  let end = path.length;
  if (hash >= 0) end = Math.min(end, hash);
  if (caret >= 0) end = Math.min(end, caret);
  return path.slice(0, end).trim();
}

function decodePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function isRemoteOrData(path: string): boolean {
  return (
    /^https?:\/\//i.test(path) ||
    path.startsWith("data:") ||
    path.startsWith("app://") ||
    path.startsWith("file://") ||
    path.startsWith("obsidian://")
  );
}

function looksLikeImagePath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext);
}

function resolveNoteFile(app: App, sourceFile: TFile, linkPath: string): TFile | null {
  const dest = app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
  return dest instanceof TFile ? dest : null;
}
