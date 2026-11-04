export interface MultipartPart {
  name: string;
  text?: string;
  filename?: string;
  contentType?: string;
  data?: ArrayBuffer;
}

/** 组装 multipart/form-data；OBS 要求 file 字段放最后 */
export function buildMultipart(boundary: string, parts: MultipartPart[]): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();

  for (const part of parts) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    if (part.filename && part.data) {
      chunks.push(
        enc.encode(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`,
        ),
      );
      chunks.push(new Uint8Array(part.data));
      chunks.push(enc.encode("\r\n"));
    } else {
      chunks.push(
        enc.encode(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.text ?? ""}\r\n`,
        ),
      );
    }
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
