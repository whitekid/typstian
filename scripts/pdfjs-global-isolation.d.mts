import type { Plugin } from "esbuild";

export function stripPdfJsGlobalExport(
  source: string,
  globalName: "pdfjsLib" | "pdfjsWorker",
  fileName?: string,
): string;

export function pdfJsGlobalIsolationPlugin(): Plugin;
