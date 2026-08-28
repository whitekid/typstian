import {
  MESSAGES,
  pdfPageLabel,
  pdfRetryLabel,
  pdfSourceLabel,
  pdfTextLayerLabel,
} from "./messages";

type PdfPreviewWindow = Window & {
  ResizeObserver?: typeof ResizeObserver;
  IntersectionObserver?: typeof IntersectionObserver;
  Element: typeof Element;
  createFragment(): DocumentFragment;
};

export interface PdfViewport {
  width: number;
  height: number;
  rotation?: number;
  viewBox?: [number, number, number, number];
  convertToPdfPoint(x: number, y: number): [number, number];
}

export interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfTextLayerTask {
  render(): Promise<void>;
  cancel(): void;
}

export interface PdfPageHandle {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
    transform?: [number, number, number, number, number, number];
  }): PdfRenderTask;
  getTextContent(): Promise<unknown>;
  cleanup(): void;
}

export interface PdfDocumentHandle {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageHandle>;
}

export interface PdfLoadingTask {
  promise: Promise<PdfDocumentHandle>;
  destroy(): Promise<void>;
}

export interface PdfEngine {
  load(data: Uint8Array): PdfLoadingTask;
  createTextLayer(options: {
    textContentSource: unknown;
    container: HTMLElement;
    viewport: PdfViewport;
  }): PdfTextLayerTask;
}

export interface PdfPreviewPoint {
  page: number;
  xPt: number;
  yPt: number;
}

interface PdfScrollAnchor {
  page: number;
  yPt: number;
  viewportOffset: number;
}

interface PdfScrollPosition {
  anchor: PdfScrollAnchor | null;
  progress: number | null;
}

export interface PdfPreviewRendererOptions {
  engine: PdfEngine;
  toolbar: HTMLElement;
  onPoint?: (point: PdfPreviewPoint) => void;
  pixelRatio?: number;
  zoom?: number;
  fit?: boolean;
}

export interface PdfPreviewViewState {
  zoom: number;
  fit: boolean;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}


const MAX_CANVAS_PIXELS = 16_777_216;
const MAX_CANVAS_DIMENSION = 8_192;

function fitScale(
  root: HTMLElement,
  pageElement: HTMLElement,
  baseWidth: number,
): number {
  const rootStyle = root.win.getComputedStyle(root);
  const pageStyle = pageElement.win.getComputedStyle(pageElement);
  const horizontalPadding = (Number.parseFloat(rootStyle.paddingLeft) || 0)
    + (Number.parseFloat(rootStyle.paddingRight) || 0);
  const configuredBorder = Number.parseFloat(
    rootStyle.getPropertyValue("--typst-pdf-page-border-width"),
  ) || 0;
  const horizontalBorder = configuredBorder > 0
    ? configuredBorder * 2
    : (Number.parseFloat(pageStyle.borderLeftWidth) || 0)
      + (Number.parseFloat(pageStyle.borderRightWidth) || 0);
  const availableWidth = Math.max(
    Number.EPSILON,
    root.clientWidth - horizontalPadding - horizontalBorder,
  );
  return Math.max(Number.EPSILON, availableWidth / baseWidth);
}

function rasterDimensions(
  viewport: PdfViewport,
  requestedPixelRatio: number,
): { width: number; height: number; scaleX: number; scaleY: number } {
  const viewportPixels = viewport.width * viewport.height;
  const pixelRatio = Math.min(
    requestedPixelRatio,
    MAX_CANVAS_DIMENSION / viewport.width,
    MAX_CANVAS_DIMENSION / viewport.height,
    Math.sqrt(MAX_CANVAS_PIXELS / viewportPixels),
  );
  const width = Math.max(1, Math.floor(viewport.width * pixelRatio));
  const height = Math.max(1, Math.floor(viewport.height * pixelRatio));
  return {
    width,
    height,
    scaleX: width / viewport.width,
    scaleY: height / viewport.height,
  };
}

export class PdfPreviewRenderer {
  private readonly engine: PdfEngine;
  private readonly onPoint: ((point: PdfPreviewPoint) => void) | undefined;
  private readonly pixelRatio: number;
  private loadingTask: PdfLoadingTask | null = null;
  private readonly renderTasks = new Set<PdfRenderTask>();
  private readonly textLayerTasks = new Set<PdfTextLayerTask>();
  private readonly pages = new Set<PdfPageHandle>();
  private readonly removeListeners = new Set<() => void>();
  private pendingRemoveListeners: Set<() => void> | null = null;
  private visibleGeneration = 0;
  private visibleRenderRequest: ((page: number) => Promise<void>) | null = null;
  private document: PdfDocumentHandle | null = null;
  private forwardPoint: PdfPreviewPoint | null = null;
  private generation = 0;
  private zoom: number;
  private fit: boolean;
  private disposed = false;

  private forwardMarker: HTMLElement | null = null;
  private forwardMarkerTimer: number | null = null;
private readonly resizeObserver: ResizeObserver | null;
  private observedWidth: number;
  private resizeTimer: number | null = null;
private pageObserver: IntersectionObserver | null = null;

private readonly pageNavigation: HTMLElement;
  private readonly previousPageButton: HTMLButtonElement;
  private readonly nextPageButton: HTMLButtonElement;
  private readonly pageNumberInput: HTMLInputElement;
  private readonly pageTotal: HTMLElement;
  private currentPage = 0;
  private totalPages = 0;

private readonly showPreviousPage = (): void => {
    this.scrollToPage(this.currentPage - 1);
  };

  private readonly showNextPage = (): void => {
    this.scrollToPage(this.currentPage + 1);
  };

private readonly commitPageNumber = (): void => {
    this.scrollToPage(Number(this.pageNumberInput.value));
  };

  private readonly handlePageNumberKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    this.commitPageNumber();
  };

private readonly visiblePageCandidates = new Set<HTMLElement>();

  private readonly handlePageScroll = (): void => {
    const candidates = this.visiblePageCandidates.size > 0
      ? this.visiblePageCandidates
      : undefined;
    const page = this.captureScrollPosition(candidates).anchor?.page;
    if (page !== undefined) this.showPagePosition(page, this.totalPages);
  };

  constructor(
    private readonly root: HTMLElement,
    options: PdfPreviewRendererOptions,
  ) {
    this.engine = options.engine;
    this.onPoint = options.onPoint;
    this.pixelRatio = Math.max(1, options.pixelRatio ?? root.win.devicePixelRatio ?? 1);
    this.zoom = clampZoom(options.zoom ?? 1);
    this.fit = options.fit ?? false;
    this.root.classList.add("typst-pdf-preview-scroll");
    this.root.addEventListener("scroll", this.handlePageScroll);

    this.pageNavigation = options.toolbar.createSpan({
      cls: "typst-pdf-page-navigation",
    });
    this.pageNavigation.setAttribute("role", "group");
    this.pageNavigation.setAttribute("aria-label", MESSAGES.pdf.pageNavigation);
    this.previousPageButton = this.pageNavigation.createEl("button");
    this.previousPageButton.type = "button";
    this.previousPageButton.textContent = "‹";
    this.previousPageButton.title = MESSAGES.pdf.previousPage;
    this.previousPageButton.setAttribute("aria-label", MESSAGES.pdf.previousPage);
    this.pageNumberInput = this.pageNavigation.createEl("input");
    this.pageNumberInput.type = "number";
    this.pageNumberInput.min = "1";
    this.pageNumberInput.step = "1";
    this.pageNumberInput.inputMode = "numeric";
    this.pageNumberInput.setAttribute("aria-label", MESSAGES.pdf.pageNumber);
    this.pageTotal = this.pageNavigation.createSpan({
      cls: "typst-pdf-page-total",
    });
    this.nextPageButton = this.pageNavigation.createEl("button");
    this.nextPageButton.type = "button";
    this.nextPageButton.textContent = "›";
    this.nextPageButton.title = MESSAGES.pdf.nextPage;
    this.nextPageButton.setAttribute("aria-label", MESSAGES.pdf.nextPage);
    this.previousPageButton.addEventListener("click", this.showPreviousPage);
    this.nextPageButton.addEventListener("click", this.showNextPage);
    this.pageNumberInput.addEventListener("change", this.commitPageNumber);
    this.pageNumberInput.addEventListener("keydown", this.handlePageNumberKeydown);
    this.showPagePosition(0, 0);

    this.observedWidth = this.root.offsetWidth
      || this.root.getBoundingClientRect().width
      || this.root.clientWidth;
    const ResizeObserverCtor = (root.win as PdfPreviewWindow).ResizeObserver;
    this.resizeObserver = typeof ResizeObserverCtor === "undefined"
      ? null
      : new ResizeObserverCtor((entries) => {
        const borderBoxWidth = entries[0]?.borderBoxSize?.[0]?.inlineSize;
        const width = borderBoxWidth ?? (
          this.root.offsetWidth
          || this.root.getBoundingClientRect().width
          || this.root.clientWidth
        );
        if (width === this.observedWidth) return;
        this.observedWidth = width;
        if (!this.fit || this.disposed) return;
        if (this.resizeTimer !== null) this.root.win.clearTimeout(this.resizeTimer);
        this.resizeTimer = this.root.win.setTimeout(() => {
          this.resizeTimer = null;
          if (!this.fit || this.disposed) return;
          void this.rerender().catch(() => undefined);
        }, 75);
      });
    this.resizeObserver?.observe(this.root);
  }
private showPagePosition(page: number, total: number): void {
    const valid = Number.isSafeInteger(page) && page >= 1 && page <= total;
    this.currentPage = valid ? page : 0;
    this.totalPages = total;
    this.pageNumberInput.value = valid ? String(page) : "";
    if (total > 0) {
      this.pageNumberInput.max = String(total);
    } else {
      this.pageNumberInput.removeAttribute("max");
    }
    this.pageTotal.textContent = `/ ${total}`;
    this.previousPageButton.disabled = !valid || page === 1;
    this.nextPageButton.disabled = !valid || page === total;
  }

private scrollToPage(page: number): boolean {
    if (!Number.isSafeInteger(page) || page < 1 || page > this.totalPages) {
      this.showPagePosition(this.currentPage, this.totalPages);
      return false;
    }
    const pageElement = this.root.querySelector<HTMLElement>(
      `.typst-pdf-page[data-page="${page}"]`,
    );
    if (pageElement === null) {
      this.showPagePosition(this.currentPage, this.totalPages);
      return false;
    }
    pageElement.scrollIntoView?.({ block: "center" });
    this.showPagePosition(page, this.totalPages);
    return true;
  }

  async render(input: Blob | Uint8Array): Promise<void> {
    if (this.disposed) return;
    this.clearForwardMarker();
    const initialScrollPosition = this.captureScrollPosition();
    const generation = ++this.generation;
    void this.stopActiveWork();

    const data = input instanceof Blob
      ? new Uint8Array(await input.arrayBuffer())
      : input;
    if (!this.isCurrent(generation)) return;

    const loadingTask = this.engine.load(data);
    this.loadingTask = loadingTask;
    try {
      const document = await loadingTask.promise;
      if (!this.isCurrent(generation) || this.loadingTask !== loadingTask) return;
      this.document = document;
      await this.renderDocument(document, generation, initialScrollPosition);
    } catch (error) {
      if (this.isCurrent(generation)) throw error;
    }
  }

  async setZoom(zoom: number): Promise<void> {
    this.zoom = clampZoom(zoom);
    this.fit = false;
    await this.rerender();
  }

  async zoomIn(): Promise<void> {
    await this.setZoom(this.zoom + ZOOM_STEP);
  }

  async zoomOut(): Promise<void> {
    await this.setZoom(this.zoom - ZOOM_STEP);
  }

  async fitToWidth(): Promise<void> {
    this.fit = true;
    await this.rerender();
  }

  serialize(): PdfPreviewViewState {
    return { zoom: this.zoom, fit: this.fit };
  }

  reveal(point: PdfPreviewPoint): boolean {
    if (
      this.disposed
      || !Number.isSafeInteger(point.page)
      || point.page < 1
      || !Number.isFinite(point.xPt)
      || point.xPt < 0
      || !Number.isFinite(point.yPt)
      || point.yPt < 0
    ) {
      return false;
    }
    const page = this.root.querySelector<HTMLElement>(
      `.typst-pdf-page[data-page="${point.page}"]`,
    );
    if (page === null) return false;
    const baseWidth = Number(page.dataset.baseWidth);
    const baseHeight = Number(page.dataset.baseHeight);
    const renderedWidth = Number(page.dataset.renderedWidth);
    const renderedHeight = Number(page.dataset.renderedHeight);
    const rendered = page.dataset.rendered === "true";
    if (
      !(baseWidth > 0)
      || !(baseHeight > 0)
      || !(renderedWidth > 0)
      || !(renderedHeight > 0)
      || (rendered && (point.xPt > baseWidth || point.yPt > baseHeight))
      || (!rendered && this.visibleRenderRequest === null)
    ) {
      return false;
    }

    this.clearForwardMarker();
    const marker = page.createSpan({ cls: "typst-pdf-forward-marker" });
    marker.setAttribute("aria-hidden", "true");
    this.positionForwardMarker(page, marker, point);
    this.forwardMarker = marker;
    this.forwardPoint = point;
    if (!rendered) {
      void this.visibleRenderRequest?.(point.page).catch(() => undefined);
    }
    marker.scrollIntoView?.({ block: "center", inline: "center" });
    this.forwardMarkerTimer = this.root.win.setTimeout(() => {
      if (this.forwardMarker !== marker) return;
      marker.remove();
      this.forwardMarker = null;
      this.forwardPoint = null;
      this.forwardMarkerTimer = null;
    }, 1_200);
    return true;
  }

  async clear(): Promise<void> {
    if (this.disposed) return;
    await this.reset();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeEventListener("scroll", this.handlePageScroll);
    this.previousPageButton.removeEventListener("click", this.showPreviousPage);
    this.nextPageButton.removeEventListener("click", this.showNextPage);
    this.pageNumberInput.removeEventListener("change", this.commitPageNumber);
    this.pageNumberInput.removeEventListener("keydown", this.handlePageNumberKeydown);
    this.pageNavigation.remove();
    this.resizeObserver?.disconnect();
    if (this.resizeTimer !== null) {
      this.root.win.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    await this.reset();
  }

  private async rerender(): Promise<void> {
    const document = this.document;
    if (this.disposed || document === null) return;
    this.clearForwardMarker();
    const initialScrollPosition = this.captureScrollPosition();
    const generation = ++this.generation;
    this.stopPageWork();
    try {
      await this.renderDocument(document, generation, initialScrollPosition);
    } catch (error) {
      if (this.isCurrent(generation)) throw error;
    }
  }

  private async renderDocument(
    document: PdfDocumentHandle,
    generation: number,
    initialScrollPosition: PdfScrollPosition,
  ): Promise<void> {
    const previousGeometry = new Map<number, { width: number; height: number }>();
    for (const page of Array.from(
      this.root.querySelectorAll<HTMLElement>(".typst-pdf-page"),
    )) {
      const pageNumber = Number(page.dataset.page);
      const width = Number(page.dataset.baseWidth);
      const height = Number(page.dataset.baseHeight);
      if (Number.isInteger(pageNumber) && pageNumber > 0 && width > 0 && height > 0) {
        previousGeometry.set(pageNumber, { width, height });
      }
    }
    const previousPages = new Set(this.pages);

    const preferredPage = document.numPages > 0
      ? Math.max(1, Math.min(document.numPages, initialScrollPosition.anchor?.page ?? 1))
      : 0;
    let priorityPage: PdfPageHandle | null = null;
    if (preferredPage > 0) {
      priorityPage = await document.getPage(preferredPage);
      if (!this.isCurrent(generation)) {
        priorityPage.cleanup();
        return;
      }
      this.pages.add(priorityPage);
    }
    const priorityBaseViewport = priorityPage?.getViewport({ scale: 1 });
    const fallbackWidth = priorityBaseViewport?.width ?? 1;
    const fallbackHeight = priorityBaseViewport?.height ?? 1;

    // Held in a fragment so the previous PDF stays visible until the priority
    // page has rendered and the whole container can be swapped in at once.
    const fragment = (this.root.win as PdfPreviewWindow).createFragment();
    const container = fragment.createDiv({ cls: "typst-pdf-pages" });

    const pageElements = new Map<number, HTMLElement>();
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const geometry = previousGeometry.get(pageNumber);
      const baseWidth = geometry?.width ?? fallbackWidth;
      const baseHeight = geometry?.height ?? fallbackHeight;
      const pageElement = container.createDiv({ cls: "typst-pdf-page" });
      const scale = this.fit && baseWidth > 0
        ? fitScale(this.root, pageElement, baseWidth)
        : this.zoom;
      pageElement.dataset.rendered = "false";
      this.configurePageElement(
        pageElement,
        pageNumber,
        baseWidth,
        baseHeight,
        baseWidth * scale,
        baseHeight * scale,
      );
      pageElements.set(pageNumber, pageElement);
    }

    const pendingRemoveListeners = new Set<() => void>();
    this.pendingRemoveListeners = pendingRemoveListeners;
    let listenerTarget = pendingRemoveListeners;
    const renderPromises = new Map<number, Promise<void>>();
    const renderingPages = new Set<number>();
    const releaseRequested = new Set<number>();
    const pageHandles = new Map<number, PdfPageHandle>();
    const pageRemoveListeners = new Map<number, Set<() => void>>();
    if (priorityPage !== null) pageHandles.set(preferredPage, priorityPage);

    const releasePage = (pageNumber: number): void => {
      if (renderingPages.has(pageNumber)) {
        releaseRequested.add(pageNumber);
        return;
      }
      const pageElement = pageElements.get(pageNumber);
      if (
        pageElement === undefined
        || pageElement.contains(pageElement.doc.activeElement)
        || (
          this.forwardMarker !== null
          && this.forwardMarker.parentElement === pageElement
        )
      ) {
        return;
      }
      for (const remove of pageRemoveListeners.get(pageNumber) ?? []) {
        remove();
        this.removeListeners.delete(remove);
        pendingRemoveListeners.delete(remove);
      }
      pageRemoveListeners.delete(pageNumber);
      const page = pageHandles.get(pageNumber);
      if (page !== undefined) {
        page.cleanup();
        this.pages.delete(page);
        pageHandles.delete(pageNumber);
      }
      pageElement.replaceChildren();
      pageElement.dataset.rendered = "false";
      renderPromises.delete(pageNumber);
      releaseRequested.delete(pageNumber);
    };

    const requestPage = (pageNumber: number): Promise<void> => {
      releaseRequested.delete(pageNumber);
      const existing = renderPromises.get(pageNumber);
      if (existing !== undefined) return existing;
      const rendering = (async () => {
        let page = pageHandles.get(pageNumber);
        if (page === undefined) {
          if (pageNumber === preferredPage && priorityPage !== null) {
            page = priorityPage;
            priorityPage = null;
          } else {
            page = await document.getPage(pageNumber);
            if (!this.isCurrent(generation)) {
              page.cleanup();
              return;
            }
            this.pages.add(page);
          }
          pageHandles.set(pageNumber, page);
        } else if (pageNumber === preferredPage) {
          priorityPage = null;
        }
        if (!this.isCurrent(generation)) return;
        const pageElement = pageElements.get(pageNumber);
        if (pageElement === undefined) return;
        const pageListeners = new Set<() => void>();
        pageRemoveListeners.set(pageNumber, pageListeners);
        renderingPages.add(pageNumber);
        try {
          await this.renderPage(
            pageElement,
            page,
            pageNumber,
            generation,
            pageListeners,
          );
          for (const remove of pageListeners) listenerTarget.add(remove);
        } finally {
          renderingPages.delete(pageNumber);
          if (releaseRequested.has(pageNumber)) releasePage(pageNumber);
        }
      })();
      const tracked = rendering.catch((error: unknown) => {
        for (const remove of pageRemoveListeners.get(pageNumber) ?? []) {
          remove();
          this.removeListeners.delete(remove);
          pendingRemoveListeners.delete(remove);
        }
        pageRemoveListeners.delete(pageNumber);
        renderPromises.delete(pageNumber);
        if (this.isCurrent(generation)) {
          const pageElement = pageElements.get(pageNumber);
          if (pageElement !== undefined) {
            pageElement.replaceChildren();
            pageElement.dataset.rendered = "error";
            const message = pageElement.createDiv({ cls: "typst-pdf-page-error" });
            message.setAttribute("role", "alert");
            message.append(MESSAGES.pdf.pageError);
            const retry = message.createEl("button", { cls: "typst-pdf-page-retry" });
            retry.type = "button";
            retry.setAttribute("aria-label", pdfRetryLabel(pageNumber));
            retry.textContent = MESSAGES.pdf.retry;
            retry.addEventListener("click", () => {
              void requestPage(pageNumber).catch(() => undefined);
            });
          }
        }
        throw error;
      });
      renderPromises.set(pageNumber, tracked);
      return tracked;
    };

    if (preferredPage > 0) await requestPage(preferredPage);
    if (!this.isCurrent(generation)) return;

    const latestScrollPosition = this.captureScrollPosition();
    const scrollPosition = latestScrollPosition.anchor !== null
      || latestScrollPosition.progress !== null
      ? latestScrollPosition
      : initialScrollPosition;
    for (const remove of this.removeListeners) remove();
    this.removeListeners.clear();
    for (const page of previousPages) {
      page.cleanup();
      this.pages.delete(page);
    }
    for (const remove of pendingRemoveListeners) this.removeListeners.add(remove);
    pendingRemoveListeners.clear();
    if (this.pendingRemoveListeners === pendingRemoveListeners) {
      this.pendingRemoveListeners = null;
    }
    listenerTarget = this.removeListeners;
    this.visibleGeneration = generation;
    this.visibleRenderRequest = requestPage;
    this.root.replaceChildren(container);
    this.showPagePosition(preferredPage, document.numPages);
    this.restoreScrollPosition(scrollPosition);

    const IntersectionObserverCtor =
      (this.root.win as PdfPreviewWindow).IntersectionObserver;
    if (typeof IntersectionObserverCtor !== "undefined") {
      const observer = new IntersectionObserverCtor((entries) => {
        if (!this.isCurrent(generation) || this.pageObserver !== observer) return;
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
          if (entry.isIntersecting) {
            this.visiblePageCandidates.add(entry.target as HTMLElement);
            void requestPage(pageNumber).catch(() => undefined);
          } else {
            this.visiblePageCandidates.delete(entry.target as HTMLElement);
            if (pageNumber !== preferredPage) releasePage(pageNumber);
          }
        }
        this.handlePageScroll();
      }, {
        root: this.root,
        rootMargin: "200% 0px",
      });
      this.pageObserver = observer;
      for (const pageElement of pageElements.values()) observer.observe(pageElement);
      return;
    }

    const remainingPages = Array.from(
      { length: document.numPages },
      (_, index) => index + 1,
    )
      .filter((pageNumber) => pageNumber !== preferredPage)
      .sort(
        (left, right) =>
          Math.abs(left - preferredPage) - Math.abs(right - preferredPage)
          || left - right,
      );
    void (async () => {
      for (const pageNumber of remainingPages) {
        if (!this.isCurrent(generation)) return;
        await requestPage(pageNumber);
      }
    })().catch(() => undefined);
  }

  private configurePageElement(
    pageElement: HTMLElement,
    pageNumber: number,
    baseWidth: number,
    baseHeight: number,
    renderedWidth: number,
    renderedHeight: number,
  ): void {
    pageElement.dataset.page = String(pageNumber);
    pageElement.dataset.baseWidth = String(baseWidth);
    pageElement.dataset.baseHeight = String(baseHeight);
    pageElement.dataset.renderedWidth = String(renderedWidth);
    pageElement.dataset.renderedHeight = String(renderedHeight);
    pageElement.style.setProperty("--typst-pdf-page-width", `${renderedWidth}px`);
    pageElement.style.setProperty("--typst-pdf-page-height", `${renderedHeight}px`);
  }

  private async renderPage(
    pageElement: HTMLElement,
    page: PdfPageHandle,
    pageNumber: number,
    generation: number,
    removeListeners: Set<() => void>,
  ): Promise<void> {
    pageElement.replaceChildren();
    const scrollPosition = generation === this.visibleGeneration
      ? this.captureScrollPosition()
      : null;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = this.fit && baseViewport.width > 0
      ? fitScale(this.root, pageElement, baseViewport.width)
      : this.zoom;
    const viewport = page.getViewport({ scale });
    this.configurePageElement(
      pageElement,
      pageNumber,
      baseViewport.width,
      baseViewport.height,
      viewport.width,
      viewport.height,
    );
    pageElement.dataset.rendered = "rendering";
    pageElement.removeAttribute("tabindex");
    pageElement.setAttribute("role", "region");
    pageElement.setAttribute("aria-label", pdfPageLabel(pageNumber));
    if (scrollPosition !== null) this.restoreScrollPosition(scrollPosition);

    const emitPoint = (viewportX: number, viewportY: number): void => {
      const [pdfX, pdfY] = viewport.convertToPdfPoint(viewportX, viewportY);
      const [xMin, , , yMax] = baseViewport.viewBox ?? [
        0,
        0,
        baseViewport.width,
        baseViewport.height,
      ];
      const xPt = pdfX - xMin;
      const yPt = yMax - pdfY;
      if (!Number.isFinite(xPt) || !Number.isFinite(yPt)) return;
      this.onPoint?.({ page: pageNumber, xPt, yPt });
    };

    const onClick = (event: MouseEvent): void => {
      if (
        generation !== this.visibleGeneration
        || this.disposed
        || event.button !== 0
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || event.defaultPrevented
      ) {
        return;
      }
      const target = event.target;
      const interactiveTarget = target instanceof (
        pageElement.win as PdfPreviewWindow
      ).Element
        ? target.closest("a[href], button, input, select, textarea, [role=button]")
        : null;
      if (interactiveTarget !== null && interactiveTarget !== pageElement) return;
      const selection = pageElement.win.getSelection?.();
      if (selection !== undefined && selection !== null && !selection.isCollapsed) return;
      const rotation = ((baseViewport.rotation ?? 0) % 360 + 360) % 360;
      if (rotation !== 0) return;
      const rect = pageElement.getBoundingClientRect();
      const style = pageElement.win.getComputedStyle(pageElement);
      const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
      const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
      const innerWidth = rect.width - borderLeft - borderRight;
      const innerHeight = rect.height - borderTop - borderBottom;
      if (!(innerWidth > 0) || !(innerHeight > 0)) return;
      const contentScale = Math.min(innerWidth / viewport.width, innerHeight / viewport.height);
      const contentWidth = viewport.width * contentScale;
      const contentHeight = viewport.height * contentScale;
      const contentLeft = rect.left + borderLeft + (innerWidth - contentWidth) / 2;
      const contentTop = rect.top + borderTop + (innerHeight - contentHeight) / 2;
      const localX = event.clientX - contentLeft;
      const localY = event.clientY - contentTop;
      if (localX < 0 || localY < 0 || localX > contentWidth || localY > contentHeight) return;
      const viewportX = localX * viewport.width / contentWidth;
      const viewportY = localY * viewport.height / contentHeight;
      emitPoint(viewportX, viewportY);
    };
    const canvas = pageElement.createEl("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("A 2D canvas context is required for PDF preview.");
    }
    const raster = rasterDimensions(viewport, this.pixelRatio);
    canvas.width = raster.width;
    canvas.height = raster.height;
    canvas.style.setProperty("--typst-pdf-canvas-width", `${viewport.width}px`);
    canvas.style.setProperty("--typst-pdf-canvas-height", `${viewport.height}px`);
    canvas.setAttribute("aria-hidden", "true");

    const textLayer = pageElement.createDiv({ cls: "typst-pdf-text-layer textLayer" });
    textLayer.setAttribute("aria-label", pdfTextLayerLabel(pageNumber));
    textLayer.style.setProperty("--scale-factor", String(scale));

    const sourceButton = pageElement.createEl("button", { cls: "typst-pdf-source-jump" });
    sourceButton.type = "button";
    sourceButton.setAttribute("aria-label", pdfSourceLabel(pageNumber));
    sourceButton.textContent = MESSAGES.pdf.source;
    const onSourceClick = (): void => {
      if (generation !== this.visibleGeneration || this.disposed) return;
      const rotation = ((baseViewport.rotation ?? 0) % 360 + 360) % 360;
      if (rotation !== 0) return;
      emitPoint(viewport.width / 2, viewport.height / 2);
    };
    sourceButton.addEventListener("click", onSourceClick);
    pageElement.addEventListener("click", onClick);
    const removeListener = (): void => {
      sourceButton.removeEventListener("click", onSourceClick);
      pageElement.removeEventListener("click", onClick);
    };
    removeListeners.add(removeListener);

    if (
      this.forwardMarker !== null
      && this.forwardPoint?.page === pageNumber
    ) {
      this.positionForwardMarker(pageElement, this.forwardMarker, this.forwardPoint);
      pageElement.append(this.forwardMarker);
    }

    const renderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      ...(raster.scaleX === 1 && raster.scaleY === 1
        ? {}
        : { transform: [raster.scaleX, 0, 0, raster.scaleY, 0, 0] }),
    });
    this.renderTasks.add(renderTask);
    try {
      await renderTask.promise;
    } finally {
      this.renderTasks.delete(renderTask);
    }
    if (!this.isCurrent(generation)) return;

    const textContentSource = await page.getTextContent();
    if (!this.isCurrent(generation)) return;
    const textLayerTask = this.engine.createTextLayer({
      textContentSource,
      container: textLayer,
      viewport,
    });
    this.textLayerTasks.add(textLayerTask);
    try {
      await textLayerTask.render();
    } finally {
      this.textLayerTasks.delete(textLayerTask);
    }
    if (this.isCurrent(generation)) {
      pageElement.dataset.rendered = "true";
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private captureScrollPosition(
    pageElements?: Iterable<HTMLElement>,
  ): PdfScrollPosition {
    const scrollRange = this.root.scrollHeight - this.root.clientHeight;
    const progress = scrollRange > 0
      ? Math.max(0, Math.min(1, this.root.scrollTop / scrollRange))
      : null;
    if (!(this.root.clientHeight > 0)) return { anchor: null, progress };

    const rootRect = this.root.getBoundingClientRect();
    const viewportOffset = this.root.clientHeight / 2;
    const viewportY = rootRect.top + viewportOffset;
    let closest: { element: HTMLElement; rect: DOMRect; distance: number } | null = null;
    const elements = pageElements ?? Array.from(
      this.root.querySelectorAll<HTMLElement>(".typst-pdf-page"),
    );
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (!(rect.height > 0)) continue;
      const distance = viewportY < rect.top
        ? rect.top - viewportY
        : viewportY > rect.bottom
          ? viewportY - rect.bottom
          : 0;
      if (closest === null || distance < closest.distance) {
        closest = { element, rect, distance };
      }
    }
    if (closest === null) return { anchor: null, progress };

    const page = Number(closest.element.dataset.page);
    const baseHeight = Number(closest.element.dataset.baseHeight);
    const renderedHeight = Number(closest.element.dataset.renderedHeight);
    if (
      !Number.isInteger(page)
      || page < 1
      || !(baseHeight > 0)
      || !(renderedHeight > 0)
    ) {
      return { anchor: null, progress };
    }

    const borderTop = Number.parseFloat(
      closest.element.win.getComputedStyle(closest.element).borderTopWidth,
    ) || 0;
    const yPt = Math.max(
      0,
      Math.min(
        baseHeight,
        (viewportY - closest.rect.top - borderTop) * baseHeight / renderedHeight,
      ),
    );
    return {
      anchor: { page, yPt, viewportOffset },
      progress,
    };
  }

  private restoreScrollPosition(position: PdfScrollPosition): void {
    const { anchor } = position;
    if (anchor !== null) {
      const page = Array.from(
        this.root.querySelectorAll<HTMLElement>(".typst-pdf-page"),
      ).find((element) => Number(element.dataset.page) === anchor.page);
      if (page !== undefined) {
        const baseHeight = Number(page.dataset.baseHeight);
        const renderedHeight = Number(page.dataset.renderedHeight);
        if (
          baseHeight > 0
          && renderedHeight > 0
          && anchor.yPt >= 0
          && anchor.yPt <= baseHeight
        ) {
          const rect = page.getBoundingClientRect();
          const borderTop = Number.parseFloat(
            page.win.getComputedStyle(page).borderTopWidth,
          ) || 0;
          const viewportY = this.root.getBoundingClientRect().top + anchor.viewportOffset;
          const anchoredY = rect.top + borderTop + anchor.yPt * renderedHeight / baseHeight;
          const delta = anchoredY - viewportY;
          if (Number.isFinite(delta)) {
            this.root.scrollTop += delta;
            return;
          }
        }
      }
    }

    if (position.progress === null) return;
    const scrollRange = Math.max(0, this.root.scrollHeight - this.root.clientHeight);
    this.root.scrollTop = position.progress * scrollRange;
  }

  private positionForwardMarker(
    page: HTMLElement,
    marker: HTMLElement,
    point: PdfPreviewPoint,
  ): void {
    const baseWidth = Number(page.dataset.baseWidth);
    const baseHeight = Number(page.dataset.baseHeight);
    const renderedWidth = Number(page.dataset.renderedWidth);
    const renderedHeight = Number(page.dataset.renderedHeight);
    marker.style.setProperty("--typst-pdf-marker-x", `${point.xPt * renderedWidth / baseWidth}px`);
    marker.style.setProperty("--typst-pdf-marker-y", `${point.yPt * renderedHeight / baseHeight}px`);
  }

  private clearForwardMarker(): void {
    if (this.forwardMarkerTimer !== null) {
      this.root.win.clearTimeout(this.forwardMarkerTimer);
      this.forwardMarkerTimer = null;
    }
    const marker = this.forwardMarker;
    this.forwardMarker = null;
    this.forwardPoint = null;
    marker?.remove();
  }

  private async reset(): Promise<void> {
    this.generation += 1;
    this.clearForwardMarker();
    this.showPagePosition(0, 0);
    const destroyed = this.stopActiveWork();
    this.root.replaceChildren();
    await destroyed;
  }

  private stopPageWork(): void {
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    this.visiblePageCandidates.clear();
    const pendingRemoveListeners = this.pendingRemoveListeners;
    this.pendingRemoveListeners = null;
    if (pendingRemoveListeners !== null) {
      for (const remove of pendingRemoveListeners) remove();
      pendingRemoveListeners.clear();
    }
    for (const task of this.renderTasks) task.cancel();
    this.renderTasks.clear();
    for (const task of this.textLayerTasks) task.cancel();
    this.textLayerTasks.clear();
  }

  private stopActiveWork(): Promise<void> {
    this.stopPageWork();
    for (const remove of this.removeListeners) remove();
    this.removeListeners.clear();
    this.visibleGeneration = 0;
    this.visibleRenderRequest = null;
    for (const page of this.pages) page.cleanup();
    this.pages.clear();
    this.document = null;

    const loadingTask = this.loadingTask;
    this.loadingTask = null;
    return loadingTask === null
      ? Promise.resolve()
      : loadingTask.destroy().catch(() => undefined);
  }
}
