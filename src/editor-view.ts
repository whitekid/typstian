import {
  autocompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, setDiagnostics as setLintDiagnostics } from "@codemirror/lint";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Platform, TextFileView, type WorkspaceLeaf } from "obsidian";

import type { CompilerCompletion, CompilerDiagnostic } from "./compiler-client";
import { typstLanguage } from "./language";
import { MESSAGES } from "./messages";

export const TYPST_VIEW_TYPE = "typst-editor";

export interface TypstForwardSearchRequest {
  sourcePath: string;
  sourceText: string;
  byteOffset: number;
}

export type TypstDefinitionRequest = TypstForwardSearchRequest;

export interface TypstCompletionRequest {
  sourcePath: string;
  sourceText: string;
  byteOffset: number;
  /** True when the user asked for completions rather than merely typing. */
  explicit: boolean;
}

export interface TypstCompletionResponse {
  /** Where the completed word starts, as a UTF-8 offset into `sourceText`. */
  byteOffset: number;
  completions: readonly CompilerCompletion[];
}

// One label for every surface that opens the preview — the palette command, the
// editor's header action, and the file menu — because a user who learns it in
// one place should recognize it in the others.
export const OPEN_PREVIEW_LABEL = MESSAGES.commands.openPreview;

export interface TypstEditorViewOptions {
  onDirty?: () => void;
  onForwardSearch?: (request: TypstForwardSearchRequest) => void;
  onComplete?: (
    request: TypstCompletionRequest,
  ) => Promise<TypstCompletionResponse | null>;
  onDefinition?: (request: TypstDefinitionRequest) => void | Promise<void>;
  onClose?: () => void;
  onOpenPreview?: (sourcePath: string) => void;
  isMacOS?: boolean;
}

/**
 * Typst's completion kinds mapped onto the icons CodeMirror knows. Anything
 * unmapped renders as plain text rather than borrowing the wrong icon.
 */
const COMPLETION_TYPES: Record<string, string> = {
  func: "function",
  type: "type",
  param: "property",
  constant: "constant",
  package: "namespace",
  label: "variable",
  syntax: "keyword"
};

/**
 * Which characters may be typed after a completion query without asking the
 * compiler again. A dot or a bracket changes what the cursor is inside, so
 * those end the run and provoke a fresh request.
 */
const COMPLETION_WORD = /^[\p{L}\p{N}_-]*$/u;

function toCodeMirrorCompletion(item: CompilerCompletion): Completion {
  const completion: Completion = {
    label: item.label,
    ...(COMPLETION_TYPES[item.kind] === undefined ? {} : { type: COMPLETION_TYPES[item.kind] }),
    ...(item.detail === undefined ? {} : { detail: item.detail })
  };
  // Typst describes a replacement in the same `${placeholder}` snippet syntax
  // CodeMirror reads, so `#figure` can land the cursor inside the body.
  return item.apply === undefined ? completion : snippetCompletion(item.apply, completion);
}

export function utf8ByteOffset(sourceText: string, position: number): number | null {
  if (!Number.isSafeInteger(position) || position < 0 || position > sourceText.length) return null;
  if (
    position > 0
    && position < sourceText.length
    && /[\uD800-\uDBFF]/u.test(sourceText[position - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(sourceText[position] ?? "")
  ) {
    return null;
  }
  return new TextEncoder().encode(sourceText.slice(0, position)).length;
}

/**
 * The inverse of `utf8ByteOffset`: the compiler counts UTF-8 bytes and the
 * editor counts UTF-16 units, so every offset crossing that boundary passes
 * through one of these two. A byte offset inside a character has no position.
 */
export function utf16Position(sourceText: string, byteOffset: number): number | null {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return null;
  const encoded = new TextEncoder().encode(sourceText);
  if (byteOffset > encoded.length) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(encoded.subarray(0, byteOffset)).length;
  } catch {
    return null;
  }
}

const editorExtensions: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  // Obsidian's own find bar never reaches a custom TextFileView, so this view
  // carries its own search panel.
  search(),
  // Search binds ahead of the defaults so Escape closes the panel instead of
  // being eaten by the selection-simplifying Escape in `defaultKeymap`.
  keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
  highlightActiveLine(),
  EditorView.lineWrapping,
  typstLanguage,
];

export class TypstEditorView extends TextFileView {
  readonly editorView: EditorView;
  private readonly onDirty: () => void;
  private applyingExternalData = false;

  private readonly onForwardSearch: (request: TypstForwardSearchRequest) => void;
  private readonly onComplete: (
    request: TypstCompletionRequest,
  ) => Promise<TypstCompletionResponse | null>;
  private readonly onDefinition: (request: TypstDefinitionRequest) => void | Promise<void>;
  private readonly onClosed: () => void;
  private readonly isMacOS: boolean;
  private dirty = false;
  private editGeneration = 0;
  constructor(leaf: WorkspaceLeaf, options: TypstEditorViewOptions = {}) {
    super(leaf);
    this.onDirty = options.onDirty ?? (() => undefined);
    this.onForwardSearch = options.onForwardSearch ?? (() => undefined);
    this.onComplete = options.onComplete ?? (() => Promise.resolve(null));
    this.onDefinition = options.onDefinition ?? (() => undefined);
    this.onClosed = options.onClose ?? (() => undefined);
    this.isMacOS = options.isMacOS ?? Platform.isMacOS;
    const onOpenPreview = options.onOpenPreview;
    // Registered with the view, not derived from the active view, so a Typst
    // editor in a background split offers it too. A view built without the
    // option gets no action at all rather than one that silently does nothing.
    if (onOpenPreview !== undefined) {
      this.addAction("file-text", OPEN_PREVIEW_LABEL, () => {
        const file = this.file;
        // A leaf that has not opened a file yet has nothing to preview.
        if (file === null) return;
        onOpenPreview(file.path);
      });
    }
    this.contentEl.classList.add("typstian-editor");
    this.editorView = new EditorView({
      parent: this.contentEl,
      state: this.createState(""),
    });
  }

  getViewType(): string {
    return TYPST_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? MESSAGES.editor.title;
  }

  override getViewData(): string {
    return this.editorView.state.doc.toString();
  }

  markSaved(data: string): boolean {
    if (data !== this.getViewData()) return false;
    this.dirty = false;
    return true;
  }

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  canDiscardUncommittedOpen(): boolean {
    return !this.dirty && this.editGeneration === 0;
  }

  override setViewData(data: string, clear: boolean): void {
    if (clear) {
      this.editorView.setState(this.createState(data));
      this.editGeneration = 0;
    } else if (data !== this.getViewData()) {
      this.applyingExternalData = true;
      try {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: data },
        });
      } finally {
        this.applyingExternalData = false;
      }
    }
    this.data = data;
    this.dirty = false;
  }

  override clear(): void {
    this.editorView.setState(this.createState(""));
    this.data = "";
    this.editGeneration = 0;
  }

  revealDiagnostic(line: number, column: number): void {
    const position = this.diagnosticPosition(line, column);
    if (position === null) return;

    this.editorView.dispatch({
      selection: { anchor: position.from },
      scrollIntoView: true,
    });
    this.editorView.focus();
  }

  /**
   * Replaces every mark in this editor with the diagnostics of the latest
   * compile. Diagnostics of other files belong to their own editor, and one
   * without a position cannot be underlined; both stay in the preview list.
   */
  setDiagnostics(diagnostics: readonly CompilerDiagnostic[]): void {
    const ownPath = this.file?.path;
    const marks: Diagnostic[] = [];
    for (const diagnostic of diagnostics) {
      if (ownPath === undefined || diagnostic.path !== ownPath) continue;
      if (diagnostic.line === undefined || diagnostic.column === undefined) continue;
      const position = this.diagnosticPosition(diagnostic.line, diagnostic.column);
      if (position === null) continue;
      marks.push({
        from: position.from,
        to: position.lineTo,
        severity: diagnostic.severity,
        message: diagnostic.message,
      });
    }

    this.editorView.dispatch(setLintDiagnostics(this.editorView.state, marks));
  }

  revealByteOffset(byteOffset: number): boolean {
    const position = utf16Position(this.editorView.state.doc.toString(), byteOffset);
    if (position === null) return false;

    this.editorView.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    });
    this.editorView.focus();
    return true;
  }


  /** Requests a retained-document definition for the current editor cursor. */
  async goToDefinition(): Promise<void> {
    const file = this.file;
    if (file === null || file.extension !== "typ") return;
    const sourceText = this.editorView.state.doc.toString();
    const byteOffset = utf8ByteOffset(sourceText, this.editorView.state.selection.main.head);
    if (byteOffset === null) return;
    await this.onDefinition({ sourcePath: file.path, sourceText, byteOffset });
  }

  override onClose(): Promise<void> {
    this.onClosed();
    this.editorView.destroy();
    return Promise.resolve();
  }

  /**
   * Maps a compiler's 1-based line and UTF-16 column onto this document. The
   * buffer may have changed since the compile, so a location past the end of a
   * line or of the document clamps instead of failing.
   */
  private diagnosticPosition(
    line: number,
    column: number,
  ): { from: number; lineTo: number } | null {
    // Without a line there is nothing to point at, but a garbled column still
    // has one: mark the whole line rather than dropping the message.
    if (!Number.isFinite(line)) return null;
    const document = this.editorView.state.doc;
    const lineNumber = Math.min(Math.max(Math.trunc(line), 1), document.lines);
    const targetLine = document.line(lineNumber);
    const columnOffset = Number.isFinite(column)
      ? Math.min(Math.max(Math.trunc(column) - 1, 0), targetLine.length)
      : 0;
    return { from: targetLine.from + columnOffset, lineTo: targetLine.to };
  }

  /**
   * Answers CodeMirror with the completions the compiler holds for the cursor.
   * The compiler answers from the document of the last compile, so a reply that
   * outlived its buffer is dropped rather than applied at a moved position; and
   * a file the compiler does not own never asks at all.
   */
  private readonly completionSource = async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const file = this.file;
    if (file === null || file.extension !== "typ") return null;
    const sourceText = context.state.doc.toString();
    const byteOffset = utf8ByteOffset(sourceText, context.pos);
    if (byteOffset === null) return null;

    const response = await this.onComplete({
      sourcePath: file.path,
      sourceText,
      byteOffset,
      explicit: context.explicit
    });
    if (
      response === null
      || response.completions.length === 0
      || context.aborted
      || this.editorView.state.doc.toString() !== sourceText
    ) {
      return null;
    }
    const from = utf16Position(sourceText, response.byteOffset);
    if (from === null || from > context.pos) return null;
    return {
      from,
      options: response.completions.map(toCodeMirrorCompletion),
      validFor: COMPLETION_WORD
    };
  };

  private createState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        editorExtensions,
        autocompletion({ override: [this.completionSource] }),
        EditorView.domEventHandlers({
          click: (event, view) => {
            const primaryModifier = this.isMacOS ? event.metaKey : event.ctrlKey;
            if (
              event.button !== 0
              || !primaryModifier
              || event.altKey
              || event.shiftKey
            ) {
              return false;
            }
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position === null) return false;
            event.preventDefault();
            view.dispatch({ selection: { anchor: position } });
            void this.goToDefinition();
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !this.applyingExternalData) {
            this.data = update.state.doc.toString();
            this.dirty = true;
            this.editGeneration += 1;
            this.onDirty();
            this.requestSave();
          }

          const userSelection = update.transactions.some(
            (transaction) => transaction.isUserEvent("select"),
          );
          if (
            !userSelection
            || this.file?.extension !== "typ"
            || this.dirty
          ) {
            return;
          }

          const sourceText = update.state.doc.toString();
          const byteOffset = utf8ByteOffset(
            sourceText,
            update.state.selection.main.head,
          );
          if (byteOffset === null) return;
          this.onForwardSearch({
            sourcePath: this.file.path,
            sourceText,
            byteOffset,
          });
        }),
      ],
    });
  }
}
