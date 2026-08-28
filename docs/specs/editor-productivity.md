# Editor productivity and bundled text fonts

Typstian already owns the retained Typst document that produced the visible PDF.
This specification extends that same offline session with definition and tooltip
reads, completes source-to-preview navigation for keyboard users, makes long PDF
documents directly navigable, and gives a default Typst document the text family
Typst itself expects.

## Acceptance criteria

### Bundled default text family

1. The six Libertinus Serif faces from `typst-assets` 0.15.1 — regular, italic,
   bold, bold italic, semibold, and semibold italic — are bundled alongside the
   existing New Computer Modern Math face and registered before system fonts.
2. A document that does not select a text family compiles without relying on an
   installed text font and its PDF uses the bundled Libertinus Serif family.
   Bold, italic, bold-italic, and semibold content select the corresponding
   bundled faces.
3. The vendored files, their provenance, and their license are recorded in the
   generated third-party notices. A production build remains below 13,500,000
   bytes so enabling the complete `typst-assets` embedded-font set cannot happen
   accidentally.

### Keyboard source-to-preview navigation

4. A keyboard-only selection change in a saved Typst editor schedules the same
   latest-only forward search as a pointer selection. Repeated cursor movement
   cannot let an older result reveal after a newer one.
5. Document edits and selections in a dirty buffer never provoke forward search,
   never save the buffer, and never compile solely for navigation.

### PDF page navigation

6. The preview toolbar exposes the current one-based page and total page count,
   previous-page and next-page controls, and a page-number control that moves to
   an existing page. Out-of-range and non-numeric input does not move the preview.
7. The current-page value follows scrolling after pages render. Previous and next
   are disabled at the first and last page, and every control has an accessible
   name and keyboard operation.
8. Page observation, element creation, event handling, and scrolling use the
   preview element's owning window and document, including in an Obsidian popout.
   Existing zoom, fit, save, selection, and source-search behavior is unchanged.

### Definition navigation

9. A retained compiler session answers a bounded `definition` request for local
   variables, imported symbols and files, and labels through Typst 0.15.1's
   public `typst_ide::definition`. It returns a validated compilation-root-relative
   source path and UTF-8 byte offset, or no definition for standard-library values
   and positions without a source target.
10. **Go to definition** is available as an Obsidian command at the editor cursor
    and through primary Mod-click in the Typst editor. A result reuses the existing
    source-opening and byte-offset navigation path; a missing or stale result does
    nothing and never replaces an unrelated dirty editor.

### Hover tooltips

11. A retained compiler session answers a bounded `tooltip` request through Typst
    0.15.1's public `typst_ide::tooltip`, preserving whether the result is prose or
    Typst code. The editor displays it through CodeMirror's hover interface as text
    or a code element without interpreting compiler text as HTML.
12. Definition and tooltip reconcile an identical live buffer or the same single
    cursor-ending splice accepted by completion with the retained source snapshot.
    Any other divergence returns no result. Neither feature starts a compile or
    creates a compiler session when no preview has retained the document.
13. A malformed, oversized, stale, or superseded definition or tooltip response
    rejects or drops only that optional IDE read. It does not dispose the retained
    compiler session, and request ordering prevents an older reply from winning.

## Verification seams

- `TypstianWasmSession` compile, definition, and tooltip requests against the real
  bundled WASM session.
- `TypstianCompilerClient` request ordering, bounds, source reconciliation, stale
  responses, and optional-read failure behavior.
- `TypstEditorView` user transactions, commands, source navigation callbacks, and
  CodeMirror tooltip DOM.
- `PdfPreviewRenderer` toolbar DOM and rendered-page scrolling behavior.
- Production `main.js`, checked-in WASM artifacts, generated notices, and the
  release contract.

## Constraints

- No network access, telemetry, native helper, compiler/package download, or
  user-configured font path is introduced.
- IDE reads use the exact retained world and document revision that produced the
  visible PDF and never trigger compilation.
- Renderer code continues to use each element's owning window and document.
- Protocol changes bump both TypeScript and Rust protocol versions together.

## Out of scope

- Rename, formatting, semantic tokens, mobile support, image attachment writes,
  Tinymist's private preview protocol, and rotated-page inverse search.
- Definitions for standard-library values that have no source file.
- Rendering Typst markup or arbitrary HTML inside hover tooltips.
