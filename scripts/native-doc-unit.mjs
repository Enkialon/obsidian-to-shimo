// 对 native-doc 纯函数做最小断言（用合成 ops，不访问网络）
let mod;
try {
  mod = await import("../research-out/plugin-test.mjs");
} catch {
  console.error("缺少 research-out/plugin-test.mjs：先按 scripts/README.md 用 esbuild 构建测试包");
  process.exit(2);
}
const { buildReplacementOps, deltaLength, nativeSignature, nativeText } = mod;

let failures = 0;
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`, ok ? "" : `\n  actual=${JSON.stringify(actual)}\n  expect=${JSON.stringify(expected)}`);
  if (!ok) failures++;
};

const cur = [
  [20, "abc", '26:"1"'],
  [20, "\n", '24:"0000"'],
];
const table = [
  30,
  [
    { A1: [40, [[20, "c", '26:"2"'], [20, "\n", '24:"0001"']], '25:"000000"'] },
    [[10, 1]],
    [[10, 1]],
  ],
  'author-block:"2"',
];
const next = [[20, "xyz", '26:"2"'], table, [20, "\n", '24:"1111"']];

eq("deltaLength 按字符数累计", deltaLength(cur), 4);
const cs = buildReplacementOps(cur, next);
eq("首 op 是删除当前全文", cs[0], [11, 4]);
eq("其后是 next 的插入 op", cs.slice(1), next);
eq("签名与属性无关", nativeSignature([[20, "abc", "attr-a"]]), nativeSignature([[20, "abc", "attr-b"]]));
eq("表格计入签名", nativeSignature([table]).startsWith("[table:A1="), true);
eq("正文文本", nativeText(next), "xyz[表格]\n");
eq("空文档不产生删除 op", buildReplacementOps([], next), next);

console.log(failures === 0 ? "ALL PASS" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
