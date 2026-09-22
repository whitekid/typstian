import { readFile } from "node:fs/promises";

const exportsByFile = new Map([
  ["pdf.mjs", "pdfjsLib"],
  ["pdf.worker.mjs", "pdfjsWorker"],
]);

export function stripPdfJsGlobalExport(source, globalName, fileName = "PDF.js module") {
  const assignment = `var __webpack_exports__ = globalThis.${globalName} = {};`;
  const matches = source.split(assignment).length - 1;
  if (matches !== 1) {
    throw new Error(
      `${fileName} must contain exactly one PDF.js ${globalName} global export; found ${matches}.`,
    );
  }
  return source.replace(assignment, "var __webpack_exports__ = {};");
}

export function pdfJsGlobalIsolationPlugin() {
  return {
    name: "typstian-pdfjs-global-isolation",
    setup(build) {
      build.onLoad({ filter: /pdf(?:\.worker)?\.mjs$/ }, async ({ path }) => {
        const normalizedPath = path.replaceAll("\\", "/");
        const packagePath = "/node_modules/pdfjs-dist/build/";
        if (!normalizedPath.includes(packagePath)) return;

        const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
        const globalName = exportsByFile.get(fileName);
        if (globalName === undefined) return;
        const source = await readFile(path, "utf8");
        return {
          contents: stripPdfJsGlobalExport(source, globalName, fileName),
          loader: "js",
        };
      });
    },
  };
}
