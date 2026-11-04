import { Notice, Plugin, TFile } from "obsidian";
import { AssetMap, DEFAULT_SETTINGS, ObsidianToShimoSettings, PluginData } from "./settings";
import { ObsidianToShimoSettingTab } from "./settings-tab";
import { isExcalidrawPath } from "./sync/excalidraw";
import { getActiveShimoMeta, noteHasShimoTarget, readShimoMeta } from "./sync/frontmatter";
import { canUpload, syncActiveNote, syncNote } from "./sync/sync-service";

export default class ObsidianToShimoPlugin extends Plugin {
  settings: ObsidianToShimoSettings = { ...DEFAULT_SETTINGS };
  assetMap: AssetMap = {};

  private ribbonEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.ribbonEl = this.addRibbonIcon("upload", "上传到石墨", async () => {
      await this.tryUpload();
    });
    this.refreshRibbonState();

    this.addCommand({
      id: "upload-to-shimo",
      name: "上传到石墨",
      callback: async () => {
        await this.tryUpload();
      },
    });

    // 文件资源管理器右键 / 标签右键，与导出插件同级入口
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (isExcalidrawPath(file.path)) return;

        menu.addItem((item) => {
          item
            .setTitle("上传到石墨")
            .setIcon("upload")
            .onClick(() => {
              void this.tryUploadFile(file);
            });
        });
      }),
    );

    // 编辑器内右键菜单
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        menu.addItem((item) => {
          item
            .setTitle("上传到石墨")
            .setIcon("upload")
            .onClick(() => {
              void this.tryUpload();
            });
        });
      }),
    );

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
    if (!this.ensureCanUpload(active?.meta ?? null, !!this.app.workspace.getActiveFile())) {
      return;
    }
    await syncActiveNote(this.syncContext());
  }

  private async tryUploadFile(file: TFile): Promise<void> {
    const cache = this.app.metadataCache.getFileCache(file);
    const meta = readShimoMeta(cache?.frontmatter);
    if (!this.ensureCanUpload(meta, true)) return;
    await syncNote(this.syncContext(), file);
  }

  private ensureCanUpload(
    meta: ReturnType<typeof readShimoMeta>,
    hasFile: boolean,
  ): boolean {
    if (!canUpload(this.settings, meta)) {
      if (!this.settings.shimoSid.trim()) {
        new Notice("请先在设置 → Obsidian to Shimo 中配置 shimo_sid");
      } else if (!hasFile) {
        new Notice("没有打开的笔记");
      } else if (!meta) {
        new Notice("当前笔记未配置 shimo 地址（frontmatter 需要 shimo: 文档或文件夹 URL）");
      } else {
        new Notice("当前无法上传，请检查凭证与 shimo 地址");
      }
      return false;
    }
    return true;
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
