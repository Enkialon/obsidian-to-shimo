import { App, Notice, PluginSettingTab, Setting, TextAreaComponent } from "obsidian";
import type ObsidianToShimoPlugin from "./main";
import { ShimoApiError, ShimoClient } from "./shimo";

export class ObsidianToShimoSettingTab extends PluginSettingTab {
  plugin: ObsidianToShimoPlugin;

  constructor(app: App, plugin: ObsidianToShimoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ots-settings");

    containerEl.createEl("h2", { text: "Obsidian → 石墨" });

    containerEl.createEl("p", {
      cls: "ots-hint",
      text:
        "个人版暂无官方开放 API。请从已登录的石墨网页复制 Cookie 中的 shimo_sid，粘贴到下方。" +
        "凭证仅保存在本地 Obsidian 配置中。",
    });

    let textarea: TextAreaComponent;
    new Setting(containerEl)
      .setName("shimo_sid")
      .setDesc("浏览器开发者工具 → Application/存储 → Cookies → shimo.im → shimo_sid")
      .addTextArea((text) => {
        textarea = text;
        text.inputEl.addClass("ots-token-input");
        text.setPlaceholder("粘贴 shimo_sid，或完整 Cookie 字符串（含 shimo_sid=）");
        text.setValue(this.plugin.settings.shimoSid);
        text.onChange(async (value) => {
          this.plugin.settings.shimoSid = value.trim();
          this.plugin.settings.credentialStatus = value.trim() ? "configured" : "empty";
          this.plugin.settings.accountName = "";
          await this.plugin.savePluginData();
          this.renderStatus(statusEl);
        });
      });

    const statusEl = containerEl.createDiv({ cls: "ots-status" });
    this.renderStatus(statusEl);

    new Setting(containerEl)
      .setName("校验凭证")
      .setDesc("调用石墨 /users/me 验证当前 shimo_sid 是否有效")
      .addButton((btn) =>
        btn.setButtonText("校验").onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.verify();
            this.renderStatus(statusEl);
            new Notice("石墨凭证有效");
          } catch (err) {
            this.renderStatus(statusEl);
            new Notice(`校验失败：${err instanceof Error ? err.message : String(err)}`);
          } finally {
            btn.setDisabled(false);
          }
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("清除").setWarning().onClick(async () => {
          this.plugin.settings.shimoSid = "";
          this.plugin.settings.credentialStatus = "empty";
          this.plugin.settings.accountName = "";
          this.plugin.settings.lastVerifiedAt = "";
          textarea.setValue("");
          await this.plugin.savePluginData();
          this.renderStatus(statusEl);
          new Notice("已清除本地凭证");
        }),
      );

    containerEl.createEl("h3", { text: "上传行为" });
    containerEl.createEl("p", {
      cls: "ots-hint",
      text:
        "无需配置方式：看笔记 frontmatter 的 shimo 指向哪。" +
        "指向文件夹（https://shimo.im/folder/xxx）→ 把 md 上传进该文件夹，不转换、不动原文档；" +
        "指向文档（https://shimo.im/docs/xxx）→ 上传并转换为石墨原生文档（保留标题/列表/表格排版），" +
        "成功后删除旧文档，并把 shimo 改写为新文档地址。",
    });

    containerEl.createEl("h3", { text: "如何获取 shimo_sid" });
    const ol = containerEl.createEl("ol", { cls: "ots-hint" });
    ol.createEl("li", { text: "浏览器打开 https://shimo.im 并登录" });
    ol.createEl("li", { text: "按 F12 打开开发者工具 → Application（或「存储」）→ Cookies → https://shimo.im" });
    ol.createEl("li", { text: "找到名称为 shimo_sid 的项，复制其 Value" });
    ol.createEl("li", { text: "粘贴到上方输入框，点击「校验」" });

    containerEl.createEl("h3", { text: "最近同步日志" });
    containerEl.createEl("p", {
      cls: "ots-hint",
      text: "失败时看这里的完整步骤与接口返回。也可在开发者工具 Console 过滤 obsidian-to-shimo。",
    });

    const logBox = containerEl.createEl("textarea");
    logBox.addClass("ots-token-input");
    logBox.readOnly = true;
    logBox.rows = 12;
    logBox.value = this.plugin.settings.lastSyncLog || "（暂无日志，先执行一次上传）";

    new Setting(containerEl)
      .setName("日志操作")
      .addButton((btn) =>
        btn.setButtonText("复制日志").onClick(async () => {
          const text = this.plugin.settings.lastSyncLog || "";
          if (!text) {
            new Notice("暂无日志");
            return;
          }
          await navigator.clipboard.writeText(text);
          new Notice("已复制同步日志");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("刷新").onClick(() => this.display()),
      )
      .addButton((btn) =>
        btn.setButtonText("清空").setWarning().onClick(async () => {
          this.plugin.settings.lastSyncLog = "";
          await this.plugin.savePluginData();
          this.display();
        }),
      );
  }

  private renderStatus(el: HTMLElement): void {
    el.empty();
    const s = this.plugin.settings;
    const label =
      s.credentialStatus === "valid"
        ? `状态：有效${s.accountName ? `（${s.accountName}）` : ""}`
        : s.credentialStatus === "invalid"
          ? "状态：无效或已过期"
          : s.credentialStatus === "configured"
            ? "状态：已填写，尚未校验"
            : "状态：未配置";
    el.createSpan({ text: label });
    if (s.lastVerifiedAt) {
      el.createEl("div", { text: `最近校验：${s.lastVerifiedAt}` });
    }
  }

  private async verify(): Promise<void> {
    const sid = this.plugin.settings.shimoSid.trim();
    if (!sid) {
      this.plugin.settings.credentialStatus = "empty";
      await this.plugin.savePluginData();
      throw new Error("请先粘贴 shimo_sid");
    }

    try {
      const client = new ShimoClient(sid);
      const me = await client.getMe();
      this.plugin.settings.credentialStatus = "valid";
      this.plugin.settings.accountName = me.name || me.email || String(me.id ?? "");
      this.plugin.settings.lastVerifiedAt = new Date().toLocaleString();
      await this.plugin.savePluginData();
    } catch (err) {
      this.plugin.settings.credentialStatus = "invalid";
      this.plugin.settings.accountName = "";
      await this.plugin.savePluginData();
      if (err instanceof ShimoApiError) throw err;
      throw err;
    }
  }
}
