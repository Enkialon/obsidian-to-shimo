// 把插件真实的 TypeScript 实现打成可在 Node 里跑的 ESM（obsidian → mock）
export { ShimoClient } from "../src/shimo/client";
export {
  buildReplacementOps,
  deltaLength,
  nativeSignature,
  nativeText,
} from "../src/shimo/native-doc";
