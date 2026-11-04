export class SyncLogger {
  private lines: string[] = [];

  step(message: string, detail?: unknown): void {
    const ts = new Date().toLocaleTimeString();
    let line = `[${ts}] ${message}`;
    if (detail !== undefined) {
      line += `\n${stringify(detail)}`;
    }
    this.lines.push(line);
    console.info("[obsidian-to-shimo]", message, detail ?? "");
  }

  error(message: string, detail?: unknown): void {
    const ts = new Date().toLocaleTimeString();
    let line = `[${ts}] ERROR ${message}`;
    if (detail !== undefined) {
      line += `\n${stringify(detail)}`;
    }
    this.lines.push(line);
    console.error("[obsidian-to-shimo]", message, detail ?? "");
  }

  toString(): string {
    return this.lines.join("\n\n");
  }
}

function stringify(detail: unknown): string {
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}
