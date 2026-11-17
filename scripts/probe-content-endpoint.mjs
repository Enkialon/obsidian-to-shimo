// 验证 /lizard-api/files/{guid}/content 与 OBS contentUrl 内容一致，并确认 head 来源
import { API, baseHeaders, ORIGIN } from "./sid.mjs";

const guid = process.argv[2] ?? "VMAPLOBvWehR0vAg";

const apiRes = await fetch(`${API}/files/${guid}/content`, {
  headers: baseHeaders({ Accept: "application/nd.shimo.v2+json, text/plain, */*", Referer: `${ORIGIN}/docs/${guid}` }),
});
const apiText = await apiRes.text();
console.log("content endpoint:", apiRes.status, "len", apiText.length);
console.log("headers:", Object.fromEntries([...apiRes.headers].filter(([k]) => /head|length|type|etag/i.test(k))));

const headRes = await fetch(`${ORIGIN}/edit/files/${guid}/head`, {
  headers: baseHeaders({ Accept: "application/json", Referer: `${ORIGIN}/docs/${guid}` }),
});
const headBody = await headRes.text();
console.log("head endpoint:", headRes.status, headBody.slice(0, 200));

const metaRes = await fetch(`${API}/files/${guid}?contentUrl=true`, { headers: baseHeaders() });
const meta = await metaRes.json();
const obsRes = await fetch(meta.contentUrl, {
  headers: baseHeaders({ Accept: "application/nd.shimo.v2+json, text/plain, */*", Referer: `${ORIGIN}/docs/${guid}` }),
});
const obsText = await obsRes.text();
const obsLen = Number(obsRes.headers.get("x-amz-meta-length")) || obsText.length;
const obsSlice = obsText.slice(0, obsLen);
console.log("obs:", obsRes.status, "len", obsSlice.length, "head", obsRes.headers.get("x-amz-meta-head"));
console.log("same text:", apiText === obsSlice);
try {
  console.log("same ops:", JSON.stringify(JSON.parse(apiText)) === JSON.stringify(JSON.parse(obsSlice)));
} catch (e) {
  console.log("parse error", e.message);
}
