export interface ViewHeaderAction {
  icon: string;
  title: string;
  callback: () => void;
}

export class TextFileView {
  contentEl: HTMLElement;
  data = "";
  file: { path: string; extension: string } | null = null;
  // Obsidian's view header actions; the stub records them so a test can
  // activate one the way a click would.
  readonly actions: ViewHeaderAction[] = [];

  constructor(_leaf?: unknown) {
    void _leaf;
    this.contentEl = document.createElement("div");
  }

  requestSave(): void {}

  addAction(icon: string, title: string, callback: () => void): HTMLElement {
    this.actions.push({ icon, title, callback });
    return document.createElement("div");
  }
}

export class View {
  constructor(public readonly leaf?: unknown) {}
}

export class ItemView {
  contentEl: HTMLElement;

  constructor(public readonly leaf?: unknown) {
    this.contentEl = document.createElement("div");
  }
}

export class TFile {
  readonly extension: string;
  readonly basename: string;

  constructor(public readonly path: string = "") {
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    this.extension = dot < 0 ? "" : name.slice(dot + 1);
    this.basename = dot < 0 ? name : name.slice(0, dot);
  }
}

export class TFolder {
  constructor(public path: string = "") {}
}

export const Platform = { isMacOS: false };

export class FileSystemAdapter {
  constructor(private readonly basePath: string) {}

  getBasePath(): string {
    return this.basePath;
  }
}

export class Notice {
  static readonly messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class Plugin {
  settings: unknown;

  constructor(
    public readonly app: unknown,
    public readonly manifest: unknown = {},
  ) {}

  loadData(): Promise<unknown> {
    return Promise.resolve({});
  }

  saveData(data: unknown): Promise<void> {
    void data;
    return Promise.resolve();
  }

  registerView(type: string, creator: unknown): void {
    void type;
    void creator;
  }

  registerExtensions(extensions: string[], viewType: string): void {
    void extensions;
    void viewType;
  }

  addCommand(command: unknown): void {
    void command;
  }

  addSettingTab(tab: unknown): void {
    void tab;
  }

  // Obsidian's status bar items carry its HTMLElement extensions, which the DOM
  // stub does not install globally.
  addStatusBarItem(): HTMLElement {
    const element = document.createElement("div");
    return Object.assign(element, {
      setText(text: string) { element.textContent = text; },
      hide() { element.style.display = "none"; },
      show() { element.style.removeProperty("display"); }
    });
  }

  registerEvent<T>(event: T): T {
    return event;
  }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");

  constructor(
    public readonly app: unknown,
    public readonly plugin: unknown,
  ) {}

  display(): void {}
}

