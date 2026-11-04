import { FrontMatterCache, TFile, App } from "obsidian";

export interface NoteShimoMeta {
  /** 石墨文档或文件夹 URL */
  shimoUrl: string;
  title?: string;
  syncAttachments: boolean;
}

export function readShimoMeta(
  frontmatter: FrontMatterCache | undefined | null,
): NoteShimoMeta | null {
  if (!frontmatter) return null;
  const raw = frontmatter.shimo;
  if (typeof raw !== "string" || !raw.trim()) return null;

  const title =
    typeof frontmatter.shimo_title === "string" ? frontmatter.shimo_title.trim() : undefined;
  const syncAttachments =
    frontmatter.shimo_sync_attachments === undefined
      ? true
      : Boolean(frontmatter.shimo_sync_attachments);

  return {
    shimoUrl: raw.trim(),
    title,
    syncAttachments,
  };
}

export function getActiveShimoMeta(app: App): { file: TFile; meta: NoteShimoMeta } | null {
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  const cache = app.metadataCache.getFileCache(file);
  const meta = readShimoMeta(cache?.frontmatter);
  if (!meta) return null;
  return { file, meta };
}

export function noteHasShimoTarget(app: App, file: TFile | null): boolean {
  if (!file) return false;
  const cache = app.metadataCache.getFileCache(file);
  return !!readShimoMeta(cache?.frontmatter);
}
