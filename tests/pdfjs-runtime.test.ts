import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import {
  pdfJsGlobalIsolationPlugin,
  stripPdfJsGlobalExport,
} from "../scripts/pdfjs-global-isolation.mjs";

const compiled = spawnSync(
  "typst",
  ["compile", "--format", "pdf", "-", "-"],
  {
    input: "#set page(width: 120pt, height: 80pt, margin: 10pt)\nPDF.js selectable smoke",
    maxBuffer: 2 * 1024 * 1024,
  },
);
let runtimeImportCount = 0;

interface BundledPdfJsRuntime {
  createPdfJsEngine(): {
    load(data: Uint8Array): {
      promise: Promise<{
        numPages: number;
        getPage(pageNumber: number): Promise<{
          getTextContent(): Promise<unknown>;
          cleanup(): void;
        }>;
      }>;
      destroy(): Promise<void>;
    };
  };
}

async function withPdfJsGlobals<T>(
  globals: { pdfjsLib?: unknown; pdfjsWorker?: unknown } | null,
  action: () => Promise<T>,
): Promise<T> {
  const names = ["pdfjsLib", "pdfjsWorker"] as const;
  const runtime = globalThis as typeof globalThis & {
    pdfjsLib?: unknown;
    pdfjsWorker?: unknown;
  };
  const original = names.map((name) => Object.getOwnPropertyDescriptor(runtime, name));
  if (globals === null) {
    for (const name of names) delete runtime[name];
  } else {
    runtime.pdfjsLib = globals.pdfjsLib;
    runtime.pdfjsWorker = globals.pdfjsWorker;
  }

  try {
    return await action();
  } finally {
    names.forEach((name, index) => {
      const descriptor = original[index];
      if (descriptor === undefined) delete runtime[name];
      else Object.defineProperty(runtime, name, descriptor);
    });
  }
}

async function loadBundledPdfJs(): Promise<BundledPdfJsRuntime> {
  const result = await build({
    entryPoints: ["src/pdfjs-adapter.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    plugins: [pdfJsGlobalIsolationPlugin()],
    sourcemap: false,
    write: false,
  });
  const bundle = result.outputFiles[0]?.text;
  if (bundle === undefined) throw new Error("PDF.js runtime bundle was not generated.");
  const runtime: unknown = await import(
    `data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}#runtime-${++runtimeImportCount}`
  ) as unknown;
  return runtime as BundledPdfJsRuntime;
}

describe("bundled PDF.js runtime", () => {
  it("requires each exact upstream global export once", () => {
    expect(stripPdfJsGlobalExport(
      "var __webpack_exports__ = globalThis.pdfjsLib = {};",
      "pdfjsLib",
      "pdf.mjs",
    )).toBe("var __webpack_exports__ = {};");
    expect(stripPdfJsGlobalExport(
      "var __webpack_exports__ = globalThis.pdfjsWorker = {};",
      "pdfjsWorker",
      "pdf.worker.mjs",
    )).toBe("var __webpack_exports__ = {};");
    expect(() => stripPdfJsGlobalExport("var __webpack_exports__ = {};", "pdfjsLib"))
      .toThrow("found 0");
    expect(() => stripPdfJsGlobalExport(
      "var __webpack_exports__ = globalThis.pdfjsWorker = {};\nvar __webpack_exports__ = globalThis.pdfjsWorker = {};",
      "pdfjsWorker",
    )).toThrow("found 2");
  });

  it("wires the global isolation plugin into the production build", async () => {
    const config = await readFile("esbuild.config.mjs", "utf8");
    expect(config).toContain('import { pdfJsGlobalIsolationPlugin }');
    expect(config).toContain("plugins: [pdfJsGlobalIsolationPlugin()]");
  });

  it("leaves host globals absent when importing the production PDF.js bundle", async () => {
    await withPdfJsGlobals(null, async () => {
      await loadBundledPdfJs();
      const runtime = globalThis as typeof globalThis & {
        pdfjsLib?: unknown;
        pdfjsWorker?: unknown;
      };
      expect(runtime.pdfjsLib).toBeUndefined();
      expect(runtime.pdfjsWorker).toBeUndefined();
    });
  });

  it("preserves existing host globals when importing the production PDF.js bundle", async () => {
    const hostPdfjsLib = { owner: "Obsidian PDF viewer API" };
    const hostPdfjsWorker = { owner: "Obsidian PDF viewer worker" };
    await withPdfJsGlobals({ pdfjsLib: hostPdfjsLib, pdfjsWorker: hostPdfjsWorker }, async () => {
      await loadBundledPdfJs();
      const runtime = globalThis as typeof globalThis & {
        pdfjsLib?: unknown;
        pdfjsWorker?: unknown;
      };
      expect(runtime.pdfjsLib).toBe(hostPdfjsLib);
      expect(runtime.pdfjsWorker).toBe(hostPdfjsWorker);
    });
  });

  it.skipIf(compiled.status !== 0)(
    "loads a real Typst PDF through the explicit worker and destroys its resources",
    async () => {
      const hostPdfjsLib = { owner: "Obsidian PDF viewer API" };
      const hostPdfjsWorker = { owner: "Obsidian PDF viewer worker" };
      await withPdfJsGlobals({ pdfjsLib: hostPdfjsLib, pdfjsWorker: hostPdfjsWorker }, async () => {
        const hostRuntime = globalThis as typeof globalThis & {
          pdfjsLib?: unknown;
          pdfjsWorker?: unknown;
        };
        const engine = await loadBundledPdfJs();
        const loadingTask = engine.createPdfJsEngine().load(new Uint8Array(compiled.stdout));

        try {
          const document = await loadingTask.promise;
          expect(document.numPages).toBe(1);
          const page = await document.getPage(1);
          const content = await page.getTextContent() as {
            items: Array<{ str?: string }>;
          };
          expect(content.items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " "))
            .toContain("PDF.js selectable smoke");
          page.cleanup();
          expect(hostRuntime.pdfjsLib).toBe(hostPdfjsLib);
          expect(hostRuntime.pdfjsWorker).toBe(hostPdfjsWorker);
        } finally {
          await loadingTask.destroy();
        }

        expect(hostRuntime.pdfjsLib).toBe(hostPdfjsLib);
        expect(hostRuntime.pdfjsWorker).toBe(hostPdfjsWorker);
      });
    },
  );
});
