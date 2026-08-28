// @vitest-environment happy-dom

import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PdfPreviewRenderer,
  type PdfDocumentHandle,
  type PdfEngine,
  type PdfLoadingTask,
  type PdfPageHandle,
  type PdfRenderTask,
  type PdfTextLayerTask,
  type PdfViewport,
} from "../src/pdf-preview-renderer";

import fs from "node:fs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function completedTask(): PdfRenderTask {
  return { promise: Promise.resolve(), cancel: vi.fn() };
}

function popoutWindow(): Window {
  const popout = new Window();
  Object.defineProperty(popout, "createFragment", {
    configurable: true,
    value: () => popout.document.createDocumentFragment(),
  });
  return popout;
}

function viewport(page: number, scale: number, height = 800): PdfViewport {
  void page;
  return {
    width: 600 * scale,
    height: height * scale,
    rotation: 0,
    viewBox: [0, 0, 600, height],
    convertToPdfPoint: (x, y) => [x / scale, height - y / scale],
  };
}

function pageHandle(
  page: number,
  renderTask = completedTask(),
  height = 800,
): PdfPageHandle {
  return {
    getViewport: ({ scale }) => viewport(page, scale, height),
    render: vi.fn(() => renderTask),
    getTextContent: vi.fn(() => Promise.resolve({ items: [{ str: `page ${page}` }] })),
    cleanup: vi.fn(),
  };
}

function documentHandle(pages: PdfPageHandle[]): PdfDocumentHandle {
  return {
    numPages: pages.length,
    getPage: vi.fn((pageNumber) => {
      const page = pages[pageNumber - 1];
      if (page === undefined) throw new Error("missing fake page");
      return Promise.resolve(page);
    }),
  };
}

function documentHandleForRenders(
  pagesByRender: PdfPageHandle[][],
): PdfDocumentHandle {
  const pageCount = pagesByRender[0]?.length ?? 0;
  let requestCount = 0;
  return {
    numPages: pageCount,
    getPage: vi.fn((pageNumber) => {
      const renderIndex = pageCount > 0 ? Math.floor(requestCount / pageCount) : 0;
      requestCount += 1;
      const page = pagesByRender[renderIndex]?.[pageNumber - 1];
      if (page === undefined) throw new Error("missing fake page render");
      return Promise.resolve(page);
    }),
  };
}

function engineFor(documents: PdfDocumentHandle[]) {
  const loadingTasks: PdfLoadingTask[] = [];
  const destroyTasks: ReturnType<typeof vi.fn>[] = [];
  const textLayers: PdfTextLayerTask[] = [];
  const load = vi.fn(() => {
    const pdfDocument = documents.shift();
    if (pdfDocument === undefined) throw new Error("missing fake document");
    const destroy = vi.fn(() => Promise.resolve());
    const task = { promise: Promise.resolve(pdfDocument), destroy };
    loadingTasks.push(task);
    destroyTasks.push(destroy);
    return task;
  });
  const engine: PdfEngine = {
    load,
    createTextLayer: vi.fn((options: Parameters<PdfEngine["createTextLayer"]>[0]) => {
      const { container } = options;
      const task = {
        render: vi.fn(() => {
          const span = document.createElement("span");
          span.textContent = "selectable text";
          container.append(span);
          return Promise.resolve();
        }),
        cancel: vi.fn(),
      };
      textLayers.push(task);
      return task;
    }),
  };
  return { engine, load, loadingTasks, destroyTasks, textLayers };
}

function makeRect(rect: Partial<DOMRect>): DOMRect {
  return {
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    left: rect.left ?? 0,
    top: rect.top ?? 0,
    right: rect.right ?? (rect.left ?? 0) + (rect.width ?? 0),
    bottom: rect.bottom ?? (rect.top ?? 0) + (rect.height ?? 0),
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    toJSON: () => ({}),
  };
}

function setRect(element: HTMLElement, rect: Partial<DOMRect>): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(makeRect(rect));
}

function modelScrollHeightReplacements(
  root: HTMLElement,
  initialHeight: number,
): (nextHeight: number) => void {
  let visibleContent = root.firstElementChild;
  let visibleHeight = initialHeight;
  let replacementHeight = initialHeight;
  Object.defineProperty(root, "scrollHeight", {
    configurable: true,
    get: () => root.firstElementChild === visibleContent ? visibleHeight : replacementHeight,
  });
  return (nextHeight: number): void => {
    const currentHeight = root.scrollHeight;
    visibleContent = root.firstElementChild;
    visibleHeight = currentHeight;
    replacementHeight = nextHeight;
  };
}

function pdfRenderer(
  root: HTMLElement,
  options: Omit<ConstructorParameters<typeof PdfPreviewRenderer>[1], "toolbar"> & {
    toolbar?: HTMLElement;
  },
): PdfPreviewRenderer {
  const toolbar = options.toolbar ?? root.ownerDocument.createElement("nav");
  return new PdfPreviewRenderer(root, { ...options, toolbar });
}

describe("PdfPreviewRenderer", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

it("shows accessible page position and disabled edge controls", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const toolbar = document.createElement("nav");
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2), pageHandle(3)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });

    await renderer.render(new Uint8Array([1]));

    const previous = toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous PDF page"]',
    );
    const next = toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Next PDF page"]',
    );
    const page = toolbar.querySelector<HTMLInputElement>(
      'input[aria-label="PDF page number"]',
    );
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);
    expect(page?.value).toBe("1");
    expect(toolbar.textContent).toContain("/ 3");
  });

it("moves between existing pages with previous and next controls", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const toolbar = document.createElement("nav");
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2), pageHandle(3)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });
    await renderer.render(new Uint8Array([1]));
    const pages = root.querySelectorAll<HTMLElement>(".typst-pdf-page");
    const scrollToSecond = vi.fn();
    const scrollToFirst = vi.fn();
    pages[1]!.scrollIntoView = scrollToSecond;
    pages[0]!.scrollIntoView = scrollToFirst;

    toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Next PDF page"]',
    )!.click();

    expect(scrollToSecond).toHaveBeenCalledWith({ block: "center" });
    expect(toolbar.querySelector<HTMLInputElement>(
      'input[aria-label="PDF page number"]',
    )?.value).toBe("2");

    toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous PDF page"]',
    )!.click();

    expect(scrollToFirst).toHaveBeenCalledWith({ block: "center" });
  });

it("accepts only safe in-range page numbers and restores invalid input", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const toolbar = document.createElement("nav");
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2), pageHandle(3)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });
    await renderer.render(new Uint8Array([1]));
    const input = toolbar.querySelector<HTMLInputElement>(
      'input[aria-label="PDF page number"]',
    )!;
    const pageThree = root.querySelector<HTMLElement>(
      '.typst-pdf-page[data-page="3"]',
    )!;
    const scrollToThird = vi.fn();
    pageThree.scrollIntoView = scrollToThird;
    const roguePage = root.createDiv({ cls: "typst-pdf-page" });
    roguePage.dataset.page = "4";
    const scrollToRogue = vi.fn();
    roguePage.scrollIntoView = scrollToRogue;

    input.value = "3";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(scrollToThird).toHaveBeenCalledOnce();
    expect(toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous PDF page"]',
    )?.disabled).toBe(false);
    expect(toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Next PDF page"]',
    )?.disabled).toBe(true);
    for (const invalid of ["0", "4", "1.5", "9007199254740992", "not-a-number"]) {
      scrollToThird.mockClear();
      input.value = invalid;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(scrollToThird).not.toHaveBeenCalled();
      expect(scrollToRogue).not.toHaveBeenCalled();
      expect(input.value).toBe("3");
    }
  });

it("tracks the centered observed page while scrolling", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    let observerCallback: IntersectionObserverCallback | null = null;
    vi.stubGlobal("IntersectionObserver", class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "200% 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    });
    const root = document.createElement("section");
    const toolbar = document.createElement("nav");
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 100 });
    setRect(root, { top: 0, bottom: 100, height: 100 });
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2), pageHandle(3)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });
    await renderer.render(new Uint8Array([1]));
    const pages = root.querySelectorAll<HTMLElement>(".typst-pdf-page");
    const firstRect = vi.spyOn(pages[0]!, "getBoundingClientRect")
      .mockReturnValue(makeRect({ top: -120, bottom: -20, height: 100 }));
    const secondRect = vi.spyOn(pages[1]!, "getBoundingClientRect")
      .mockReturnValue(makeRect({ top: 20, bottom: 120, height: 100 }));
    const thirdRect = vi.spyOn(pages[2]!, "getBoundingClientRect")
      .mockReturnValue(makeRect({ top: 140, bottom: 240, height: 100 }));
    observerCallback!([
      { target: pages[0], isIntersecting: true },
      { target: pages[1], isIntersecting: true },
    ] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
    thirdRect.mockClear();

    root.dispatchEvent(new Event("scroll"));

    const input = toolbar.querySelector<HTMLInputElement>(
      'input[aria-label="PDF page number"]',
    );
    expect(input?.value).toBe("2");
    expect(thirdRect).not.toHaveBeenCalled();

    firstRect.mockReturnValue(makeRect({ top: -240, bottom: -140, height: 100 }));
    secondRect.mockReturnValue(makeRect({ top: -120, bottom: -20, height: 100 }));
    thirdRect.mockReturnValue(makeRect({ top: 20, bottom: 120, height: 100 }));
    root.dispatchEvent(new Event("scroll"));
    expect(input?.value).toBe("2");

    observerCallback!([
      { target: pages[0], isIntersecting: false },
      { target: pages[1], isIntersecting: false },
      { target: pages[2], isIntersecting: true },
    ] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);

    expect(input?.value).toBe("3");
  });

it("removes page controls and their behavior on dispose", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const toolbar = document.createElement("nav");
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });
    await renderer.render(new Uint8Array([1]));
    const navigation = toolbar.querySelector<HTMLElement>(
      '.typst-pdf-page-navigation',
    )!;
    const next = navigation.querySelector<HTMLButtonElement>(
      'button[aria-label="Next PDF page"]',
    )!;

    await renderer.dispose();
    const replacementPage = root.createDiv({ cls: "typst-pdf-page" });
    replacementPage.dataset.page = "2";
    const scroll = vi.fn();
    replacementPage.scrollIntoView = scroll;
    next.click();

    expect(toolbar.contains(navigation)).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

it("resets page controls when the rendered document is cleared", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const toolbar = document.createElement("nav");
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });
    await renderer.render(new Uint8Array([1]));

    await renderer.clear();

    expect(toolbar.querySelector<HTMLInputElement>(
      'input[aria-label="PDF page number"]',
    )?.value).toBe("");
    expect(toolbar.textContent).toContain("/ 0");
    expect(toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous PDF page"]',
    )?.disabled).toBe(true);
    expect(toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Next PDF page"]',
    )?.disabled).toBe(true);
  });

it("keeps visible page controls stable until replacement pages swap in", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const replacementRender = deferred<void>();
    const replacementPage = pageHandle(1, {
      promise: replacementRender.promise,
      cancel: vi.fn(),
    });
    const replacementStarted = vi.spyOn(replacementPage, "render");
    const root = document.createElement("section");
    const toolbar = document.createElement("nav");
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2)]),
      documentHandle([replacementPage, pageHandle(2), pageHandle(3)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });
    await renderer.render(new Uint8Array([1]));
    toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Next PDF page"]',
    )!.click();

    const replacing = renderer.render(new Uint8Array([2]));
    await vi.waitFor(() => expect(replacementStarted).toHaveBeenCalledOnce());

    expect(toolbar.querySelector<HTMLInputElement>(
      'input[aria-label="PDF page number"]',
    )?.value).toBe("2");
    expect(toolbar.textContent).toContain("/ 2");

    replacementRender.resolve();
    await replacing;
    expect(toolbar.querySelector<HTMLInputElement>(
      'input[aria-label="PDF page number"]',
    )?.value).toBe("1");
    expect(toolbar.textContent).toContain("/ 3");
  });

  it("renders Blob bytes as ordered canvas pages with selectable text layers", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine, load } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2)]),
    ]);
    const renderer = pdfRenderer(root, { engine });

    await renderer.render(new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }));
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".typst-pdf-text-layer span")).toHaveLength(2);
    });

    expect(load).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(root.querySelectorAll(".typst-pdf-page canvas")).toHaveLength(2);
    expect(root.querySelectorAll(".typst-pdf-text-layer")).toHaveLength(2);
    expect(root.querySelectorAll(".typst-pdf-text-layer span")).toHaveLength(2);
    expect(root.classList.contains("typst-pdf-preview-scroll")).toBe(true);
  });

  it("reuses the loaded PDF document for zoom and fit controls", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 300 });
    const { engine, load } = engineFor([
      documentHandle([pageHandle(1)]),
    ]);
    const renderer = pdfRenderer(root, { engine });

    await renderer.render(new Uint8Array([1]));
    await renderer.zoomIn();
    await renderer.zoomOut();
    await renderer.fitToWidth();

    expect(load).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLElement>(".typst-pdf-page")?.style.getPropertyValue("--typst-pdf-page-width")).toBe("300px");
  });

  it("shows the priority page before a delayed large document finishes", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const delayedRender = deferred<void>();
    const pages = Array.from(
      { length: 49 },
      (_, index) => pageHandle(
        index + 1,
        index === 1
          ? { promise: delayedRender.promise, cancel: vi.fn() }
          : completedTask(),
      ),
    );
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle(pages)]);
    const renderer = pdfRenderer(root, { engine });

    const rendering = renderer.render(new Uint8Array([1]));
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".typst-pdf-page")).toHaveLength(49);
    });

    expect(root.querySelector('.typst-pdf-page[data-page="1"] .typst-pdf-text-layer span'))
      .not.toBeNull();
    expect(root.querySelector('.typst-pdf-page[data-page="2"] .typst-pdf-text-layer span'))
      .toBeNull();

    delayedRender.resolve();
    await rendering;
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".typst-pdf-text-layer span")).toHaveLength(49);
    });
  });

  it("prioritizes the anchored page and reveals it before distant pages finish", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const delayedFirstPage = deferred<void>();
    const initialPages = Array.from({ length: 49 }, (_, index) => pageHandle(index + 1));
    const rerenderPages = Array.from(
      { length: 49 },
      (_, index) => pageHandle(
        index + 1,
        index === 0
          ? { promise: delayedFirstPage.promise, cancel: vi.fn() }
          : completedTask(),
      ),
    );
    const anchoredPageRender = vi.spyOn(rerenderPages[24]!, "render");
    const root = document.createElement("section");
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 49 * 800 },
    });
    setRect(root, { top: 0, height: 400 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.classList.contains("typst-pdf-page")) return makeRect({ top: 0, height: 400 });
      const height = Number(this.dataset.renderedHeight);
      const page = Number(this.dataset.page);
      return makeRect({
        top: (page - 1) * height - root.scrollTop,
        width: Number(this.dataset.renderedWidth),
        height,
      });
    });
    const { engine } = engineFor([
      documentHandleForRenders([initialPages, rerenderPages]),
    ]);
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".typst-pdf-text-layer span")).toHaveLength(49);
    });
    root.scrollTop = 24 * 800 + 200;
    const previousPages = root.firstElementChild;

    const rerendering = renderer.zoomIn();
    await vi.waitFor(() => {
      expect(root.firstElementChild).not.toBe(previousPages);
    });

    expect(anchoredPageRender).toHaveBeenCalledOnce();
    expect(renderer.reveal({ page: 25, xPt: 60, yPt: 80 })).toBe(true);

    delayedFirstPage.resolve();
    await rerendering;
  });

  it("keeps visible click mapping active until a control rerender swaps pages", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const delayedZoom = deferred<void>();
    const zoomPage = pageHandle(1, { promise: delayedZoom.promise, cancel: vi.fn() });
    const zoomPageRender = vi.spyOn(zoomPage, "render");
    const root = document.createElement("section");
    const onPoint = vi.fn();
    const { engine } = engineFor([
      documentHandleForRenders([[pageHandle(1)], [zoomPage]]),
    ]);
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const visiblePage = root.querySelector<HTMLElement>(".typst-pdf-page");
    if (visiblePage === null) throw new Error("missing visible page");
    setRect(visiblePage, { width: 600, height: 800 });

    const rerendering = renderer.zoomIn();
    await vi.waitFor(() => expect(zoomPageRender).toHaveBeenCalledOnce());
    visiblePage.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    }));

    expect(onPoint).toHaveBeenCalledWith({ page: 1, xPt: 100, yPt: 100 });

    delayedZoom.resolve();
    await rerendering;
  });

  it("does not resume background page rendering after disposal", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const delayedSecondPage = deferred<void>();
    const secondPage = pageHandle(2, {
      promise: delayedSecondPage.promise,
      cancel: vi.fn(),
    });
    const secondPageRender = vi.spyOn(secondPage, "render");
    const thirdPage = pageHandle(3);
    const thirdPageRender = vi.spyOn(thirdPage, "render");
    const root = document.createElement("section");
    const { engine, destroyTasks } = engineFor([
      documentHandle([pageHandle(1), secondPage, thirdPage]),
    ]);
    const renderer = pdfRenderer(root, { engine });

    const rendering = renderer.render(new Uint8Array([1]));
    await vi.waitFor(() => expect(secondPageRender).toHaveBeenCalledOnce());
    expect(root.querySelectorAll(".typst-pdf-page")).toHaveLength(3);

    await renderer.dispose();
    delayedSecondPage.resolve();
    await rendering;

    expect(root.childElementCount).toBe(0);
    expect(thirdPageRender).not.toHaveBeenCalled();
    expect(destroyTasks[0]).toHaveBeenCalledOnce();
  });

  it("shows the anchored page before a delayed distant getPage resolves", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const delayedLastPage = deferred<PdfPageHandle>();
    const initialPages = Array.from({ length: 49 }, (_, index) => pageHandle(index + 1));
    const rerenderPages = Array.from({ length: 49 }, (_, index) => pageHandle(index + 1));
    const anchoredPageRender = vi.spyOn(rerenderPages[24]!, "render");
    let useRerenderPages = false;
    const pdfDocument: PdfDocumentHandle = {
      numPages: 49,
      getPage: vi.fn((pageNumber) => {
        if (useRerenderPages && pageNumber === 49) return delayedLastPage.promise;
        const page = (useRerenderPages ? rerenderPages : initialPages)[pageNumber - 1];
        if (page === undefined) throw new Error("missing fake page");
        return Promise.resolve(page);
      }),
    };
    const root = document.createElement("section");
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 49 * 800 },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.classList.contains("typst-pdf-page")) return makeRect({ top: 0, height: 400 });
      const height = Number(this.dataset.renderedHeight);
      const page = Number(this.dataset.page);
      return makeRect({
        top: (page - 1) * height - root.scrollTop,
        width: Number(this.dataset.renderedWidth),
        height,
      });
    });
    const { engine } = engineFor([pdfDocument]);
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));
    root.scrollTop = 24 * 800 + 200;
    const previousPages = root.firstElementChild;
    useRerenderPages = true;

    const rerendering = renderer.zoomIn();
    await vi.waitFor(() => expect(anchoredPageRender).toHaveBeenCalledOnce());

    expect(root.firstElementChild).not.toBe(previousPages);

    delayedLastPage.resolve(rerenderPages[48]!);
    await rerendering;
  });

  it("prioritizes reveal rendering ahead of blocked background pages", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const delayedSecondPage = deferred<void>();
    const pages = Array.from(
      { length: 49 },
      (_, index) => pageHandle(
        index + 1,
        index === 1
          ? { promise: delayedSecondPage.promise, cancel: vi.fn() }
          : completedTask(),
      ),
    );
    const secondPageRender = vi.spyOn(pages[1]!, "render");
    const lastPageRender = vi.spyOn(pages[48]!, "render");
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle(pages)]);
    const renderer = pdfRenderer(root, { engine });

    const rendering = renderer.render(new Uint8Array([1]));
    await vi.waitFor(() => expect(secondPageRender).toHaveBeenCalledOnce());

    expect(renderer.reveal({ page: 49, xPt: 60, yPt: 80 })).toBe(true);
    await vi.waitFor(() => expect(lastPageRender).toHaveBeenCalledOnce());

    const lastPage = root.querySelector<HTMLElement>('.typst-pdf-page[data-page="49"]');
    expect(lastPage?.querySelector(".typst-pdf-forward-marker")).not.toBeNull();
    expect(lastPage?.querySelector(".typst-pdf-text-layer span")).not.toBeNull();

    delayedSecondPage.resolve();
    await rendering;
  });

  it("resolves a stale control render when PDF.js cancellation rejects", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const canceledRender = deferred<void>();
    const cancelZoom = vi.fn(() => canceledRender.reject(new Error("render canceled")));
    const zoomPage = pageHandle(1, { promise: canceledRender.promise, cancel: cancelZoom });
    const zoomPageRender = vi.spyOn(zoomPage, "render");
    const root = document.createElement("section");
    const { engine } = engineFor([
      documentHandleForRenders([[pageHandle(1)], [zoomPage], [pageHandle(1)]]),
    ]);
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));

    const zooming = renderer.zoomIn();
    await vi.waitFor(() => expect(zoomPageRender).toHaveBeenCalledOnce());
    const fitting = renderer.fitToWidth();

    await expect(zooming).resolves.toBeUndefined();
    await fitting;
    expect(cancelZoom).toHaveBeenCalledOnce();
  });

  it("scrolls to an output point and removes its transient marker", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const previousScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      const root = document.createElement("section");
      const { engine } = engineFor([documentHandle([pageHandle(1)])]);
      const renderer = pdfRenderer(root, { engine, zoom: 2 });
      await renderer.render(new Uint8Array([1]));

      const page = root.querySelector<HTMLElement>(".typst-pdf-page")!;
      expect(renderer.reveal({ page: 1, xPt: 60, yPt: 80 })).toBe(true);
      const marker = page.querySelector<HTMLElement>(".typst-pdf-forward-marker");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center" });
      expect(scrollIntoView.mock.instances[0]).toBe(marker);
      expect(marker?.style.getPropertyValue("--typst-pdf-marker-x")).toBe("120px");
      expect(marker?.style.getPropertyValue("--typst-pdf-marker-y")).toBe("160px");

      await vi.runAllTimersAsync();
      expect(page.querySelector(".typst-pdf-forward-marker")).toBeNull();
    } finally {
      if (previousScrollIntoView === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScrollIntoView);
      }
      vi.useRealTimers();
    }
  });

  it("keeps rendered page dimensions as the PDF content box", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const renderer = pdfRenderer(root, { engine, zoom: 2 });

    await renderer.render(new Uint8Array([1]));

    const page = root.querySelector<HTMLElement>(".typst-pdf-page");
    expect(page?.style.getPropertyValue("--typst-pdf-page-width")).toBe("1200px");
    expect(page?.style.getPropertyValue("--typst-pdf-page-height")).toBe("1600px");
  });

  it("configures PDF.js text-layer scale from the rendered viewport", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const renderer = pdfRenderer(root, { engine, zoom: 2 });

    await renderer.render(new Uint8Array([1]));

    const textLayer = root.querySelector<HTMLElement>(".typst-pdf-text-layer");
    expect(textLayer?.style.getPropertyValue("--scale-factor")).toBe("2");
  });

  it("excludes page borders when mapping clicks to PDF points", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const page = root.querySelector<HTMLElement>(".typst-pdf-page");
    if (page === null) throw new Error("missing page");
    page.style.borderStyle = "solid";
    page.style.borderLeftWidth = "10px";
    page.style.borderRightWidth = "0";
    page.style.borderTopWidth = "20px";
    page.style.borderBottomWidth = "0";
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      borderLeftWidth: "10px",
      borderRightWidth: "0px",
      borderTopWidth: "20px",
      borderBottomWidth: "0px",
    } as CSSStyleDeclaration);
    setRect(page, { left: 100, top: 200, width: 610, height: 820 });

    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 410,
      clientY: 620,
    }));

    expect(onPoint).toHaveBeenCalledWith({ page: 1, xPt: 300, yPt: 400 });
  });

  it("exposes PDF pages as focused keyboard inverse-search targets", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2)]),
    ]);
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const second = root.querySelector<HTMLElement>('.typst-pdf-page[data-page="2"]');
    if (second === null) throw new Error("missing second page");
    setRect(second, { left: 100, top: 200, width: 300, height: 400 });

    expect(second.tabIndex).toBe(-1);
    expect(second.getAttribute("role")).toBe("region");
    expect(second.getAttribute("aria-label")).toBe("PDF page 2");
    const sourceButton = second.querySelector<HTMLButtonElement>(".typst-pdf-source-jump");
    if (sourceButton === null) throw new Error("missing source jump button");
    expect(sourceButton.type).toBe("button");
    expect(sourceButton.getAttribute("aria-label")).toBe("Jump to source from PDF page 2");

    sourceButton.click();
    expect(onPoint).toHaveBeenCalledOnce();
    expect(onPoint).toHaveBeenCalledWith({ page: 2, xPt: 300, yPt: 400 });

    const stylesheet = fs.readFileSync("styles.css", "utf8");
    expect(stylesheet).toMatch(
      /\.typst-pdf-source-jump:focus-visible\s*\{[^}]*outline:/s,
    );
    await renderer.dispose();
  });

  it("maps unmodified primary clicks and ignores modifier clicks", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([pageHandle(1), pageHandle(2)])]);
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const pages = root.querySelectorAll<HTMLElement>(".typst-pdf-page");
    const second = pages[1];
    if (second === undefined) throw new Error("missing second page");
    setRect(second, { left: 100, top: 200, width: 300, height: 400 });

    second.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 250,
      clientY: 400,
    }));
    expect(onPoint).toHaveBeenCalledOnce();
    expect(onPoint).toHaveBeenCalledWith({ page: 2, xPt: 300, yPt: 400 });

    for (const modifier of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      second.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 175,
        clientY: 300,
        ...modifier,
      }));
    }
    expect(onPoint).toHaveBeenCalledOnce();
  });

  it("does not navigate selected text, controls, handled events, or secondary clicks", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const page = root.querySelector<HTMLElement>(".typst-pdf-page");
    const text = root.querySelector<HTMLElement>(".typst-pdf-text-layer span");
    if (page === null || text === null) throw new Error("missing rendered PDF content");
    setRect(page, { width: 600, height: 800 });

    let selectionCollapsed = false;
    vi.spyOn(window, "getSelection").mockImplementation(
      () => ({ isCollapsed: selectionCollapsed }) as Selection,
    );
    text.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160,
    }));

    selectionCollapsed = true;
    const link = document.createElement("a");
    link.href = "https://example.com";
    page.append(link);
    link.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160,
    }));
    const control = document.createElement("button");
    page.append(control);
    control.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 160,
    }));
    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 2,
      clientX: 120,
      clientY: 160,
    }));
    const prevented = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 120,
      clientY: 160,
    });
    prevented.preventDefault();
    page.dispatchEvent(prevented);

    expect(prevented.defaultPrevented).toBe(true);
    expect(onPoint).not.toHaveBeenCalled();
  });

  it("preserves interactive clicks in a popout window", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const popout = popoutWindow();
    const root = popout.document.createElement("section") as unknown as HTMLElement;
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const page = root.querySelector<HTMLElement>(".typst-pdf-page");
    if (page === null) throw new Error("missing popout PDF page");
    setRect(page, { left: 0, top: 0, width: 600, height: 800 });
    const link = popout.document.createElement("a") as unknown as HTMLElement;
    link.setAttribute("href", "#destination");
    page.append(link);

    vi.stubGlobal("Element", class MainWindowElement {});
    link.dispatchEvent(new popout.MouseEvent("click", {
      bubbles: true,
      clientX: 300,
      clientY: 400,
    }) as unknown as MouseEvent);

    expect(onPoint).not.toHaveBeenCalled();
    await renderer.dispose();
    popout.close();
  });

  it("maps the visual top to top-left Typst points and rejects letterbox clicks", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const page = root.querySelector<HTMLElement>(".typst-pdf-page");
    if (page === null) throw new Error("missing page");
    setRect(page, { left: 100, top: 200, width: 400, height: 400 });

    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 125,
      clientY: 210,
    }));
    expect(onPoint).not.toHaveBeenCalled();

    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 200,
      clientY: 210,
    }));
    expect(onPoint).toHaveBeenCalledWith({ page: 1, xPt: 100, yPt: 20 });
  });

  it("does not emit source points for rotated non-Typst pages", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const rotated = pageHandle(1);
    rotated.getViewport = ({ scale }) => ({ ...viewport(1, scale), rotation: 90 });
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([rotated])]);
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const page = root.querySelector<HTMLElement>(".typst-pdf-page");
    if (page === null) throw new Error("missing page");
    setRect(page, { width: 600, height: 800 });

    page.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      ctrlKey: true,
      clientX: 100,
      clientY: 100,
    }));

    expect(onPoint).not.toHaveBeenCalled();
  });

  it("rerenders at bounded zoom and fit-width scale", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const root = document.createElement("section");
    let rootWidth = 300;
    Object.defineProperty(root, "clientWidth", { get: () => rootWidth });
    const documents = Array.from({ length: 4 }, () => documentHandle([pageHandle(1)]));
    const { engine } = engineFor(documents);
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));

    await renderer.setZoom(9);
    expect(renderer.serialize()).toEqual({ zoom: 4, fit: false });
    expect(root.querySelector<HTMLElement>(".typst-pdf-page")?.style.getPropertyValue("--typst-pdf-page-width")).toBe("2400px");

    await renderer.fitToWidth();
    expect(renderer.serialize()).toEqual({ zoom: 4, fit: true });
    expect(root.querySelector<HTMLElement>(".typst-pdf-page")?.style.getPropertyValue("--typst-pdf-page-width")).toBe("300px");

    rootWidth = 60;
    await renderer.fitToWidth();
    expect(root.querySelector<HTMLElement>(".typst-pdf-page")?.style.getPropertyValue("--typst-pdf-page-width")).toBe("60px");
  });


  it("fits page content inside preview padding and page borders", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const style = document.createElement("style");
    style.textContent = [
      ".typst-pdf-preview-scroll { --typst-pdf-page-border-width: 1px; }",
      ".typst-pdf-page { border: 1px solid transparent; }",
    ].join("\n");
    document.head.append(style);
    const root = document.createElement("section");
    root.style.paddingLeft = "16px";
    root.style.paddingRight = "16px";
    document.body.append(root);
    Object.defineProperty(root, "clientWidth", { value: 300 });
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const renderer = pdfRenderer(root, { engine, fit: true });

    await renderer.render(new Uint8Array([1]));

    expect(root.querySelector<HTMLElement>(".typst-pdf-page")?.style.getPropertyValue("--typst-pdf-page-width")).toBe("266px");
    await renderer.dispose();
    root.remove();
    style.remove();
  });

  it("bounds raster pixels while preserving the CSS zoom size", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const page = pageHandle(1);
    const renderPage = vi.spyOn(page, "render");
    const { engine } = engineFor([documentHandle([page])]);
    const root = documentRoot();
    const renderer = pdfRenderer(root, {
      engine,
      pixelRatio: 4,
      zoom: 4,
    });

    await renderer.render(new Uint8Array([1]));

    const canvas = root.querySelector<HTMLCanvasElement>("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.style.getPropertyValue("--typst-pdf-canvas-width")).toBe("2400px");
    expect(canvas?.style.getPropertyValue("--typst-pdf-canvas-height")).toBe("3200px");
    expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(16_777_216);
    expect(canvas?.width).toBeLessThanOrEqual(8_192);
    expect(canvas?.height).toBeLessThanOrEqual(8_192);
    const renderOptions = renderPage.mock.calls[0]?.[0];
    expect(renderOptions?.transform).toEqual([
      (canvas?.width ?? 0) / 2400,
      0,
      0,
      (canvas?.height ?? 0) / 3200,
      0,
      0,
    ]);
    await renderer.dispose();
  });


  it("does not rerender when only scrollbar occupancy changes client width", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    let notifyResize: ((borderBoxWidth: number) => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = (borderBoxWidth) => {
          callback([{
            borderBoxSize: [{ inlineSize: borderBoxWidth, blockSize: 800 }],
          } as unknown as ResizeObserverEntry], this);
        };
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    let outerWidth = 600;
    let hasVerticalScrollbar = false;
    const root = document.createElement("section");
    Object.defineProperty(root, "clientWidth", {
      configurable: true,
      get: () => outerWidth - (hasVerticalScrollbar ? 15 : 0),
    });
    const page = pageHandle(1);
    const pageRender = vi.spyOn(page, "render");
    const { engine } = engineFor([documentHandle([page])]);
    const renderer = pdfRenderer(root, { engine, fit: true });
    await renderer.render(new Uint8Array([1]));

    expect(root.classList.contains("typst-pdf-preview-scroll")).toBe(true);
    expect(root.clientWidth).toBe(600);
    for (const nextScrollbarState of [true, false, true, false]) {
      hasVerticalScrollbar = nextScrollbarState;
      expect(root.clientWidth).toBe(nextScrollbarState ? 585 : 600);
      notifyResize?.(outerWidth);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(pageRender).toHaveBeenCalledOnce();

    outerWidth = 300;
    notifyResize?.(outerWidth);
    await vi.waitFor(() => expect(pageRender).toHaveBeenCalledTimes(2));
    expect(
      root.querySelector<HTMLElement>(".typst-pdf-page")?.style.getPropertyValue("--typst-pdf-page-width"),
    ).toBe("300px");
    await renderer.dispose();
  });

  it("rerenders fitted pages when the preview width changes", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    let notifyResize: ((borderBoxWidth: number) => void) | undefined;
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = (borderBoxWidth) => {
          callback([{
            borderBoxSize: [{ inlineSize: borderBoxWidth, blockSize: 800 }],
          } as unknown as ResizeObserverEntry], this);
        };
      }

      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    let previewWidth = 600;
    const root = document.createElement("section");
    Object.defineProperties(root, {
      clientWidth: {
        configurable: true,
        get: () => previewWidth,
      },
      clientHeight: { value: 300 },
    });
    const setNextScrollHeight = modelScrollHeightReplacements(root, 1_200);
    const initialPage = pageHandle(1);
    const resizedPage = pageHandle(1);
    const resizedRender = vi.spyOn(resizedPage, "render");
    const { engine } = engineFor([
      documentHandleForRenders([[initialPage], [resizedPage]]),
    ]);
    const renderer = pdfRenderer(root, {
      engine,
      fit: true,
    });

    await renderer.render(new Uint8Array([1]));
    expect(observe).toHaveBeenCalledWith(root);
    root.scrollTop = 300;
    previewWidth = 300;
    setNextScrollHeight(600);
    notifyResize?.(previewWidth);

    await vi.waitFor(() => {
      expect(resizedRender).toHaveBeenCalledOnce();
    });
    expect(
      root.querySelector<HTMLElement>(".typst-pdf-page")?.style.getPropertyValue("--typst-pdf-page-width")
    ).toBe("300px");
    expect(root.scrollTop).toBe(100);
    await renderer.dispose();
  });


  it("disconnects preview resize observation on dispose", async () => {
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = disconnect;
    });
    const root = document.createElement("section");
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const renderer = pdfRenderer(root, { engine });

    await renderer.dispose();

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("uses the popout window resize observer", async () => {
    const popout = popoutWindow();
    const disconnect = vi.fn();
    Object.defineProperty(popout, "ResizeObserver", {
      configurable: true,
      value: class PopoutResizeObserver {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = disconnect;
      },
    });
    vi.stubGlobal("ResizeObserver", class MainWindowResizeObserver {
      constructor() {
        throw new Error("main-window ResizeObserver was used");
      }
    });
    const root = popout.document.createElement("section") as unknown as HTMLElement;
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);

    const renderer = pdfRenderer(root, { engine });
    await renderer.dispose();

    expect(root.win).toBe(popout);
    expect(disconnect).toHaveBeenCalledOnce();
    popout.close();
  });

  it("builds replacement pages with the popout document", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    vi.stubGlobal("createFragment", () => {
      throw new Error("main-window document fragment was used");
    });
    const popout = popoutWindow();
    const root = popout.document.createElement("section") as unknown as HTMLElement;
    const toolbar = popout.document.createElement("nav") as unknown as HTMLElement;
    const { engine } = engineFor([
      documentHandle([pageHandle(1), pageHandle(2)]),
    ]);
    const renderer = pdfRenderer(root, { engine, toolbar });

    await renderer.render(new Uint8Array([1]));

    const pages = root.querySelector(".typst-pdf-pages");
    const navigation = toolbar.querySelector(".typst-pdf-page-navigation");
    const secondPage = root.querySelector<HTMLElement>(
      '.typst-pdf-page[data-page="2"]',
    )!;
    const scroll = vi.fn();
    secondPage.scrollIntoView = scroll;
    toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Next PDF page"]',
    )!.click();
    expect(pages?.ownerDocument.defaultView).toBe(popout);
    expect(navigation?.ownerDocument.defaultView).toBe(popout);
    expect(scroll).toHaveBeenCalledOnce();
    await renderer.dispose();
    popout.close();
  });

  it("observes virtual pages with the popout window", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const observe = vi.fn();
    const popout = popoutWindow();
    Object.defineProperty(popout, "IntersectionObserver", {
      configurable: true,
      value: class PopoutIntersectionObserver {
        readonly root = null;
        readonly rootMargin = "200% 0px";
        readonly thresholds = [0];
        observe = observe;
        unobserve = vi.fn();
        disconnect = vi.fn();
        takeRecords(): IntersectionObserverEntry[] { return []; }
      },
    });
    vi.stubGlobal("IntersectionObserver", class MainWindowIntersectionObserver {
      constructor() {
        throw new Error("main-window IntersectionObserver was used");
      }
    });
    const root = popout.document.createElement("section") as unknown as HTMLElement;
    const { engine } = engineFor([documentHandle([pageHandle(1)])]);
    const renderer = pdfRenderer(root, { engine });

    await renderer.render(new Uint8Array([1]));

    expect(observe).toHaveBeenCalledOnce();
    await renderer.dispose();
    popout.close();
  });

  it("discards a loading generation superseded by newer PDF bytes", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = deferred<PdfDocumentHandle>();
    const destroyFirst = vi.fn(() => Promise.resolve());
    const firstTask: PdfLoadingTask = { promise: first.promise, destroy: destroyFirst };
    const secondTask: PdfLoadingTask = {
      promise: Promise.resolve(documentHandle([pageHandle(2)])),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const engine: PdfEngine = {
      load: vi.fn().mockReturnValueOnce(firstTask).mockReturnValueOnce(secondTask),
      createTextLayer: vi.fn((options: Parameters<PdfEngine["createTextLayer"]>[0]) => ({
        render: vi.fn(() => {
          const { container } = options;
          container.append(document.createElement("span"));
          return Promise.resolve();
        }),
        cancel: vi.fn(),
      })),
    };
    const root = document.createElement("section");
    const renderer = pdfRenderer(root, { engine });

    const oldRender = renderer.render(new Uint8Array([1]));
    await renderer.render(new Uint8Array([2]));
    first.resolve(documentHandle([pageHandle(1), pageHandle(1)]));
    await oldRender;

    expect(destroyFirst).toHaveBeenCalledOnce();
    expect(root.querySelectorAll(".typst-pdf-page")).toHaveLength(1);
    expect(root.querySelector(".typst-pdf-page")?.getAttribute("data-page")).toBe("1");
  });

  it("ignores modifier clicks from an old render generation", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = engineFor([
      documentHandle([pageHandle(1)]),
      documentHandle([pageHandle(1)]),
    ]);
    const root = document.createElement("section");
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    await renderer.render(new Uint8Array([1]));
    const oldPage = root.querySelector<HTMLElement>(".typst-pdf-page");
    if (oldPage === null) throw new Error("missing old page");
    setRect(oldPage, { width: 600, height: 800 });

    await renderer.render(new Uint8Array([2]));
    oldPage.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      ctrlKey: true,
      clientX: 100,
      clientY: 100,
    }));

    expect(onPoint).not.toHaveBeenCalled();
  });

  it("cancels page and text work, destroys the loader, and removes listeners on dispose", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const renderDeferred = deferred<void>();
    const cancelRender = vi.fn();
    const renderTask: PdfRenderTask = { promise: renderDeferred.promise, cancel: cancelRender };
    const { engine, destroyTasks } = engineFor([documentHandle([pageHandle(1, renderTask)])]);
    const root = document.createElement("section");
    const onPoint = vi.fn();
    const renderer = pdfRenderer(root, { engine, onPoint });
    const rendering = renderer.render(new Uint8Array([1]));
    await Promise.resolve();
    await Promise.resolve();
    const detachedPage = root.querySelector<HTMLElement>(".typst-pdf-page");

    await renderer.dispose();
    renderDeferred.resolve();
    await rendering;

    expect(cancelRender).toHaveBeenCalledOnce();
    expect(destroyTasks[0]).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);
    detachedPage?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(onPoint).not.toHaveBeenCalled();
  });

  it("cancels an active text-layer render on dispose", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const textDeferred = deferred<void>();
    const cancelText = vi.fn();
    const pdfDocument = documentHandle([pageHandle(1)]);
    const loadingTask: PdfLoadingTask = {
      promise: Promise.resolve(pdfDocument),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const createTextLayer = vi.fn(() => ({ render: () => textDeferred.promise, cancel: cancelText }));
    const engine: PdfEngine = {
      load: () => loadingTask,
      createTextLayer,
    };
    const renderer = pdfRenderer(documentRoot(), { engine });
    const rendering = renderer.render(new Uint8Array([1]));
    await vi.waitFor(() => {
      expect(createTextLayer).toHaveBeenCalledOnce();
    });

    await renderer.dispose();
    textDeferred.resolve();
    await rendering;

    expect(cancelText).toHaveBeenCalledOnce();
  });

  it("preserves vertical scroll progress after source, zoom, and fit rerenders complete", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const sourceRender = deferred<void>();
    const zoomRender = deferred<void>();
    const fitRender = deferred<void>();
    const sourcePage = pageHandle(1, { promise: sourceRender.promise, cancel: vi.fn() });
    const zoomPage = pageHandle(1, { promise: zoomRender.promise, cancel: vi.fn() });
    const fitPage = pageHandle(1, { promise: fitRender.promise, cancel: vi.fn() });
    const sourcePageRender = vi.spyOn(sourcePage, "render");
    const zoomPageRender = vi.spyOn(zoomPage, "render");
    const fitPageRender = vi.spyOn(fitPage, "render");
    const { engine } = engineFor([
      documentHandle([pageHandle(1)]),
      documentHandleForRenders([[sourcePage], [zoomPage], [fitPage]]),
    ]);
    const root = documentRoot();
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 600 },
    });
    const setNextScrollHeight = modelScrollHeightReplacements(root, 1_000);
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));
    root.scrollTop = 300;

    setNextScrollHeight(1_600);
    const sourceRerender = renderer.render(new Uint8Array([2]));
    await vi.waitFor(() => expect(sourcePageRender).toHaveBeenCalledOnce());
    sourceRender.resolve();
    await sourceRerender;
    expect(root.scrollTop).toBe(600);

    setNextScrollHeight(2_400);
    const zoomRerender = renderer.setZoom(2);
    await vi.waitFor(() => expect(zoomPageRender).toHaveBeenCalledOnce());
    zoomRender.resolve();
    await zoomRerender;
    expect(root.scrollTop).toBe(1_000);

    setNextScrollHeight(800);
    const fitRerender = renderer.fitToWidth();
    await vi.waitFor(() => expect(fitPageRender).toHaveBeenCalledOnce());
    fitRender.resolve();
    await fitRerender;
    expect(root.scrollTop).toBe(200);
  });

  it("preserves scroll progress when a control rerender supersedes active rendering", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const zoomRender = deferred<void>();
    const fitRender = deferred<void>();
    const zoomPage = pageHandle(1, { promise: zoomRender.promise, cancel: vi.fn() });
    const fitPage = pageHandle(1, { promise: fitRender.promise, cancel: vi.fn() });
    const zoomPageRender = vi.spyOn(zoomPage, "render");
    const fitPageRender = vi.spyOn(fitPage, "render");
    const { engine } = engineFor([
      documentHandleForRenders([[pageHandle(1)], [zoomPage], [fitPage]]),
    ]);
    const root = documentRoot();
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => 400 },
      clientWidth: { configurable: true, get: () => 600 },
    });
    const setNextScrollHeight = modelScrollHeightReplacements(root, 1_000);
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));
    root.scrollTop = 300;

    setNextScrollHeight(1_600);
    const zoomRerender = renderer.zoomIn();
    await vi.waitFor(() => expect(zoomPageRender).toHaveBeenCalledOnce());

    const fitRerender = renderer.fitToWidth();
    await vi.waitFor(() => expect(fitPageRender).toHaveBeenCalledOnce());
    zoomRender.resolve();
    fitRender.resolve();

    await Promise.all([zoomRerender, fitRerender]);
    expect(root.scrollTop).toBe(600);
  });

  it("keeps the current pages visible while a control rerender is in progress", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const zoomRender = deferred<void>();
    const zoomPage = pageHandle(1, { promise: zoomRender.promise, cancel: vi.fn() });
    const zoomPageRender = vi.spyOn(zoomPage, "render");
    const { engine } = engineFor([
      documentHandleForRenders([[pageHandle(1)], [zoomPage]]),
    ]);
    const root = documentRoot();
    Object.defineProperty(root, "clientHeight", { configurable: true, get: () => 400 });
    const setNextScrollHeight = modelScrollHeightReplacements(root, 1_000);
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));
    root.scrollTop = 300;
    const visiblePages = root.firstElementChild;

    setNextScrollHeight(1_600);
    const zoomRerender = renderer.zoomIn();
    await vi.waitFor(() => expect(zoomPageRender).toHaveBeenCalledOnce());

    expect(root.firstElementChild).toBe(visiblePages);
    expect(root.scrollTop).toBe(300);

    zoomRender.resolve();
    await zoomRerender;
    expect(root.firstElementChild).not.toBe(visiblePages);
    expect(root.scrollTop).toBe(600);
  });

  it("keeps the latest visible PDF point when the user scrolls during a control rerender", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const zoomRender = deferred<void>();
    const zoomPage = pageHandle(1, { promise: zoomRender.promise, cancel: vi.fn() });
    const zoomPageRender = vi.spyOn(zoomPage, "render");
    const { engine } = engineFor([
      documentHandleForRenders([[pageHandle(1)], [zoomPage]]),
    ]);
    const root = documentRoot();
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 800 + root.scrollTop / 2 },
    });
    setRect(root, { top: 0, height: 400 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("typst-pdf-page")) return makeRect({});
      const height = Number(this.dataset.renderedHeight);
      return makeRect({ top: -root.scrollTop, width: Number(this.dataset.renderedWidth), height });
    });
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));
    root.scrollTop = 100;

    const zoomRerender = renderer.zoomIn();
    await vi.waitFor(() => expect(zoomPageRender).toHaveBeenCalledOnce());
    root.scrollTop = 200;

    zoomRender.resolve();
    await zoomRerender;

    expect(root.scrollTop).toBe(300);
  });

  it("falls back to document progress when a replacement page is shorter than the anchor", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const { engine } = engineFor([
      documentHandle([pageHandle(1)]),
      documentHandle([pageHandle(1, completedTask(), 400)]),
    ]);
    const root = documentRoot();
    Object.defineProperty(root, "clientHeight", { configurable: true, get: () => 400 });
    const setNextScrollHeight = modelScrollHeightReplacements(root, 1_200);
    setRect(root, { top: 0, height: 400 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("typst-pdf-page")) return makeRect({});
      const height = Number(this.dataset.renderedHeight);
      return makeRect({ top: -root.scrollTop, width: Number(this.dataset.renderedWidth), height });
    });
    const renderer = pdfRenderer(root, { engine });
    await renderer.render(new Uint8Array([1]));
    root.scrollTop = 500;

    setNextScrollHeight(800);
    await renderer.render(new Uint8Array([2]));

    expect(root.scrollTop).toBe(250);
  });

  it("clears active work without preventing a later recovery render", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const activeRender = deferred<void>();
    const cancelRender = vi.fn();
    const activePage = pageHandle(1, { promise: activeRender.promise, cancel: cancelRender });
    const activePageRender = vi.spyOn(activePage, "render");
    const { engine, destroyTasks } = engineFor([
      documentHandle([activePage]),
      documentHandle([pageHandle(1)]),
    ]);
    const root = documentRoot();
    const renderer = pdfRenderer(root, { engine });
    const rendering = renderer.render(new Uint8Array([1]));
    await vi.waitFor(() => expect(activePageRender).toHaveBeenCalledOnce());

    await renderer.clear();
    activeRender.resolve();
    await rendering;

    expect(cancelRender).toHaveBeenCalledOnce();
    expect(destroyTasks[0]).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);

    await renderer.render(new Uint8Array([2]));
    expect(root.querySelectorAll(".typst-pdf-page")).toHaveLength(1);
  });
  it("renders and releases only pages near the viewport", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    let observerCallback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "200% 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const first = pageHandle(1);
    const second = pageHandle(2);
    const third = pageHandle(3);
    const pdfDocument = documentHandle([first, second, third]);
    const getPage = vi.spyOn(pdfDocument, "getPage");
    const secondRender = vi.spyOn(second, "render");
    const thirdCleanup = vi.spyOn(third, "cleanup");
    const { engine } = engineFor([pdfDocument]);
    const root = documentRoot();
    const renderer = pdfRenderer(root, { engine });

    await renderer.render(new Uint8Array([1]));
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getPage).toHaveBeenCalledWith(1);
    expect(observe).toHaveBeenCalledTimes(3);

    const thirdElement = root.querySelector<HTMLElement>('.typst-pdf-page[data-page="3"]');
    if (thirdElement === null || observerCallback === undefined) {
      throw new Error("missing virtual page observer");
    }
    observerCallback([
      { isIntersecting: true, target: thirdElement } as unknown as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledWith(3));
    expect(secondRender).not.toHaveBeenCalled();

    observerCallback([
      { isIntersecting: false, target: thirdElement } as unknown as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
    await vi.waitFor(() => expect(thirdCleanup).toHaveBeenCalledOnce());
    expect(thirdElement.dataset.rendered).toBe("false");
    expect(thirdElement.querySelector("canvas")).toBeNull();

    await renderer.dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });


  it("allows a virtual page render to recover after a failure", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    let observerCallback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "200% 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const failedTask: PdfRenderTask = {
      promise: Promise.reject(new Error("render failed")),
      cancel: vi.fn(),
    };
    const recoveredTask = completedTask();
    const second = pageHandle(2);
    const secondRender = vi.spyOn(second, "render")
      .mockReturnValueOnce(failedTask)
      .mockReturnValueOnce(recoveredTask);
    const { engine } = engineFor([
      documentHandle([pageHandle(1), second]),
    ]);
    const root = documentRoot();
    const renderer = pdfRenderer(root, { engine });

    await renderer.render(new Uint8Array([1]));
    const secondElement = root.querySelector<HTMLElement>(
      '.typst-pdf-page[data-page="2"]',
    );
    if (secondElement === null || observerCallback === undefined) {
      throw new Error("missing virtual page observer");
    }

    const entry = {
      isIntersecting: true,
      target: secondElement,
    } as unknown as IntersectionObserverEntry;
    observerCallback([entry], {} as IntersectionObserver);
    await vi.waitFor(() => {
      expect(secondElement.dataset.rendered).toBe("error");
    });
    const retry = secondElement.querySelector<HTMLButtonElement>(
      ".typst-pdf-page-retry",
    );
    expect(retry?.type).toBe("button");
    expect(retry?.textContent).toBe("Retry");
    expect(retry?.getAttribute("aria-label")).toBe("Retry PDF page 2");
    expect(fs.readFileSync("styles.css", "utf8")).toMatch(
      /\.typst-pdf-page-error\s*\{[^}]*(?:color|background):/s,
    );

    retry?.click();
    await vi.waitFor(() => {
      expect(secondRender).toHaveBeenCalledTimes(2);
      expect(secondElement.dataset.rendered).toBe("true");
    });
    expect(secondElement.querySelector(".typst-pdf-page-error")).toBeNull();
    await renderer.dispose();
  });
});

function documentRoot(): HTMLElement {
  return document.createElement("section");
}
