import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const artifact = resolve("main.js");
const globals = ["pdfjsLib", "pdfjsWorker"];
const original = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
const originalLoad = Module._load;

// Obsidian supplies this external module in the desktop app. Other imports
// come from the installed dependencies, and PDF.js comes from main.js itself.
class ObsidianClassStub {}
const obsidian = new Proxy({}, { get: () => ObsidianClassStub });

function loadArtifact() {
  delete require.cache[artifact];
  Module._load = function loadWithObsidian(id, parent, isMain) {
    if (id === "obsidian") return obsidian;
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    assert.equal(typeof require(artifact).default, "function");
  } finally {
    Module._load = originalLoad;
  }
}

try {
  for (const name of globals) delete globalThis[name];
  loadArtifact();
  for (const name of globals) {
    assert.equal(Object.hasOwn(globalThis, name), false, `${name} was added to the host`);
  }

  const hostPdfjsLib = { owner: "Obsidian PDF viewer API" };
  const hostPdfjsWorker = { owner: "Obsidian PDF viewer worker" };
  globalThis.pdfjsLib = hostPdfjsLib;
  globalThis.pdfjsWorker = hostPdfjsWorker;
  loadArtifact();
  assert.equal(globalThis.pdfjsLib, hostPdfjsLib, "pdfjsLib was replaced");
  assert.equal(globalThis.pdfjsWorker, hostPdfjsWorker, "pdfjsWorker was replaced");

  process.stdout.write("Production main.js preserved absent and existing host PDF.js globals.\n");
} finally {
  Module._load = originalLoad;
  delete require.cache[artifact];
  globals.forEach((name, index) => {
    const descriptor = original[index];
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  });
}
