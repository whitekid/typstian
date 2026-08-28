import { requestDeadlineMs } from "./compile-deadline";
import { COMPILER_CLIENT_ERROR } from "./messages";

const PROTOCOL_VERSION = 6;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 70 * 1024 * 1024;
export const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
// A completion request carries the buffer the cursor belongs to, so it cannot
// fit the request cap that guards the compile path. It gets its own bound,
// matching the compiler's, rather than travelling unbounded.
const DEFAULT_MAX_COMPLETION_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 1_000;
const MAX_DEPENDENCIES = 10_000;
const MAX_DIAGNOSTICS = 1_000;
// Matches the compiler's own completion cap; math mode alone offers a few
// thousand symbol names.
const MAX_COMPLETIONS = 8_192;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type CompilerClientErrorCode =
  | "invalid-input"
  | "unavailable"
  | "permission-denied"
  | "timeout"
  | "output-limit"
  | "malformed-protocol"
  | "crash"
  | "aborted"
  | "closed"
  | "stale"
  | "compiler-error";

export class CompilerClientError extends Error {
  constructor(
    readonly code: CompilerClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompilerClientError";
  }
}

export interface WasmEngineFactoryOptions {
  rootPath: string;
  wasmPath: string;
  maxOutputBytes: number;
}

export interface WasmEngine {
  ready(): Promise<void>;
  checkEnvironment(): Promise<string>;
  compile(request: EngineCompileRequest): Promise<unknown>;
  jump(request: { revision: number; page: number; xPt: number; yPt: number }): Promise<string>;
  forward(request: { revision: number; source: string; byteOffset: number }): Promise<string>;
  complete(request: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
    explicit: boolean;
  }): Promise<string>;
  definition(request: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
  }): Promise<string>;
  dispose(): void;
}

export type WasmEngineFactory = (
  options: WasmEngineFactoryOptions,
) => Promise<WasmEngine>;

export interface TypstianCompilerClientOptions {
  rootPath: string;
  wasmPath: string;
  timeoutMs?: number;
  initializationTimeoutMs?: number;
  maxOutputBytes?: number;
  maxPdfBytes?: number;
  maxRequestBytes?: number;
  maxCompletionBytes?: number;
  engineFactory?: WasmEngineFactory;
}

export interface CompilerEnvironment {
  protocolVersion: 6;
  typstVersion: string;
}

export interface CompilerDiagnostic {
  severity: "error" | "warning";
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface CompilerPageSize {
  widthPt: number;
  heightPt: number;
}

export interface EngineCompileRequest {
  revision: number;
  entryPath: string;
  /**
   * Unsaved editor buffers, keyed by compilation-root-relative path. The map is
   * pinned for the whole compile so every input the compiler asks for comes from
   * one snapshot; a later edit belongs to a later revision.
   */
  overlay?: ReadonlyMap<string, Uint8Array>;
}

export interface CompilerCompileRequest extends EngineCompileRequest {
  signal?: AbortSignal;
}

export interface CompilerCompileSuccess {
  ok: true;
  revision: number;
  pdf: Uint8Array;
  pages: CompilerPageSize[];
  dependencies: string[];
  diagnostics: CompilerDiagnostic[];
}

export interface CompilerCompileFailure {
  ok: false;
  revision: number;
  reason: "compile-error" | "pdf-error";
  message: string;
  dependencies: string[];
  diagnostics: CompilerDiagnostic[];
}

export type CompilerCompileResult = CompilerCompileSuccess | CompilerCompileFailure;

export interface CompilerJumpRequest {
  revision: number;
  page: number;
  xPt: number;
  yPt: number;
  signal?: AbortSignal;
}

export interface CompilerJumpResult {
  revision: number;
  location: { path: string; byteOffset: number } | null;
}

export interface CompilerForwardRequest {
  revision: number;
  source: string;
  byteOffset: number;
  signal?: AbortSignal;
}

export interface CompilerForwardPosition {
  page: number;
  xPt: number;
  yPt: number;
}

export interface CompilerForwardResult {
  revision: number;
  positions: CompilerForwardPosition[];
}

export interface CompilerCompleteRequest {
  revision: number;
  source: string;
  /**
   * The buffer the cursor belongs to. The compiler reconciles it against the
   * snapshot it retained, so the cursor keeps its meaning across the keystrokes
   * that landed since the last compile.
   */
  sourceText: string;
  byteOffset: number;
  /** Whether the user asked for completions outright rather than by typing. */
  explicit: boolean;
  signal?: AbortSignal;
}

export interface CompilerCompletion {
  kind: string;
  label: string;
  /** Snippet-syntax replacement text, when it differs from the label. */
  apply?: string;
  detail?: string;
}

export interface CompilerCompleteResult {
  revision: number;
  /** Where the completed word starts, as a UTF-8 offset into `sourceText`. */
  byteOffset: number;
  completions: CompilerCompletion[];
}

export interface CompilerDefinitionRequest {
  revision: number;
  source: string;
  sourceText: string;
  byteOffset: number;
  signal?: AbortSignal;
}

export interface CompilerDefinitionResult {
  revision: number;
  location: { path: string; byteOffset: number } | null;
}

export type RequestKind =
  | "environment"
  | "compile"
  | "jump"
  | "forward"
  | "complete"
  | "definition";

interface PendingRequest<T = unknown> {
  kind: RequestKind;
  generation: number;
  settled: boolean;
  resolve: (value: T) => void;
  reject: (error: CompilerClientError) => void;
  timeout?: number;
  signal?: AbortSignal;
  abort?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message: string): CompilerClientError {
  return new CompilerClientError("malformed-protocol", message);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(COMPILER_CLIENT_ERROR.invalidCompilerValue(label));
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidCompilerValue(label));
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidCompilerValue(label));
  }
  return value as number;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidCompilerValue(label));
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidCompilerValue(label));
  }
  return value;
}

function isSafeVaultPath(path: string): boolean {
  if (path.length === 0 || path.includes("\0")) return false;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function requireVaultPath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (!isSafeVaultPath(path)) throw malformed(COMPILER_CLIENT_ERROR.unsafeCompilerPath(label));
  return path;
}

function validateVaultPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isSafeVaultPath(value)) {
    throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.vaultRelativePath(label));
  }
}

function validateRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.revisionNonNegative);
  }
}

function parseDiagnostics(value: unknown): CompilerDiagnostic[] {
  if (!Array.isArray(value) || value.length > MAX_DIAGNOSTICS) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidDiagnostics);
  }
  return value.map((item) => {
    const diagnostic = requireRecord(item, "diagnostic");
    if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") {
      throw malformed(COMPILER_CLIENT_ERROR.invalidDiagnosticSeverity);
    }
    const result: CompilerDiagnostic = {
      severity: diagnostic.severity,
      message: requireString(diagnostic.message, "diagnostic message"),
    };
    if (diagnostic.file !== undefined) {
      result.path = requireVaultPath(diagnostic.file, "diagnostic file");
    }
    if (diagnostic.line !== undefined) result.line = requireInteger(diagnostic.line, "diagnostic line", 1);
    if (diagnostic.column !== undefined) {
      result.column = requireInteger(diagnostic.column, "diagnostic column", 1);
    }
    return result;
  });
}

function parseDependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidDependencies);
  }
  return value.map((path) => requireVaultPath(path, "dependency path"));
}

function parseError(
  response: Record<string, unknown>,
  expectedKind: RequestKind,
  expectedRevision?: number,
): Record<string, unknown> {
  if (response.type !== "error" || response.requestType !== expectedKind) {
    throw malformed(COMPILER_CLIENT_ERROR.wrongResponse(expectedKind));
  }
  if (expectedRevision === undefined) {
    if (response.revision !== null) throw malformed(COMPILER_CLIENT_ERROR.invalidErrorRevision);
  } else if (response.revision !== expectedRevision) {
    throw malformed(COMPILER_CLIENT_ERROR.wrongErrorRevision);
  }
  requireString(response.code, "error code");
  requireString(response.message, "error message");
  return response;
}

function transportError(response: Record<string, unknown>): CompilerClientError {
  const code = response.code;
  const message = requireString(response.message, "error message");
  if (code === "output-limit") return new CompilerClientError("output-limit", message);
  if (code === "invalid-request") return new CompilerClientError("invalid-input", message);
  return new CompilerClientError("compiler-error", message);
}

function parseEnvironment(value: unknown): CompilerEnvironment {
  const response = requireRecord(value, "environment response");
  if (response.type === "error") throw transportError(parseError(response, "environment"));
  if (response.type !== "environment" || response.protocolVersion !== PROTOCOL_VERSION) {
    throw malformed(COMPILER_CLIENT_ERROR.protocolVersionMismatch);
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    typstVersion: requireString(response.typstVersion, "Typst version"),
  };
}

function parseCompileError(
  response: Record<string, unknown>,
  revision: number,
): CompilerCompileFailure {
  const error = parseError(response, "compile", revision);
  if (error.code !== "compile" && error.code !== "pdf") throw transportError(error);
  return {
    ok: false,
    revision,
    reason: error.code === "compile" ? "compile-error" : "pdf-error",
    message: requireString(error.message, "compile error message"),
    dependencies: parseDependencies(error.dependencies),
    diagnostics: parseDiagnostics(error.diagnostics),
  };
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

function parseCompile(
  value: unknown,
  revision: number,
  maxPdfBytes: number,
): CompilerCompileResult {
  const response = requireRecord(value, "compile response");
  if (response.type === "error") return parseCompileError(response, revision);
  if (response.type !== "compiled" || response.revision !== revision) {
    throw malformed(COMPILER_CLIENT_ERROR.wrongCompileRevision);
  }

  const declaredBytes = requireInteger(response.pdfBytes, "PDF byte count", 1);
  if (declaredBytes > maxPdfBytes) {
    throw new CompilerClientError("output-limit", COMPILER_CLIENT_ERROR.pdfTooLarge);
  }

  let pdf: Uint8Array;
  if (response.pdfBuffer instanceof ArrayBuffer) {
    pdf = new Uint8Array(response.pdfBuffer);
  } else {
    const encoded = requireString(response.pdfBase64, "PDF artifact");
    if (
      encoded.length !== 4 * Math.ceil(declaredBytes / 3)
      || !BASE64.test(encoded)
    ) {
      throw malformed(COMPILER_CLIENT_ERROR.invalidBase64Pdf);
    }
    const decoded = Buffer.from(encoded, "base64");
    pdf = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  }
  if (pdf.byteLength !== declaredBytes || !hasPdfMagic(pdf)) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidPdfArtifact);
  }
  if (!Array.isArray(response.pages) || response.pages.length > MAX_PAGES) {
    throw malformed(COMPILER_CLIENT_ERROR.invalidPdfPageMetadata);
  }
  const pages = response.pages.map((item) => {
    const page = requireRecord(item, "PDF page metadata");
    return {
      widthPt: requirePositiveNumber(page.widthPt, "page width"),
      heightPt: requirePositiveNumber(page.heightPt, "page height"),
    };
  });

  return {
    ok: true,
    revision,
    pdf,
    pages,
    dependencies: parseDependencies(response.dependencies),
    diagnostics: parseDiagnostics(response.diagnostics),
  };
}

function parseJump(value: unknown, revision: number): CompilerJumpResult {
  const response = requireRecord(value, "jump response");
  if (response.type === "error") throw transportError(parseError(response, "jump", revision));
  if (response.type === "stale-revision") {
    requireInteger(response.expectedRevision, "expected revision");
    throw new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive);
  }
  if (response.revision !== revision) throw malformed(COMPILER_CLIENT_ERROR.wrongJumpRevision);
  if (response.type === "no-source") return { revision, location: null };
  if (response.type !== "source") throw malformed(COMPILER_CLIENT_ERROR.wrongJumpResponse);
  return {
    revision,
    location: {
      path: requireVaultPath(response.path, "jump path"),
      byteOffset: requireInteger(response.byteOffset, "jump byte offset"),
    },
  };
}

function parseForward(value: unknown, revision: number): CompilerForwardResult {
  const response = requireRecord(value, "forward response");
  if (response.type === "error") throw transportError(parseError(response, "forward", revision));
  if (response.type === "stale-revision") {
    requireInteger(response.expectedRevision, "expected revision");
    throw new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive);
  }
  if (response.revision !== revision) throw malformed(COMPILER_CLIENT_ERROR.wrongPreviewPositionRevision);
  if (response.type === "no-position") return { revision, positions: [] };
  if (response.type !== "positions" || !Array.isArray(response.positions)) {
    throw malformed(COMPILER_CLIENT_ERROR.wrongPreviewPositionReply);
  }
  if (response.positions.length > MAX_PAGES) {
    throw malformed(COMPILER_CLIENT_ERROR.tooManyPreviewPositions);
  }
  return {
    revision,
    positions: response.positions.map((value) => {
      const position = requireRecord(value, "forward position");
      const page = requireInteger(position.page, "forward page", 1);
      if (page > MAX_PAGES) throw malformed(COMPILER_CLIENT_ERROR.invalidForwardPage);
      return {
        page,
        xPt: requireNonNegativeNumber(position.xPt, "forward x coordinate"),
        yPt: requireNonNegativeNumber(position.yPt, "forward y coordinate"),
      };
    }),
  };
}

function parseComplete(
  value: unknown,
  revision: number,
  byteOffset: number,
): CompilerCompleteResult {
  const response = requireRecord(value, "completion response");
  if (response.type === "error") throw transportError(parseError(response, "complete", revision));
  if (response.type === "stale-revision") {
    requireInteger(response.expectedRevision, "expected revision");
    throw new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive);
  }
  if (response.revision !== revision) {
    throw malformed(COMPILER_CLIENT_ERROR.wrongCompletionRevision);
  }
  // Nothing to offer still answers with the cursor, so the caller never has to
  // special-case an absent replacement range.
  if (response.type === "no-completions") return { revision, byteOffset, completions: [] };
  if (response.type !== "completions" || !Array.isArray(response.completions)) {
    throw malformed(COMPILER_CLIENT_ERROR.wrongCompletionResponse);
  }
  if (response.completions.length > MAX_COMPLETIONS) {
    throw malformed(COMPILER_CLIENT_ERROR.tooManyCompletions);
  }
  const start = requireInteger(response.byteOffset, "completion byte offset");
  if (start > byteOffset) throw malformed(COMPILER_CLIENT_ERROR.completionPastCursor);
  return {
    revision,
    byteOffset: start,
    completions: response.completions.map((item) => {
      const completion = requireRecord(item, "completion");
      const result: CompilerCompletion = {
        kind: requireString(completion.kind, "completion kind"),
        label: requireString(completion.label, "completion label"),
      };
      if (completion.apply !== null && completion.apply !== undefined) {
        result.apply = requireString(completion.apply, "completion replacement");
      }
      if (completion.detail !== null && completion.detail !== undefined) {
        result.detail = requireString(completion.detail, "completion detail");
      }
      return result;
    }),
  };
}


function parseDefinition(value: unknown, revision: number): CompilerDefinitionResult {
  const response = requireRecord(value, "definition response");
  if (response.type === "error") throw transportError(parseError(response, "definition", revision));
  if (response.type === "stale-revision") {
    requireInteger(response.expectedRevision, "expected revision");
    throw new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive);
  }
  if (response.revision !== revision) {
    throw malformed(COMPILER_CLIENT_ERROR.wrongDefinitionRevision);
  }
  if (response.type === "no-definition") return { revision, location: null };
  if (response.type !== "source") {
    throw malformed(COMPILER_CLIENT_ERROR.wrongDefinitionResponse);
  }
  return {
    revision,
    location: {
      path: requireVaultPath(response.path, "definition path"),
      byteOffset: requireInteger(response.byteOffset, "definition byte offset"),
    },
  };
}

function requirePositiveOption(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.positiveInteger(label));
  }
  return value;
}

function asClientError(
  error: unknown,
  fallbackCode: CompilerClientErrorCode,
  fallbackMessage: string,
): CompilerClientError {
  return error instanceof CompilerClientError
    ? error
    : new CompilerClientError(fallbackCode, fallbackMessage);
}

async function createWasmEngine(options: WasmEngineFactoryOptions): Promise<WasmEngine> {
  const adapter = await import("./wasm-engine");
  return adapter.createWasmEngine(options);
}

export class TypstianCompilerClient {
  private readonly rootPath: string;
  private readonly wasmPath: string;
  private readonly timeoutMs: number;
  private readonly initializationTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxPdfBytes: number;
  private readonly maxRequestBytes: number;
  private readonly maxCompletionBytes: number;
  private readonly engineFactory: WasmEngineFactory;
  private readonly pending = new Set<PendingRequest>();
  private readonly disposedEngines = new WeakSet<WasmEngine>();
  private enginePromise: Promise<WasmEngine> | undefined;
  private loadedEngine: WasmEngine | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private queuedCount = 0;
  private latestCompileRevision = -1;
  private latestDocumentRevision: number | undefined;
  private sessionCompileCount = 0;
  private closed = false;

  constructor(options: TypstianCompilerClientOptions) {
    if (options.rootPath.length === 0) {
      throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.vaultRootRequired);
    }
    this.rootPath = options.rootPath;
    this.wasmPath = options.wasmPath;
    this.timeoutMs = requirePositiveOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Timeout");
    this.initializationTimeoutMs = requirePositiveOption(
      options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
      "Initialization timeout",
    );
    this.maxOutputBytes = requirePositiveOption(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "Output limit",
    );
    this.maxPdfBytes = requirePositiveOption(options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES, "PDF limit");
    this.maxRequestBytes = requirePositiveOption(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      "Request limit",
    );
    this.maxCompletionBytes = requirePositiveOption(
      options.maxCompletionBytes ?? DEFAULT_MAX_COMPLETION_BYTES,
      "Completion limit",
    );
    this.engineFactory = options.engineFactory ?? createWasmEngine;
  }

  checkEnvironment(signal?: AbortSignal): Promise<CompilerEnvironment> {
    return this.enqueue("environment", {}, parseEnvironment, signal);
  }

  compile(request: CompilerCompileRequest): Promise<CompilerCompileResult> {
    try {
      validateRevision(request.revision);
      validateVaultPath(request.entryPath, "Entry path");
    } catch (error) {
      return Promise.reject(asClientError(error, "invalid-input", COMPILER_CLIENT_ERROR.compileRequestInvalid));
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(new CompilerClientError("aborted", COMPILER_CLIENT_ERROR.requestCancelled));
    }
    if (request.revision <= this.latestCompileRevision) {
      return Promise.reject(new CompilerClientError("stale", COMPILER_CLIENT_ERROR.compileSuperseded));
    }

    if (this.queuedCount > 0 || this.pending.size > 0) {
      this.failSession(new CompilerClientError("stale", COMPILER_CLIENT_ERROR.compileSuperseded));
    }
    this.latestCompileRevision = request.revision;
    this.latestDocumentRevision = undefined;
    return this.enqueue(
      "compile",
      {
        revision: request.revision,
        entryPath: request.entryPath,
        ...(request.overlay === undefined ? {} : { overlay: request.overlay }),
      },
      (response) => parseCompile(response, request.revision, this.maxPdfBytes),
      request.signal,
    ).then((result) => {
      if (request.revision !== this.latestCompileRevision) {
        throw new CompilerClientError("stale", COMPILER_CLIENT_ERROR.compileSuperseded);
      }
      this.latestDocumentRevision = result.ok ? result.revision : undefined;
      return result;
    });
  }

  jump(request: CompilerJumpRequest): Promise<CompilerJumpResult> {
    try {
      validateRevision(request.revision);
      if (
        !Number.isSafeInteger(request.page) ||
        request.page < 1 ||
        !Number.isFinite(request.xPt) ||
        request.xPt < 0 ||
        !Number.isFinite(request.yPt) ||
        request.yPt < 0
      ) {
        throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.jumpCoordinatesInvalid);
      }
    } catch (error) {
      return Promise.reject(asClientError(error, "invalid-input", COMPILER_CLIENT_ERROR.jumpRequestInvalid));
    }
    if (request.revision !== this.latestDocumentRevision) {
      return Promise.reject(new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive));
    }
    return this.enqueue(
      "jump",
      {
        revision: request.revision,
        page: request.page,
        xPt: request.xPt,
        yPt: request.yPt,
      },
      (response) => parseJump(response, request.revision),
      request.signal,
    );
  }

  forward(request: CompilerForwardRequest): Promise<CompilerForwardResult> {
    try {
      validateRevision(request.revision);
      validateVaultPath(request.source, "Forward source");
      if (!Number.isSafeInteger(request.byteOffset) || request.byteOffset < 0) {
        throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.forwardByteOffsetInvalid);
      }
    } catch (error) {
      return Promise.reject(asClientError(error, "invalid-input", COMPILER_CLIENT_ERROR.forwardRequestInvalid));
    }
    if (request.revision !== this.latestDocumentRevision) {
      return Promise.reject(new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive));
    }
    return this.enqueue(
      "forward",
      {
        revision: request.revision,
        source: request.source,
        byteOffset: request.byteOffset,
      },
      (response) => parseForward(response, request.revision),
      request.signal,
    );
  }

  /**
   * Offers the completions of the retained document at a cursor. Like `jump`
   * and `forward` it answers from the snapshot the visible PDF came from, so it
   * never starts a compile of its own.
   */
  complete(request: CompilerCompleteRequest): Promise<CompilerCompleteResult> {
    try {
      validateRevision(request.revision);
      validateVaultPath(request.source, "Completion source");
      if (!Number.isSafeInteger(request.byteOffset) || request.byteOffset < 0) {
        throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.completionByteOffsetInvalid);
      }
      if (
        typeof request.sourceText !== "string"
        || Buffer.byteLength(request.sourceText) > this.maxCompletionBytes
      ) {
        throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.completionSourceTooLarge);
      }
    } catch (error) {
      return Promise.reject(asClientError(error, "invalid-input", COMPILER_CLIENT_ERROR.completionRequestInvalid));
    }
    if (request.revision !== this.latestDocumentRevision) {
      return Promise.reject(new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive));
    }
    return this.enqueue(
      "complete",
      {
        revision: request.revision,
        source: request.source,
        sourceText: request.sourceText,
        byteOffset: request.byteOffset,
        explicit: request.explicit,
      },
      (response) => parseComplete(response, request.revision, request.byteOffset),
      request.signal,
    );
  }


  definition(request: CompilerDefinitionRequest): Promise<CompilerDefinitionResult> {
    try {
      validateRevision(request.revision);
      validateVaultPath(request.source, "Definition source");
      if (!Number.isSafeInteger(request.byteOffset) || request.byteOffset < 0) {
        throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.definitionByteOffsetInvalid);
      }
      if (
        typeof request.sourceText !== "string"
        || Buffer.byteLength(request.sourceText) > this.maxCompletionBytes
      ) {
        throw new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.definitionSourceTooLarge);
      }
    } catch (error) {
      return Promise.reject(asClientError(error, "invalid-input", COMPILER_CLIENT_ERROR.definitionRequestInvalid));
    }
    if (request.revision !== this.latestDocumentRevision) {
      return Promise.reject(new CompilerClientError("stale", COMPILER_CLIENT_ERROR.previewRevisionInactive));
    }
    return this.enqueue(
      "definition",
      {
        revision: request.revision,
        source: request.source,
        sourceText: request.sourceText,
        byteOffset: request.byteOffset,
      },
      (response) => parseDefinition(response, request.revision),
      request.signal,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failSession(new CompilerClientError("closed", COMPILER_CLIENT_ERROR.clientClosed));
  }

  dispose(): void {
    this.close();
  }

  private enqueue<T>(
    kind: RequestKind,
    payload: Record<string, unknown>,
    parse: (response: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CompilerClientError("closed", COMPILER_CLIENT_ERROR.clientClosed));
    }
    if (signal?.aborted === true) {
      return Promise.reject(new CompilerClientError("aborted", COMPILER_CLIENT_ERROR.requestCancelled));
    }

    const encodedRequest = JSON.stringify(payload);
    const requestLimit = kind === "complete" || kind === "definition"
      ? this.maxCompletionBytes
      : this.maxRequestBytes;
    if (Buffer.byteLength(encodedRequest) > requestLimit) {
      return Promise.reject(new CompilerClientError("invalid-input", COMPILER_CLIENT_ERROR.requestTooLarge));
    }

    const generation = this.generation;
    this.queuedCount += 1;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<T> = {
        kind,
        generation,
        settled: false,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        pending.abort = () => {
          if (pending.settled) return;
          const error = new CompilerClientError("aborted", COMPILER_CLIENT_ERROR.requestCancelled);
          if (kind === "compile") {
            this.failSession(error);
          } else {
            this.finishPending(pending, () => pending.reject(error));
          }
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.add(pending as PendingRequest);

      const execution = this.operationTail.then(async () => {
        if (generation !== this.generation) {
          throw new CompilerClientError("stale", COMPILER_CLIENT_ERROR.sessionSuperseded);
        }
        const engine = await this.getEngine(generation);
        if (generation !== this.generation) {
          throw new CompilerClientError("stale", COMPILER_CLIENT_ERROR.sessionSuperseded);
        }
        if (pending.settled) {
          throw new CompilerClientError("aborted", COMPILER_CLIENT_ERROR.requestCancelled);
        }
        pending.timeout = window.setTimeout(() => {
          if (generation !== this.generation || pending.settled) return;
          this.failSession(new CompilerClientError("timeout", COMPILER_CLIENT_ERROR.requestTimedOut));
        }, requestDeadlineMs(kind, this.timeoutMs, this.sessionCompileCount));
        if (kind === "compile") this.sessionCompileCount += 1;
        return this.callEngine(engine, kind, payload);
      });
      this.operationTail = execution.then(
        () => undefined,
        () => undefined,
      );

      void execution.then(
        (responseValue) => {
          if (generation === this.generation) this.queuedCount -= 1;
          if (generation !== this.generation || pending.settled) return;
          try {
            let response: unknown;
            if (typeof responseValue === "string") {
              if (Buffer.byteLength(responseValue) > this.maxOutputBytes) {
                throw new CompilerClientError(
                  "output-limit",
                  COMPILER_CLIENT_ERROR.outputTooLarge,
                );
              }
              try {
                response = JSON.parse(responseValue) as unknown;
              } catch {
                throw malformed(COMPILER_CLIENT_ERROR.malformedJson);
              }
            } else {
              if (kind !== "compile") {
                throw malformed(COMPILER_CLIENT_ERROR.nonTextResponse);
              }
              response = responseValue;
            }
            const value = parse(response);
            this.finishPending(pending, () => pending.resolve(value));
          } catch (error) {
            const clientError =
              error instanceof CompilerClientError
                ? error
                : malformed(COMPILER_CLIENT_ERROR.malformedResponse);
            // Optional IDE reads only observe retained state: refusing one bad
            // reply is enough. Compile, jump, and forward still fail the
            // whole session, because a document they cannot trust is one the
            // preview is already showing.
            if (
              kind !== "complete"
              && kind !== "definition"
              && (clientError.code === "malformed-protocol"
                || clientError.code === "output-limit")
            ) {
              this.failSession(clientError);
            } else {
              this.finishPending(pending, () => pending.reject(clientError));
            }
          }
        },
        (error) => {
          if (generation === this.generation) this.queuedCount -= 1;
          if (generation !== this.generation || pending.settled) return;
          this.failSession(asClientError(error, "crash", COMPILER_CLIENT_ERROR.wasmFailed));
        },
      );
    });
  }

  private async getEngine(generation: number): Promise<WasmEngine> {
    if (this.loadedEngine !== undefined) return this.loadedEngine;
    if (this.enginePromise !== undefined) return this.enginePromise;

    const promise = Promise.resolve()
      .then(() => this.engineFactory({
        rootPath: this.rootPath,
        wasmPath: this.wasmPath,
        maxOutputBytes: this.maxOutputBytes,
      }))
      .then(async (engine) => {
        if (generation !== this.generation || this.closed) {
          this.disposeEngine(engine);
          throw new CompilerClientError(
            this.closed ? "closed" : "stale",
            this.closed
              ? COMPILER_CLIENT_ERROR.clientClosed
              : COMPILER_CLIENT_ERROR.sessionSuperseded,
          );
        }
        this.loadedEngine = engine;
        await this.waitForEngine(engine);
        if (generation !== this.generation || this.closed) {
          throw new CompilerClientError(
            this.closed ? "closed" : "stale",
            this.closed
              ? COMPILER_CLIENT_ERROR.clientClosed
              : COMPILER_CLIENT_ERROR.sessionSuperseded,
          );
        }
        return engine;
      })
      .catch((error: unknown) => {
        if (this.enginePromise === promise) this.enginePromise = undefined;
        throw asClientError(error, "unavailable", COMPILER_CLIENT_ERROR.wasmCouldNotLoad);
      });
    this.enginePromise = promise;
    return promise;
  }

  private waitForEngine(engine: WasmEngine): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new CompilerClientError(
          "timeout",
          COMPILER_CLIENT_ERROR.initializationTimedOut,
        ));
      }, this.initializationTimeoutMs);
      void engine.ready().then(
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          window.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private callEngine(
    engine: WasmEngine,
    kind: RequestKind,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    switch (kind) {
      case "environment":
        return engine.checkEnvironment();
      case "compile":
        return engine.compile({
          revision: payload.revision as number,
          entryPath: payload.entryPath as string,
          ...(payload.overlay === undefined
            ? {}
            : { overlay: payload.overlay as ReadonlyMap<string, Uint8Array> }),
        });
      case "jump":
        return engine.jump(
          payload as { revision: number; page: number; xPt: number; yPt: number },
        );
      case "forward":
        return engine.forward(
          payload as { revision: number; source: string; byteOffset: number },
        );
      case "complete":
        return engine.complete(
          payload as {
            revision: number;
            source: string;
            sourceText: string;
            byteOffset: number;
            explicit: boolean;
          },
        );
      case "definition":
        return engine.definition(
          payload as {
            revision: number;
            source: string;
            sourceText: string;
            byteOffset: number;
          },
        );
    }
  }

  private finishPending<T>(pending: PendingRequest<T>, settle: () => void): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timeout !== undefined) window.clearTimeout(pending.timeout);
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    this.pending.delete(pending as PendingRequest);
    settle();
  }

  private failSession(error: CompilerClientError): void {
    this.generation += 1;
    this.queuedCount = 0;
    // The next request starts a cold session: fresh worker, no registered fonts,
    // no retained document. It gets the cold-start budget again.
    this.sessionCompileCount = 0;
    this.operationTail = Promise.resolve();
    this.latestDocumentRevision = undefined;

    const engine = this.loadedEngine;
    this.loadedEngine = undefined;
    this.enginePromise = undefined;
    if (engine !== undefined) this.disposeEngine(engine);

    for (const pending of [...this.pending]) {
      this.finishPending(pending, () => pending.reject(error));
    }
  }

  private disposeEngine(engine: WasmEngine): void {
    if (this.disposedEngines.has(engine)) return;
    this.disposedEngines.add(engine);
    try {
      engine.dispose();
    } catch {
      // Disposal is best-effort after the session has already been invalidated.
    }
  }
}
