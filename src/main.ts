import { Notice, Plugin, TFile } from "obsidian";
import { AssetMap, DEFAULT_SETTINGS, ObsidianToShimoSettings, PluginData } from "./settings";
import { ObsidianToShimoSettingTab } from "./settings-tab";
import { getActiveShimoMeta, noteHasShimoTarget } from "./sync/frontmatter";
import { canUpload, syncActiveNote } from "./sync/sync-service";

export default class ObsidianToShimoPlugin extends Plugin {
  settings: ObsidianToShimoSettings = { ...DEFAULT_SETTINGS };
  assetMap: AssetMap = {};

  private ribbonEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    // 左侧功能区始终显示入口；未配置时点击会提示原因（不隐藏按钮）
    this.ribbonEl = this.addRibbonIcon("upload", "上传到石墨", async () => {
      await this.tryUpload();
    });
    this.refreshRibbonState();

    // 一条命令：行为由 frontmatter 的 shimo 指向决定（文件夹=上传，文档=转换覆盖）
    this.addCommand({
      id: "upload-to-shimo",
      name: "上传到石墨",
      callback: async () => {
        await this.tryUpload();
      },
    });

    this.addSettingTab(new ObsidianToShimoSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.refreshRibbonState(file);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const active = this.app.workspace.getActiveFile();
        if (active && file.path === active.path) {
          this.refreshRibbonState(active);
        }
      }),
    );
  }

  onunload(): void {
    this.ribbonEl = null;
  }

  private async tryUpload(): Promise<void> {
    const active = getActiveShimoMeta(this.app);
    if (!canUpload(this.settings, active?.meta ?? null)) {
      if (!this.settings.shimoSid.trim()) {
        new Notice("请先在设置 → Obsidian to Shimo 中配置 shimo_sid");
      } else if (!active) {
        new Notice("当前笔记未配置 shimo 地址（frontmatter 需要 shimo: 文档或文件夹 URL）");
      } else {
        new Notice("当前无法上传，请检查凭证与 shimo 地址");
      }
      return;
    }
    await syncActiveNote(this.syncContext());
  }

  private syncContext() {
    return {
      app: this.app,
      settings: this.settings,
      assetMap: this.assetMap,
      persistAssetMap: async () => this.savePluginData(),
      saveSyncLog: async (log: string) => {
        this.settings.lastSyncLog = log;
        await this.savePluginData();
      },
    };
  }

  private refreshRibbonState(file?: TFile | null): void {
    if (!this.ribbonEl) return;
    const target = file ?? this.app.workspace.getActiveFile();
    const enabled = noteHasShimoTarget(this.app, target) && !!this.settings.shimoSid.trim();
    // 始终可见；未就绪时略微变淡，但不要藏起来
    this.ribbonEl.style.opacity = enabled ? "1" : "0.55";
    this.ribbonEl.style.display = "";
    this.ribbonEl.removeAttribute("aria-disabled");
    this.ribbonEl.setAttribute(
      "aria-label",
      enabled ? "上传到石墨" : "上传到石墨（需配置 shimo_sid 与笔记 shimo 地址）",
    );
  }

  async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.assetMap = { ...(data?.assetMap ?? {}) };
  }

  async savePluginData(): Promise<void> {
    const payload: PluginData = {
      settings: this.settings,
      assetMap: this.assetMap,
    };
    await this.saveData(payload);
    this.refreshRibbonState();
  }
}
