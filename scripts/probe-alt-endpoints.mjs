// 探测 shimo.im 域名下是否有可替代 OBS 的内容读取接口（只读 GET）
import { baseHeaders } from "./sid.mjs";

const guid = process.argv[2] ?? "VMAPLOBvWehR0vAg";
const candidates = [
  `https://shimo.im/edit/files/${guid}/head`,
  `https://shimo.im/edit/files/${guid}/pull?rev=0`,
  `https://shimo.im/edit/files/${guid}/pull?rev=1`,
  `https://shimo.im/lizard-api/files/${guid}/content`,
  `https://shimo.im/lizard-api/files/${guid}/content?rev=0`,
  `https://shimo.im/lizard-api/files/${guid}/export`,
  `https://shimo.im/lizard-api/office-gw/files/${guid}/content`,
  `https://shimo.im/edit/files/${guid}/csHistories`,
];

for (const url of candidates) {
  try {
    const res = await fetch(url, {
      headers: baseHeaders({
        Accept: "application/json, text/plain, */*",
        Referer: `https://shimo.im/docs/${guid}`,
      }),
    });
    const text = await res.text();
    console.log(`\n${res.status} ${url}\n  ${text.slice(0, 300).replace(/\n/g, "\\n")}`);
  } catch (e) {
    console.log(`\nERR ${url}\n  ${e.message}`);
  }
}
