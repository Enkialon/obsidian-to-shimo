// 不启动 Obsidian，用 mock 的 obsidian 模块 require 打包后的 main.js 并执行 onload，
// 用来捕捉「插件加载即报错」这类问题（语法错误、顶层引用、onload 异常）。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

class Notice {
  constructor(message) {
    this.message = message;
    console.log("[Notice]", message);
  }
  hide() {}
  setMessage() {}
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.settingTabs = [];
    this.events = [];
  }
  addCommand(cmd) {
    this.commands.push(cmd);
  }
  addSettingTab(tab) {
    this.settingTabs.push(tab);
  }
  registerEvent(ref) {
    this.events.push(ref);
  }
  async loadData() {
    return null;
  }
  async saveData() {}
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}

class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addTextArea() { return this; }
  addButton() { return this; }
  addDropdown() { return this; }
}

class TFile {}
class TextAreaComponent {}

const mockObsidian = {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TextAreaComponent,
  requestUrl: async () => {
    throw new Error("load-check 不应发请求");
  },
};

// 拦截 require("obsidian")
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return mockObsidian;
  return originalLoad.call(this, request, parent, isMain);
};

const written = [];
const app = {
  vault: {
    configDir: ".obsidian",
    adapter: {
      exists: async () => false,
      mkdir: async (dir) => {
        written.push(["mkdir", dir]);
      },
      write: async (path, data) => {
        written.push(["write", path, String(data).length]);
      },
      read: async () => "",
    },
    metadataCache: { getFileCache: () => null },
  },
  workspace: {
    on: () => () => {},
    getActiveFile: () => null,
  },
  fileManager: { processFrontMatter: async () => {} },
};

let failures = 0;
try {
  const mod = require(join(here, "..", "main.js"));
  const PluginClass = mod.default ?? mod;
  console.log("export:", typeof PluginClass, PluginClass?.name || "(anonymous)");
  if (typeof PluginClass !== "function") throw new Error("main.js 没有导出插件类");

  const manifest = JSON.parse(readFileSync(join(here, "..", "manifest.json"), "utf8"));
  const plugin = new PluginClass(app, manifest);
  await plugin.onload();
  console.log(`onload OK：commands=${plugin.commands.length} settingTabs=${plugin.settingTabs.length}`);

  // 触发一次设置页渲染，确认 UI 代码不炸
  const tab = plugin.settingTabs[0];
  if (tab) {
    const el = () => ({
      empty() {},
      addClass() {},
      createEl() {
        return el();
      },
      createDiv() {
        return el();
      },
      createSpan() {
        return el();
      },
      addEventListener() {},
      value: "",
      readOnly: false,
      rows: 0,
    });
    tab.containerEl = el();
    tab.display();
    console.log("设置页 display OK");
  }

  // 备份写入路径
  const path = await plugin.writeBackup("demo.json", '{"ok":true}');
  console.log("writeBackup ->", path, JSON.stringify(written));
  if (!path.endsWith("obsidian-to-shimo/backups/demo.json") || !written.some((w) => w[0] === "write")) {
    throw new Error("备份路径/写入不符合预期");
  }
} catch (err) {
  failures++;
  console.error("LOAD FAILED:", err);
}

console.log(failures === 0 ? "LOAD CHECK PASS" : "LOAD CHECK FAILED");
process.exit(failures === 0 ? 0 : 1);
