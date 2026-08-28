# ADR 0004: Bundled WebAssembly compiler

- Status: accepted
- Date: 2026-08-25
- Supersedes: the native-helper transport and distribution decisions in ADR 0002

## Context

ADR 0002 moved Typst compilation and source mapping into a native Rust helper.
Users then had to install a platform-specific executable and configure its path
before the preview worked. That second installation made the Obsidian plugin an
incomplete release artifact.

Typstian still needs the exact Typst 0.15.1 document that produced the visible
PDF for inverse and forward search. The compiler also needs rooted access to
vault imports and images without a network filesystem or package downloader.

## Decision

Compile the Rust compiler core for `wasm32-unknown-unknown` with
`wasm-bindgen`. Obsidian's Community installer downloads only `main.js`,
`manifest.json`, and optional `styles.css`, so release CI rebuilds WASM from the
locked Rust sources and esbuild Brotli-compresses and base64-embeds it in
`main.js`. The same bundle embeds the readable third-party notices. The
checked-in WASM package remains an input for local builds and tests, not a
separate release asset.

The renderer decompresses and compiles the embedded WASM module once. Each preview
client clones that `WebAssembly.Module` into a Blob-backed browser Web Worker whose
IIFE source is also generated and embedded by esbuild. The worker owns one compiler
session and retains its Typst `World` and `PagedDocument` by revision. The TypeScript
client serializes compile, inverse-search, and forward-search calls and keeps request
bounds, revision checks, cancellation state, and stale-result checks.

The first worker implementation used Node `worker_threads`. Obsidian 1.13.7's
Electron renderer rejects their construction because its V8 platform does not
support Node workers. A standard browser Web Worker does work there and isolates the
synchronous WASM call without introducing a native executable or release sidecar.

The WASM `World` still asks synchronous JavaScript callbacks for files as Typst
resolves them. A cache miss records the path and returns missing; the worker then
posts a `need-inputs` batch to the renderer, which resolves paths asynchronously and
replies with one transferable byte chunk per file. The worker retries the same
revision against the compile-local cache, which is discarded after that compile.
Vault inputs are capped at 70 MiB per compile. The rooted reader accepts only
root-relative paths, opens the canonical regular file, and rechecks its device and
inode before returning bytes. Absolute paths, traversal, symlink escapes, package
imports, and files exchanged after validation fail as missing files.

Bundle the six Libertinus Serif faces and New Computer Modern Math face vendored
from `typst-assets` 0.15.1, then add fonts installed in standard macOS, Windows,
and Linux font directories. `typst-kit` keeps its embedded-font feature disabled
so the full upstream font set cannot enter the artifact accidentally. During
worker initialization, the renderer enumerates system font files and passes each
to that session long enough to parse metadata;
registration does not retain the file bytes. During compilation, a `FontSource`
records selected-font cache misses, and the same input-batch protocol asks an
allowlisted asynchronous host reader for only those bytes. The worker keeps selected
bytes only for the active compile. Limits are 64 MiB per font, 128 MiB of selected
fonts per compile, 10,000 font files, 2 GiB scanned data, and 20,000 font faces.
Version 0.0.1 does not accept user-supplied font paths.

## Security and lifecycle

The renderer decompresses and compiles its trusted build-time WASM payload from
`main.js` once, then clones the module into per-preview workers. Typstian does not
spawn an external process, invoke a shell, download a compiler, or send source to a
service. Workers have no filesystem access: the rooted renderer reader remains the
only vault path into the compiler. Font loading separately reads allowlisted regular
files from fixed OS font candidates under the stated bounds.

WASM calls run synchronously inside the browser worker, leaving the renderer event
loop available. Initialization has a 120-second deadline and each compile a
15-second deadline. Timeout or abort terminates that worker, discards its retained
document and caches, and rejects pending requests. The next request creates a clean
worker session against the already compiled module. The compiler returns PDF bytes across the WASM boundary as an `ArrayBuffer`.
The worker transfers that buffer to the renderer, avoiding base64 expansion and
another full PDF copy on the UI thread.

## Consequences

- Users install `main.js`, the plugin manifest, and stylesheet; the compiler and
  third-party notices are contained in `main.js`.
- PDF output, diagnostics, imports, images, inverse search, and forward search
  use the retained Typst 0.15.1 document.
- Typstian needs no helper executable, OS-specific build, or child process.
- The bundled default Libertinus Serif and New Computer Modern Math faces work
  without system fonts; additional faces come from bounded system directories.
- The uncompressed WASM input is about 36 MiB; Brotli and base64 expand the
  production `main.js` to about 19 MiB.
- A large compile consumes a worker thread but does not block Obsidian's renderer; terminating the worker also discards its retained document.

## Evidence

- WASM session tests in `helper/wasm/tests/session.rs`
- Browser-worker runtime and real compiler tests in `tests/wasm-worker-runtime.test.ts` and `tests/compiler-real.test.ts`
- TypeScript client tests under `tests/`
- Release build output: `main.js`, `manifest.json`, and `styles.css`
- [wasm-bindgen guide](https://rustwasm.github.io/docs/wasm-bindgen/)
