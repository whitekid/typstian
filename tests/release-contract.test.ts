import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";


describe("release contract", () => {
  it("declares Typstian as a desktop-only Obsidian plugin with synchronized versions", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      packages?: Record<string, unknown>;
    };
    const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8")) as Record<string, unknown>;
    const scripts = packageJson.scripts as Record<string, string>;
    const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    const esbuildConfig = fs.readFileSync(path.join(root, "esbuild.config.mjs"), "utf8");

    expect(manifest).toMatchObject({
      id: "typstian",
      name: "Typstian",
      minAppVersion: "1.13.1",
      isDesktopOnly: true
    });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson).toMatchObject({
      name: "typstian",
      version: manifest.version
    });
    expect(scripts["build:wasm"]).toContain("wasm-pack");
    expect(scripts["build:wasm"]).toContain("node scripts/normalize-wasm-glue.mjs");
    expect(scripts.release).toBe("node scripts/release.mjs");
    for (const generated of ["typstian_wasm.d.ts", "typstian_wasm_bg.wasm.d.ts", "typstian_wasm.js"]) {
      expect(fs.readFileSync(path.join(root, "helper/wasm/pkg", generated), "utf8"))
        .not.toContain("/* eslint-disable */");
    }
    // wasm-bindgen types the compile callbacks as `Function` and its result as
    // `any`, which every linter reading the generated glue reports.
    const glueTypes = fs.readFileSync(
      path.join(root, "helper/wasm/pkg/typstian_wasm.d.ts"),
      "utf8"
    );
    expect(glueTypes).toContain(
      "compile(request_json: string, read_file: WasmInputReader, read_package: WasmInputReader, read_font: WasmInputReader): unknown;"
    );
    expect(glueTypes).not.toMatch(/\bFunction\b/);
    expect(glueTypes).not.toMatch(/:\s*any\b/);
    expect(scripts.build).not.toContain("build:wasm");
    expect(scripts.test).not.toContain("build:wasm");
    expect(gitignore.split(/\r?\n/)).not.toContain("typstian_wasm_bg.wasm");
    expect(esbuildConfig).toContain("src/wasm-worker.ts");
    expect(esbuildConfig).toContain("write: false");
    expect(esbuildConfig).toContain("__TYPSTIAN_WORKER_SOURCE__");
    expect(packageLock).toMatchObject({
      name: packageJson.name,
      version: manifest.version
    });
    expect(packageLock.packages?.[""]).toMatchObject({
      name: packageJson.name,
      version: manifest.version
    });
    expect(versions[manifest.version as string]).toBe(manifest.minAppVersion);
    expect(fs.existsSync(path.join(root, "styles.css"))).toBe(true);
    expect(fs.existsSync(path.join(root, "helper/wasm/pkg/typstian_wasm.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "helper/wasm/pkg/typstian_wasm_bg.wasm"))).toBe(true);
    expect(fs.existsSync(path.join(root, "helper/wasm/assets/NewCMMath-Book.otf"))).toBe(true);
  });


  it("builds an installable Community plugin release from one main bundle", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const workflowPath = path.join(root, ".github/workflows/release.yml");
    expect(fs.existsSync(workflowPath)).toBe(true);

    const workflow = fs.readFileSync(workflowPath, "utf8");
    const esbuildConfig = fs.readFileSync(path.join(root, "esbuild.config.mjs"), "utf8");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const contributing = fs.readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    const adr = fs.readFileSync(
      path.join(root, "docs/adr/0004-bundled-wasm-compiler.md"),
      "utf8",
    );

    expect(esbuildConfig).toContain("__TYPSTIAN_WASM_BROTLI__");
    expect(esbuildConfig).toContain("THIRD_PARTY_NOTICES.md");
    expect(esbuildConfig).toContain("banner:");
    expect(esbuildConfig).not.toContain("copyFile");

    expect(workflow).toMatch(
      /build:\n {4}runs-on: ubuntu-latest\n {4}permissions:\n {6}contents: read/,
    );
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("cargo install wasm-pack --version 0.15.0 --locked");
    // wasm-pack otherwise downloads whatever prebuilt wasm-bindgen its platform
    // offers, and those builds carry different walrus patches, which rewrite the
    // module differently — the release stops being reproducible off the runner.
    const wasmBindgenVersion = /name = "wasm-bindgen"\nversion = "([^"]+)"/
      .exec(fs.readFileSync(path.join(root, "helper/wasm/Cargo.lock"), "utf8"))?.[1];
    expect(wasmBindgenVersion).toBeDefined();
    expect(workflow).toContain(
      `cargo install wasm-bindgen-cli --version ${wasmBindgenVersion!} --locked`
    );
    // The developer side has to be pinned to the same build, or a local
    // reproduction of a release diverges again with no signal.
    expect(fs.readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8")).toContain(
      `cargo install wasm-bindgen-cli --version ${wasmBindgenVersion!} --locked`
    );
    expect(workflow).toContain("npm run build:wasm");
    expect(workflow).toContain("npm run licenses:check");
    expect(workflow).toContain("actions/checkout@");
    expect(workflow).toContain("actions/setup-node@");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("actions/download-artifact@");
    expect(workflow).toContain("actions/attest@");
    expect(workflow).toContain("needs: build");
    expect(workflow).toMatch(
      /release:\n {4}needs: build\n {4}runs-on: ubuntu-latest\n {4}permissions:\n {6}contents: write\n {6}id-token: write\n {6}attestations: write/,
    );
    expect(workflow).toContain("main.js manifest.json styles.css");
    expect(workflow).not.toContain("typstian_wasm_bg.wasm");
    expect(workflow.indexOf("npm run build:wasm")).toBeLessThan(
      workflow.indexOf("npm run licenses:check"),
    );
    expect(workflow.indexOf("npm run licenses:check")).toBeLessThan(
      workflow.lastIndexOf("npm run build"),
    );
    for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/g)) {
      expect(match[1]).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }

    expect(readme).not.toContain(
      "Copy `main.js`, `typstian_wasm_bg.wasm`",
    );
    expect(readme).not.toContain("hard timeout");
    // README.md is the plugin's Community directory description, so it carries
    // only what a user needs; building and releasing live in CONTRIBUTING.md.
    for (const developerOnly of [
      "npm run release",
      "npm run build:wasm",
      "wasm-pack",
      "draft",
    ]) {
      expect(readme).not.toContain(developerOnly);
    }
    // The PDF export is one of the plugin's two writes into the user's vault
    // (creating a Typst file is the other), so the Community-directory
    // description has to state where the file lands and that nothing is
    // overwritten.
    // AGENTS.md is CLAUDE.md for other tools. It has drifted twice by being
    // edited one file at a time, and nothing but this noticed.
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"))
      .toBe(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"));
    expect(readme).toContain("Typstian: Save the compiled PDF to the vault");
    expect(readme).toContain("An existing file is never overwritten");
    expect(workflow).not.toContain("--draft");
    expect(workflow).toContain("scripts/release-notes.mjs");
    expect(workflow).toContain("--notes-file release-notes.md");
    expect(contributing).toContain("npm run release");
    expect(contributing).toContain("community.obsidian.md/plugins/typstian");
    expect(contributing).toContain("Rust 1.92 or newer");
    expect(contributing).toContain("Release CI uses Rust 1.98.0");
    expect(contributing).not.toContain("Rust 1.85 or newer");
    expect(workflow).toContain("rustup toolchain install 1.98.0");
    expect(readme).toContain(
      "complete third-party license and attribution notices",
    );
    expect(readme).toContain("isEvalSupported");
    expect(readme).toContain("Node's `fs`");
    expect(readme).not.toContain("The Apache 2.0 notices");
    expect(agents).toContain("Brotli");
    expect(claude).toContain("Brotli");
    expect(adr).toContain("Brotli");
    expect(adr).not.toContain(
      "Release `main.js` and `typstian_wasm_bg.wasm` as plugin",
    );
  });


  it("declares the project license as MIT", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const licensePath = path.join(root, "LICENSE");
    expect(fs.existsSync(licensePath)).toBe(true);

    const license = fs.readFileSync(licensePath, "utf8");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      license?: unknown;
      scripts?: Record<string, string>;
    };
    const packageLock = JSON.parse(
      fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { license?: unknown }> };
    const wasmCargo = fs.readFileSync(
      path.join(root, "helper/wasm/Cargo.toml"),
      "utf8",
    );
    const wasmPackage = JSON.parse(
      fs.readFileSync(path.join(root, "helper/wasm/pkg/package.json"), "utf8"),
    ) as { license?: unknown };
    const notices = fs.readFileSync(
      path.join(root, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    const noticeGenerator = fs.readFileSync(
      path.join(root, "scripts/generate-third-party-notices.mjs"),
      "utf8",
    );
    const activeCargoLock = fs.readFileSync(
      path.join(root, "helper/wasm/Cargo.lock"),
    );
    const activeCargoLockHash = createHash("sha256").update(activeCargoLock).digest("hex");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

    expect(license).toContain("MIT License");
    expect(license).toContain(
      "Copyright (c) 2026 Typstian contributors",
    );
    expect(license).toContain("Permission is hereby granted");
    expect(packageJson.license).toBe("MIT");
    expect(packageLock.packages?.[""]?.license).toBe("MIT");
    expect(wasmCargo).toContain('license = "MIT"');
    expect(wasmPackage.license).toBe("MIT");
    expect(packageJson.scripts?.["build:wasm"]).toContain("--locked");
    // rustc records the crate paths it compiled, so without these the module —
    // and the main.js that embeds it — differs per checkout location and no one
    // can reproduce a published release.
    expect(packageJson.scripts?.["build:wasm"]).toContain("--remap-path-prefix=$PWD=");
    expect(packageJson.scripts?.["build:wasm"]).toContain(".cargo}=/cargo");
    expect(packageJson.scripts?.["licenses:generate"]).toBe(
      "node scripts/generate-third-party-notices.mjs",
    );
    expect(packageJson.scripts?.["licenses:check"]).toBe(
      "node scripts/generate-third-party-notices.mjs --check",
    );
    expect(packageJson.scripts?.build).not.toContain("licenses:check");
    expect(packageJson.scripts?.build).toContain("verify:release-notices");
    expect(fs.existsSync(
      path.join(root, "scripts/generate-third-party-notices.mjs"),
    )).toBe(true);
    expect(fs.existsSync(
      path.join(root, "scripts/verify-release-notices.mjs"),
    )).toBe(true);
    expect(noticeGenerator).toContain("metadata.workspace_root");
    expect(notices).toContain(
      `helper/wasm/Cargo.lock SHA-256: ${activeCargoLockHash}`,
    );
    // One crate, one lock: the notices cannot be generated from a second,
    // unshipped lockfile because there is no longer one to pick by mistake.
    expect(fs.existsSync(path.join(root, "helper/Cargo.lock"))).toBe(false);
    expect(notices).toContain(license.trim());
    expect(notices).toContain("typst-assets 0.15.1");
    for (const requiredNotice of [
      "SIL OPEN FONT LICENSE",
      "GUST Font License",
      "Bitstream Vera",
      "Unicode License V3",
    ]) {
      expect(notices).toContain(requiredNotice);
    }
    expect(readme).toContain("licensed under the MIT License");
  });

  it("keeps bundled npm dependency notices current", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const packageLock = fs.readFileSync(path.join(root, "package-lock.json"));
    const notices = fs.readFileSync(
      path.join(root, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );

    expect(notices).toContain(
      `package-lock.json SHA-256: ${createHash("sha256").update(packageLock).digest("hex")}`,
    );
    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      const dependency = JSON.parse(
        fs.readFileSync(
          path.join(root, "node_modules", ...dependencyName.split("/"), "package.json"),
          "utf8",
        ),
      ) as { name: string; version: string };
      expect(notices).toContain(`### ${dependency.name} ${dependency.version}`);
    }
  });

  it("records the vendored Libertinus fonts and their license", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const notices = fs.readFileSync(
      path.join(root, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    const faces = [
      "Regular",
      "Italic",
      "Bold",
      "BoldItalic",
      "Semibold",
      "SemiboldItalic",
    ];

    for (const face of faces) {
      const file = `LibertinusSerif-${face}.otf`;
      expect(fs.existsSync(path.join(root, "helper/wasm/assets", file))).toBe(true);
      expect(notices).toContain(`helper/wasm/assets/${file}`);
      expect(notices).toContain(
        `typst-assets 0.15.1/files/fonts/${file}`,
      );
    }
    expect(notices).toContain("SIL Open Font License Version 1.1");
  });
});
