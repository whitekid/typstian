// @vitest-environment happy-dom

import type { WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompilerClientError,
  type CompilerCompileResult,
  type CompilerForwardRequest,
  type CompilerJumpRequest,
  type CompilerJumpResult
} from "../src/compiler-client";
import { TypstPreviewView } from "../src/preview-view";
import { makePdfEngine, setElementRect } from "./fake-pdf-engine";

class TestPreviewView extends TypstPreviewView {
  open(): Promise<void> {
    return this.onOpen();
  }

  close(): Promise<void> {
    return this.onClose();
  }
}

function success(revision = 1): CompilerCompileResult {
  return {
    ok: true,
    revision,
    pdf: new Uint8Array([37, 80, 68, 70, 45]),
    pages: [{ widthPt: 600, heightPt: 800 }],
    dependencies: ["book/main.typ"],
    diagnostics: []
  };
}

describe("TypstPreviewView", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("restores its source, renders PDF text layers, and maps a current unmodified click", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    const compile = vi.fn().mockResolvedValue(success());
    const jump = vi.fn((request: CompilerJumpRequest) => Promise.resolve({
      revision: request.revision,
      location: { path: "book/section.typ", byteOffset: 12 }
    }));
    const onSourceLocation = vi.fn();
    const onCompiled = vi.fn();
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile,
      jump,
      forward: vi.fn(),
      onSourceLocation,
      onCompiled,
      onDiagnostic: () => undefined,
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: () => undefined
    });
    await view.setState({ sourcePath: "book/main.typ", zoom: 2, fit: true }, {} as never);

    await view.open();
    await vi.advanceTimersByTimeAsync(300);

    expect(compile).toHaveBeenCalledWith("book/main.typ", 1, expect.any(AbortSignal));
    expect(onCompiled).toHaveBeenCalledWith("book/main.typ", success());
    const page = view.contentEl.querySelector<HTMLElement>(".typst-pdf-page");
    expect(page).not.toBeNull();
    expect(view.contentEl.querySelector(
      '.typst-preview-toolbar [aria-label="PDF page navigation"]',
    )).not.toBeNull();
    expect(view.contentEl.querySelector(".typst-pdf-text-layer")).not.toBeNull();
    setElementRect(page!, 600, 800);

    page!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160
    }));
    await Promise.resolve();
    await Promise.resolve();

    const jumpRequest = jump.mock.calls[0]?.[0];
    expect(jumpRequest).toMatchObject({
      revision: 1,
      page: 1,
      xPt: 120,
      yPt: 160
    });
    expect(jumpRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(onSourceLocation).toHaveBeenCalledWith(
      {
        path: "book/section.typ",
        byteOffset: 12
      },
      expect.any(Function),
    );
    expect(view.getState()).toEqual({ sourcePath: "book/main.typ", zoom: 2, fit: true });
    await view.close();
  });

  it("starts a saved refresh promptly without hiding the visible PDF", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    let releaseSecondPage!: () => void;
    const delayedSecondPage = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
    const { engine, pages } = makePdfEngine(49);
    pages[1]!.render = vi.fn(() => ({
      promise: delayedSecondPage,
      cancel: vi.fn()
    }));
    const pending = new Promise<CompilerCompileResult>(() => undefined);
    const compile = vi.fn()
      .mockResolvedValueOnce(success())
      .mockReturnValueOnce(pending);
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile,
      jump: vi.fn(),
      forward: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn()
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);
    const visiblePage = view.contentEl.querySelector(".typst-pdf-page");
    expect(visiblePage).not.toBeNull();

    view.markDirty();
    await Promise.resolve();
    expect(view.contentEl.querySelector(".typst-pdf-page")).toBe(visiblePage);

    view.refresh();
    await vi.advanceTimersByTimeAsync(100);

    expect(compile).toHaveBeenCalledTimes(2);
    expect(view.contentEl.querySelector(".typst-pdf-page")).toBe(visiblePage);
    expect(view.contentEl.textContent).toContain("Compiling");
    releaseSecondPage();
    await view.close();
  });

  it("keeps only the latest navigation from two rapid preview clicks", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    let resolveFirst!: (result: CompilerJumpResult) => void;
    let resolveSecond!: (result: CompilerJumpResult) => void;
    const jump = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const onSourceLocation = vi.fn();
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump,
      forward: vi.fn(),
      onSourceLocation,
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn(),
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);
    const page = view.contentEl.querySelector<HTMLElement>(".typst-pdf-page")!;
    setElementRect(page, 600, 800);

    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160,
    }));
    const firstSignal = (jump.mock.calls[0]?.[0] as CompilerJumpRequest | undefined)?.signal;
    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 180,
      clientY: 240,
    }));
    expect(firstSignal?.aborted).toBe(true);

    resolveFirst({
      revision: 1,
      location: { path: "book/old.typ", byteOffset: 1 },
    });
    resolveSecond({
      revision: 1,
      location: { path: "book/latest.typ", byteOffset: 9 },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSourceLocation).toHaveBeenCalledOnce();
    expect(onSourceLocation).toHaveBeenCalledWith(
      { path: "book/latest.typ", byteOffset: 9 },
      expect.any(Function),
    );
    await view.close();
  });

  it("reveals the first current forward position without changing the preview entry", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    const forward = vi.fn((request: CompilerForwardRequest) => Promise.resolve({
      revision: request.revision,
      positions: [{ page: 1, xPt: 60, yPt: 80 }]
    }));
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn(),
      forward,
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn()
    });
    await view.setState({ sourcePath: "book/main.typ", zoom: 2 }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);
    const page = view.contentEl.querySelector<HTMLElement>(".typst-pdf-page")!;
    page.scrollIntoView = vi.fn();

    await expect(view.forward("book/section.typ", 8)).resolves.toBe(true);

    const forwardRequest = forward.mock.calls[0]?.[0];
    expect(forwardRequest).toMatchObject({
      revision: 1,
      source: "book/section.typ",
      byteOffset: 8
    });
    expect(forwardRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(page.querySelector<HTMLElement>(".typst-pdf-forward-marker")?.style.getPropertyValue("--typst-pdf-marker-x")).toBe("120px");
    expect(view.getSourcePath()).toBe("book/main.typ");
    await view.close();
  });


  it("reveals a distant forward target before blocked background rendering finishes", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    let releaseSecondPage!: () => void;
    const delayedSecondPage = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
    const { engine, pages } = makePdfEngine(49);
    pages[1]!.render = vi.fn(() => ({
      promise: delayedSecondPage,
      cancel: vi.fn()
    }));
    const distantPageRender = vi.spyOn(pages[48]!, "render");
    const forward = vi.fn((request: CompilerForwardRequest) => Promise.resolve({
      revision: request.revision,
      positions: [{ page: 49, xPt: 60, yPt: 80 }]
    }));
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn(),
      forward,
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn()
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);
    const target = view.contentEl.querySelector<HTMLElement>(
      '.typst-pdf-page[data-page="49"]'
    )!;
    target.scrollIntoView = vi.fn();

    const navigation = view.forward("book/section.typ", 8);
    const result = Promise.race([
      navigation,
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 25);
      })
    ]);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe(true);
    expect(distantPageRender).toHaveBeenCalled();
    releaseSecondPage();
    await navigation;
    await view.close();
  });

  it("discards an older forward result without aborting the retained compiler session", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    let resolveFirst!: (result: { revision: number; positions: Array<{ page: number; xPt: number; yPt: number }> }) => void;
    let resolveSecond!: typeof resolveFirst;
    const forward = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn(),
      forward,
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn()
    });
    await view.setState({ sourcePath: "book/main.typ", zoom: 2 }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);

    const first = view.forward("book/section.typ", 8);
    const firstSignal = (forward.mock.calls[0]?.[0] as CompilerForwardRequest | undefined)?.signal;
    const second = view.forward("book/section.typ", 9);
    expect(firstSignal?.aborted).toBe(false);

    resolveFirst({ revision: 1, positions: [{ page: 1, xPt: 10, yPt: 20 }] });
    await expect(first).resolves.toBe(false);
    resolveSecond({ revision: 1, positions: [{ page: 1, xPt: 20, yPt: 30 }] });
    await expect(second).resolves.toBe(true);
    await view.close();
  });

  it("drops a definition after its retained revision becomes inactive", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    let resolveDefinition!: (result: {
      revision: number;
      location: { path: string; byteOffset: number } | null;
    }) => void;
    const definition = vi.fn(() => new Promise<{
      revision: number;
      location: { path: string; byteOffset: number } | null;
    }>((resolve) => { resolveDefinition = resolve; }));
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn(),
      forward: vi.fn(),
      complete: vi.fn(),
      definition,
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      requestSaveLayout: vi.fn(),
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);

    const pending = view.definition("book/main.typ", "#let x = 1\n#x", 13);
    view.markDirty();
    resolveDefinition({
      revision: 1,
      location: { path: "book/main.typ", byteOffset: 5 },
    });

    await expect(pending).resolves.toBeNull();
    await view.close();
  });

  it("invalidates inverse search as soon as the source becomes dirty", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    const jump = vi.fn();
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump,
      forward: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn()
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);
    const page = view.contentEl.querySelector<HTMLElement>(".typst-pdf-page")!;
    setElementRect(page, 600, 800);

    view.markDirty();
    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160
    }));
    await Promise.resolve();

    expect(jump).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector(".typst-pdf-page")).not.toBeNull();
    await view.close();
  });

  it("does not move the source cursor when opening finishes after revision invalidation", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    let finishOpen!: () => void;
    const opened = new Promise<void>((resolve) => { finishOpen = resolve; });
    let navigationStarted!: () => void;
    const started = new Promise<void>((resolve) => { navigationStarted = resolve; });
    const revealByteOffset = vi.fn();
    let currentCheck: (() => boolean) | undefined;
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn((request: CompilerJumpRequest) => Promise.resolve({
        revision: request.revision,
        location: { path: "book/section.typ", byteOffset: 12 },
      })),
      forward: vi.fn(),
      onSourceLocation: vi.fn((_location, isCurrent?: () => boolean) => {
        currentCheck = isCurrent;
        navigationStarted();
        return opened.then(() => {
          if (isCurrent?.()) revealByteOffset(12);
        });
      }),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn(),
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);
    const page = view.contentEl.querySelector<HTMLElement>(".typst-pdf-page")!;
    setElementRect(page, 600, 800);

    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160,
    }));
    await started;
    expect(currentCheck).toEqual(expect.any(Function));

    view.markDirty();
    finishOpen();
    await Promise.resolve();
    await Promise.resolve();

    expect(revealByteOffset).not.toHaveBeenCalled();
    await view.close();
  });

  it("moves the source cursor when the retained revision stays current", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    const revealByteOffset = vi.fn();
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn((request: CompilerJumpRequest) => Promise.resolve({
        revision: request.revision,
        location: { path: "book/section.typ", byteOffset: 12 },
      })),
      forward: vi.fn(),
      onSourceLocation: vi.fn(async (_location, isCurrent?: () => boolean) => {
        await Promise.resolve();
        if (isCurrent?.()) revealByteOffset(12);
      }),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn(),
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);
    const page = view.contentEl.querySelector<HTMLElement>(".typst-pdf-page")!;
    setElementRect(page, 600, 800);

    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160,
    }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(revealByteOffset).toHaveBeenCalledWith(12);
    await view.close();
  });

  it("routes a located compiler diagnostic to the navigation callback", async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const diagnostic = {
      path: "book/section.typ",
      line: 3,
      column: 5,
      severity: "error" as const,
      message: "expected expression"
    };
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue({
        ok: false,
        revision: 1,
        reason: "compile-error",
        message: "Typst compilation failed.",
        dependencies: ["book/main.typ", "book/section.typ"],
        diagnostics: [diagnostic]
      } satisfies CompilerCompileResult),
      jump: vi.fn(),
      forward: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic,
      disposeBackend: vi.fn(),
      pdfEngine: makePdfEngine().engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: () => undefined
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);

    view.contentEl.querySelector<HTMLButtonElement>(".typst-preview-diagnostic")?.click();

    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
    await view.close();
  });

  it("distinguishes a missing compiler and cleans the backend on close", async () => {
    vi.useFakeTimers();
    const disposeBackend = vi.fn();
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockRejectedValue(
        new CompilerClientError("unavailable", "Typstian compiler could not be loaded.")
      ),
      jump: vi.fn(),
      forward: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend,
      pdfEngine: makePdfEngine().engine,
      complete: vi.fn(),
      definition: vi.fn(),
      requestSaveLayout: vi.fn()
    });
    await view.setState({ sourcePath: "book/main.typ" }, {} as never);
    await view.open();
    await vi.advanceTimersByTimeAsync(300);

    expect(view.contentEl.textContent).toContain("Typstian compiler could not be loaded.");
    await view.close();
    await view.close();

    expect(disposeBackend).toHaveBeenCalledOnce();
  });

  it("saves the compiled PDF from the toolbar", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = makePdfEngine(1);
    const savePdf = vi.fn();
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn(),
      forward: vi.fn(),
      complete: vi.fn(),
      definition: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      savePdf,
      requestSaveLayout: () => undefined
    });
    await view.setState({ sourcePath: "book/main.typ", zoom: 1, fit: false }, {} as never);
    await view.open();

    const button = view.contentEl.querySelector<HTMLButtonElement>(
      "button[aria-label='Save the compiled PDF to the vault']"
    );
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
    button!.click();

    expect(savePdf).toHaveBeenCalledWith("book/main.typ");
    await view.close();
  });

  it("cannot save while the preview follows no Typst source", async () => {
    const { engine } = makePdfEngine(1);
    const savePdf = vi.fn();
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn(),
      jump: vi.fn(),
      forward: vi.fn(),
      complete: vi.fn(),
      definition: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      savePdf,
      requestSaveLayout: () => undefined
    });
    await view.open();

    const button = view.contentEl.querySelector<HTMLButtonElement>(
      "button[aria-label='Save the compiled PDF to the vault']"
    );
    expect(button?.disabled).toBe(true);
    button!.click();

    expect(savePdf).not.toHaveBeenCalled();
    await view.close();
  });

  it("disables the save button while a save runs, so no second one starts", async () => {
    const { engine } = makePdfEngine(1);
    let finishSave!: () => void;
    const savePdf = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn(),
      forward: vi.fn(),
      complete: vi.fn(),
      definition: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      savePdf,
      requestSaveLayout: () => undefined
    });
    await view.setState({ sourcePath: "book/main.typ", zoom: 1, fit: false }, {} as never);
    await view.open();
    const button = view.contentEl.querySelector<HTMLButtonElement>(
      "button[aria-label='Save the compiled PDF to the vault']"
    )!;

    button.click();
    await Promise.resolve();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Saving…");

    button.click();
    expect(savePdf).toHaveBeenCalledTimes(1);

    finishSave();
    await vi.waitFor(() => { expect(button.disabled).toBe(false); });
    expect(button.textContent).toBe("Save");

    button.click();
    expect(savePdf).toHaveBeenCalledTimes(2);
    await view.close();
  });

  it("frees the save button again when the save fails", async () => {
    const { engine } = makePdfEngine(1);
    const savePdf = vi.fn(() => Promise.reject(new Error("no room in the vault")));
    const view = new TestPreviewView({} as WorkspaceLeaf, {
      compile: vi.fn().mockResolvedValue(success()),
      jump: vi.fn(),
      forward: vi.fn(),
      complete: vi.fn(),
      definition: vi.fn(),
      onSourceLocation: vi.fn(),
      onCompiled: vi.fn(),
      onDiagnostic: vi.fn(),
      disposeBackend: vi.fn(),
      pdfEngine: engine,
      savePdf,
      requestSaveLayout: () => undefined
    });
    await view.setState({ sourcePath: "book/main.typ", zoom: 1, fit: false }, {} as never);
    await view.open();
    const button = view.contentEl.querySelector<HTMLButtonElement>(
      "button[aria-label='Save the compiled PDF to the vault']"
    )!;

    button.click();
    await Promise.resolve();
    expect(button.textContent).toBe("Saving…");

    await vi.waitFor(() => { expect(button.textContent).toBe("Save"); });
    expect(button.disabled).toBe(false);
    await view.close();
  });
});
