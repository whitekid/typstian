import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { brotliDecompress } from "node:zlib";

import init, {
  TypstianWasmSession,
} from "../helper/wasm/pkg/typstian_wasm.js";
import type {
  EngineCompileRequest,
  WasmEngine,
  WasmEngineFactoryOptions,
} from "./compiler-client";
import {
  registerSystemFonts,
  systemFontDirectories,
  type RegisteredSystemFonts,
} from "./system-fonts";
import {
  createLocalPackageReader,
  typstPackageDirectories,
  type LocalPackages,
} from "./typst-packages";
import { MAX_SELECTED_FONT_BYTES } from "./font-residency";
import {
  MAX_VAULT_INPUT_BYTES,
  rootedReadFile,
  rootedReadFileAsync,
} from "./wasm-vault-reader";
import { compileRequestJson, hostClock } from "./compile-request";

declare const __TYPSTIAN_WASM_BROTLI__: string | undefined;
declare const __TYPSTIAN_WORKER_SOURCE__: string | undefined;

let wasmBytesInitialization: Promise<Uint8Array> | undefined;
let wasmInitialization: Promise<void> | undefined;
let wasmModuleInitialization: Promise<WebAssembly.Module> | undefined;

const decompressBrotli = promisify(brotliDecompress);
const MAX_COMPILER_INPUT_PATHS = 10_000;

function loadWasmBytes(wasmPath: string): Promise<Uint8Array> {
  wasmBytesInitialization ??= Promise.resolve().then(async () => {
    if (typeof __TYPSTIAN_WASM_BROTLI__ === "string") {
      return decompressBrotli(Buffer.from(__TYPSTIAN_WASM_BROTLI__, "base64"));
    }
    return readFileSync(wasmPath);
  });
  return wasmBytesInitialization;
}

function initializeWasm(wasmPath: string): Promise<void> {
  wasmInitialization ??= loadWasmBytes(wasmPath)
    .then((moduleBytes) => init({ module_or_path: moduleBytes }))
    .then(() => undefined);
  return wasmInitialization;
}

function compileWasmModule(wasmPath: string): Promise<WebAssembly.Module> {
  wasmModuleInitialization ??= loadWasmBytes(wasmPath).then(
    (moduleBytes) => WebAssembly.compile(moduleBytes),
  );
  return wasmModuleInitialization;
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return Uint8Array.from(bytes).buffer;
}

class InlineWasmEngine implements WasmEngine {
  private readonly readFile: ReturnType<typeof rootedReadFile>;
  private readonly packages: LocalPackages;
  private readonly session: Promise<TypstianWasmSession | undefined>;
  private readonly lifecycle = new AbortController();
  private readFont: RegisteredSystemFonts["readSync"] = () => undefined;
  private activeSession: TypstianWasmSession | undefined;
  private disposed = false;

  constructor(rootPath: string, wasmPath: string) {
    this.readFile = rootedReadFile(rootPath);
    this.packages = createLocalPackageReader(typstPackageDirectories());
    this.session = initializeWasm(wasmPath).then(async () => {
      if (this.disposed) return undefined;
      const session = new TypstianWasmSession();
      try {
        const fonts = await registerSystemFonts(
          systemFontDirectories(),
          (fontPath, bytes) => session.register_font(fontPath, bytes),
          this.lifecycle.signal,
        );
        if (this.disposed) {
          session.free();
          return undefined;
        }
        this.readFont = (fontPath) => fonts.readSync(fontPath);
        this.activeSession = session;
        return session;
      } catch (error) {
        session.free();
        throw error;
      }
    });
  }

  ready(): Promise<void> {
    return this.requireSession().then(() => undefined);
  }

  async checkEnvironment(): Promise<string> {
    return (await this.requireSession()).environment();
  }

  async compile(request: EngineCompileRequest): Promise<unknown> {
    const overlay = request.overlay;
    const readFile = overlay === undefined
      ? this.readFile
      : (inputPath: string) => overlay.get(inputPath) ?? this.readFile(inputPath);
    return (await this.requireSession()).compile(
      compileRequestJson(request, hostClock()),
      readFile,
      (key: string) => this.packages.readSync(key),
      this.readFont,
    );
  }

  async jump(request: {
    revision: number;
    page: number;
    xPt: number;
    yPt: number;
  }): Promise<string> {
    return (await this.requireSession()).jump(JSON.stringify(request));
  }

  async forward(request: {
    revision: number;
    source: string;
    byteOffset: number;
  }): Promise<string> {
    return (await this.requireSession()).forward(JSON.stringify(request));
  }

  async complete(request: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
    explicit: boolean;
  }): Promise<string> {
    return (await this.requireSession()).complete(JSON.stringify(request));
  }


  async definition(request: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
  }): Promise<string> {
    return (await this.requireSession()).definition(JSON.stringify(request));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    this.activeSession?.free();
    this.activeSession = undefined;
  }

  private async requireSession(): Promise<TypstianWasmSession> {
    if (this.disposed) throw new Error("Typstian WASM engine is not available.");
    const session = await this.session;
    if (session === undefined || this.disposed) {
      throw new Error("Typstian WASM engine is not available.");
    }
    return session;
  }
}

interface PendingWorkerRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface InputBudget {
  vaultBytes: number;
  fontBytes: number;
}

interface CompileContext {
  budget: InputBudget;
  overlay?: ReadonlyMap<string, Uint8Array>;
  /** Set once the worker's own resident font bytes have been charged. */
  residentFontsCharged?: boolean;
}

class WorkerWasmEngine implements WasmEngine {
  private readonly worker: Worker;
  private readonly workerUrl: string;
  private readonly readFile: ReturnType<typeof rootedReadFileAsync>;
  private readonly packages: LocalPackages;
  private readonly pending = new Map<number, PendingWorkerRequest>();
  private readonly lifecycle = new AbortController();
  private readonly initialization: Promise<void>;
  private nextRequestId = 0;
  private disposed = false;
  private compileContext: CompileContext | undefined;
  private readFont: RegisteredSystemFonts["read"] = () => Promise.resolve(undefined);

  constructor(
    rootPath: string,
    wasmPath: string,
    workerSource: string,
    maxOutputBytes: number,
  ) {
    this.readFile = rootedReadFileAsync(rootPath);
    this.packages = createLocalPackageReader(typstPackageDirectories());
    this.workerUrl = URL.createObjectURL(new Blob([workerSource], {
      type: "text/javascript",
    }));
    this.worker = new Worker(this.workerUrl);
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleMessageError);
    this.initialization = this.initialize(wasmPath, maxOutputBytes);
  }

  ready(): Promise<void> {
    return this.initialization;
  }

  async checkEnvironment(): Promise<string> {
    await this.initialization;
    return this.request<string>("environment", {});
  }

  async compile(request: EngineCompileRequest): Promise<unknown> {
    await this.initialization;
    if (this.compileContext !== undefined) {
      throw new Error("Typstian WASM worker is already compiling.");
    }
    const context: CompileContext = {
      budget: {
        vaultBytes: MAX_VAULT_INPUT_BYTES,
        fontBytes: MAX_SELECTED_FONT_BYTES,
      },
      overlay: request.overlay,
    };
    this.compileContext = context;
    try {
      return await this.request<unknown>("compile", {
        revision: request.revision,
        entryPath: request.entryPath,
      });
    } finally {
      if (this.compileContext === context) this.compileContext = undefined;
    }
  }

  async jump(request: {
    revision: number;
    page: number;
    xPt: number;
    yPt: number;
  }): Promise<string> {
    await this.initialization;
    return this.request<string>("jump", request);
  }

  async forward(request: {
    revision: number;
    source: string;
    byteOffset: number;
  }): Promise<string> {
    await this.initialization;
    return this.request<string>("forward", request);
  }

  async complete(request: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
    explicit: boolean;
  }): Promise<string> {
    await this.initialization;
    return this.request<string>("complete", request);
  }


  async definition(request: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
  }): Promise<string> {
    await this.initialization;
    return this.request<string>("definition", request);
  }

  dispose(): void {
    this.stop(new Error("Typstian WASM engine was disposed."));
  }

  private async initialize(wasmPath: string, maxOutputBytes: number): Promise<void> {
    const module = await compileWasmModule(wasmPath);
    await this.request("initialize", { module, maxOutputBytes });
    const fonts = await registerSystemFonts(
      systemFontDirectories(),
      async (fontPath, bytes, resident) => {
        const buffer = transferableBuffer(bytes);
        return this.request<number>(
          "register-font",
          { path: fontPath, bytes: buffer, resident },
          [buffer],
        );
      },
      this.lifecycle.signal,
    );
    this.readFont = (fontPath, signal) => fonts.read(fontPath, signal);
  }

  private request<T>(
    method: string,
    payload: unknown,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Typstian WASM engine is not available."));
    }
    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.worker.postMessage({ type: "request", id, method, payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.type === "need-inputs") {
      void this.provideInputs(record);
      return;
    }
    if (record.type !== "response" || !Number.isSafeInteger(record.id)) return;
    const pending = this.pending.get(record.id as number);
    if (pending === undefined) return;
    this.pending.delete(record.id as number);
    if (record.ok === true) {
      pending.resolve(record.value);
    } else {
      pending.reject(new Error(
        typeof record.error === "string" ? record.error : "Typstian WASM worker failed.",
      ));
    }
  };

  private readonly handleError = (event: ErrorEvent): void => {
    this.stop(new Error(event.message || "Typstian WASM worker crashed."));
  };

  private readonly handleMessageError = (): void => {
    this.stop(new Error("Typstian WASM worker returned an unreadable response."));
  };

  private async provideInputs(message: Record<string, unknown>): Promise<void> {
    if (
      !Number.isSafeInteger(message.batchId)
      || !Array.isArray(message.vaultPaths)
      || !Array.isArray(message.packagePaths)
      || !Array.isArray(message.fontPaths)
    ) {
      return;
    }
    const batchId = message.batchId as number;
    const residentFontBytes = Number.isSafeInteger(message.residentFontBytes)
      ? Math.max(0, message.residentFontBytes as number)
      : 0;
    const strings = (values: unknown[]): string[] =>
      values.filter((value): value is string => typeof value === "string");
    const vaultPaths = strings(message.vaultPaths);
    const packagePaths = strings(message.packagePaths);
    const fontPaths = strings(message.fontPaths);
    const context = this.compileContext;
    if (context === undefined) {
      this.postInputError(batchId, "Typstian compiler requested inputs outside a compile.");
      return;
    }
    if (
      vaultPaths.length + packagePaths.length + fontPaths.length
        > MAX_COMPILER_INPUT_PATHS
    ) {
      this.postInputError(batchId, "Typstian compiler requested too many inputs.");
      return;
    }
    // Font faces the worker kept from an earlier compile are never re-shipped
    // through `providePath`, so they would otherwise spend none of this
    // compile's selected-font budget while still being alive for it. Charging
    // them once keeps the worker's residency and the bytes shipped here under
    // one 128 MiB ceiling rather than two.
    if (context.residentFontsCharged !== true) {
      context.residentFontsCharged = true;
      context.budget.fontBytes = Math.max(0, context.budget.fontBytes - residentFontBytes);
    }

    try {
      for (const path of vaultPaths) {
        await this.providePath(batchId, "vault", path, context);
      }
      for (const path of packagePaths) {
        await this.providePath(batchId, "package", path, context);
      }
      for (const path of fontPaths) {
        await this.providePath(batchId, "font", path, context);
      }
      if (this.disposed) return;
      this.worker.postMessage({
        type: "inputs",
        batchId,
        files: [],
        done: true,
      });
    } catch (error) {
      if (this.disposed) return;
      this.postInputError(
        batchId,
        error instanceof Error ? error.message : "Typstian compiler input failed.",
      );
    }
  }

  private async providePath(
    batchId: number,
    kind: "vault" | "package" | "font",
    path: string,
    context: CompileContext,
  ): Promise<void> {
    const bytes = kind === "vault"
      ? context.overlay?.get(path) ?? await this.readFile(path)
      : kind === "package"
        ? await this.packages.read(path)
        : await this.readFont(path, this.lifecycle.signal);
    if (this.disposed) return;
    // Package files are host bytes a document pulls in, so they spend the same
    // per-compile budget as vault files: an import cannot widen the ceiling.
    const budgetKey = kind === "font" ? "fontBytes" : "vaultBytes";
    if (bytes !== undefined) {
      if (bytes.byteLength > context.budget[budgetKey]) {
        throw new Error(
          kind === "font"
            ? "Typstian selected fonts exceeded the 128 MiB limit."
            : "Typstian compiler inputs exceeded the 70 MiB limit.",
        );
      }
      context.budget[budgetKey] -= bytes.byteLength;
    }
    const buffer = bytes === undefined ? null : transferableBuffer(bytes);
    this.worker.postMessage({
      type: "inputs",
      batchId,
      files: [{ kind, path, bytes: buffer }],
      done: false,
    }, buffer === null ? [] : [buffer]);
  }

  private postInputError(batchId: number, error: string): void {
    if (this.disposed) return;
    this.worker.postMessage({
      type: "inputs",
      batchId,
      files: [],
      done: true,
      error,
    });
  }

  private stop(error: Error): void {
    if (!this.disposed) {
      this.disposed = true;
      this.lifecycle.abort();
      this.worker.removeEventListener("message", this.handleMessage);
      this.worker.removeEventListener("error", this.handleError);
      this.worker.removeEventListener("messageerror", this.handleMessageError);
      this.worker.terminate();
      URL.revokeObjectURL(this.workerUrl);
    }
    this.fail(error);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createWasmEngine(
  options: WasmEngineFactoryOptions,
): Promise<WasmEngine> {
  try {
    const workerSource = typeof __TYPSTIAN_WORKER_SOURCE__ === "string"
      ? __TYPSTIAN_WORKER_SOURCE__
      : undefined;
    return Promise.resolve(
      workerSource === undefined
        ? new InlineWasmEngine(options.rootPath, options.wasmPath)
        : new WorkerWasmEngine(
            options.rootPath,
            options.wasmPath,
            workerSource,
            options.maxOutputBytes,
          ),
    );
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error("Typstian WASM engine could not be started."),
    );
  }
}
