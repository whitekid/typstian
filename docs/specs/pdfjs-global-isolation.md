# PDF.js global isolation

## Requirements

- Importing Typstian's bundled PDF.js runtime must preserve the host's existing
  `globalThis.pdfjsLib` and `globalThis.pdfjsWorker` values.
- Typstian's PDF preview must continue to load a PDF through its explicit
  `MessageChannel` worker and destroy the document and worker resources.
- The build must stop if either upstream PDF.js global export changes shape, so
  a dependency update cannot silently restore the conflict.
- A bundle smoke test must import the same PDF.js adapter bundle used by the
  production build, with both globals absent and with host sentinel values.

## Approach

The production build will remove only PDF.js's two top-level assignments that
publish `pdfjsLib` and `pdfjsWorker` on `globalThis`. The module's local exports
and Typstian's explicit `WorkerMessageHandler.initializeFromPort` path remain.
The build hook will match each exact assignment once and fail on drift.

The production build will execute its generated `main.js` as a fresh CommonJS
module with host globals absent and then present. The smoke test will verify that
absent globals stay absent and that existing globals keep their identity. Its
only host stub is Obsidian, which supplies that external module at runtime.
The adapter test will load a real Typst PDF through the explicit worker and
check resource cleanup.

## Coverage plan

| Req | Source | Implementation target | Verification | Status |
| --- | --- | --- | --- | --- |
| R1 | Issue #5 expected behavior | Production PDF.js bundle transform | Bundle import with globals absent and sentinel values | done |
| R2 | Issue #5 expected behavior; ADR 0002 | Keep explicit `MessageChannel` worker support | Real Typst PDF text extraction and loading-task destroy smoke | done |
| R3 | Issue #5 reproducibility | Exact-match build guard for both upstream assignments | Unit test against current PDF.js sources and drift cases | done |
| R4 | Issue #7 production bundle gap | Generated `main.js` from `src/main.ts` in CommonJS format | Build smoke with both globals absent and with host sentinel values | done |
