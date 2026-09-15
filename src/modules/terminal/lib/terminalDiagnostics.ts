type LogLevel = "debug" | "info" | "warn" | "error";

type DiagnosticEntry = {
  timestamp: number;
  level: LogLevel;
  message: string;
};

export class TerminalDiagnostics {
  private entries: DiagnosticEntry[] = [];
  private maxEntries = 500;

  log(level: LogLevel, message: string): void {
    this.entries.push({ timestamp: Date.now(), level, message });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  debug(message: string): void {
    this.log("debug", message);
  }

  info(message: string): void {
    this.log("info", message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  error(message: string): void {
    this.log("error", message);
  }

  getEntries(): readonly DiagnosticEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}

export const terminalDiagnostics = new TerminalDiagnostics();
