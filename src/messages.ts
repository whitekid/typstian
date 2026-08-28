import type { CompilationRootProblem } from "./path-policy";

export const MESSAGES = {
  commands: {
    createTypstFile: "Create a Typst file",
    openPreview: "Open Typst preview",
    savePdf: "Save the compiled PDF to the vault",
    checkEnvironment: "Check Typst environment",
    goToDefinition: "Go to definition",
    newTypstFile: "New Typst file",
  },
  editor: {
    title: "Typst editor",
  },
  preview: {
    title: "Typst preview",
    unableToRender: "Unable to render the compiled PDF.",
    idle: "Open a Typst file to preview it.",
    compiling: "Compiling Typst document…",
    failedUnexpectedly: "Typst preview failed unexpectedly.",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    fit: "Fit",
    fitTitle: "Fit pages to the preview width",
    save: "Save",
    saving: "Saving…",
  },
  pdf: {
    pageError: "Could not render PDF page.",
    retry: "Retry",
    source: "Source",
    pageNavigation: "PDF page navigation",
    previousPage: "Previous PDF page",
    nextPage: "Next PDF page",
    pageNumber: "PDF page number",
  },
  settings: {
    compilationRoot: "Compilation root",
    rootPlaceholder: "projects/book",
    rootDescription: "Optional path relative to the vault. Empty uses the vault root.",
    rootReady: "Ready: this folder is inside the vault.",
  },
  status: {
    compiling: "Typst: compiling…",
    idle: "Typst: idle",
    failed: "Typst: failed",
  },
  notices: {
    tooManyUntitled: "Too many untitled Typst files sit in this folder; rename some and try again.",
    entryOutsideRoot: "The Typst entry file must be inside the configured compilation root.",
    sourceUnreadable: "Unable to read the Typst source to reveal the matching spot in the preview.",
    saveBeforeReveal: "Save the Typst file to reveal the matching spot in the preview.",
    openPreviewBeforeReveal: "Open a preview of this Typst source to reveal the matching spot in it.",
    sourceOutsideRoot: "The Typst source must be inside the configured compilation root.",
    staleSourceLocation: "That source location is no longer valid for the current file.",
    sourceOutsideVault: "The source location points outside this vault.",
    compilerUnavailable: "Unable to initialize the bundled Typstian WASM compiler.",
    tooManySavedPdfs: "Too many saved PDFs sit beside this Typst file; remove some and try again.",
  },
} as const;


/**
 * CompilerClientError messages are rendered directly by the preview and notices.
 * Keep protocol-validation copy here too: those failures use the same visible path.
 */
export const COMPILER_CLIENT_ERROR = {
  invalidCompilerValue: (label: string): string => `Compiler returned an invalid ${label}.`,
  unsafeCompilerPath: (label: string): string => `Compiler returned an unsafe ${label}.`,
  wrongResponse: (kind: string): string => `Compiler returned the wrong response for ${kind}.`,
  vaultRelativePath: (label: string): string => `${label} must be a vault-relative path.`,
  positiveInteger: (label: string): string => `${label} must be a positive integer.`,
  revisionNonNegative: "Revision must be a non-negative integer.",
  invalidDiagnostics: "Compiler returned invalid diagnostics.",
  invalidDiagnosticSeverity: "Compiler returned an invalid diagnostic severity.",
  invalidDependencies: "Compiler returned invalid dependencies.",
  invalidErrorRevision: "Compiler returned an invalid error revision.",
  wrongErrorRevision: "Compiler returned the wrong error revision.",
  protocolVersionMismatch: "Typstian compiler protocol version does not match the plugin.",
  wrongCompileRevision: "Compiler returned the wrong compile revision.",
  pdfTooLarge: "Typstian compiler PDF exceeded its size limit.",
  invalidBase64Pdf: "Compiler returned invalid base64 PDF data.",
  invalidPdfArtifact: "Compiler returned an invalid PDF artifact.",
  invalidPdfPageMetadata: "Compiler returned invalid PDF page metadata.",
  previewRevisionInactive: "Preview revision is no longer active.",
  wrongJumpRevision: "Compiler returned the wrong jump revision.",
  wrongJumpResponse: "Compiler returned the wrong jump response.",
  wrongPreviewPositionRevision: "Compiler returned the wrong revision for a preview position.",
  wrongPreviewPositionReply: "Compiler returned the wrong reply for a preview position.",
  tooManyPreviewPositions: "Compiler returned too many preview positions.",
  invalidForwardPage: "Compiler returned an invalid forward page.",
  wrongCompletionRevision: "Compiler returned the wrong completion revision.",
  wrongCompletionResponse: "Compiler returned the wrong completion response.",
  tooManyCompletions: "Compiler returned too many completions.",
  completionPastCursor: "Compiler returned a completion past the cursor.",
  wrongDefinitionRevision: "Compiler returned the wrong definition revision.",
  wrongDefinitionResponse: "Compiler returned the wrong definition response.",
  vaultRootRequired: "Vault root path is required.",
  compileRequestInvalid: "Compile request is invalid.",
  requestCancelled: "Typst engine request was cancelled.",
  compileSuperseded: "Compile revision has been superseded.",
  jumpCoordinatesInvalid: "Jump coordinates are invalid.",
  jumpRequestInvalid: "Jump request is invalid.",
  forwardByteOffsetInvalid: "Forward byte offset is invalid.",
  forwardRequestInvalid: "Forward request is invalid.",
  completionByteOffsetInvalid: "Completion byte offset is invalid.",
  completionSourceTooLarge: "Completion source text is too large.",
  completionRequestInvalid: "Completion request is invalid.",
  definitionByteOffsetInvalid: "Definition byte offset is invalid.",
  definitionSourceTooLarge: "Definition source text is too large.",
  definitionRequestInvalid: "Definition request is invalid.",
  clientClosed: "Typst engine client is closed.",
  requestTooLarge: "Typst engine request is too large.",
  sessionSuperseded: "Typst engine session has been superseded.",
  requestTimedOut: "Typst engine request timed out.",
  outputTooLarge: "Typst engine output exceeded its limit.",
  malformedJson: "Typst engine returned malformed JSON.",
  nonTextResponse: "Typst engine returned a non-text response.",
  malformedResponse: "Typst engine returned a malformed response.",
  wasmFailed: "Typst WASM engine failed.",
  wasmCouldNotLoad: "Typst WASM engine could not be loaded.",
  initializationTimedOut: "Typst WASM engine initialization timed out.",
} as const;

export const COMPILATION_ROOT_PROBLEM: Record<CompilationRootProblem, string> = {
  "missing": "No folder at this path yet. Create it, or type a path that exists.",
  "not-a-folder": "This path is a file, not a folder. Type the path of a folder instead.",
  "broken-link": "This link points at nothing. Fix the link, or type another path.",
  "unreadable": "This path cannot be read. Check its permissions, or type another path.",
  "outside-vault": "This path leaves the vault. Type a path inside the vault instead.",
};

export const previewTitle = (sourcePath: string | null): string => sourcePath === null
  ? MESSAGES.preview.title
  : `${MESSAGES.preview.title}: ${sourcePath.split("/").at(-1) ?? sourcePath}`;

export const failedCompileStatus = (errorCount: number): string =>
  `${MESSAGES.status.failed} (${errorCount} ${errorCount === 1 ? "error" : "errors"})`;


export const diagnosticCopy = (
  { path, line, column, message }: {
    path: string;
    line: number;
    column: number;
    message: string;
  },
): { text: string; label: string } => ({
  text: `${path}:${line}:${column} — ${message}`,
  label: `Go to ${path}, line ${line}, column ${column}: ${message}`,
});

export const pdfPageLabel = (page: number): string => `PDF page ${page}`;
export const pdfTextLayerLabel = (page: number): string => `Selectable text for PDF page ${page}`;
export const pdfSourceLabel = (page: number): string => `Jump to source from PDF page ${page}`;
export const pdfRetryLabel = (page: number): string => `Retry PDF page ${page}`;

export const createFailedNotice = (path: string, reason: string): string =>
  `Unable to create ${path}: ${reason}`;
export const sourceNotFoundNotice = (path: string): string => `Typst source not found: ${path}`;
export const environmentNotice = (version: string, root: string): string =>
  `Typstian WASM compiler; Typst ${version}\nRoot: ${root}`;
export const savedPdfNotice = (path: string): string => `Saved the compiled PDF to ${path}`;
export const savePdfFailedNotice = (path: string): string =>
  `Unable to save the compiled PDF to ${path}`;
