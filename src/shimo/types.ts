export interface ShimoUser {
  id?: number | string;
  name?: string;
  email?: string;
  teamRole?: string;
  [key: string]: unknown;
}

export interface ShimoFileInfo {
  guid: string;
  name?: string;
  type?: string;
  url?: string;
  isFolder?: boolean;
  is_folder?: boolean;
  isSpace?: boolean;
  contentUrl?: string;
  [key: string]: unknown;
}

export interface ShimoUploadResult {
  url: string;
  raw?: unknown;
}
