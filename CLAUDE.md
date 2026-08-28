# Typstian

Obsidian desktop plugin (TypeScript) with a bundled Rust-to-WASM Typst compiler.
`README.md` is the plugin's description in Obsidian's Community directory, so it
carries only what a user needs; building, testing, and releasing live in
`CONTRIBUTING.md`. This file records what is not obvious from the code.

## Commands

```sh
npm test                  # vitest run
npm run typecheck         # tsc --noEmit
npm run lint              # eslint . --max-warnings 0 (warnings fail)
npm run build             # -> main.js with Brotli-embedded WASM
npm run dev               # esbuild watch

make                      # npm run build
make clean                # drop the cargo cache, main.js, and coverage output

cargo test   --manifest-path helper/wasm/Cargo.toml
cargo clippy --manifest-path helper/wasm/Cargo.toml --all-targets -- -D warnings
npm run build:wasm        # wasm-pack web target -> helper/wasm/pkg/, then
                          # scripts/normalize-wasm-glue.mjs strips the blanket
                          # eslint-disable the community review rejects and
                          # narrows the `Function`/`any` compile signature
```

Run `npm run build:wasm` after changing `helper/wasm/`, then commit the generated
files under `helper/wasm/pkg/`. Local `npm test` and `npm run build` consume those
checked-in files without requiring `wasm-pack`. Release CI instead rebuilds WASM
from the locked Rust sources before the plugin build. esbuild Brotli-compresses
and embeds the result in `main.js`; Community releases contain only `main.js`,
`manifest.json`, and `styles.css`.

## Architecture

- `src/`: Obsidian plugin. `main.ts` (`TypstianPlugin`) wires the editor,
  preview, and settings; `compiler-client.ts` owns request ordering, bounds,
  cancellation, and response validation; `wasm-engine.ts` initializes the
  bundled WASM module and owns per-preview browser workers; `wasm-worker.ts`
  owns compiler sessions and the asynchronous vault/font input protocol.
  `path-policy.ts` decides what counts as inside the vault and inside the
  compilation root — one `escapesRoot` that the vault reader, the package
  reader, and the settings row all answer to, plus the failure taxonomy the
  settings row turns into sentences (missing, a file, a link to nothing,
  unreadable, outside the vault). `font-residency.ts` and
  `compile-deadline.ts` hold the two policies those three share — which font bytes a worker keeps, and how long a request may
  take — as pure functions, so both are testable without Obsidian.
  `fontconfig-directories.ts` is the same kind of extraction for reading
  fontconfig's own configuration: it maps the environment onto the directories
  that configuration declares and never opens a font, so `system-fonts.ts` is
  left with discovery and registration.
- `helper/wasm/src/protocol.rs` holds the serde-only wire types the plugin and
  the compiler agree on. It was a separate `typstian-core` crate while a native
  helper existed; the bundled WASM compiler is the only consumer now, so it is a
  module and the repository has exactly one Cargo lockfile.
- `helper/wasm/` provides the only Rust compiler implementation, using
  `wasm-bindgen` and exact Typst 0.15.1 crates for compile/jump/forward.
- Each WASM session retains the compiled document per revision so a
  PDF click maps back to a source span (inverse search), an editor cursor maps
  forward to a page position, and a cursor maps to `typst-ide` completions, all
  against the exact snapshot that produced the visible PDF.

## Gotchas

- **Protocol version is duplicated**: `PROTOCOL_VERSION` in
  `src/compiler-client.ts` and `helper/wasm/src/lib.rs`. Bump both together; the
  environment handshake rejects a mismatch.
- **Every compile request carries the host clock.** The compiler has neither a
  clock nor a timezone database, so `src/compile-request.ts` samples the instant
  and the host's UTC offset and both engines send them as a required `clock`
  field; without it `datetime.today()` fails the whole document with "unable to
  get the current date". The worker samples once *outside* its input-fetch retry
  loop so the date cannot shift mid-compile. `Clock` is non-optional in
  `helper/wasm/src/lib.rs`, so a client that omits it fails deserialization —
  that is what the protocol bump guards.
- **Release contract**: `manifest.json` `version` must exist as a key in
  `versions.json` mapping to `minAppVersion`. `npm run release -- <patch|minor|
  major|x.y.z>` bumps every version-bearing file together, regenerates the
  notices, runs the gates, then commits, tags, and pushes.
  `tests/release-contract.test.ts` also guards the embedded WASM and third-party
  notices, pinned release workflow, checked-in WASM glue/artifact, `styles.css`,
  the README paragraphs answering the community review's filesystem and
  dynamic-execution findings, and the split that keeps developer instructions in
  `CONTRIBUTING.md` rather than the README.
- **Reproducing a release needs the pinned `wasm-bindgen` CLI.** `wasm-pack`
  otherwise downloads whatever prebuilt binary its platform offers, and those
  builds carry different `walrus` patches that rewrite the module differently —
  0.0.6 came out 604 bytes apart between CI and a local build for that reason
  alone. `cargo install wasm-bindgen-cli --version <the Cargo.lock version>
  --locked` on both sides, which the release workflow does and the release
  contract pins.
- **The WASM build remaps its source paths.** rustc bakes the paths of every
  crate it compiles into the module, so without the `--remap-path-prefix` pair
  in `build:wasm` the artifact — and the `main.js` embedding it — differs per
  checkout location, and a published release cannot be reproduced. With them,
  two builds from different directories are byte-identical.
- **Typst crates are pinned `=0.15.1`** (`typst`, `typst-ide`, `typst-kit`,
  `typst-layout`, `typst-pdf`). They move together; do not bump one alone.
- **esbuild externals**: `obsidian`, `electron`, node builtins, and every
  `@codemirror/*` / `@lezer/*` package must stay in `external` in
  `esbuild.config.mjs`. Bundling CodeMirror creates a second instance and breaks
  the host editor. vitest mirrors this with `dedupe` in `vitest.config.mts`.
- **`obsidian` is aliased** to `tests/stubs/obsidian.ts` under vitest; there is
  no real Obsidian in tests. Obsidian's DOM extensions (`createEl`/`createDiv`/
  `createSpan` on `Node`, plus `win` and `doc`) are separate: they arrive through
  the `tests/stubs/obsidian-dom.ts` setup file, and only in test files that opt
  into `// @vitest-environment happy-dom`.
- `main.js` is a gitignored build artifact (~19 MB): PDF.js, its in-process
  worker, the embedded browser compiler-worker source, the Brotli-compressed
  WASM compiler, and third-party notices are bundled without a CDN.
- Preview compiles unsaved buffers: `src/dirty-buffer-overlay.ts` snapshots every
  open dirty Typst editor into a compilation-root-relative overlay that
  `WorkerWasmEngine.providePath` consults before the disk reader, under the same
  70 MiB budget and path policy. The snapshot is pinned per compile revision, so a
  mid-compile edit cannot tear it. Never save the buffer on the user's behalf.
- **Never abort a compile to supersede it.** Aborting a compile request calls
  `failSession`, which disposes the engine and terminates the worker — that
  discards the retained document and re-runs system-font registration.
  `PreviewController` therefore queues the newest revision and starts it when the
  running compile settles; only `setSource` and `dispose` abort.
- The checked-in `typstian_wasm_bg.wasm` is a local-development input; release CI
  rebuilds it and embeds the result in `main.js`. A Blob-backed browser worker owns
  each compiler session. Vault inputs arrive as file-by-file transferable chunks
  through `src/wasm-vault-reader.ts`, capped at 70 MiB per compile. Its rooted reader
  opens each canonical regular file and rechecks device and inode before returning
  bytes. System-font discovery separately scans standard OS directories, the
  Flatpak host font mounts, and the `<dir>` elements declared by fontconfig's
  configuration — both the system's (`$FONTCONFIG_FILE`, or each root on
  `$FONTCONFIG_PATH`, default `/etc/fonts`) and the user's
  (`$XDG_CONFIG_HOME/fontconfig`, `~/.fonts.conf`), which ranks ahead of the
  system's — behind `~/.fonts` and `$XDG_DATA_HOME/fonts`, which lead. Those are
  directories the machine has already told every application about, which is why
  reading them does not reopen the user-typed-path decision below. Configuration
  files include each other, so the reader follows `<include>` and terminates on
  two invariants together: one visited set per scan, so no file is read twice,
  and `MAX_FONTCONFIG_INCLUDE_DEPTH`. Bounds: `MAX_SYSTEM_FONT_DIRECTORIES`, `MAX_SYSTEM_FONT_FILES`,
  `MAX_SYSTEM_FONT_SCAN_BYTES`, `MAX_SYSTEM_FONT_BYTES`, and, because
  discovery runs synchronously on the init thread,
  `MAX_FONTCONFIG_FILE_BYTES`, `MAX_FONTCONFIG_FILES`, `MAX_FONTCONFIG_FRAGMENTS`, and
  `MAX_FONTCONFIG_INCLUDE_DEPTH`. The worker retains parsed metadata; selected font bytes
  load through an allowlisted callback only for the active compile, capped at
  128 MiB in aggregate. Keep network,
  telemetry, native process launch, and compiler downloads out of the plugin.
- **Font residency, `src/font-residency.ts`.** Registration hands the compiler
  metadata only, so without residency the first compile of a session lays the
  whole document out with no loadable face and Typst rescans the entire font book
  for every uncovered run — 22 s on a 126 KB Korean book against 983 faces,
  versus 0.3 s once the bytes are there. `planFontResidency` picks, from the
  files `registerSystemFonts` reads anyway, the set the worker keeps after
  `register-font`; the transferred buffer is retained, never re-read. Ranking is
  discovery root ascending (`systemFontDirectories()` lists the user's own
  directories first) then file size descending (the fallback walk ends on
  broad-coverage CJK faces, which are the largest files); a candidate that does
  not fit is skipped so the cheap tail still fills the budget.
  `MAX_RESIDENT_FONT_BYTES` is 256 MiB — a cold-start ceiling on *unproven*
  candidates, not `MAX_SYSTEM_FONT_SCAN_BYTES`, which only bounds how much the
  host may read. 256 MiB is the measured knee on a 866 MiB / 983-face macOS
  corpus: 96, 128, and 192 MiB all still miss a needed face and leave the first
  compile at 7-9 s.
- **Residency is a transient, not a per-preview tax.** A `WorkerWasmEngine` is
  per preview, so a cold-start set that never shrank would cost N x 256 MiB
  across N open previews. `settleResidency` therefore runs in the compile's
  `finally` — *after* it settles, because the first compile is the pass the
  residency exists for — and `retainUsedFonts` keeps only the faces that compile
  actually read, which the seeded cache records as `readFont` hits. The 126 KB
  Korean book falls from 256 MiB peak to 43 MiB steady. The steady set is still
  per worker, so N previews cost N of those — bounded by the 128 MiB budget
  below, not by one global ceiling. A failed compile narrows
  too, so the cold-start set never outlives the compile that would have proved
  it; a later cold session starts empty and gets the full set again. An
  evicted face that turns out to be needed later comes back through the ordinary
  host request path, which reads it from disk again — the residency buys the
  first compile, not every later one.
- **The residency lives inside the 128 MiB selected-font budget.** Survivors are
  capped at `MAX_SELECTED_FONT_BYTES`, the same number `providePath` charges
  host-shipped font bytes against for one compile, and the worker declares its
  proven `residentFontBytes` on every `need-inputs` so `provideInputs` subtracts
  them from that compile's budget once. Retained and shipped bytes therefore
  share one ceiling instead of each holding their own. Cold-start bytes are
  declared as 0 on purpose: they are governed by `MAX_RESIDENT_FONT_BYTES`, they
  are gone once the compile settles, and charging them would starve the very
  compile that has to fetch whatever the bet missed. The instantaneous ceiling
  during a cold compile is therefore 384 MiB, not 256: the unproven set plus a
  full host-shipped budget. Both halves are gone by the time it settles.
- Obsidian's Electron renderer cannot create Node `worker_threads`; the release
  uses an embedded browser Web Worker instead. WASM calls remain synchronous only
  inside that worker. Initialization has a 120-second deadline; each compile has a
  15-second deadline, except the first compile of a session, which
  `src/compile-deadline.ts` widens by `COLD_COMPILE_DEADLINE_MULTIPLIER` (4x, so
  60 s) because a cold session pays for font residency and a first layout pass
  that a warm one does not. Missing that deadline is not a cheap retry: it
  disposes the engine, so the next attempt starts colder still.
  Timeout or abort terminates the worker and its retained
  document; the next request starts a clean session. PDF bytes cross the WASM boundary directly as an `ArrayBuffer`; the worker
  transfers it without a renderer-side copy.
- **Only the default text and math families are embedded.** Six Libertinus Serif
  faces and `helper/wasm/assets/NewCMMath-Book.otf` are vendored from typst-assets
  under their upstream licenses and registered in `InMemoryWorld::new` before
  system fonts. `typst-kit` runs with `default-features = false`, so
  `fonts::embedded()` cannot pull in the full upstream set. Dropping New Computer
  Modern Math fails every equation with `no font could be found` — Typst treats
  that as a compile error, not a fallback. Additional text faces come from the
  bounded standard OS directories, Flatpak host mounts, and directories declared
  by system and user fontconfig. No user-typed font paths.
- **`@preview` packages resolve from local files only.** `src/typst-packages.ts`
  maps a `{namespace}/{name}/{version}/{path}` key onto Typst's own data and
  cache package directories and reads it through the same rooted reader the
  vault uses, so a package file cannot escape its package directory. Package
  bytes spend the *same* 70 MiB per-compile budget as vault files, on both
  sides. The compiler asks for them on a third input channel (`readPackage`),
  never through the vault loader. A package that is not installed fails with a
  diagnostic naming it and saying nothing was downloaded — Typst reads a
  package's `typst.toml` first, which is how `helper/wasm/src/lib.rs` knows the
  directory is absent rather than one file inside it. Never add a download path.
- **`registerExtensions` only opens a `.typ` file that already exists.** Obsidian's
  own "New note" always makes Markdown, so a vault with no `.typ` file had no way
  into the plugin at all — and `open-typst-preview` is a `checkCallback` gated on
  an active Typst editor, which Obsidian hides when the check fails, so the
  preview looked missing too (issue #1). The `create-typst-file` command and the
  `file-menu` folder item are that entry point; `src/new-typst-file.ts` picks the
  name. A new file starts with a heading, not empty, because an empty Typst
  source compiles to a document with no pages and a blank preview reads as a
  broken plugin.
- **The preview needs an entry point that is visible, not only findable.**
  `open-typst-preview` stayed a `checkCallback` gated on an active Typst editor,
  which is right for a palette command and useless as discovery — the reporter of
  issue #1 could create a `.typ` file and still not find the preview. Two visible
  entry points answer that: the `Open Typst preview` header action
  `TypstEditorView` registers in its constructor, and the `file-menu` item on a
  `.typ` `TFile`. Both route through `openPreview`, the same path the command
  takes. The file item is deliberately *not* gated on the compilation root the
  way `New Typst file` is — creating a file outside the root hands the user
  something nothing can compile, while opening a preview only reports the
  problem. `docs/specs/preview-entry-points.md` holds the requirements.
- **Renderer code must not touch main-window globals.** A preview can live in a
  popout window, so timers, `getComputedStyle`, `getSelection`, and
  `activeElement` go through the element's own `win`/`doc`, and elements are
  created through their parent's `createEl`/`createDiv`/`createSpan`.
  `eslint-plugin-obsidianmd` enforces the weaker form of this.
- **Autocomplete answers from the last compile, never a new one.**
  `Session::complete` runs `typst_ide::autocomplete` against the retained world
  and document. The cursor, though, belongs to the buffer the user is typing in,
  which is usually a few keystrokes ahead, so the request carries that buffer and
  `CursorMapping::resolve` reconciles the two: identical text completes at the
  cursor; a single splice that *ends at the cursor* completes at the mapped
  snapshot offset and maps the reply back; anything else answers
  `no-completions`. Never map an offset between the two texts by assumption —
  a cursor on the wrong syntax node describes a different document. The live
  buffer rides on the request, so it carries its own 2 MiB bound
  (`MAX_COMPLETION_SOURCE_BYTES`, mirrored by `maxCompletionBytes` in
  `src/compiler-client.ts`) instead of the 64 KiB request cap that guards the
  compile path. `OptionalReadScheduler` gives completion and definition separate
  one-in-flight, latest-queued pipelines, and a completion reply whose buffer
  changed underneath is dropped. A
  file with no preview, or no retained document, offers nothing — completion
  must never provoke a compile. Typst's `apply` strings are snippet syntax
  (`${name}`), which is also CodeMirror's, so they go through
  `snippetCompletion` unchanged.
- **Malformed optional IDE replies do not fail the session.** Completion,
  definition, and tooltip are optional reads, so `enqueue` refuses only the
  malformed or oversized request. Compile, jump, and forward remain
  session-fatal because the preview is showing a document they could not
  validate.
- `@codemirror/autocomplete` is pinned exactly, like `@codemirror/lint`: every
  6.x release so far depends on `@codemirror/view ^6.17.0`, which Obsidian's
  6.38.6 satisfies, so npm keeps one CodeMirror instance. Check that range
  before bumping — a demand for a newer `view` would nest a second
  `@codemirror/state` and silently break the extension.
- Compiler test fixtures are under `helper/tests/fixtures/`
  (`project/`, `completion/`, `definition/`, `diagnostics/`, `escape/`, `fonts/`),
  not `tests/fixtures/`.

## Decisions

`docs/adr/`: 0001 (superseded by 0002), 0002 PDF.js preview with inverse search,
0003 source-to-preview search, 0004 bundled WASM compiler, and 0005
unsaved-buffer live preview. Read the relevant
ADR before changing preview, search, or compiler integration.

`docs/specs/` holds the requirements a change was accepted against, one file per
change, written before the code: `preview-entry-points.md`,
`font-discovery-paths.md`, `editor-productivity.md`. An ADR records why
an architecture is the way it is; a spec records what a change had to do.
