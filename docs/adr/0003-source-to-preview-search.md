# ADR 0003: Source-to-preview search on the retained Typst document

- Status: accepted; helper transport superseded by ADR 0004
- Date: 2026-08-25

## Context

ADR 0002 retained the compiled Typst document so a PDF click could be mapped
back to source. Forward search has the same consistency requirement in the
other direction: an editor cursor must be mapped against the exact source
snapshot and document revision that produced the visible PDF.

Reading the source again from disk after compilation would mix revisions.
Automatically saving an editor to obtain a mapping would also violate
Obsidian's `TextFileView` lifecycle and the saved-preview policy.

## Decision

Extend the existing helper protocol with a bounded `forward` request containing
the visible revision, compilation-root-relative source path, and UTF-8 byte
offset. The helper resolves the source only from the retained rooted world's
source cache and calls Typst 0.15.1's public
`typst_ide::jump_from_cursor` API against the retained `PagedDocument`.

The helper returns an ordered list of page and top-left Typst point positions,
no position, a stale-revision response, or a structured safe error. The plugin
uses the first position for this version. Both protocol sides validate
revisions, bounds, page numbers, and finite coordinates.

The dedicated Typst editor observes CodeMirror's user selection transactions.
Pointer and keyboard selection changes send the saved selection head without
requiring a modifier. Document edits and dirty buffers intentionally do not sync.
Pointer bursts are coalesced for 75 ms and carry a latest-request generation
through the asynchronous vault read and preview reveal, so an older cursor can
never win by resolving later. Closing the originating editor invalidates both
queued and in-flight work for that editor without cancelling another editor's
newer request. Before sending the request, the plugin compares
the captured editor contents with the current vault file. A dirty or changed
buffer is never saved automatically and cannot navigate against the saved preview.

The PDF renderer owns point conversion, scrolling, the temporary marker, and
cleanup. The preview waits for rendering of the same revision before revealing
the position and discards superseded results.

Opening an imported source does not replace its entry document's preview. A
preview keeps its entry while the active Typst file is either that entry or one
of the retained compilation dependencies. An unrelated Typst file continues to
make the preview follow normally.

## Consequences

- Navigation works in both directions without Tinymist or a second compiler.
- Forward search uses the same retained source and document as the visible PDF.
- Unsaved buffers require saving before forward search.
- `jump_from_cursor` returns syntax-span output anchors. The result is a
  corresponding output location, not a guaranteed glyph-exact inverse
  round-trip, and a cursor may have multiple positions or none.
- The first returned output position is used in this version.

## Evidence

- [Typst 0.15.1 `jump_from_cursor`](https://docs.rs/typst-ide/0.15.1/typst_ide/fn.jump_from_cursor.html)
- Rust helper unit and protocol integration tests under `helper/`
- Editor, compiler-client, preview-view, PDF renderer, and plugin policy tests
  under `tests/`
