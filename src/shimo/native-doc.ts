/**
 * 石墨轻文档（newdoc）原生内容 = 打包后的 Delta。
 *
 * 内容接口（GET /files/{guid}，再取返回的 contentUrl）拿到的是整篇文档的快照：
 *   ops = [[code, data, attributes?], ...]
 *   code = packId * 10 + action，action：0 插入 / 1 删除 / 2 保留
 *   packId：1 通用 Operator、2 文本、3 表格、4 单元格
 *
 * 快照里只有插入 op，所以「把 A 覆盖到 B」的 changeset 可以完全照抄 A 的插入 op，
 * 只需在开头补一条「删除 B 全文」：[[11, B.length], ...A.ops]。
 * 这样不需要实现 Markdown → 石墨节点的转换器，也不需要浏览器。
 */

export type NativeOp = [number, unknown, string?];

/** 通用 Operator 的 delete：packId 1 * 10 + action 1 */
export const OP_REMOVE_GENERIC = 11;

export interface NativeDocument {
  guid: string;
  /** 当前修订号；compose 的 rev 必须等于它 */
  head: number;
  /** 正文长度（字符数，嵌入/表格按 1 个位置计） */
  length: number;
  ops: NativeOp[];
  name?: string;
  /** 原始打包文本，便于备份/排查 */
  raw: string;
}

function isOpCode(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function actionOf(code: number): number {
  return code % 10;
}

/** 解析内容接口返回的打包 Delta；不是数组说明不是轻文档原生内容 */
export function parseNativeContent(raw: string): NativeOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`原生内容不是 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("原生内容不是 Delta 数组（可能是旧版文档，暂不支持原地覆盖）");
  }

  return parsed.map((op, index) => {
    if (!Array.isArray(op) || op.length < 2 || !isOpCode(op[0])) {
      throw new Error(`原生内容第 ${index} 个 op 结构异常`);
    }
    return op as NativeOp;
  });
}

/** 单个 op 占用的位置数：文本取字符数，数字取数值，表格/嵌入算 1 */
export function opLength(op: NativeOp): number {
  const data = op[1];
  if (typeof data === "string") return data.length;
  if (typeof data === "number") return data;
  return 1;
}

export function deltaLength(ops: NativeOp[]): number {
  let total = 0;
  for (const op of ops) total += opLength(op);
  return total;
}

/**
 * 构造「用 next 覆盖当前文档」的 changeset。
 * 先删掉当前全文，再插入 next 的全部插入 op。
 */
export function buildReplacementOps(current: NativeOp[], next: NativeOp[]): NativeOp[] {
  const inserts = next.filter((op) => actionOf(op[0]) === 0);
  if (inserts.length === 0) {
    throw new Error("新文档没有任何可插入内容");
  }

  const removeLength = deltaLength(current);
  const head: NativeOp = [OP_REMOVE_GENERIC, removeLength];
  return removeLength > 0 ? [head, ...inserts] : inserts;
}

/**
 * 与属性无关的内容指纹：正文文本 + 表格单元格文本 + 嵌入资源标识。
 * 用于 compose 之后校验服务端是否真的落盘成新内容（属性可能被服务端规整，故不参与比较）。
 */
export function nativeSignature(ops: NativeOp[]): string {
  const parts: string[] = [];
  for (const op of ops) {
    if (actionOf(op[0]) !== 0) continue;
    parts.push(dataSignature(op[1]));
  }
  return parts.join("");
}

/** 人读用：正文文本（表格/嵌入以占位符表示） */
export function nativeText(ops: NativeOp[]): string {
  let text = "";
  for (const op of ops) {
    const action = actionOf(op[0]);
    const data = op[1];
    if (action === 0) {
      if (typeof data === "string") text += data;
      else if (isTableData(data)) text += "[表格]";
      else text += "[嵌入]";
    } else if (action === 2 && typeof data === "string") {
      text += data;
    }
  }
  return text;
}

function isTableData(data: unknown): boolean {
  return Array.isArray(data) && data.length >= 1 && isPlainObject(data[0]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function dataSignature(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof data === "number") return `#${data}`;

  if (Array.isArray(data)) {
    // 文本 op：[code, data, attributes?]，属性不参与比较
    if (typeof data[0] === "number") {
      const action = data[0] % 10;
      if (action !== 0) return "";
      return dataSignature(data[1]);
    }
    // 表格 op 的 data：[cells, rows, cols]
    if (isTableData(data)) {
      const cells = data[0] as Record<string, unknown>;
      const keys = Object.keys(cells).sort();
      return `[table:${keys.map((key) => `${key}=${dataSignature(cells[key])}`).join(";")}]`;
    }
    return data.map((item) => dataSignature(item)).join("");
  }

  if (isPlainObject(data)) {
    const keys = Object.keys(data).sort();
    return `{${keys
      .map((key) => `${key}=${dataSignature(data[key])}`)
      .join(";")}}`;
  }

  return "";
}
