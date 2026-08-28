// @vitest-environment happy-dom

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Notice, TFile, TFolder, View, type Command, type WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { DependencyIndex } from "../src/dependency-index";
import TypstianPlugin from "../src/main";
import { OPEN_PREVIEW_LABEL, TYPST_VIEW_TYPE, TypstEditorView } from "../src/editor-view";
import {
  TYPST_PREVIEW_VIEW_TYPE,
  TypstPreviewView,
} from "../src/preview-view";
import { headerActions } from "./view-actions";

interface DeferredLeaf {
  view: unknown;
  openFile: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

function deferredLeaf(options: { holdCompletion?: boolean } = {}) {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let releaseCompletion = (): void => undefined;
  const completion = options.holdCompletion === true
    ? new Promise<void>((resolve) => { releaseCompletion = resolve; })
    : Promise.resolve();
  const reveals: ReturnType<typeof vi.fn>[] = [];
  const leaf: DeferredLeaf = {
    view: {},
    detach: vi.fn(),
    openFile: vi.fn(async (file: TFile) => {
      await gate;
      const editor = new TypstEditorView(leaf as never);
      editor.file = file;
      editor.setViewData("0123456789", true);
      reveals.push(vi.spyOn(editor, "revealByteOffset"));
      leaf.view = editor;
      await completion;
    }),
  };
  return { finish, leaf, releaseCompletion, reveals };
}

async function registeredPreview(
  leaves: DeferredLeaf[],
  factory: (leaf: WorkspaceLeaf) => unknown,
  sourcePath: string,
): Promise<TypstPreviewView> {
  const leaf: DeferredLeaf = {
    view: {},
    detach: vi.fn(),
    openFile: vi.fn(),
  };
  const view = factory(leaf as unknown as WorkspaceLeaf);
  if (!(view instanceof TypstPreviewView)) {
    throw new Error("Preview view factory returned the wrong view type.");
  }
  leaf.view = view;
  leaves.push(leaf);
  await view.setState({ sourcePath }, {} as never);
  return view;
}

async function closeRegisteredPreview(
  leaves: DeferredLeaf[],
  view: TypstPreviewView,
): Promise<void> {
  await (view as unknown as { onClose(): Promise<void> }).onClose();
  const index = leaves.findIndex((leaf) => leaf.view === view);
  if (index >= 0) leaves.splice(index, 1);
}

describe("TypstianPlugin vault dependency invalidation", () => {
  it("refreshes dependency lifecycle changes and clears renamed entry edges", async () => {
    const { internals, plugin, vaultCallbacks } = harness([]);
    let sourcePath: string | null = "book/main.typ";
    const preview = {
      follow: vi.fn((path: string | null) => { sourcePath = path; }),
      getSourcePath: vi.fn(() => sourcePath),
      refresh: vi.fn(),
    };
    vi.spyOn(internals, "previewViews").mockReturnValue([preview]);
    await plugin.onload();

    const dependency = Object.assign(new TFile(), {
      path: "book/image.svg",
      extension: "svg",
      basename: "image",
    });
    internals.dependencies.update("book/main.typ", ["/vault/book/image.svg"]);

    vaultCallbacks.get("create")?.(dependency);
    expect(preview.refresh).toHaveBeenCalledOnce();

    preview.refresh.mockClear();
    vaultCallbacks.get("delete")?.(dependency);
    expect(preview.refresh).toHaveBeenCalledOnce();

    preview.refresh.mockClear();
    const renamedDependency = Object.assign(new TFile(), {
      path: "book/renamed.svg",
      extension: "svg",
      basename: "renamed",
    });
    vaultCallbacks.get("rename")?.(renamedDependency, "book/image.svg");
    expect(preview.refresh).toHaveBeenCalledOnce();

    preview.refresh.mockClear();
    sourcePath = "book/old.typ";
    internals.dependencies.update("book/old.typ", ["/vault/book/section.typ"]);
    const renamedEntry = Object.assign(new TFile(), {
      path: "book/new.typ",
      extension: "typ",
      basename: "new",
    });
    vaultCallbacks.get("rename")?.(renamedEntry, "book/old.typ");

    expect(preview.follow).toHaveBeenLastCalledWith("book/new.typ");
    expect(preview.refresh).not.toHaveBeenCalled();
    expect(internals.dependencies.affectedBy("/vault/book/section.typ")).toEqual([]);
  });

  it("drops dependency edges when the last preview for an entry closes", async () => {
    const leaves: DeferredLeaf[] = [];
    const {
      internals,
      plugin,
      vaultCallbacks,
      viewFactories,
    } = harness(leaves);
    await plugin.onload();
    const factory = viewFactories.get(TYPST_PREVIEW_VIEW_TYPE);
    if (factory === undefined) throw new Error("Preview view factory was not registered.");

    const preview = await registeredPreview(leaves, factory, "book/main.typ");
    internals.dependencies.update("book/main.typ", ["/vault/book/image.svg"]);
    await closeRegisteredPreview(leaves, preview);

    const reopened = await registeredPreview(leaves, factory, "book/main.typ");
    const refresh = vi.spyOn(reopened, "refresh");
    vaultCallbacks.get("create")?.(fileAt("book/image.svg"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps dependency edges while another preview for the entry remains open", async () => {
    const leaves: DeferredLeaf[] = [];
    const {
      internals,
      plugin,
      vaultCallbacks,
      viewFactories,
    } = harness(leaves);
    await plugin.onload();
    const factory = viewFactories.get(TYPST_PREVIEW_VIEW_TYPE);
    if (factory === undefined) throw new Error("Preview view factory was not registered.");

    const first = await registeredPreview(leaves, factory, "book/main.typ");
    const remaining = await registeredPreview(leaves, factory, "book/main.typ");
    internals.dependencies.update("book/main.typ", ["/vault/book/image.svg"]);
    await closeRegisteredPreview(leaves, first);

    const refresh = vi.spyOn(remaining, "refresh");
    vaultCallbacks.get("create")?.(fileAt("book/image.svg"));

    expect(refresh).toHaveBeenCalledOnce();
  });
});


describe("TypstianPlugin settings updates", () => {
  it("skips persistence and backend restart when normalized settings are unchanged", async () => {
    const plugin = new TypstianPlugin({} as never, {} as never);
    const restartBackend = vi.fn();
    const internals = plugin as unknown as {
      savePdf(sourcePath: string): Promise<void>;
    settings: { rootPath: string };
      previewViews(): Array<{ restartBackend(): void }>;
    };
    internals.settings = { rootPath: "projects/book" };
    vi.spyOn(internals, "previewViews").mockReturnValue([{ restartBackend }]);
    const saveData = vi.spyOn(plugin, "saveData");

    await plugin.updateSettings({ rootPath: " projects/book " });

    expect(saveData).not.toHaveBeenCalled();
    expect(restartBackend).not.toHaveBeenCalled();
  });

  it("serializes settings persistence before restarting each backend", async () => {
    const plugin = new TypstianPlugin({} as never, {} as never);
    const restartBackend = vi.fn();
    const internals = plugin as unknown as {
      settings: { rootPath: string };
      previewViews(): Array<{ restartBackend(): void }>;
    };
    internals.settings = { rootPath: "" };
    vi.spyOn(internals, "previewViews").mockReturnValue([{ restartBackend }]);
    let resolveFirstSave: (() => void) | undefined;
    const saveData = vi.spyOn(plugin, "saveData")
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockResolvedValueOnce();

    const first = plugin.updateSettings({ rootPath: "first" });
    const second = plugin.updateSettings({ rootPath: "second" });
    await Promise.resolve();

    expect(saveData).toHaveBeenCalledTimes(1);
    expect(restartBackend).not.toHaveBeenCalled();
    resolveFirstSave?.();
    await first;
    await second;

    expect(saveData).toHaveBeenNthCalledWith(1, { rootPath: "first" });
    expect(saveData).toHaveBeenNthCalledWith(2, { rootPath: "second" });
    expect(restartBackend).toHaveBeenCalledTimes(2);
    expect(internals.settings).toEqual({ rootPath: "second" });
  });

  it("does not apply an in-flight settings save after plugin unload", async () => {
    const plugin = new TypstianPlugin({} as never, {} as never);
    const restartBackend = vi.fn();
    const internals = plugin as unknown as {
      settings: { rootPath: string };
      previewViews(): Array<{ restartBackend(): void }>;
    };
    internals.settings = { rootPath: "" };
    vi.spyOn(internals, "previewViews").mockReturnValue([{ restartBackend }]);
    let resolveSave: (() => void) | undefined;
    vi.spyOn(plugin, "saveData").mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );

    const update = plugin.updateSettings({ rootPath: "project" });
    await Promise.resolve();
    plugin.onunload();
    resolveSave?.();
    await update;

    expect(internals.settings).toEqual({ rootPath: "" });
    expect(restartBackend).not.toHaveBeenCalled();
  });
});

describe("TypstianPlugin diagnostic fan-out", () => {
  it("leaves an editor outside the compile's dependencies untouched", async () => {
    const first = deferredLeaf();
    const second = deferredLeaf();
    const { internals, workspace } = harness([first.leaf, second.leaf]);
    first.finish();
    second.finish();
    const openFile = (leaf: DeferredLeaf): ((file: TFile) => Promise<void>) =>
      leaf.openFile as unknown as (file: TFile) => Promise<void>;
    await openFile(first.leaf)(fileAt("a.typ"));
    await openFile(second.leaf)(fileAt("b.typ"));
    (workspace.getLeavesOfType as unknown as { mockReturnValue(value: unknown): void })
      .mockReturnValue([first.leaf, second.leaf]);
    const editorA = first.leaf.view as TypstEditorView;
    const editorB = second.leaf.view as TypstEditorView;
    const markedA = vi.spyOn(editorA, "setDiagnostics");
    const markedB = vi.spyOn(editorB, "setDiagnostics");

    internals.publishDiagnostics({
      ok: true,
      dependencies: ["a.typ"],
      diagnostics: [{ severity: "warning", message: "careful", path: "a.typ", line: 1, column: 1 }],
    });

    // A second project's preview must not clear the marks this editor is
    // showing for its own compile.
    expect(markedA).toHaveBeenCalledTimes(1);
    expect(markedB).not.toHaveBeenCalled();
  });
});

function fileAt(path: string): TFile {
  return Object.assign(new TFile(), {
    path,
    extension: "typ",
    basename: path.replace(/\.typ$/, ""),
  });
}

function harness(leaves: DeferredLeaf[]) {
  const files = new Map<string, TFile>();
  const activeCallbacks: Array<(leaf: unknown) => void> = [];
  const menuCallbacks: Array<(menu: unknown, file: unknown) => void> = [];
  const vaultCallbacks = new Map<string, (...args: unknown[]) => void>();
  const workspace = {
    activeLeaf: { id: "preview" } as unknown,
    getLeavesOfType: vi.fn((type: string) => leaves.filter(
      (leaf) => type === TYPST_PREVIEW_VIEW_TYPE
        ? leaf.view instanceof TypstPreviewView
        : leaf.view instanceof TypstEditorView,
    )),
    getLeaf: vi.fn(() => {
      const leaf = leaves.find((candidate) => candidate.openFile.mock.calls.length === 0);
      if (leaf === undefined) throw new Error("missing test leaf");
      workspace.activeLeaf = leaf;
      for (const callback of activeCallbacks) callback(leaf);
      return leaf;
    }),
    revealLeaf: vi.fn((leaf: DeferredLeaf) => {
      workspace.activeLeaf = leaf;
      for (const callback of activeCallbacks) callback(leaf);
      return Promise.resolve();
    }),
    on: vi.fn((event: string, callback: (leaf: unknown) => void) => {
      if (event === "active-leaf-change") activeCallbacks.push(callback);
      if (event === "file-menu") menuCallbacks.push(callback);
      return { event, callback };
    }),
    onLayoutReady: vi.fn(),
    getActiveViewOfType: vi.fn((type: unknown) => (
      type === View && workspace.activeLeaf !== null && workspace.activeLeaf !== undefined
        ? { leaf: workspace.activeLeaf }
        : null
    )),
    requestSaveLayout: vi.fn(),
  };
  const vault = {
    adapter: {},
    getAbstractFileByPath: vi.fn((path: string): TFile | null => {
      let file = files.get(path);
      if (file === undefined) {
        const name = path.split("/").pop() ?? path;
        file = Object.assign(new TFile(), {
          path,
          extension: "typ",
          basename: name.replace(/\.typ$/, ""),
        });
        files.set(path, file);
      }
      return file;
    }),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      vaultCallbacks.set(event, callback);
      return { event, callback };
    }),
    create: vi.fn((path: string) => {
      const file = Object.assign(new TFile(), {
        path,
        extension: "typ",
        basename: (path.split("/").pop() ?? path).replace(/\.typ$/, ""),
      });
      files.set(path, file);
      return Promise.resolve(file);
    }),
    read: vi.fn(),
  };
  const app = { vault, workspace };
  const plugin = new TypstianPlugin(app as never, {} as never);
  const commands = new Map<string, Command>();
  const viewFactories = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
  vi.spyOn(plugin, "registerView").mockImplementation((type, creator) => {
    viewFactories.set(type, creator);
  });
  vi.spyOn(plugin, "addCommand").mockImplementation((command) => {
    commands.set(command.id, command);
    return command;
  });
  const internals = plugin as unknown as {
    dependencies: DependencyIndex;
    previewViews(): Array<{
      follow(path: string | null): void;
      getSourcePath(): string | null;
      refresh(): void;
    }>;
    publishDiagnostics(result: unknown): void;
    openPreview(sourcePath: string): Promise<void>;
    createEditorView(leaf: WorkspaceLeaf): TypstEditorView;
    savePdf(sourcePath: string): Promise<void>;
    settings: { rootPath: string };
    vaultRoot(): string;
    compilationRoot(vaultRoot: string): string;
    revealSourceLocation(
      location: { path: string; byteOffset: number },
      isCurrent: () => boolean,
    ): Promise<void>;
  };
  vi.spyOn(internals, "vaultRoot").mockReturnValue("/vault");
  vi.spyOn(internals, "compilationRoot").mockReturnValue("/vault");
  return {
    activeCallbacks,
    commands,
    internals,
    menuCallbacks,
    plugin,
    vault,
    vaultCallbacks,
    viewFactories,
    workspace,
  };
}

describe("TypstianPlugin source navigation", () => {
  it("opens a new target and reveals its exact byte offset despite getLeaf activation", async () => {
    const sourceLeaf = deferredLeaf();
    const { internals, plugin } = harness([sourceLeaf.leaf]);
    await plugin.onload();

    const navigation = internals.revealSourceLocation(
      { path: "book/section.typ", byteOffset: 4 },
      () => true,
    );
    sourceLeaf.finish();
    await navigation;

    expect(sourceLeaf.leaf.openFile).toHaveBeenCalledOnce();
    expect(sourceLeaf.reveals[0]).toHaveBeenCalledWith(4);
  });

  it("serializes stale and latest opens and commits only the latest source", async () => {
    const oldLeaf = deferredLeaf();
    const latestLeaf = deferredLeaf();
    const { internals, plugin, workspace } = harness([oldLeaf.leaf, latestLeaf.leaf]);
    await plugin.onload();
    let oldCurrent = true;

    const oldNavigation = internals.revealSourceLocation(
      { path: "book/old.typ", byteOffset: 1 },
      () => oldCurrent,
    );
    oldCurrent = false;
    const latestNavigation = internals.revealSourceLocation(
      { path: "book/latest.typ", byteOffset: 9 },
      () => true,
    );

    expect(oldLeaf.leaf.openFile).toHaveBeenCalledOnce();
    expect(latestLeaf.leaf.openFile).not.toHaveBeenCalled();

    oldLeaf.finish();
    await oldNavigation;
    await Promise.resolve();
    expect(latestLeaf.leaf.openFile).toHaveBeenCalledOnce();
    expect(oldLeaf.leaf.detach).toHaveBeenCalledOnce();

    latestLeaf.finish();
    await latestNavigation;

    expect(workspace.revealLeaf).toHaveBeenCalledTimes(2);
    expect(workspace.revealLeaf).toHaveBeenNthCalledWith(1, { id: "preview" });
    expect(workspace.revealLeaf).toHaveBeenLastCalledWith(latestLeaf.leaf);
    expect(oldLeaf.reveals[0]).not.toHaveBeenCalled();
    expect(latestLeaf.reveals[0]).toHaveBeenCalledWith(9);
  });

  it("preserves a stale plugin-created leaf after the user edits it", async () => {
    const oldLeaf = deferredLeaf({ holdCompletion: true });
    const latestLeaf = deferredLeaf();
    const { internals, plugin, workspace } = harness([oldLeaf.leaf, latestLeaf.leaf]);
    await plugin.onload();
    let oldCurrent = true;
    const oldNavigation = internals.revealSourceLocation(
      { path: "book/old.typ", byteOffset: 1 },
      () => oldCurrent,
    );
    oldCurrent = false;
    const latestNavigation = internals.revealSourceLocation(
      { path: "book/latest.typ", byteOffset: 9 },
      () => true,
    );

    oldLeaf.finish();
    await vi.waitFor(() => {
      expect(oldLeaf.leaf.view).toBeInstanceOf(TypstEditorView);
    });
    workspace.activeLeaf = { id: "preview" };
    const oldEditor = oldLeaf.leaf.view as TypstEditorView;
    oldEditor.editorView.dispatch({
      changes: { from: oldEditor.getViewData().length, insert: "!" },
    });
    oldLeaf.releaseCompletion();
    await oldNavigation;

    expect(oldLeaf.leaf.detach).not.toHaveBeenCalled();
    latestLeaf.finish();
    await latestNavigation;
    expect(latestLeaf.reveals[0]).toHaveBeenCalledWith(9);
  });

  it("cancels a deferred open when keyboard context changes", async () => {
    const sourceLeaf = deferredLeaf();
    const { activeCallbacks, internals, plugin, workspace } = harness([sourceLeaf.leaf]);
    await plugin.onload();
    const navigation = internals.revealSourceLocation(
      { path: "book/section.typ", byteOffset: 4 },
      () => true,
    );

    const keyboardTarget = { id: "keyboard-target" };
    workspace.activeLeaf = keyboardTarget;
    activeCallbacks[0]?.(keyboardTarget);
    sourceLeaf.finish();
    await navigation;

    expect(sourceLeaf.leaf.detach).toHaveBeenCalledOnce();
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    expect(sourceLeaf.reveals[0]).not.toHaveBeenCalled();
  });

  it("does not move the cursor when context changes during revealLeaf", async () => {
    const sourceLeaf = deferredLeaf();
    const { activeCallbacks, internals, plugin, workspace } = harness([sourceLeaf.leaf]);
    let finishReveal!: () => void;
    const revealing = new Promise<void>((resolve) => { finishReveal = resolve; });
    workspace.revealLeaf.mockImplementation(async (leaf: DeferredLeaf) => {
      workspace.activeLeaf = leaf;
      for (const callback of activeCallbacks) callback(leaf);
      await revealing;
    });
    await plugin.onload();
    const navigation = internals.revealSourceLocation(
      { path: "book/section.typ", byteOffset: 4 },
      () => true,
    );

    sourceLeaf.finish();
    await vi.waitFor(() => {
      expect(workspace.revealLeaf).toHaveBeenCalledWith(sourceLeaf.leaf);
    });
    const keyboardTarget = { id: "keyboard-target" };
    workspace.activeLeaf = keyboardTarget;
    activeCallbacks[0]?.(keyboardTarget);
    finishReveal();
    await navigation;

    expect(sourceLeaf.leaf.detach).not.toHaveBeenCalled();
    expect(sourceLeaf.reveals[0]).not.toHaveBeenCalled();
  });
});

function menuItems(callback: (menu: unknown, file: unknown) => void, file: unknown) {
  const items: Array<{ title: string; click: () => void }> = [];
  const menu = {
    addItem(build: (item: unknown) => void) {
      const item = {
        setTitle(title: string) { entry.title = title; return item; },
        setIcon() { return item; },
        onClick(handler: () => void) { entry.click = handler; return item; },
      };
      const entry = { title: "", click: (): void => undefined };
      build(item);
      items.push(entry);
      return menu;
    },
  };
  callback(menu, file);
  return items;
}

describe("TypstianPlugin Typst file creation", () => {
  it("creates Untitled.typ at the compilation root and opens it in the editor", async () => {
    const target = deferredLeaf();
    target.finish();
    const { commands, plugin, vault, workspace } = harness([target.leaf]);
    vault.getAbstractFileByPath.mockReturnValue(null);
    await plugin.onload();

    commands.get("create-typst-file")?.callback?.();
    await vi.waitFor(() => {
      expect(workspace.revealLeaf).toHaveBeenCalledWith(target.leaf);
    });

    expect(vault.create).toHaveBeenCalledWith("Untitled.typ", "= Untitled\n");
    expect(target.leaf.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Untitled.typ" }),
    );
    plugin.onunload();
  });

  it("refuses to create a file when the compilation root escapes the vault", async () => {
    const target = deferredLeaf();
    target.finish();
    const { commands, internals, plugin, vault } = harness([target.leaf]);
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-vault-"));
    try {
      vault.getAbstractFileByPath.mockReturnValue(null);
      // `rootPath` is free text; the real policy has to run for this to mean
      // anything, so the harness's stubbed root is restored here.
      vi.spyOn(internals, "vaultRoot").mockReturnValue(fs.realpathSync(vaultRoot));
      (internals.compilationRoot as unknown as { mockRestore(): void }).mockRestore();
      const notices = (Notice as unknown as { messages: string[] }).messages;
      notices.length = 0;
      await plugin.onload();
      internals.settings.rootPath = "../outside-the-vault";

      commands.get("create-typst-file")?.callback?.();

      expect(notices).toContain("This path leaves the vault. Type a path inside the vault instead.");
      expect(vault.create).not.toHaveBeenCalled();
      plugin.onunload();
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  it("keeps the folder menu out of folders the compiler cannot reach", async () => {
    const target = deferredLeaf();
    target.finish();
    const { internals, menuCallbacks, plugin } = harness([target.leaf]);
    vi.spyOn(internals, "compilationRoot").mockReturnValue("/vault/book");
    await plugin.onload();
    const items: string[] = [];
    const menu = {
      addItem: (build: (item: {
        setTitle(value: string): typeof item;
        setIcon(value: string): typeof item;
        onClick(handler: () => void): typeof item;
      }) => void) => {
        const item = {
          setTitle(value: string) { items.push(value); return item; },
          setIcon() { return item; },
          onClick() { return item; },
        };
        build(item);
      },
    };
    const folder = Object.assign(new TFolder(), { path: "notes" });

    // A file outside the compilation root cannot be compiled at all, which is
    // the failure this command exists to prevent.
    for (const callback of menuCallbacks) callback(menu, folder);

    expect(items).not.toContain("New Typst file");
    plugin.onunload();
  });

  it("names the real problem when the compilation root does not exist", async () => {
    const target = deferredLeaf();
    target.finish();
    const { commands, internals, plugin, vault } = harness([target.leaf]);
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-vault-"));
    try {
      vault.getAbstractFileByPath.mockReturnValue(null);
      vi.spyOn(internals, "vaultRoot").mockReturnValue(fs.realpathSync(vaultRoot));
      (internals.compilationRoot as unknown as { mockRestore(): void }).mockRestore();
      const notices = (Notice as unknown as { messages: string[] }).messages;
      notices.length = 0;
      await plugin.onload();
      // The settings row invites exactly this state: a folder the user is
      // about to create. Calling it "outside this vault" contradicts it.
      internals.settings.rootPath = "not-created-yet";

      commands.get("create-typst-file")?.callback?.();

      expect(notices).toContain("No folder at this path yet. Create it, or type a path that exists.");
      expect(vault.create).not.toHaveBeenCalled();
      plugin.onunload();
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  it("says why a save cannot start instead of failing silently", async () => {
    const target = deferredLeaf();
    target.finish();
    const { internals, plugin } = harness([target.leaf]);
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-vault-"));
    try {
      vi.spyOn(internals, "vaultRoot").mockReturnValue(fs.realpathSync(vaultRoot));
      (internals.compilationRoot as unknown as { mockRestore(): void }).mockRestore();
      const notices = (Notice as unknown as { messages: string[] }).messages;
      notices.length = 0;
      await plugin.onload();
      internals.settings.rootPath = "../outside-the-vault";

      // The toolbar button absorbs the rejection, so a throw here reaches
      // nobody: the user watches "Saving…" turn back into "Save" and no more.
      await internals.savePdf("book/main.typ");

      expect(notices).toContain("This path leaves the vault. Type a path inside the vault instead.");
      plugin.onunload();
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  it("never overwrites a taken name", async () => {
    const target = deferredLeaf();
    target.finish();
    const { commands, plugin, vault } = harness([target.leaf]);
    vault.getAbstractFileByPath.mockImplementation(
      (path: string) => (path === "Untitled.typ" ? fileAt(path) : null),
    );
    await plugin.onload();

    commands.get("create-typst-file")?.callback?.();
    await vi.waitFor(() => {
      expect(vault.create).toHaveBeenCalledWith("Untitled 1.typ", "= Untitled 1\n");
    });
    plugin.onunload();
  });

  it("offers the same action inside the folder a user right-clicks", async () => {
    const target = deferredLeaf();
    target.finish();
    const { commands, menuCallbacks, plugin, vault } = harness([target.leaf]);
    vault.getAbstractFileByPath.mockReturnValue(null);
    await plugin.onload();

    const forFolder = menuItems(menuCallbacks[0]!, Object.assign(new TFolder(), { path: "book" }));
    const forFile = menuItems(menuCallbacks[0]!, fileAt("book/main.typ"));
    expect(forFile.map((item) => item.title)).not.toContain("New Typst file");
    expect(forFolder.map((item) => item.title)).toEqual(["New Typst file"]);

    forFolder[0]!.click();
    await vi.waitFor(() => {
      expect(vault.create).toHaveBeenCalledWith("book/Untitled.typ", "= Untitled\n");
    });
    expect(commands.get("create-typst-file")).toBeDefined();
    plugin.onunload();
  });
});

describe("TypstianPlugin preview entry points", () => {
  it("calls the preview by one name the user can recognize anywhere", async () => {
    const { commands, plugin } = harness([]);
    await plugin.onload();

    // Spelled out rather than compared to the constant: a test that reads the
    // same constant the surfaces read cannot notice the label changing.
    expect(OPEN_PREVIEW_LABEL).toBe("Open Typst preview");
    expect(commands.get("open-typst-preview")?.name).toBe("Open Typst preview");

    plugin.onunload();
  });

  it("opens the preview from the file menu of a Typst file", async () => {
    const { internals, menuCallbacks, plugin } = harness([]);
    const openPreview = vi.spyOn(internals, "openPreview").mockResolvedValue();
    await plugin.onload();

    const items = menuItems(menuCallbacks[0]!, fileAt("book/main.typ"));

    expect(items.map((item) => item.title)).toEqual([OPEN_PREVIEW_LABEL]);
    items[0]!.click();
    expect(openPreview).toHaveBeenCalledWith("book/main.typ");
    plugin.onunload();
  });

  it("routes the editor's own preview action through the preview opener", async () => {
    const { internals, plugin } = harness([]);
    const openPreview = vi.spyOn(internals, "openPreview").mockResolvedValue();
    await plugin.onload();
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = internals.createEditorView(leaf);
    const action = headerActions(view).find((entry) => entry.title === OPEN_PREVIEW_LABEL);

    // No file yet: the leaf has nothing to preview.
    action?.callback();
    expect(action).toBeDefined();
    expect(openPreview).not.toHaveBeenCalled();

    view.file = fileAt("book/main.typ");
    action?.callback();

    expect(openPreview).toHaveBeenCalledWith("book/main.typ");
    plugin.onunload();
  });

  it("keeps the preview item off other files and folders", async () => {
    const { menuCallbacks, plugin } = harness([]);
    await plugin.onload();

    const markdown = Object.assign(new TFile(), {
      path: "book/notes.md",
      extension: "md",
      basename: "notes",
    });
    const forMarkdown = menuItems(menuCallbacks[0]!, markdown);
    const forFolder = menuItems(menuCallbacks[0]!, Object.assign(new TFolder(), { path: "book" }));

    expect(forMarkdown).toHaveLength(0);
    expect(forFolder.map((item) => item.title)).toEqual(["New Typst file"]);
    plugin.onunload();
  });

  // The mirror of "keeps the folder menu out of folders the compiler cannot
  // reach": creating a file outside the root hands the user something nothing
  // can compile, but opening a preview only reports the root problem, so the
  // file item must survive where the folder item does not.
  it("offers the preview on a Typst file the compilation root does not cover", async () => {
    const { internals, menuCallbacks, plugin } = harness([]);
    vi.spyOn(internals, "compilationRoot").mockReturnValue("/vault/book");
    const openPreview = vi.spyOn(internals, "openPreview").mockResolvedValue();
    await plugin.onload();

    const outside = fileAt("notes/main.typ");
    const forFile = menuItems(menuCallbacks[0]!, outside);
    const forFolder = menuItems(
      menuCallbacks[0]!,
      Object.assign(new TFolder(), { path: "notes" }),
    );

    expect(forFile.map((item) => item.title)).toEqual([OPEN_PREVIEW_LABEL]);
    expect(forFolder.map((item) => item.title)).not.toContain("New Typst file");

    forFile[0]!.click();
    expect(openPreview).toHaveBeenCalledWith("notes/main.typ");
    plugin.onunload();
  });
});

describe("TypstianPlugin completion routing", () => {
  interface CompletionInternals {
    handleCompletion(
      editor: TypstEditorView,
      request: {
        sourcePath: string;
        sourceText: string;
        byteOffset: number;
        explicit: boolean;
      },
      isCurrent: () => boolean,
    ): Promise<{ byteOffset: number; completions: unknown[] } | null>;
  }

  function completionHarness() {
    const { internals, plugin } = harness([]);
    const unrelated = {
      getSourcePath: vi.fn(() => "other/doc.typ"),
      complete: vi.fn(),
    };
    const owning = {
      getSourcePath: vi.fn(() => "book/main.typ"),
      complete: vi.fn(() =>
        Promise.resolve({
          revision: 4,
          byteOffset: 5,
          completions: [{ kind: "func", label: "image" }],
        }),
      ),
    };
    vi.spyOn(internals, "previewViews").mockReturnValue(
      [unrelated, owning] as never,
    );
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const editor = new TypstEditorView(leaf);
    editor.file = Object.assign(new TFile(), {
      path: "book/main.typ",
      extension: "typ",
      basename: "main",
    });
    editor.setViewData("#im", true);
    return {
      editor,
      internals: plugin as unknown as CompletionInternals,
      owning,
      plugin,
      unrelated,
    };
  }

  it("asks only the preview that compiles the edited file", async () => {
    const { editor, internals, owning, plugin, unrelated } = completionHarness();
    await plugin.onload();

    const result = await internals.handleCompletion(
      editor,
      { sourcePath: "book/main.typ", sourceText: "#im", byteOffset: 3, explicit: true },
      () => true,
    );

    expect(unrelated.complete).not.toHaveBeenCalled();
    // The compilation root is the vault root here, so the compiler path is the
    // vault path; the editor never sees the revision the preview holds.
    expect(owning.complete).toHaveBeenCalledWith(
      "book/main.typ",
      "#im",
      3,
      true,
      expect.any(Function),
    );
    expect(result).toEqual({ byteOffset: 5, completions: [{ kind: "func", label: "image" }] });
    plugin.onunload();
  });

  it("offers nothing once the request no longer matches the editor", async () => {
    const { editor, internals, owning, plugin } = completionHarness();
    await plugin.onload();

    const stale = await internals.handleCompletion(
      editor,
      { sourcePath: "book/main.typ", sourceText: "#im", byteOffset: 3, explicit: true },
      () => false,
    );
    const foreign = await internals.handleCompletion(
      editor,
      { sourcePath: "book/other.typ", sourceText: "#im", byteOffset: 3, explicit: true },
      () => true,
    );

    expect(stale).toBeNull();
    expect(foreign).toBeNull();
    expect(owning.complete).not.toHaveBeenCalled();
    plugin.onunload();
  });
});

describe("TypstianPlugin definition routing", () => {
  it("asks only the owning preview and reuses safe source navigation", async () => {
    const { internals, plugin } = harness([]);
    const unrelated = {
      getSourcePath: vi.fn(() => "other/doc.typ"),
      definition: vi.fn(),
    };
    const owning = {
      getSourcePath: vi.fn(() => "book/main.typ"),
      definition: vi.fn().mockResolvedValue({ path: "book/defs.typ", byteOffset: 7 }),
    };
    vi.spyOn(internals, "previewViews").mockReturnValue([unrelated, owning] as never);
    const reveal = vi.spyOn(internals, "revealSourceLocation").mockResolvedValue(undefined);
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const editor = new TypstEditorView(leaf);
    editor.file = fileAt("book/main.typ");
    editor.setViewData("#let x = 1\n#x", true);
    await plugin.onload();
    const definitionInternals = plugin as unknown as {
      handleDefinition(
        editor: TypstEditorView,
        request: { sourcePath: string; sourceText: string; byteOffset: number },
        isCurrent: () => boolean,
      ): Promise<void>;
    };

    await definitionInternals.handleDefinition(
      editor,
      { sourcePath: "book/main.typ", sourceText: "#let x = 1\n#x", byteOffset: 13 },
      () => true,
    );

    expect(unrelated.definition).not.toHaveBeenCalled();
    expect(owning.definition).toHaveBeenCalledWith(
      "book/main.typ",
      "#let x = 1\n#x",
      13,
      expect.any(Function),
    );
    expect(reveal).toHaveBeenCalledWith(
      { path: "book/defs.typ", byteOffset: 7 },
      expect.any(Function),
    );
    plugin.onunload();
  });


  it("drops a definition after its owning editor closes without cancelling another editor", async () => {
    const { internals, plugin, viewFactories } = harness([]);
    let resolveFirst!: (location: { path: string; byteOffset: number }) => void;
    const firstResult = new Promise<{ path: string; byteOffset: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const owning = {
      getSourcePath: vi.fn(() => "book/main.typ"),
      definition: vi.fn()
        .mockImplementationOnce(() => firstResult)
        .mockResolvedValue({ path: "book/defs.typ", byteOffset: 9 }),
    };
    vi.spyOn(internals, "previewViews").mockReturnValue([owning] as never);
    const reveal = vi.spyOn(internals, "revealSourceLocation").mockResolvedValue(undefined);
    await plugin.onload();

    const factory = viewFactories.get(TYPST_VIEW_TYPE);
    if (factory === undefined) throw new Error("Typst editor view factory was not registered.");
    const createEditor = (): TypstEditorView => {
      const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
      const view = factory(leaf);
      if (!(view instanceof TypstEditorView)) throw new Error("Typst editor was not created.");
      view.file = fileAt("book/main.typ");
      view.setViewData("#let x = 1\n#x", true);
      return view;
    };

    const closedEditor = createEditor();
    const stale = closedEditor.goToDefinition();
    await vi.waitFor(() => expect(owning.definition).toHaveBeenCalledOnce());
    await closedEditor.onClose();
    resolveFirst({ path: "book/defs.typ", byteOffset: 7 });
    await stale;
    expect(reveal).not.toHaveBeenCalled();

    const liveEditor = createEditor();
    await liveEditor.goToDefinition();
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(
      { path: "book/defs.typ", byteOffset: 9 },
      expect.any(Function),
    );
    plugin.onunload();
  });

  it("registers Go to definition for the active Typst editor", async () => {
    const { commands, plugin, workspace } = harness([]);
    const goToDefinition = vi.fn().mockResolvedValue(undefined);
    workspace.getActiveViewOfType.mockReturnValue({
      file: { extension: "typ" },
      goToDefinition,
    } as never);
    await plugin.onload();

    const command = commands.get("go-to-definition");
    expect(command?.name).toBe("Go to definition");
    expect(command?.checkCallback?.(true)).toBe(true);
    expect(command?.checkCallback?.(false)).toBe(true);
    expect(goToDefinition).toHaveBeenCalledOnce();
    plugin.onunload();
  });
});

describe("TypstianPlugin user-facing wording", () => {
  function noticeHarness() {
    const { internals, plugin, vault } = harness([]);
    const wording = internals as unknown as {
      handleForwardSearch(
        editor: unknown,
        request: { sourcePath: string; sourceText: string; byteOffset: number },
        isCurrent: () => boolean,
      ): Promise<void>;
    };
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    const editor = {
      file: fileAt("book/main.typ"),
      getViewData: () => "= Draft\n",
    };
    const request = {
      sourcePath: "book/main.typ",
      sourceText: "= Draft\n",
      byteOffset: 2,
    };
    return { editor, notices, plugin, request, vault, wording };
  }

  it("asks for a save without naming forward search", async () => {
    const { editor, notices, plugin, request, vault, wording } = noticeHarness();
    await plugin.onload();
    vault.read.mockResolvedValue("= Saved\n");

    await wording.handleForwardSearch(editor, request, () => true);

    expect(notices).toEqual([
      "Save the Typst file to reveal the matching spot in the preview."
    ]);
    plugin.onunload();
  });

  it("asks for a preview without naming forward search", async () => {
    const { editor, notices, plugin, request, vault, wording } = noticeHarness();
    await plugin.onload();
    vault.read.mockResolvedValue("= Draft\n");

    await wording.handleForwardSearch(editor, request, () => true);

    expect(notices).toEqual([
      "Open a preview of this Typst source to reveal the matching spot in it."
    ]);
    plugin.onunload();
  });

  it("reports an unreadable source without naming forward search", async () => {
    const { editor, notices, plugin, request, vault, wording } = noticeHarness();
    await plugin.onload();
    vault.read.mockRejectedValue(new Error("nope"));

    await wording.handleForwardSearch(editor, request, () => true);

    expect(notices).toEqual([
      "Unable to read the Typst source to reveal the matching spot in the preview."
    ]);
    plugin.onunload();
  });

  it("reports a stale preview click without naming inverse search", async () => {
    const sourceLeaf = deferredLeaf();
    const { internals, plugin } = harness([sourceLeaf.leaf]);
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    await plugin.onload();

    const navigation = internals.revealSourceLocation(
      { path: "book/section.typ", byteOffset: 4096 },
      () => true,
    );
    sourceLeaf.finish();
    await navigation;

    expect(notices).toEqual([
      "That source location is no longer valid for the current file."
    ]);
    plugin.onunload();
  });
});

describe("TypstianPlugin preview wiring", () => {
  it("gives the preview the same save path as the command", async () => {
    const { internals, plugin } = harness([]);
    const wiring = internals as unknown as {
      createPreviewView(leaf: unknown): unknown;
      savePdf(sourcePath: string): Promise<void>;
    };
    const savePdf = vi.spyOn(wiring, "savePdf").mockResolvedValue(undefined);
    await plugin.onload();

    const view = wiring.createPreviewView({}) as {
      options: { savePdf?: (sourcePath: string) => void | Promise<void> };
    };
    await view.options.savePdf?.("book/main.typ");

    expect(savePdf).toHaveBeenCalledWith("book/main.typ");
    plugin.onunload();
  });
});
