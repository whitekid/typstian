import fs from "node:fs";
import path from "node:path";
import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TFile,
  TFolder,
  View,
  type WorkspaceLeaf
} from "obsidian";

import {
  EMPTY_COMPILE_STATUS,
  compileStatusLabel,
  reduceCompileStatus,
  type CompileStatusEvent,
  type CompileStatusState,
  compileOutcomeForFailure
} from "./compile-status";
import { DependencyIndex } from "./dependency-index";
import { collectDirtyBuffers } from "./dirty-buffer-overlay";
import { OptionalReadScheduler } from "./optional-read-scheduler";
import { ForwardSearchScheduler } from "./forward-search-scheduler";
import { SourceNavigationScheduler } from "./source-navigation-scheduler";
import { chooseSourceEditorLeaf } from "./editor-leaf-policy";
import {
  OPEN_PREVIEW_LABEL,
  TYPST_VIEW_TYPE,
  TypstEditorView,
  type TypstCompletionRequest,
  type TypstCompletionResponse,
  type TypstDefinitionRequest,
  type TypstForwardSearchRequest
} from "./editor-view";
import {
  CompilerClientError,
  TypstianCompilerClient,
  type CompilerCompileResult,
  type CompilerDiagnostic
} from "./compiler-client";
import {
  resolveCompilationRoot,
  resolveDiagnosticVaultPath,
  resolveCompilerEntryPath,
  checkCompilationRoot,
  type CompilationRootCheck
} from "./path-policy";
import {
  COMPILATION_ROOT_PROBLEM,
  createFailedNotice,
  environmentNotice,
  MESSAGES,
  savedPdfNotice,
  savePdfFailedNotice,
  sourceNotFoundNotice,
} from "./messages";
import { isWithinVaultFolder, resolveNewTypstFile } from "./new-typst-file";

type CompilationRootFolder =
  | { readonly ok: true; readonly folder: string }
  | Extract<CompilationRootCheck, { ok: false }>;
import { resolvePdfExportPath } from "./pdf-export";
import {
  chooseForwardPreview,
  isSavedForwardSnapshot,
  shouldPreviewFollow
} from "./preview-routing";
import {
  TYPST_PREVIEW_VIEW_TYPE,
  TypstPreviewView,
  type TypstSourceLocation
} from "./preview-view";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type TypstianSettings
} from "./settings-model";
import { TypstianSettingsTab } from "./settings-tab";

export default class TypstianPlugin extends Plugin {
  override settings: TypstianSettings = DEFAULT_SETTINGS;
  private readonly dependencies = new DependencyIndex();
  private readonly compilers = new Set<TypstianCompilerClient>();
  private readonly forwardSearchScheduler = new ForwardSearchScheduler<{
    editor: TypstEditorView;
    request: TypstForwardSearchRequest;
  }>(({ editor, request }, isCurrent) =>
    this.handleForwardSearch(editor, request, isCurrent)
  );
  private readonly completionScheduler = new OptionalReadScheduler<
    { editor: TypstEditorView; request: TypstCompletionRequest },
    TypstCompletionResponse
  >(({ editor, request }, isCurrent) => this.handleCompletion(editor, request, isCurrent));
  private readonly definitionScheduler = new OptionalReadScheduler<
    { editor: TypstEditorView; request: TypstDefinitionRequest },
    void
  >(({ editor, request }, isCurrent) => this.handleDefinition(editor, request, isCurrent));
  private readonly sourceNavigationScheduler =
    new SourceNavigationScheduler<TypstSourceLocation>(
      (location, isCurrent) => this.performRevealSourceLocation(location, isCurrent)
    );
  private revealingSourceLeaf: WorkspaceLeaf | null = null;
  private creatingSourceLeaf = false;
  private settingsUpdate = Promise.resolve();

  private compileStatus: CompileStatusState = EMPTY_COMPILE_STATUS;
  private compileStatusEl: HTMLElement | null = null;
  private nextPreviewId = 0;

  private unloaded = false;
  private lifecycleGeneration = 0;

  override async onload(): Promise<void> {
    this.unloaded = false;
    this.lifecycleGeneration += 1;
    this.settings = normalizeSettings(
      await this.loadData() as Parameters<typeof normalizeSettings>[0] | null ?? {}
    );

    this.compileStatus = EMPTY_COMPILE_STATUS;
    this.compileStatusEl = this.addStatusBarItem();
    this.renderCompileStatus();

    this.registerView(TYPST_VIEW_TYPE, (leaf) => this.createEditorView(leaf));
    this.registerExtensions(["typ"], TYPST_VIEW_TYPE);
    this.registerView(TYPST_PREVIEW_VIEW_TYPE, (leaf) => this.createPreviewView(leaf));

    this.addCommand({
      id: "create-typst-file",
      name: MESSAGES.commands.createTypstFile,
      callback: () => {
        const root = this.compilationRootFolder();
        if (!root.ok) {
          new Notice(COMPILATION_ROOT_PROBLEM[root.reason]);
          return;
        }
        void this.createTypstFile(root.folder);
      }
    });
    this.addCommand({
      id: "open-typst-preview",
      name: OPEN_PREVIEW_LABEL,
      checkCallback: (checking) => {
        const source = this.activeTypstPath();
        if (source === null) return false;
        if (!checking) void this.openPreview(source);
        return true;
      }
    });
    this.addCommand({
      id: "go-to-definition",
      name: MESSAGES.commands.goToDefinition,
      checkCallback: (checking) => {
        const editor = this.app.workspace.getActiveViewOfType(TypstEditorView);
        if (editor?.file?.extension !== "typ") return false;
        if (!checking) void editor.goToDefinition();
        return true;
      }
    });
    this.addCommand({
      id: "save-compiled-pdf",
      name: MESSAGES.commands.savePdf,
      checkCallback: (checking) => {
        const source = this.activeTypstPath();
        if (source === null) return false;
        if (!checking) void this.savePdf(source);
        return true;
      }
    });
    this.addCommand({
      id: "check-typst-environment",
      name: MESSAGES.commands.checkEnvironment,
      callback: () => { void this.checkEnvironment(); }
    });
    this.addSettingTab(new TypstianSettingsTab(this.app, this));

    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (
        !this.creatingSourceLeaf
        && leaf !== this.revealingSourceLeaf
      ) {
        this.sourceNavigationScheduler.cancel();
      }
      if (leaf?.view instanceof TypstEditorView && leaf.view.file !== null) {
        this.followInAllPreviews(leaf.view.file.path);
      }
    }));
    // The file explorer's context menu is where a user looks for what can be
    // done to a file or a folder: previewing the Typst file they right-clicked,
    // and creating one inside a folder — which the command palette cannot
    // express, having no way to say "in this folder".
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      // Not gated on the compilation root: opening a preview only reports the
      // root problem, the way `open-typst-preview` does.
      if (file instanceof TFile && file.extension === "typ") {
        menu.addItem((item) => item
          .setTitle(OPEN_PREVIEW_LABEL)
          .setIcon("file-text")
          .onClick(() => { void this.openPreview(file.path); }));
        return;
      }
      if (!(file instanceof TFolder)) return;
      // Offering it outside the compilation root would hand the user a file
      // nothing can compile — the failure this command exists to undo.
      const root = this.compilationRootFolder();
      if (!root.ok || !isWithinVaultFolder(root.folder, file.path)) return;
      menu.addItem((item) => item
        .setTitle(MESSAGES.commands.newTypstFile)
        .setIcon("file-plus")
        .onClick(() => { void this.createTypstFile(file.path); }));
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.handleSavedFile(file);
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      this.handleSavedFile(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.handleVaultPath(file.path);
      this.dependencies.remove(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && file.extension === "typ") {
        for (const preview of this.previewViews()) {
          if (preview.getSourcePath() === oldPath) preview.follow(file.path);
        }
      }
      this.handleVaultPath(oldPath);
      this.dependencies.remove(oldPath);
      this.handleVaultPath(file.path, false);
    }));

    this.app.workspace.onLayoutReady(() => {
      for (const preview of this.previewViews()) {
        const source = preview.getSourcePath();
        if (source === null) continue;
        const file = this.app.vault.getAbstractFileByPath(source);
        if (file instanceof TFile && file.extension === "typ") preview.refresh();
        else preview.follow(null);
      }
    });
  }

  override onunload(): void {
    this.unloaded = true;
    this.lifecycleGeneration += 1;
    this.forwardSearchScheduler.dispose();
    this.completionScheduler.dispose();
    this.definitionScheduler.dispose();
    this.sourceNavigationScheduler.dispose();
    for (const compiler of this.compilers) compiler.close();
    this.compilers.clear();
    this.dependencies.clear();
    // Obsidian removes the item itself; dropping the reference keeps a late
    // compile result from writing into a detached element.
    this.compileStatusEl = null;
    this.compileStatus = EMPTY_COMPILE_STATUS;
  }

  async updateSettings(value: TypstianSettings): Promise<void> {
    const next = normalizeSettings(value);
    const lifecycleGeneration = this.lifecycleGeneration;
    const update = this.settingsUpdate.then(async () => {
      if (
        this.unloaded
        || lifecycleGeneration !== this.lifecycleGeneration
        || next.rootPath === this.settings.rootPath
      ) {
        return;
      }
      await this.saveData(next);
      if (this.unloaded || lifecycleGeneration !== this.lifecycleGeneration) return;
      this.settings = next;
      for (const preview of this.previewViews()) preview.restartBackend();
    });
    this.settingsUpdate = update.catch(() => undefined);
    await update;
  }

  private createEditorView(leaf: WorkspaceLeaf): TypstEditorView {
    const view = new TypstEditorView(leaf, {
      onDirty: () => {
        const source = view.file?.path;
        if (source === undefined) return;
        this.handleDirtyPath(source);
      },
      onForwardSearch: (request) => {
        this.forwardSearchScheduler.schedule(view, { editor: view, request });
      },
      // The buffer the request was built from is the staleness check: an answer
      // that arrives after another keystroke would point at a moved cursor.
      onComplete: (request): Promise<TypstCompletionResponse | null> =>
        this.completionScheduler.schedule(
        { editor: view, request },
        () => !this.unloaded && view.getViewData() === request.sourceText
      ),
      onDefinition: async (request) => {
        await this.definitionScheduler.schedule(
          { editor: view, request },
          () => !this.unloaded
            && !view.isClosed()
            && view.file?.path === request.sourcePath
            && view.getViewData() === request.sourceText,
        );
      },
      onClose: () => {
        this.forwardSearchScheduler.cancel(view);
      },
      onOpenPreview: (sourcePath) => { void this.openPreview(sourcePath); }
    });
    return view;
  }

  private createPreviewView(leaf: WorkspaceLeaf): TypstPreviewView {
    const previewId = `preview-${++this.nextPreviewId}`;
    let compiler: TypstianCompilerClient | null = null;
    const getCompiler = (): TypstianCompilerClient => {
      compiler ??= this.createCompilerClient();
      return compiler;
    };
    const closeCompiler = (): void => {
      if (compiler === null) return;
      compiler.close();
      this.compilers.delete(compiler);
      compiler = null;
    };

    let view!: TypstPreviewView;
    view = new TypstPreviewView(leaf, {
      compile: async (sourcePath, revision, signal) => {
        const vaultRoot = this.vaultRoot();
        const root = this.compilationRoot(vaultRoot);
        const entryPath = resolveCompilerEntryPath(vaultRoot, root, sourcePath);
        if (entryPath === null) {
          throw new CompilerClientError(
            "invalid-input",
            MESSAGES.notices.entryOutsideRoot
          );
        }
        this.noteCompileStatus({ type: "started", preview: previewId });
        try {
          const result = await getCompiler().compile({
            entryPath,
            revision,
            overlay: this.dirtyBufferOverlay(vaultRoot, root),
            signal
          });
          this.noteCompileStatus(result.ok
            ? { type: "settled", preview: previewId, outcome: "ok" }
            : {
              type: "settled",
              preview: previewId,
              outcome: "error",
              errorCount: result.diagnostics.filter((one) => one.severity === "error").length
            });
          return result;
        } catch (error) {
          this.noteCompileStatus({
            type: "settled",
            preview: previewId,
            outcome: compileOutcomeForFailure(error, signal.aborted)
          });
          throw error;
        }
      },
      jump: (request) => getCompiler().jump(request),
      forward: (request) => getCompiler().forward(request),
      complete: (request) => getCompiler().complete(request),
      definition: (request) => getCompiler().definition(request),
      onCompiled: (sourcePath, result) => {
        this.recordDependencies(sourcePath, result);
        this.publishDiagnostics(result);
      },
      onDiagnostic: (diagnostic) => { void this.revealDiagnostic(diagnostic); },
      onSourceLocation: (location, isCurrent) => this.revealSourceLocation(location, isCurrent),
      savePdf: (sourcePath) => this.savePdf(sourcePath),
      disposeBackend: () => {
        const sourcePath = view.getSourcePath();
        closeCompiler();
        this.noteCompileStatus({ type: "disposed", preview: previewId });
        if (
          sourcePath !== null
          && !this.previewViews().some((candidate) => (
            candidate !== view && candidate.getSourcePath() === sourcePath
          ))
        ) {
          this.dependencies.remove(sourcePath);
        }
      },
      // A restart keeps the preview open, so its status entry survives it.
      restartBackend: closeCompiler,
      requestSaveLayout: () => this.app.workspace.requestSaveLayout()
    });
    return view;
  }

  /**
   * Every preview reports into one status bar item: a preview is rarely the
   * active leaf — the user types in the editor — so keying the item to the
   * active leaf would blank it exactly when a compile is worth watching. A
   * compile in flight anywhere therefore wins, and once everything settles the
   * preview that settled last speaks, which is the one the user just edited.
   */
  private noteCompileStatus(event: CompileStatusEvent): void {
    this.compileStatus = reduceCompileStatus(this.compileStatus, event);
    this.renderCompileStatus();
  }

  private renderCompileStatus(): void {
    const element = this.compileStatusEl;
    if (element === null) return;
    const label = compileStatusLabel(this.compileStatus);
    element.setText(label);
    if (label === "") element.hide();
    else element.show();
  }

  private createCompilerClient(): TypstianCompilerClient {
    const vaultRoot = this.vaultRoot();
    if (this.manifest.dir === undefined) {
      throw new Error("Typstian plugin directory is unavailable.");
    }
    const compiler = new TypstianCompilerClient({
      rootPath: this.compilationRoot(vaultRoot),
      wasmPath: path.join(vaultRoot, this.manifest.dir, "typstian_wasm_bg.wasm"),
    });
    this.compilers.add(compiler);
    return compiler;
  }

  /**
   * Mirrors a compile's diagnostics into the editors that compile covers. Its
   * own dependency list bounds the fan-out: another project's preview reports
   * on its own files, and clearing every open editor would wipe the marks it
   * just published.
   */
  private publishDiagnostics(result: CompilerCompileResult): void {
    const vaultRoot = this.vaultRoot();
    const root = this.compilationRoot(vaultRoot);
    const toVaultPath = (compilerPath: string): string | null =>
      resolveDiagnosticVaultPath(vaultRoot, root, compilerPath);
    const covered = new Set(
      result.dependencies
        .map((dependency) => toVaultPath(dependency))
        .filter((vaultPath): vaultPath is string => vaultPath !== null)
    );
    const located = result.diagnostics.map((diagnostic) => {
      if (diagnostic.path === undefined) return diagnostic;
      return { ...diagnostic, path: toVaultPath(diagnostic.path) ?? undefined };
    });
    for (const leaf of this.app.workspace.getLeavesOfType(TYPST_VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof TypstEditorView)) continue;
      const path = view.file?.path;
      if (path !== undefined && covered.has(path)) view.setDiagnostics(located);
    }
  }

  private recordDependencies(sourcePath: string, result: CompilerCompileResult): void {
    const vaultRoot = this.vaultRoot();
    const root = this.compilationRoot(vaultRoot);
    const absoluteDependencies = result.dependencies.map((dependency) => path.resolve(root, dependency));
    if (result.ok) this.dependencies.update(sourcePath, absoluteDependencies);
    else this.dependencies.extend(sourcePath, absoluteDependencies);
  }

  // Obsidian's own "New note" only ever makes Markdown, and `registerExtensions`
  // opens `.typ` files that already exist — so without this there is no way to
  // reach the Typst editor, or the preview behind it, from inside the app.
  private async createTypstFile(folderPath: string): Promise<void> {
    const target = resolveNewTypstFile(
      folderPath,
      (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null
    );
    if (target === null) {
      new Notice(MESSAGES.notices.tooManyUntitled);
      return;
    }
    try {
      const file = await this.app.vault.create(target.path, target.content);
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      new Notice(createFailedNotice(target.path, reason));
    }
  }

  private async openPreview(sourcePath: string): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)[0];
    if (leaf === undefined) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: TYPST_PREVIEW_VIEW_TYPE, active: true });
    }
    if (leaf.view instanceof TypstPreviewView) leaf.view.follow(sourcePath);
    await this.app.workspace.revealLeaf(leaf);
  }

  private followInAllPreviews(sourcePath: string): void {
    const affectedEntries = new Set(
      this.dependencies.affectedBy(path.resolve(this.vaultRoot(), sourcePath))
    );
    for (const preview of this.previewViews()) {
      const entry = preview.getSourcePath();
      if (shouldPreviewFollow(entry, sourcePath, affectedEntries)) preview.follow(sourcePath);
    }
  }

  private dirtyBufferOverlay(
    vaultRoot: string,
    compilationRoot: string
  ): ReadonlyMap<string, Uint8Array> {
    const buffers = this.app.workspace.getLeavesOfType(TYPST_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is TypstEditorView => view instanceof TypstEditorView)
      .filter((view) => view.file !== null && view.hasUnsavedChanges())
      .map((view) => ({ path: view.file!.path, text: view.getViewData() }));
    return collectDirtyBuffers(vaultRoot, compilationRoot, buffers);
  }

  private previewViews(): TypstPreviewView[] {
    return this.app.workspace.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is TypstPreviewView => view instanceof TypstPreviewView);
  }

  private activeTypstPath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(TypstEditorView);
    return view?.file?.path ?? null;
  }

private handleVaultPath(vaultPath: string, includeDirectEntry = true): void {
    const absolutePath = path.resolve(this.vaultRoot(), vaultPath);
    const affected = new Set(this.dependencies.affectedBy(absolutePath));
    if (includeDirectEntry && path.extname(vaultPath).toLowerCase() === ".typ") {
      affected.add(vaultPath);
    }
    for (const preview of this.previewViews()) {
      const source = preview.getSourcePath();
      if (source !== null && affected.has(source)) preview.refresh();
    }
  }

  private handleSavedFile(file: unknown): void {
    if (!(file instanceof TFile)) return;
    if (file.extension === "typ") void this.markSavedEditors(file);
    this.handleVaultPath(file.path);
  }

  private async markSavedEditors(file: TFile): Promise<void> {
    let savedText: string;
    try {
      savedText = await this.app.vault.read(file);
    } catch {
      return;
    }
    for (const leaf of this.app.workspace.getLeavesOfType(TYPST_VIEW_TYPE)) {
      if (leaf.view instanceof TypstEditorView && leaf.view.file?.path === file.path) {
        leaf.view.markSaved(savedText);
      }
    }
  }

  private async handleForwardSearch(
    editor: TypstEditorView,
    request: TypstForwardSearchRequest,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (
      !isCurrent()
      || editor.file?.path !== request.sourcePath
      || editor.getViewData() !== request.sourceText
    ) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(request.sourcePath);
    if (!(file instanceof TFile)) return;

    let savedText: string;
    try {
      savedText = await this.app.vault.read(file);
    } catch {
      if (isCurrent()) new Notice(MESSAGES.notices.sourceUnreadable);
      return;
    }
    if (!isCurrent()) return;
    if (!isSavedForwardSnapshot(
      editor.file?.path ?? null,
      editor.getViewData(),
      savedText,
      request
    )) {
      new Notice(MESSAGES.notices.saveBeforeReveal);
      return;
    }

    const preview = this.previewForSource(request.sourcePath);
    if (!isCurrent()) return;
    if (preview === undefined) {
      new Notice(MESSAGES.notices.openPreviewBeforeReveal);
      return;
    }

    const vaultRoot = this.vaultRoot();
    const compilerSource = resolveCompilerEntryPath(
      vaultRoot,
      this.compilationRoot(vaultRoot),
      request.sourcePath
    );
    if (!isCurrent()) return;
    if (compilerSource === null) {
      new Notice(MESSAGES.notices.sourceOutsideRoot);
      return;
    }
    await preview.forward(compilerSource, request.byteOffset, isCurrent);
  }

  /**
   * The open preview whose compile covers a source file, which is the only one
   * holding a document that can answer for it.
   */
  private previewForSource(sourcePath: string): TypstPreviewView | undefined {
    const affectedEntries = new Set(
      this.dependencies.affectedBy(path.resolve(this.vaultRoot(), sourcePath))
    );
    return chooseForwardPreview(
      this.previewViews().map((candidate) => ({
        preview: candidate,
        sourcePath: candidate.getSourcePath()
      })),
      sourcePath,
      affectedEntries
    );
  }

  /**
   * Answers the editor with the completions the retained document holds. Every
   * exit here is silent: an editor without a preview, or outside the
   * compilation root, simply has nothing to offer — it must never provoke a
   * compile or a notice.
   */
  private async handleCompletion(
    editor: TypstEditorView,
    request: TypstCompletionRequest,
    isCurrent: () => boolean
  ): Promise<TypstCompletionResponse | null> {
    if (!isCurrent() || editor.file?.path !== request.sourcePath) return null;

    const preview = this.previewForSource(request.sourcePath);
    if (preview === undefined || !isCurrent()) return null;

    const vaultRoot = this.vaultRoot();
    const compilerSource = resolveCompilerEntryPath(
      vaultRoot,
      this.compilationRoot(vaultRoot),
      request.sourcePath
    );
    if (compilerSource === null || !isCurrent()) return null;

    const result = await preview.complete(
      compilerSource,
      request.sourceText,
      request.byteOffset,
      request.explicit,
      isCurrent
    );
    return result === null
      ? null
      : { byteOffset: result.byteOffset, completions: result.completions };
  }


  private async handleDefinition(
    editor: TypstEditorView,
    request: TypstDefinitionRequest,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (
      !isCurrent()
      || editor.file?.path !== request.sourcePath
      || editor.getViewData() !== request.sourceText
    ) {
      return;
    }

    const preview = this.previewForSource(request.sourcePath);
    if (preview === undefined || !isCurrent()) return;

    const vaultRoot = this.vaultRoot();
    const compilerSource = resolveCompilerEntryPath(
      vaultRoot,
      this.compilationRoot(vaultRoot),
      request.sourcePath,
    );
    if (compilerSource === null || !isCurrent()) return;

    const location = await preview.definition(
      compilerSource,
      request.sourceText,
      request.byteOffset,
      isCurrent,
    );
    if (location === null || !isCurrent()) return;
    await this.revealSourceLocation(location, isCurrent);
  }

  private handleDirtyPath(sourcePath: string): void {
    const absolutePath = path.resolve(this.vaultRoot(), sourcePath);
    const affected = new Set(this.dependencies.affectedBy(absolutePath));
    affected.add(sourcePath);
    for (const preview of this.previewViews()) {
      const entry = preview.getSourcePath();
      if (entry !== null && affected.has(entry)) preview.markDirty();
    }
  }

  private async revealDiagnostic(diagnostic: CompilerDiagnostic): Promise<void> {
    if (
      diagnostic.path === undefined
      || diagnostic.line === undefined
      || diagnostic.column === undefined
    ) {
      new Notice(diagnostic.message);
      return;
    }
    const editor = await this.openSourceEditor(diagnostic.path);
    editor?.revealDiagnostic(diagnostic.line, diagnostic.column);
  }

  private revealSourceLocation(
    location: TypstSourceLocation,
    isCurrent: () => boolean,
  ): Promise<void> {
    return this.sourceNavigationScheduler.schedule(location, isCurrent);
  }

  private async performRevealSourceLocation(
    location: TypstSourceLocation,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const editor = await this.openSourceEditor(location.path, isCurrent);
    if (
      editor !== null
      && isCurrent()
      && !editor.revealByteOffset(location.byteOffset)
    ) {
      new Notice(MESSAGES.notices.staleSourceLocation);
    }
  }

  private async openSourceEditor(
    compilerPath: string,
    isCurrent: () => boolean = () => true,
  ): Promise<TypstEditorView | null> {
    if (!isCurrent()) return null;
    const vaultRoot = this.vaultRoot();
    const vaultPath = resolveDiagnosticVaultPath(
      vaultRoot,
      this.compilationRoot(vaultRoot),
      compilerPath
    );
    if (vaultPath === null) {
      new Notice(MESSAGES.notices.sourceOutsideVault);
      return null;
    }
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) {
      new Notice(sourceNotFoundNotice(vaultPath));
      return null;
    }

    const editorLeaves = this.app.workspace.getLeavesOfType(TYPST_VIEW_TYPE)
      .filter((candidate) => candidate.view instanceof TypstEditorView);
    let leaf = chooseSourceEditorLeaf(
      editorLeaves.map((candidate) => ({
        leaf: candidate,
        sourcePath: candidate.view instanceof TypstEditorView
          ? candidate.view.file?.path
          : undefined,
      })),
      vaultPath
    );
    if (!isCurrent()) return null;
    const previousLeaf = this.activeLeaf();
    const created = leaf === undefined;
    if (leaf === undefined) {
      this.creatingSourceLeaf = true;
      try {
        leaf = this.app.workspace.getLeaf("tab");
      } finally {
        this.creatingSourceLeaf = false;
      }
    }
    if (!(leaf.view instanceof TypstEditorView) || leaf.view.file?.path !== vaultPath) {
      this.revealingSourceLeaf = leaf;
      try {
        await leaf.openFile(file);
      } finally {
        if (this.revealingSourceLeaf === leaf) this.revealingSourceLeaf = null;
      }
      if (!isCurrent()) {
        if (created) {
          await this.discardStaleCreatedLeaf(leaf, vaultPath, previousLeaf);
        }
        return null;
      }
    }
    if (!(leaf.view instanceof TypstEditorView) || !isCurrent()) return null;
    this.revealingSourceLeaf = leaf;
    try {
      await this.app.workspace.revealLeaf(leaf);
    } finally {
      if (this.revealingSourceLeaf === leaf) this.revealingSourceLeaf = null;
    }
    if (!isCurrent()) return null;
    return leaf.view;
  }

  private async discardStaleCreatedLeaf(
    leaf: WorkspaceLeaf,
    vaultPath: string,
    previousLeaf: WorkspaceLeaf | null,
  ): Promise<void> {
    const isUntouchedTarget = (): boolean =>
      leaf.view instanceof TypstEditorView
      && leaf.view.file?.path === vaultPath
      && leaf.view.canDiscardUncommittedOpen();
    if (!isUntouchedTarget()) return;

    if (this.activeLeaf() === leaf) {
      if (previousLeaf === null || previousLeaf === leaf) return;
      this.revealingSourceLeaf = previousLeaf;
      try {
        await this.app.workspace.revealLeaf(previousLeaf);
      } finally {
        if (this.revealingSourceLeaf === previousLeaf) {
          this.revealingSourceLeaf = null;
        }
      }
    }
    if (
      this.activeLeaf() !== leaf
      && isUntouchedTarget()
    ) {
      leaf.detach();
    }
  }

  private async checkEnvironment(): Promise<void> {
    let compiler: TypstianCompilerClient | null = null;
    try {
      compiler = this.createCompilerClient();
      const result = await compiler.checkEnvironment();
      new Notice(
        environmentNotice(result.typstVersion, this.compilationRoot(this.vaultRoot()))
      );
    } catch (error) {
      const message = error instanceof CompilerClientError
        ? error.message
        : MESSAGES.notices.compilerUnavailable;
      new Notice(message);
    } finally {
      if (compiler !== null) {
        compiler.close();
        this.compilers.delete(compiler);
      }
    }
  }

  private async savePdf(sourcePath: string): Promise<void> {
    // The toolbar button absorbs whatever this returns, so a throw from here
    // would reach nobody: the user would watch the button settle and learn
    // nothing. Every refusal has to be a notice.
    const rootFolder = this.compilationRootFolder();
    if (!rootFolder.ok) {
      new Notice(COMPILATION_ROOT_PROBLEM[rootFolder.reason]);
      return;
    }
    const vaultRoot = this.vaultRoot();
    const root = this.compilationRoot(vaultRoot);
    const entryPath = resolveCompilerEntryPath(vaultRoot, root, sourcePath);
    if (entryPath === null) {
      new Notice(MESSAGES.notices.entryOutsideRoot);
      return;
    }
    const targetPath = resolvePdfExportPath(
      sourcePath,
      (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null
    );
    if (targetPath === null) {
      new Notice(MESSAGES.notices.tooManySavedPdfs);
      return;
    }

    // The preview keeps no bytes to hand over, so the current source is compiled
    // afresh on a client of its own; the running previews keep their sessions.
    let compiler: TypstianCompilerClient | null = null;
    try {
      compiler = this.createCompilerClient();
      const result = await compiler.compile({
        entryPath,
        revision: 1,
        overlay: this.dirtyBufferOverlay(vaultRoot, root)
      });
      if (!result.ok) {
        new Notice(result.message);
        return;
      }
      const pdf = result.pdf;
      await this.app.vault.createBinary(
        targetPath,
        pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength)
      );
      new Notice(savedPdfNotice(targetPath));
    } catch (error) {
      const message = error instanceof CompilerClientError
        ? error.message
        : savePdfFailedNotice(targetPath);
      new Notice(message);
    } finally {
      if (compiler !== null) {
        compiler.close();
        this.compilers.delete(compiler);
      }
    }
  }

  // Workspace.activeLeaf is deprecated; the active view carries its own leaf.
  private activeLeaf(): WorkspaceLeaf | null {
    return this.app.workspace.getActiveViewOfType(View)?.leaf ?? null;
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Typstian requires a local filesystem vault.");
    }
    return fs.realpathSync.native(adapter.getBasePath());
  }

  private compilationRoot(vaultRoot: string): string {
    return resolveCompilationRoot(vaultRoot, this.settings.rootPath);
  }

  /**
   * The compilation root as a vault-relative folder, or null when the setting
   * points outside the vault. The setting is free text, so it reaches the vault
   * API only through the same policy every compile already applies to it.
   */
  /**
   * The compilation root as a vault-relative folder, or why it is unusable —
   * the same reason the settings row shows, so a command cannot tell the user
   * a different story about the value than the setting that produced it.
   */
  private compilationRootFolder(): CompilationRootFolder {
    const vaultRoot = this.vaultRoot();
    try {
      const root = this.compilationRoot(vaultRoot);
      return { ok: true, folder: path.relative(vaultRoot, root).split(path.sep).join("/") };
    } catch {
      // Only the root policy is classified here; a vault that is not on a local
      // filesystem throws out of `vaultRoot` above, as it does everywhere else.
      const check = checkCompilationRoot(vaultRoot, this.settings.rootPath);
      return check.ok ? { ok: false, reason: "unreadable" } : check;
    }
  }
}
