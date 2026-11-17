// 研究/测试用：在没有 Obsidian 运行时的情况下模拟 requestUrl。
// 仅供 scripts/plugin-e2e.mjs 通过 esbuild alias 注入，不进入插件产物。
export async function requestUrl(params) {
  const { url, method = "GET", headers = {}, body, throw: shouldThrow = true } = params;
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  const resHeaders = {};
  res.headers.forEach((value, key) => {
    resHeaders[key.toLowerCase()] = value;
  });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (shouldThrow && !res.ok) {
    const err = new Error(`Request failed, status ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return {
    status: res.status,
    headers: resHeaders,
    text,
    json,
    arrayBuffer: new TextEncoder().encode(text).buffer,
  };
}

export class Notice {
  constructor(message) {
    this.message = message;
  }
  hide() {}
  setMessage() {}
}
