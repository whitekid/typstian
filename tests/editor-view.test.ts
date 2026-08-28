// @vitest-environment happy-dom

import type { TFile, WorkspaceLeaf } from "obsidian";
import {
  acceptCompletion,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { forEachDiagnostic } from "@codemirror/lint";
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { describe, expect, it, vi } from "vitest";

import {
  OPEN_PREVIEW_LABEL,
  TYPST_VIEW_TYPE,
  TypstEditorView,
  utf8ByteOffset,
} from "../src/editor-view";
import { ForwardSearchScheduler } from "../src/forward-search-scheduler";
import { headerActions } from "./view-actions";

function createView(onDirty = vi.fn(), onForwardSearch = vi.fn()) {
  const modify = vi.fn();
  const leaf = { app: { vault: { modify } } } as unknown as WorkspaceLeaf;
  const view = new TypstEditorView(leaf, { onDirty, onForwardSearch });
  document.body.appendChild(view.contentEl);
  return { view, modify, onDirty, onForwardSearch };
}

function collectDiagnostics(view: TypstEditorView) {
  const collected: { from: number; to: number; severity: string; message: string }[] = [];
  forEachDiagnostic(view.editorView.state, (diagnostic, from, to) => {
    collected.push({ from, to, severity: diagnostic.severity, message: diagnostic.message });
  });
  return collected;
}

function pressKey(view: TypstEditorView, init: KeyboardEventInit) {
  view.editorView.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

describe("TypstEditorView", () => {
  it("identifies itself as the dedicated Typst file view", () => {
    const { view } = createView();

    expect(view.getViewType()).toBe(TYPST_VIEW_TYPE);
    expect(view.getDisplayText()).toBe("Typst editor");
  });

  it("requests go to definition at the current UTF-8 cursor", async () => {
    const onDefinition = vi.fn().mockResolvedValue(undefined);
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onDefinition });
    document.body.appendChild(view.contentEl);
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("café #x", true);
    view.editorView.dispatch({ selection: { anchor: 7 } });

    await view.goToDefinition();

    expect(onDefinition).toHaveBeenCalledWith({
      sourcePath: "book/main.typ",
      sourceText: "café #x",
      byteOffset: 8,
    });
    await view.onClose();
  });


  it("renders prose and code hover tooltips as owning-document text nodes", async () => {
    const onTooltip = vi.fn()
      .mockResolvedValueOnce({ kind: "text", content: "<img src=x onerror=alert(1)>" })
      .mockResolvedValueOnce({ kind: "code", content: "#let x = 1" });
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onTooltip });
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("café #x", true);
    const popoutDocument = document.implementation.createHTMLDocument("popout");
    popoutDocument.body.appendChild(view.contentEl);

    const prose = await view.tooltipAt(7, -1);
    expect(onTooltip).toHaveBeenLastCalledWith({
      sourcePath: "book/main.typ",
      sourceText: "café #x",
      byteOffset: 8,
      side: -1,
    });
    const proseDom = prose?.create(view.editorView).dom;
    expect(proseDom?.ownerDocument).toBe(popoutDocument);
    expect(proseDom?.tagName).toBe("DIV");
    expect(proseDom?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(proseDom?.querySelector("img")).toBeNull();

    const code = await view.tooltipAt(7, 1);
    const codeDom = code?.create(view.editorView).dom;
    expect(codeDom?.ownerDocument).toBe(popoutDocument);
    expect(codeDom?.tagName).toBe("CODE");
    expect(codeDom?.textContent).toBe("#let x = 1");
    view.editorView.destroy();
  });

  it("hides a rendered tooltip when the document changes", async () => {
    vi.useFakeTimers();
    try {
      const onTooltip = vi.fn().mockResolvedValue({ kind: "text", content: "old value" });
      const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
      const view = new TypstEditorView(leaf, { onTooltip });
      document.body.appendChild(view.contentEl);
      view.file = { path: "book/main.typ", extension: "typ" } as never;
      view.setViewData("#value", true);
      vi.spyOn(view.editorView, "posAtCoords").mockReturnValue(1);
      vi.spyOn(view.editorView, "coordsAtPos").mockReturnValue({
        left: 10,
        right: 10,
        top: 0,
        bottom: 20,
      });

      view.editorView.contentDOM.querySelector(".cm-line")?.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }));
      await vi.advanceTimersByTimeAsync(400);
      expect(document.querySelector(".cm-tooltip")?.textContent).toContain("old value");

      view.editorView.dispatch({ changes: { from: 0, insert: "X" } });

      expect(document.querySelector(".cm-tooltip")).toBeNull();
      view.editorView.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not request a tooltip for a non-Typst file", async () => {
    const onTooltip = vi.fn();
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onTooltip });
    view.file = { path: "book/notes.md", extension: "md" } as never;
    view.setViewData("#value", true);

    await expect(view.tooltipAt(1, 1)).resolves.toBeNull();
    expect(onTooltip).not.toHaveBeenCalled();
    view.editorView.destroy();
  });

  it("drops a tooltip reply after the live source changes", async () => {
    let resolveTooltip!: (value: { kind: "text"; content: string }) => void;
    const onTooltip = vi.fn(() => new Promise<{ kind: "text"; content: string }>((resolve) => {
      resolveTooltip = resolve;
    }));
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onTooltip });
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("#value", true);

    const tooltip = view.tooltipAt(1, 1);
    view.editorView.dispatch({ changes: { from: 0, insert: "X" } });
    resolveTooltip({ kind: "text", content: "stale" });

    await expect(tooltip).resolves.toBeNull();
    view.editorView.destroy();
  });

  it("uses Meta-click on macOS and Control-click on other platforms", async () => {
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const macDefinition = vi.fn().mockResolvedValue(undefined);
    const mac = new TypstEditorView(leaf, { onDefinition: macDefinition, isMacOS: true });
    document.body.appendChild(mac.contentEl);
    mac.file = { path: "book/main.typ", extension: "typ" } as never;
    mac.setViewData("café #x", true);
    vi.spyOn(mac.editorView, "posAtCoords").mockReturnValue(7);

    mac.editorView.contentDOM.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
      clientX: 10,
      clientY: 10,
    }));
    expect(macDefinition).not.toHaveBeenCalled();
    mac.editorView.contentDOM.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
      clientX: 10,
      clientY: 10,
    }));
    await vi.waitFor(() => expect(macDefinition).toHaveBeenCalledOnce());

    const otherDefinition = vi.fn().mockResolvedValue(undefined);
    const other = new TypstEditorView(leaf, { onDefinition: otherDefinition, isMacOS: false });
    document.body.appendChild(other.contentEl);
    other.file = { path: "book/main.typ", extension: "typ" } as never;
    other.setViewData("café #x", true);
    vi.spyOn(other.editorView, "posAtCoords").mockReturnValue(7);
    other.editorView.contentDOM.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
      clientX: 10,
      clientY: 10,
    }));
    await vi.waitFor(() => expect(otherDefinition).toHaveBeenCalledOnce());
    expect(otherDefinition).toHaveBeenCalledWith({
      sourcePath: "book/main.typ",
      sourceText: "café #x",
      byteOffset: 8,
    });

    await mac.onClose();
    await other.onClose();
  });

  it("loads and returns view data without scheduling a recursive save", () => {
    const { view, onDirty } = createView();
    const requestSave = vi.spyOn(view, "requestSave");

    view.setViewData("= Loaded", false);

    expect(view.getViewData()).toBe("= Loaded");
    expect(requestSave).not.toHaveBeenCalled();
    expect(onDirty).not.toHaveBeenCalled();
  });

  it("routes user edits through TextFileView requestSave and marks preview stale", () => {
    const { view, modify, onDirty } = createView();
    const requestSave = vi.spyOn(view, "requestSave");

    view.editorView.dispatch({ changes: { from: 0, insert: "Hello" } });

    expect(view.getViewData()).toBe("Hello");
    expect(requestSave).toHaveBeenCalledOnce();
    expect(onDirty).toHaveBeenCalledOnce();
    expect(modify).not.toHaveBeenCalled();
  });

  it("provides undo history for ordinary editor changes", () => {
    const { view } = createView();
    view.editorView.dispatch({ changes: { from: 0, insert: "first" } });

    expect(undo(view.editorView)).toBe(true);
    expect(view.getViewData()).toBe("");
  });

  it("clears content and history when switching files", () => {
    const { view } = createView();
    view.editorView.dispatch({ changes: { from: 0, insert: "old file" } });

    view.clear();

    expect(view.getViewData()).toBe("");
    expect(undo(view.editorView)).toBe(false);
  });

  it("treats setViewData with clear as a new history boundary", () => {
    const { view } = createView();
    view.editorView.dispatch({ changes: { from: 0, insert: "old file" } });

    view.setViewData("new file", true);

    expect(view.getViewData()).toBe("new file");
    expect(undo(view.editorView)).toBe(false);
  });

  it("opens the search panel from the find shortcut and closes it with Escape", () => {
    const { view } = createView();

    pressKey(view, { key: "f", ctrlKey: true });
    expect(view.contentEl.querySelector(".cm-search")).not.toBeNull();

    pressKey(view, { key: "Escape" });
    expect(view.contentEl.querySelector(".cm-search")).toBeNull();
  });

  it("closes the search panel on the first Escape even with text selected", () => {
    const { view } = createView();
    view.setViewData("alpha beta", true);
    view.editorView.dispatch({ selection: { anchor: 0, head: 5 } });

    pressKey(view, { key: "f", ctrlKey: true });
    pressKey(view, { key: "Escape" });

    // Escape also simplifies a selection, so the panel only closes on the
    // first press while the search binding takes precedence.
    expect(view.contentEl.querySelector(".cm-search")).toBeNull();
  });

  it("jumps to the next match from the find-next shortcut", () => {
    const { view } = createView();
    view.setViewData("alpha beta alpha", true);
    view.editorView.dispatch({
      selection: { anchor: 1 },
      effects: setSearchQuery.of(new SearchQuery({ search: "alpha" })),
    });

    pressKey(view, { key: "g", ctrlKey: true });

    expect(view.editorView.state.selection.main.from).toBe(11);
  });

  it("reveals a diagnostic using clamped 1-based line and column coordinates", () => {
    const { view } = createView();
    view.setViewData("one\ntwo", true);
    const dispatch = vi.spyOn(view.editorView, "dispatch");

    view.revealDiagnostic(99, 99);

    expect(view.editorView.state.selection.main.head).toBe(7);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ scrollIntoView: true }),
    );
    expect(document.activeElement).toBe(view.editorView.contentDOM);

    view.revealDiagnostic(0, 0);
    expect(view.editorView.state.selection.main.head).toBe(0);
  });

  it("marks a compiler diagnostic in the editor with its severity and message", () => {
    const { view } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("one\ntwo", true);

    view.setDiagnostics([
      { severity: "error", message: "unknown variable", path: "book/main.typ", line: 2, column: 2 },
    ]);

    expect(collectDiagnostics(view)).toEqual([
      { from: 5, to: 7, severity: "error", message: "unknown variable" },
    ]);
    expect(view.contentEl.querySelector(".cm-lintRange-error")).not.toBeNull();
  });

  it("keeps the compiler severity when marking a warning", () => {
    const { view } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("one\ntwo", true);

    view.setDiagnostics([
      { severity: "warning", message: "unused", path: "book/main.typ", line: 1, column: 1 },
    ]);

    expect(collectDiagnostics(view)).toEqual([
      { from: 0, to: 3, severity: "warning", message: "unused" },
    ]);
  });

  it("ignores a diagnostic reported for another file", () => {
    const { view } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("one\ntwo", true);

    view.setDiagnostics([
      { severity: "error", message: "elsewhere", path: "book/other.typ", line: 1, column: 1 },
      { severity: "error", message: "unplaced" },
    ]);

    expect(collectDiagnostics(view)).toEqual([]);
  });

  it("clamps a diagnostic pointing past the end of the current buffer", () => {
    const { view } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("one\ntwo", true);

    view.setDiagnostics([
      { severity: "error", message: "stale", path: "book/main.typ", line: 99, column: 99 },
    ]);

    expect(collectDiagnostics(view)).toEqual([
      { from: 7, to: 7, severity: "error", message: "stale" },
    ]);
  });

  it("clamps a diagnostic pointing before the start of the buffer", () => {
    const { view } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("one\ntwo", true);

    view.setDiagnostics([
      { severity: "error", message: "low", path: "book/main.typ", line: 0, column: -5 },
    ]);

    expect(collectDiagnostics(view)).toEqual([
      { from: 0, to: 3, severity: "error", message: "low" },
    ]);
  });

  it("skips a diagnostic whose coordinates are not finite", () => {
    const { view } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("one\ntwo", true);

    // A missing or garbled location must not take the whole mark pass down.
    view.setDiagnostics([
      { severity: "error", message: "nowhere", path: "book/main.typ", line: Number.NaN, column: 1 },
      { severity: "error", message: "endless", path: "book/main.typ", line: 1, column: Infinity },
      { severity: "warning", message: "fine", path: "book/main.typ", line: 2, column: 1 },
    ]);

    expect(collectDiagnostics(view).map((one) => one.message)).toEqual(["endless", "fine"]);
  });

  it("replaces the previous marks when a new diagnostic list arrives", () => {
    const { view } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("one\ntwo", true);
    view.setDiagnostics([
      { severity: "error", message: "first", path: "book/main.typ", line: 1, column: 1 },
    ]);

    view.setDiagnostics([]);

    expect(collectDiagnostics(view)).toEqual([]);
    expect(view.contentEl.querySelector(".cm-lintRange-error")).toBeNull();
  });

  it("reveals a source location from a UTF-8 byte offset", () => {
    const { view } = createView();
    view.setViewData("A한🙂Z", true);

    expect(view.revealByteOffset(4)).toBe(true);
    expect(view.editorView.state.selection.main.head).toBe(2);
    expect(view.revealByteOffset(2)).toBe(false);
    expect(view.editorView.state.selection.main.head).toBe(2);
    expect(view.revealByteOffset(99)).toBe(false);
  });

  it("maps an unmodified mouse selection to the exact saved UTF-8 byte offset", () => {
    const { view, onForwardSearch } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("A한🙂Z", true);

    view.editorView.dispatch({
      selection: { anchor: 4 },
      userEvent: "select.pointer",
    });

    expect(onForwardSearch).toHaveBeenCalledWith({
      sourcePath: "book/main.typ",
      sourceText: "A한🙂Z",
      byteOffset: 8,
    });
  });

  it("routes a content DOM mouse gesture through CodeMirror pointer selection", async () => {
    const { view, onForwardSearch } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("saved", true);
    const dispatchDocumentEvent = document.dispatchEvent.bind(document);
    vi.spyOn(document, "dispatchEvent").mockImplementation((event) =>
      event.type === "selectionchange" ? true : dispatchDocumentEvent(event)
    );

    view.editorView.contentDOM.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
    }));
    view.editorView.contentDOM.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      clientX: 10,
      clientY: 10,
    }));
    view.editorView.contentDOM.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    }));
    await Promise.resolve();

    expect(onForwardSearch).toHaveBeenCalledOnce();
    expect(onForwardSearch).toHaveBeenCalledWith({
      sourcePath: "book/main.typ",
      sourceText: "saved",
      byteOffset: 5,
    });
  });

  it("refuses a forward position inside a UTF-16 surrogate pair", () => {
    expect(utf8ByteOffset("A🙂Z", 2)).toBeNull();
    expect(utf8ByteOffset("A🙂Z", 3)).toBe(5);
  });

  it("maps a keyboard-only selection to the saved forward snapshot", () => {
    const { view, onForwardSearch } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("A한🙂Z", true);

    view.editorView.dispatch({
      selection: { anchor: 4 },
      userEvent: "select",
    });

    expect(onForwardSearch).toHaveBeenCalledWith({
      sourcePath: "book/main.typ",
      sourceText: "A한🙂Z",
      byteOffset: 8,
    });
  });

  it("refuses forward search while the editor buffer is dirty", () => {
    const { view, onForwardSearch } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("saved", true);
    view.editorView.dispatch({ changes: { from: 5, insert: "!" } });

    view.editorView.dispatch({
      selection: { anchor: 6 },
      userEvent: "select.pointer",
    });

    expect(onForwardSearch).not.toHaveBeenCalled();
  });

  it("re-enables forward search only after the exact editor buffer is saved", () => {
    const { view, onForwardSearch } = createView();
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("saved", true);
    view.editorView.dispatch({ changes: { from: 5, insert: "!" } });

    expect(view.markSaved("different")).toBe(false);
    expect(view.markSaved("saved!")).toBe(true);
    view.editorView.dispatch({
      selection: { anchor: 6 },
      userEvent: "select.pointer",
    });

    expect(onForwardSearch).toHaveBeenCalledOnce();
  });

  it("reports whether the editor has unsaved changes", () => {
    const { view } = createView();
    view.setViewData("saved", true);
    expect(view.hasUnsavedChanges()).toBe(false);
    expect(view.canDiscardUncommittedOpen()).toBe(true);

    view.editorView.dispatch({ changes: { from: 5, insert: "!" } });
    expect(view.hasUnsavedChanges()).toBe(true);
    expect(view.canDiscardUncommittedOpen()).toBe(false);

    expect(view.markSaved("saved!")).toBe(true);
    expect(view.hasUnsavedChanges()).toBe(false);
    expect(view.canDiscardUncommittedOpen()).toBe(false);
  });

  it("destroys its CodeMirror view when closed", async () => {
    const { view } = createView();
    const destroy = vi.spyOn(view.editorView, "destroy");

    await view.onClose();

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("offers a preview action that names the file the leaf is showing", () => {
    const onOpenPreview = vi.fn();
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onOpenPreview });
    view.file = { path: "book/main.typ" } as unknown as TFile;

    const action = headerActions(view).find((entry) => entry.title === OPEN_PREVIEW_LABEL);
    action?.callback();

    expect(action).toBeDefined();
    expect(onOpenPreview).toHaveBeenCalledWith("book/main.typ");
  });

  it("offers no preview action when nothing can open a preview", () => {
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf);

    expect(headerActions(view).map((entry) => entry.title))
      .not.toContain(OPEN_PREVIEW_LABEL);
  });

  it("invalidates its forward-search owner when closed", async () => {
    const onClose = vi.fn();
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onClose });

    await view.onClose();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels its queued forward search when closed before debounce", async () => {
    vi.useFakeTimers();
    const forward = vi.fn();
    const scheduler = new ForwardSearchScheduler(forward);
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, {
      onForwardSearch: (request) => scheduler.schedule(view, request),
      onClose: () => scheduler.cancel(view),
    });
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("saved", true);
    view.editorView.dispatch({
      selection: { anchor: 2 },
      userEvent: "select.pointer",
    });

    await view.onClose();
    await vi.advanceTimersByTimeAsync(100);

    expect(forward).not.toHaveBeenCalled();
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("cancels its in-flight forward search when closed during a vault read", async () => {
    vi.useFakeTimers();
    let finishRead!: () => void;
    const read = new Promise<void>((resolve) => { finishRead = resolve; });
    const forward = vi.fn();
    const scheduler = new ForwardSearchScheduler(async (request, isCurrent) => {
      await read;
      if (isCurrent()) forward(request);
    });
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, {
      onForwardSearch: (request) => scheduler.schedule(view, request),
      onClose: () => scheduler.cancel(view),
    });
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("saved", true);
    view.editorView.dispatch({
      selection: { anchor: 2 },
      userEvent: "select.pointer",
    });
    await vi.advanceTimersByTimeAsync(100);

    await view.onClose();
    finishRead();
    await Promise.resolve();

    expect(forward).not.toHaveBeenCalled();
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("offers compiler completions at the cursor and replaces the typed prefix", async () => {
    const onComplete = vi.fn(() =>
      Promise.resolve({
        byteOffset: 7,
        completions: [
          { kind: "func", label: "image", apply: "image(\"${path}\")", detail: "An image." },
          { kind: "label", label: "intro" },
        ],
      }),
    );
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onComplete });
    document.body.appendChild(view.contentEl);
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    // "café" is two bytes wider than it is UTF-16 units, so a byte offset used
    // as a document position would land in the wrong place.
    view.setViewData("café #im", true);
    view.editorView.dispatch({ selection: { anchor: 8 } });

    startCompletion(view.editorView);
    await vi.waitFor(() => expect(currentCompletions(view.editorView.state)).toHaveLength(1));

    expect(onComplete).toHaveBeenCalledWith({
      sourcePath: "book/main.typ",
      sourceText: "café #im",
      byteOffset: 9,
      explicit: true,
    });
    // Byte offset 7 is the `i` of `#im`, so the query is `im` and only `image`
    // survives CodeMirror's own filtering.
    expect(currentCompletions(view.editorView.state)[0]).toMatchObject({
      label: "image",
      type: "function",
      detail: "An image.",
    });

    // CodeMirror ignores a pick within its own interaction delay, so retry
    // until the freshly opened list will actually accept one.
    await vi.waitFor(() => expect(acceptCompletion(view.editorView)).toBe(true));

    // The typed prefix is replaced, not doubled, and Typst's snippet syntax
    // reaches CodeMirror as a placeholder.
    expect(view.getViewData()).toBe("café #image(\"path\")");
    await view.onClose();
  });

  it("offers nothing when the buffer changed while the compiler answered", async () => {
    let answer!: (value: { byteOffset: number; completions: [] }) => void;
    const onComplete = vi.fn(() =>
      new Promise<{ byteOffset: number; completions: [] }>((resolve) => {
        answer = resolve;
      }),
    );
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onComplete });
    document.body.appendChild(view.contentEl);
    view.file = { path: "book/main.typ", extension: "typ" } as never;
    view.setViewData("#im", true);
    view.editorView.dispatch({ selection: { anchor: 3 } });

    startCompletion(view.editorView);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    view.editorView.dispatch({ changes: { from: 3, insert: "age" } });
    answer({ byteOffset: 1, completions: [] });
    await Promise.resolve();

    expect(currentCompletions(view.editorView.state)).toEqual([]);
    await view.onClose();
  });

  it("stays silent for files the compiler does not own", async () => {
    const onComplete = vi.fn();
    const leaf = { app: { vault: { modify: vi.fn() } } } as unknown as WorkspaceLeaf;
    const view = new TypstEditorView(leaf, { onComplete });
    document.body.appendChild(view.contentEl);
    view.file = { path: "book/notes.md", extension: "md" } as never;
    view.setViewData("#im", true);
    view.editorView.dispatch({ selection: { anchor: 3 } });

    startCompletion(view.editorView);
    await Promise.resolve();

    expect(onComplete).not.toHaveBeenCalled();
    await view.onClose();
  });
});
