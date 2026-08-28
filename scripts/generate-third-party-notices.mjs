import { execFileSync } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = join(projectRoot, "THIRD_PARTY_NOTICES.md");
const checkOnly = process.argv.includes("--check");
const legalFilePattern = /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-].*)?$/i;

const libertinusFaces = [
  "Regular",
  "Italic",
  "Bold",
  "BoldItalic",
  "Semibold",
  "SemiboldItalic",
];
const vendoredLibertinusNotices = libertinusFaces.map((face) => {
  const file = `LibertinusSerif-${face}.otf`;
  const projectPath = `helper/wasm/assets/${file}`;
  if (!existsSync(join(projectRoot, projectPath))) {
    throw new Error(`Vendored font is missing: ${projectPath}`);
  }
  return `- ${projectPath} — typst-assets 0.15.1/files/fonts/${file}`;
});

function normalizeText(value) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function documentTitle(text) {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "Legal document";
  if (firstLine !== firstLine.toUpperCase()) return firstLine;
  return firstLine
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function legalFiles(packageRoot, explicitLicenseFile) {
  const files = new Set();
  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    if (entry.isFile() && legalFilePattern.test(entry.name)) {
      files.add(join(packageRoot, entry.name));
    }
  }
  if (explicitLicenseFile) {
    const file = isAbsolute(explicitLicenseFile)
      ? explicitLicenseFile
      : resolve(packageRoot, explicitLicenseFile);
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error(`Declared license file is missing: ${file}`);
    }
    files.add(file);
  }
  return [...files].sort();
}

const documents = new Map();
function addDocument(origin, file) {
  const text = normalizeText(readFileSync(file, "utf8"));
  if (text.length === 0) throw new Error(`Empty legal document: ${file}`);
  const hash = sha256(text);
  const existing = documents.get(hash);
  if (existing) {
    existing.origins.add(origin);
  } else {
    documents.set(hash, { origins: new Set([origin]), text, title: documentTitle(text) });
  }
  return hash;
}

function cargoPackages() {
  const metadata = JSON.parse(execFileSync("cargo", [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--manifest-path",
    "helper/wasm/Cargo.toml",
    "--filter-platform",
    "wasm32-unknown-unknown",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }));
  const nodeById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const reachable = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    for (const dependency of nodeById.get(id)?.deps ?? []) {
      const production = dependency.dep_kinds.length === 0
        || dependency.dep_kinds.some(({ kind }) => kind !== "dev");
      if (production) pending.push(dependency.pkg);
    }
  }

  const packages = [...reachable]
    .map((id) => packageById.get(id))
    .filter((pkg) => pkg?.source)
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
    .map((pkg) => {
      if (!pkg.license && !pkg.license_file) {
        throw new Error(`Cargo package has no declared license: ${pkg.name} ${pkg.version}`);
      }
      const packageRoot = dirname(pkg.manifest_path);
      const documentIds = legalFiles(packageRoot, pkg.license_file).map((file) =>
        addDocument(
          `cargo:${pkg.name} ${pkg.version}/${relative(packageRoot, file)}`,
          file,
        ));
      return {
        authors: pkg.authors.join(", ") || "Not declared",
        documents: documentIds,
        license: pkg.license ?? `SEE LICENSE IN ${basename(pkg.license_file)}`,
        name: pkg.name,
        source: pkg.repository ?? pkg.source,
        version: pkg.version,
      };
    });
  return {
    lockPath: join(metadata.workspace_root, "Cargo.lock"),
    packages,
  };
}

function npmPackages() {
  const packageJson = readJson(join(projectRoot, "package.json"));
  return Object.keys(packageJson.dependencies ?? {})
    .sort()
    .map((dependencyName) => {
      const packageRoot = join(projectRoot, "node_modules", ...dependencyName.split("/"));
      const manifestPath = join(packageRoot, "package.json");
      if (!existsSync(manifestPath)) {
        throw new Error(`Run npm ci before generating notices: missing ${manifestPath}`);
      }
      const manifest = readJson(manifestPath);
      const files = legalFiles(packageRoot, manifest.licenseFile);
      if (files.length === 0) {
        throw new Error(`npm package has no legal document: ${dependencyName}`);
      }
      const repository = typeof manifest.repository === "string"
        ? manifest.repository
        : manifest.repository?.url;
      const author = typeof manifest.author === "string"
        ? manifest.author
        : manifest.author?.name;
      return {
        authors: author ?? "See package legal documents",
        documents: files.map((file) => addDocument(
          `npm:${manifest.name} ${manifest.version}/${relative(packageRoot, file)}`,
          file,
        )),
        license: manifest.license ?? "See package legal documents",
        name: manifest.name,
        source: repository ?? manifest.homepage ?? "npm registry",
        version: manifest.version,
      };
    });
}

function packageSection(title, packages) {
  const lines = [`## ${title}`, ""];
  for (const pkg of packages) {
    const documentLinks = [...new Set(pkg.documents)]
      .map((hash) => `license-${hash.slice(0, 16)}`)
      .join(", ") || "metadata-only declaration";
    lines.push(
      `### ${pkg.name} ${pkg.version}`,
      "",
      `- License: ${pkg.license}`,
      `- Authors: ${pkg.authors}`,
      `- Source: ${pkg.source}`,
      `- Legal documents: ${documentLinks}`,
      "",
    );
  }
  return lines.join("\n");
}

const rootLicense = normalizeText(readFileSync(join(projectRoot, "LICENSE"), "utf8"));
const npmDependencies = npmPackages();
const cargo = cargoPackages();
const cargoDependencies = cargo.packages;
const cargoLockPath = relative(projectRoot, cargo.lockPath);
const cargoLockHash = sha256(readFileSync(cargo.lockPath));
const packageLockHash = sha256(readFileSync(join(projectRoot, "package-lock.json")));
const sections = [
  "# Typstian distribution license and third-party notices",
  "",
  "This file is generated by `scripts/generate-third-party-notices.mjs` from locked",
  "npm and Cargo package sources. Do not edit it manually.",
  "",
  `- ${cargoLockPath} SHA-256: ${cargoLockHash}`,
  `- package-lock.json SHA-256: ${packageLockHash}`,
  "",
  "## Typstian license",
  "",
  rootLicense,
  "",
  "## Vendored font assets",
  "",
  "Libertinus Serif is licensed under the SIL Open Font License Version 1.1.",
  "",
  ...vendoredLibertinusNotices,
  "",
  packageSection("Bundled npm production dependencies", npmDependencies),
  packageSection("Bundled WASM production dependencies", cargoDependencies),
  "## Deduplicated upstream license and notice texts",
  "",
];

for (const [hash, document] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
  sections.push(
    `### license-${hash.slice(0, 16)} — ${document.title}`,
    "",
    `Upstream files: ${[...document.origins].sort().join("; ")}`,
    "",
    document.text,
    "",
  );
}

const generated = `${sections.join("\n").trimEnd()}\n`;
if (checkOnly) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== generated) {
    console.error("THIRD_PARTY_NOTICES.md is stale; run npm run licenses:generate");
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, generated);
  console.log(
    `Generated notices for ${npmDependencies.length} npm and ${cargoDependencies.length} Cargo packages.`,
  );
}
