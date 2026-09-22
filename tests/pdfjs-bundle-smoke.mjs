import { build } from "esbuild";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { pdfJsGlobalIsolationPlugin } from "../scripts/pdfjs-global-isolation.mjs";

const runtime = globalThis;
let runtimeImportCount = 0;

async function bundlePdfJs() {
  const result = await build({
    entryPoints: ["src/pdfjs-adapter.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    sourcemap: false,
    write: false,
    plugins: [pdfJsGlobalIsolationPlugin()],
  });
  const bundle = result.outputFiles[0]?.text;
  if (bundle === undefined) throw new Error("PDF.js runtime bundle was not generated.");
  return await import(
    `data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}#runtime-${++runtimeImportCount}`
  );
}

async function smoke() {
  await bundlePdfJs();
  if (runtime.pdfjsLib !== undefined || runtime.pdfjsWorker !== undefined) {
    throw new Error("Bundled PDF.js created a host global that was absent before import.");
  }

  const hostPdfjsLib = { owner: "Obsidian PDF viewer API" };
  const hostPdfjsWorker = { owner: "Obsidian PDF viewer worker" };
  runtime.pdfjsLib = hostPdfjsLib;
  runtime.pdfjsWorker = hostPdfjsWorker;
  const { createPdfJsEngine } = await bundlePdfJs();
  if (runtime.pdfjsLib !== hostPdfjsLib || runtime.pdfjsWorker !== hostPdfjsWorker) {
    throw new Error("Bundled PDF.js replaced a host PDF.js global.");
  }

  const compiled = spawnSync(
    "typst",
    ["compile", "--format", "pdf", "-", "-"],
    {
      input: "#set page(width: 120pt, height: 80pt, margin: 10pt)\nBundled PDF.js smoke",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (compiled.status !== 0) {
    throw new Error("Typst could not create the PDF.js bundle smoke fixture.");
  }

  const loadingTask = createPdfJsEngine().load(new Uint8Array(compiled.stdout));
  try {
    const document = await loadingTask.promise;
    if (document.numPages !== 1) throw new Error("Bundled PDF.js returned an unexpected page count.");
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ");
    page.cleanup();
    if (!text.includes("Bundled PDF.js smoke")) {
      throw new Error(`Bundled PDF.js returned unexpected text: ${text}`);
    }
    if (runtime.pdfjsLib !== hostPdfjsLib || runtime.pdfjsWorker !== hostPdfjsWorker) {
      throw new Error("PDF.js changed a host global while reading a PDF.");
    }
    process.stdout.write("Bundled PDF.js preserved host globals and loaded a Typst PDF with selectable text.\n");
  } finally {
    await loadingTask.destroy();
  }
  if (runtime.pdfjsLib !== hostPdfjsLib || runtime.pdfjsWorker !== hostPdfjsWorker) {
    throw new Error("PDF.js changed a host global during cleanup.");
  }
}

void smoke().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
