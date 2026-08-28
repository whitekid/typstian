# Typstian

Typstian opens `.typ` files as editable source in Obsidian and renders the
document as a selectable PDF in an adjacent preview leaf, including edits you
have not saved yet. Click the preview to jump to the source that produced it,
and move the cursor in the source to reveal the matching spot in the preview.

The Typst compiler ships inside the plugin as WebAssembly, so there is nothing
to install alongside it — no Typst binary, no native helper, and no download at
runtime.

> **Alpha.** Typstian is early software under active development. It compiles
> and previews real documents, but settings, commands, and behaviour can still
> change between releases, and a large or font-heavy document can be slow on its
> first compile. Keep a copy of anything you cannot afford to lose, and please
> report what breaks.

## Requirements

- Obsidian desktop 1.13.1 or newer
- A filesystem-backed vault (desktop only; Typstian does not run on mobile)

## Install

Open **Settings -> Community plugins -> Browse**, search for **Typstian**,
install it, and enable it. Do not enable another plugin that registers the
`.typ` extension in the same vault.

## Use

1. Create a `.typ` file: run **Typstian: Create a Typst file** from the command
   palette, or right-click a folder in the file explorer and choose **New Typst
   file**. Obsidian's own **New note** always makes a Markdown file, so it cannot
   start one. The palette command puts the file in the compilation root — the
   vault root unless you changed it — and the folder menu puts it in that folder.
   It is named `Untitled.typ`, or the next free name, and opens in the Typst
   source view. An existing `.typ` file opens by clicking it as usual.
2. Edit it in the Typst source view.
3. Run **Typstian: Open Typst preview** from the command palette. It is listed
   only while a Typst file is the active editor, so open one first.
4. Use the preview toolbar to zoom, fit pages to the available width, or save
   the compiled PDF into the vault.
5. Click rendered preview text to jump to the exact Typst source byte offset.
   Dragging still selects text for copying; links and controls keep their normal behavior.
6. In a saved `.typ` editor, move the selection with the mouse or keyboard to
   reveal the matching spot in the preview. Unsaved buffers must be saved first.

The preview follows the active Typst editor, except that opening a source
imported by the visible entry keeps that entry's preview. Compiler diagnostics are buttons;
select one to open its `.typ` file and move the cursor to the reported location.
The command **Typstian: Check Typst environment** reports the embedded Typst
version and compilation root.

The preview toolbar's **Save** button and the command
**Typstian: Save the compiled PDF to the vault** both compile a `.typ` file,
unsaved text included, and write the PDF beside it under the same name. The
button saves the file its preview is following; the command saves the active
editor's file.
An existing file is never overwritten: the PDF lands on the next free `name-1.pdf`,
`name-2.pdf`, and so on, and the notice names the file it wrote.
Creating a Typst file and saving a PDF are the only two places Typstian writes
to your vault, and both happen only when you ask for them.

Typstian recompiles shortly after you stop typing, using the unsaved text of
every open Typst editor in place of its file on disk. Obsidian still owns the
normal save lifecycle; the plugin never saves the buffer for you. Everything the
compiler does not have open reads from the vault, so relative imports, images,
fonts, and multi-page output keep their normal Typst meaning. Changes to
dependencies from the previous compile refresh only affected previews.

A compile that is already running cannot be cancelled without discarding the
compiler session, so an edit made mid-compile does not interrupt it. That result
is dropped and the newest text compiles as soon as the running compile finishes.

## Settings

- **Compilation root**: optional path inside the vault; defaults to the vault
  root. The setting reports whether what you typed resolves to a folder inside
  the vault. A path that does not is still saved, so you can point it at a
  folder before creating it.

Typstian embeds six Libertinus Serif faces — regular, italic, bold, bold
italic, semibold, and semibold italic — plus New Computer Modern Math for
equations. A document that does not set `#set text(font: ...)` therefore uses
the bundled Libertinus family without relying on an installed text font.

Additional faces come from your system's standard macOS, Windows, or Linux font
directories. Typstian registers shared font metadata once, then loads only the
fonts a document selects into WASM on demand. If a document requests another
family, install that family on the system. Typstian does not accept additional
font paths or compiler flags.

## Troubleshooting

### An import or image is not found

Paths remain relative to the `.typ` entry file. Keep the entry and dependency
inside the selected compilation root. The default root is the vault.

### A `.typ` file opens in another view

Disable other Obsidian plugins that register the `.typ` extension, then reload
Typstian.

## Privacy and security

Typstian makes no network requests, sends no telemetry, compiles nothing
remotely, and never launches or downloads an executable. The compiler is already
inside `main.js`.

It reads three things outside your vault's Obsidian API: the files your document
references, your installed fonts, and the Typst packages already on your
machine. That is why it uses Node's `fs` rather than the vault API — a Typst
compile resolves `#import` and `#image` against the compilation root and needs
the bytes of every file reached that way, plus system fonts and package files
that live outside the vault entirely. Reads are confined to the compilation
root, the standard OS font directories, and Typst's own package directories;
absolute paths, traversal, and symlink escapes are rejected, and the plugin
never writes to disk. Each compile runs in its own sandboxed worker with a
15-second deadline.

An `#import "@preview/…"` resolves only against packages you have already
downloaded — with the Typst CLI, or by placing them in Typst's package
directory yourself. Typstian never downloads one, and says so by name when a
package is missing.

The preview loads PDF.js with `isEvalSupported: false`, so the one path that
would run generated code over document content stays off.

Typstian is licensed under the MIT License. That license and the
complete third-party license and attribution notices are embedded as a readable
comment in the installed `main.js` and recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## File size and Obsidian Sync

`main.js` is around 11 MB, because the Typst compiler travels inside it as a
Brotli-compressed WebAssembly module instead of being downloaded at runtime.
That is above the 5 MB per-file limit of Obsidian Sync's Standard plan, so Sync
Standard will not carry the plugin file itself; installing from the Community
directory on each device works normally.

## Current scope

Typstian does not provide mobile support, rename, formatting, semantic tokens,
or Tinymist's custom preview protocol. Clicking a
rotated page does not jump to the source that produced it. Moving the cursor
reveals the spot the surrounding source produced rather than the exact glyph
under the cursor, and some cursor positions reveal nothing at all.
IDE reads and PDF export are narrow: completions, definitions, and hover tooltips
use the last compiled snapshot, and the export writes one PDF beside the source
on request.
Syntax highlighting comes from the experimental `codemirror-lang-typst` 0.6.0 Lezer grammar for Typst 0.15.

## Contributing

Building Typstian from source, running its tests, and cutting a release are
documented in [`CONTRIBUTING.md`](CONTRIBUTING.md).
