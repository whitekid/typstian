import init, { TypstianWasmSession } from "../helper/wasm/pkg/typstian_wasm.js";

import { compileRequestJson, hostClock } from "./compile-request";
import {
  MAX_RESIDENT_FONT_BYTES,
  retainUsedFonts,
} from "./font-residency";

type WorkerMethod =
  | "initialize"
  | "register-font"
  | "environment"
  | "compile"
  | "jump"
  | "forward"
  | "complete"
  | "definition"
  | "tooltip";

interface WorkerRequest {
  type: "request";
  id: number;
  method: WorkerMethod;
  payload: unknown;
}

type InputKind = "vault" | "package" | "font";

interface InputResponse {
  type: "inputs";
  batchId: number;
  files: Array<{
    kind: InputKind;
    path: string;
    bytes: ArrayBuffer | null;
  }>;
  done?: boolean;
  error?: string;
}

interface WorkerDispatchResult {
  value: unknown;
  transfer?: Transferable[];
}

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest | InputResponse>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const MAX_INPUT_PATHS = 10_000;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const sleep = new Map<number, (message: InputResponse) => void>();
// Bytes the host asked this worker to keep after registration, so the first
// compile of a session can answer the compiler's font lookups from memory
// instead of laying the document out once with no loadable face. The host
// already bounds the set through `planFontResidency`; the cap is re-enforced
// here because the worker owns the memory. `settleResidency` then narrows the
// set to the faces a compile actually read, so the cold-start ceiling is a
// transient, not a per-preview tax.
const residentFonts = new Map<string, Uint8Array>();
let residentFontBytes = 0;
// False until the first compile of this session settles, and never reset: a
// session is one worker, and a failed one is terminated rather than reused, so
// there is no path back to unproven. While it is false the
// residency is an unproven bet governed by `MAX_RESIDENT_FONT_BYTES` alone;
// once true the surviving bytes are proven selections, and the host charges
// them against the same per-compile budget as the bytes it ships itself.
let residencyProven = false;
let previousPaths = new Set<string>();
let previousPackagePaths = new Set<string>();
let previousFontPaths = new Set<string>();
let session: TypstianWasmSession | undefined;
let batchId = 0;
let outputLimitBytes: number | undefined;

scope.addEventListener("message", (event: MessageEvent<WorkerRequest | InputResponse>) => {
  const message = event.data;
  if (message.type === "inputs") {
    sleep.get(message.batchId)?.(message);
    return;
  }
  void handleRequest(message);
});

function exceedsUtf8Limit(value: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800
      && code <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

function boundedOutput(value: string): string {
  const limit = outputLimitBytes;
  if (limit === undefined) {
    throw new Error("Typstian WASM worker is not initialized.");
  }
  if (exceedsUtf8Limit(value, limit)) {
    throw new Error("Typstian compiler output exceeded its limit.");
  }
  return value;
}

function workerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const limit = outputLimitBytes;
  return limit !== undefined && exceedsUtf8Limit(message, limit)
    ? "Typstian compiler output exceeded its limit."
    : message;
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    const result = await dispatch(request.method, request.payload);
    scope.postMessage(
      { type: "response", id: request.id, ok: true, value: result.value },
      result.transfer,
    );
  } catch (error) {
    scope.postMessage({
      type: "response",
      id: request.id,
      ok: false,
      error: workerErrorMessage(error),
    });
  }
}

async function dispatch(
  method: WorkerMethod,
  payload: unknown,
): Promise<WorkerDispatchResult> {
  if (method === "initialize") {
    const initialization = payload as {
      module: WebAssembly.Module;
      maxOutputBytes: unknown;
    };
    if (
      !Number.isSafeInteger(initialization.maxOutputBytes)
      || (initialization.maxOutputBytes as number) <= 0
    ) {
      throw new Error("Typstian compiler output limit is invalid.");
    }
    outputLimitBytes = initialization.maxOutputBytes as number;
    await init({ module_or_path: initialization.module });
    session = new TypstianWasmSession();
    return { value: undefined };
  }

  const activeSession = session;
  if (activeSession === undefined) throw new Error("Typstian WASM worker is not initialized.");

  if (method === "register-font") {
    const font = payload as { path: string; bytes: ArrayBuffer; resident?: boolean };
    const bytes = new Uint8Array(font.bytes);
    const faces = activeSession.register_font(font.path, bytes);
    if (
      font.resident === true
      && !residentFonts.has(font.path)
      && residentFontBytes + bytes.byteLength <= MAX_RESIDENT_FONT_BYTES
    ) {
      // The buffer was transferred to this worker, so retaining it costs no copy.
      residentFonts.set(font.path, bytes);
      residentFontBytes += bytes.byteLength;
    }
    return { value: faces };
  }
  if (method === "environment") {
    return { value: boundedOutput(activeSession.environment()) };
  }
  if (method === "jump") {
    return { value: boundedOutput(activeSession.jump(JSON.stringify(payload))) };
  }
  if (method === "forward") {
    return { value: boundedOutput(activeSession.forward(JSON.stringify(payload))) };
  }
  if (method === "complete") {
    return { value: boundedOutput(activeSession.complete(JSON.stringify(payload))) };
  }
  if (method === "definition") {
    return { value: boundedOutput(activeSession.definition(JSON.stringify(payload))) };
  }
  if (method === "tooltip") {
    return { value: boundedOutput(activeSession.tooltip(JSON.stringify(payload))) };
  }
  return compile(activeSession, payload as { revision: number; entryPath: string });
}

function decodeCompileResult(value: unknown): WorkerDispatchResult {
  if (typeof value === "string") {
    const responseText = boundedOutput(value);
    const parsed = JSON.parse(responseText) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Typstian compiler returned an invalid response.");
    }
    if ((parsed as Record<string, unknown>).type === "compiled") {
      throw new Error("Typstian compiler returned a text-encoded PDF artifact.");
    }
    return { value: parsed };
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Typstian compiler returned an invalid response.");
  }
  const response = value as Record<string, unknown>;
  const pdfBuffer = response.pdfBuffer;
  const declaredBytes = response.pdfBytes;
  if (
    response.type !== "compiled"
    || !(pdfBuffer instanceof ArrayBuffer)
    || !Number.isSafeInteger(declaredBytes)
    || (declaredBytes as number) <= 0
    || (declaredBytes as number) > MAX_PDF_BYTES
    || pdfBuffer.byteLength !== declaredBytes
  ) {
    throw new Error("Typstian compiler returned an invalid PDF artifact.");
  }
  boundedOutput(JSON.stringify(response));
  return { value: response, transfer: [pdfBuffer] };
}

/**
 * Cashes in the cold-start residency once a compile has settled.
 *
 * `usedFontPaths` is every path the compiler asked `readFont` for during this
 * compile, seeded hits included, so the faces that earned their memory are
 * exactly the ones that stay. Running after the compile rather than before is
 * the point: the first compile is the pass the residency exists for.
 */
function settleResidency(usedFontPaths: ReadonlySet<string>): void {
  const kept = retainUsedFonts(
    [...residentFonts].map(([path, bytes]) => ({
      path,
      byteLength: bytes.byteLength,
    })),
    usedFontPaths,
  );
  for (const path of [...residentFonts.keys()]) {
    if (!kept.has(path)) residentFonts.delete(path);
  }
  residentFontBytes = 0;
  for (const bytes of residentFonts.values()) residentFontBytes += bytes.byteLength;
  residencyProven = true;
}

async function compile(
  activeSession: TypstianWasmSession,
  request: { revision: number; entryPath: string },
): Promise<WorkerDispatchResult> {
  const fileCache = new Map<string, Uint8Array | null>();
  const packageCache = new Map<string, Uint8Array | null>();
  const fontCache = new Map<string, Uint8Array | null>();
  const currentPaths = new Set<string>();
  const currentPackagePaths = new Set<string>();
  const currentFontPaths = new Set<string>();
  const missing = new Set<string>();
  const missingPackages = new Set<string>();
  const missingFonts = new Set<string>();
  const caches = { vault: fileCache, package: packageCache, font: fontCache };
  const reader = (
    seen: Set<string>,
    cache: Map<string, Uint8Array | null>,
    absent: Set<string>,
  ) => (path: string): Uint8Array | undefined => {
    seen.add(path);
    if (cache.has(path)) return cache.get(path) ?? undefined;
    absent.add(path);
    return undefined;
  };
  const readFile = reader(currentPaths, fileCache, missing);
  const readPackage = reader(currentPackagePaths, packageCache, missingPackages);
  const readFont = reader(currentFontPaths, fontCache, missingFonts);

  // The retry loop below recompiles the same revision until every input is
  // present, so the instant is captured once: `datetime.today()` must not
  // shift mid-compile.
  const clock = hostClock();

  // Everything from the seeding on runs inside the try: the pre-warm can throw
  // too, and the cold-start set must not survive a compile that never settled.
  try {
    // Seed the retained faces before the first pass runs: a font lookup that
    // misses costs a whole document layout that Typst then has to redo.
    for (const [fontPath, bytes] of residentFonts) fontCache.set(fontPath, bytes);

    // A retained face is already in the cache, so re-warming it would make the
    // host read the same file from disk a second time.
    const staleFontPaths = Array.from(previousFontPaths)
      .filter((fontPath) => !fontCache.has(fontPath));

    if (
      previousPaths.size > 0
      || previousPackagePaths.size > 0
      || staleFontPaths.length > 0
    ) {
      await requestInputs(
        Array.from(previousPaths),
        Array.from(previousPackagePaths),
        staleFontPaths,
        caches,
      );
    }

    while (true) {
      missing.clear();
      missingPackages.clear();
      missingFonts.clear();
      const result: unknown = activeSession.compile(
        compileRequestJson(request, clock),
        readFile,
        readPackage,
        readFont,
      );
      if (missing.size === 0 && missingPackages.size === 0 && missingFonts.size === 0) {
        previousPaths = currentPaths;
        previousPackagePaths = currentPackagePaths;
        previousFontPaths = currentFontPaths;
        return decodeCompileResult(result);
      }
      if (
        currentPaths.size + currentPackagePaths.size + currentFontPaths.size
          > MAX_INPUT_PATHS
      ) {
        throw new Error("Typstian compiler requested too many inputs.");
      }
      await requestInputs(
        Array.from(missing),
        Array.from(missingPackages),
        Array.from(missingFonts),
        caches,
      );
      const unresolved = Array.from(missing).some((path) => !fileCache.has(path))
        || Array.from(missingPackages).some((path) => !packageCache.has(path))
        || Array.from(missingFonts).some((path) => !fontCache.has(path));
      if (unresolved) {
        throw new Error("Typstian compiler input provider made no progress.");
      }
    }
  } finally {
    // The buffers must not outlive the compile that proved them, and a failed
    // compile must not leave the cold-start set resident either.
    settleResidency(currentFontPaths);
  }
}

function requestInputs(
  vaultPaths: string[],
  packagePaths: string[],
  fontPaths: string[],
  caches: Record<InputKind, Map<string, Uint8Array | null>>,
): Promise<void> {
  const currentBatch = ++batchId;
  return new Promise((resolve, reject) => {
    sleep.set(currentBatch, (message) => {
      if (typeof message.error === "string") {
        sleep.delete(currentBatch);
        reject(new Error(message.error));
        return;
      }
      for (const file of message.files) {
        const cache = caches[file.kind];
        cache?.set(
          file.path,
          file.bytes === null ? null : new Uint8Array(file.bytes),
        );
      }
      if (message.done === true) {
        sleep.delete(currentBatch);
        resolve();
      }
    });
    scope.postMessage({
      type: "need-inputs",
      batchId: currentBatch,
      // Proven resident faces never travel through the host's input path, so
      // the host cannot see them in its per-compile font budget unless they are
      // declared here. Unproven cold-start bytes are not declared: they are
      // governed by `MAX_RESIDENT_FONT_BYTES` and are gone once this compile
      // settles, and charging them would starve the very compile that has to
      // fetch whatever the bet missed.
      residentFontBytes: residencyProven ? residentFontBytes : 0,
      vaultPaths,
      packagePaths,
      fontPaths,
    });
  });
}
