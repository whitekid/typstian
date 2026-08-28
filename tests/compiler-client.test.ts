// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import {
  TypstianCompilerClient,
  type EngineCompileRequest,
  type WasmEngine,
  type WasmEngineFactory,
} from "../src/compiler-client";

class FakeWasmEngine implements WasmEngine {
  readonly calls: Array<{ kind: string; payload: object }> = [];
  readonly dispose = vi.fn();
  private readonly pending: Array<{
    resolve: (response: string) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(private readonly readiness: Promise<void> = Promise.resolve()) {}

  ready(): Promise<void> {
    return this.readiness;
  }

  checkEnvironment(): Promise<string> {
    return this.request("environment", {});
  }

  compile(payload: EngineCompileRequest): Promise<string> {
    return this.request("compile", payload);
  }

  jump(payload: { revision: number; page: number; xPt: number; yPt: number }): Promise<string> {
    return this.request("jump", payload);
  }

  forward(payload: { revision: number; source: string; byteOffset: number }): Promise<string> {
    return this.request("forward", payload);
  }

  complete(payload: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
    explicit: boolean;
  }): Promise<string> {
    return this.request("complete", payload);
  }

  definition(payload: {
    revision: number;
    source: string;
    sourceText: string;
    byteOffset: number;
  }): Promise<string> {
    return this.request("definition", payload);
  }

  respond(response: unknown): void {
    const pending = this.pending.shift();
    if (pending === undefined) throw new Error("No pending WASM request.");
    pending.resolve(typeof response === "string" ? response : JSON.stringify(response));
  }

  respondRaw(response: unknown): void {
    const pending = this.pending.shift();
    if (pending === undefined) throw new Error("No pending WASM request.");
    pending.resolve(response as string);
  }

  fail(error: unknown): void {
    const pending = this.pending.shift();
    if (pending === undefined) throw new Error("No pending WASM request.");
    pending.reject(error);
  }

  private request(kind: string, payload: object): Promise<string> {
    this.calls.push({ kind, payload });
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

function harness(
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxPdfBytes?: number;
    maxRequestBytes?: number;
    readiness?: Promise<void>;
  } = {},
) {
  const engines: FakeWasmEngine[] = [];
  const engineFactory: WasmEngineFactory = vi.fn(() => {
    const engine = new FakeWasmEngine(options.readiness);
    engines.push(engine);
    return Promise.resolve(engine);
  });
  const client = new TypstianCompilerClient({
    rootPath: "/vault path/with [notes]",
    wasmPath: "/vault/.obsidian/plugins/typstian/typstian_wasm_bg.wasm",
    engineFactory,
    ...options,
  });
  return { client, engineFactory, engines };
}


async function retainRevision(
  client: TypstianCompilerClient,
  engines: FakeWasmEngine[],
  revision: number,
): Promise<FakeWasmEngine> {
  const compile = client.compile({ revision, entryPath: "docs/main.typ" });
  await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
  const engine = engines[0]!;
  engine.respond({
    type: "compiled",
    revision,
    pdfBase64: pdf.toString("base64"),
    pdfBytes: pdf.length,
    pages: [{ widthPt: 240, heightPt: 180 }],
    dependencies: ["docs/main.typ"],
    diagnostics: [],
  });
  await compile;
  return engine;
}

const pdf = Buffer.from("%PDF-1.7\n%%EOF\n");

describe("TypstianCompilerClient", () => {
  it("loads one WASM engine lazily and checks the environment", async () => {
    const { client, engineFactory, engines } = harness();

    expect(engineFactory).not.toHaveBeenCalled();
    const result = client.checkEnvironment();
    await vi.waitFor(() => expect(engines[0]?.calls).toEqual([{ kind: "environment", payload: {} }]));
    expect(engineFactory).toHaveBeenCalledWith({
      rootPath: "/vault path/with [notes]",
      wasmPath: "/vault/.obsidian/plugins/typstian/typstian_wasm_bg.wasm",
      maxOutputBytes: 70 * 1024 * 1024,
    });

    engines[0]!.respond({ type: "environment", protocolVersion: 6, typstVersion: "0.15.1" });

    await expect(result).resolves.toEqual({ protocolVersion: 6, typstVersion: "0.15.1" });
    expect(engineFactory).toHaveBeenCalledOnce();
    client.close();
  });

  it("compiles a saved entry and maps inverse and forward positions through the retained engine", async () => {
    const { client, engines } = harness();
    const compile = client.compile({ revision: 7, entryPath: "docs/main.typ" });

    await vi.waitFor(() =>
      expect(engines[0]?.calls).toEqual([
        { kind: "compile", payload: { revision: 7, entryPath: "docs/main.typ" } },
      ]),
    );
    engines[0]!.respond({
      type: "compiled",
      revision: 7,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [{ widthPt: 240, heightPt: 180 }],
      dependencies: ["docs/main.typ", "docs/part.typ"],
      diagnostics: [],
    });

    const compiled = await compile;
    expect(compiled).toMatchObject({
      ok: true,
      revision: 7,
      pages: [{ widthPt: 240, heightPt: 180 }],
      dependencies: ["docs/main.typ", "docs/part.typ"],
    });
    expect(compiled.ok && Buffer.from(compiled.pdf).equals(pdf)).toBe(true);

    const jump = client.jump({ revision: 7, page: 1, xPt: 12.5, yPt: 40 });
    await vi.waitFor(() =>
      expect(engines[0]?.calls.at(-1)).toEqual({
        kind: "jump",
        payload: { revision: 7, page: 1, xPt: 12.5, yPt: 40 },
      }),
    );
    engines[0]!.respond({
      type: "source",
      revision: 7,
      path: "docs/part.typ",
      byteOffset: 12,
    });
    await expect(jump).resolves.toEqual({
      revision: 7,
      location: { path: "docs/part.typ", byteOffset: 12 },
    });

    const forward = client.forward({ revision: 7, source: "docs/part.typ", byteOffset: 8 });
    await vi.waitFor(() =>
      expect(engines[0]?.calls.at(-1)).toEqual({
        kind: "forward",
        payload: { revision: 7, source: "docs/part.typ", byteOffset: 8 },
      }),
    );
    engines[0]!.respond({
      type: "positions",
      revision: 7,
      positions: [{ page: 1, xPt: 10, yPt: 20 }],
    });
    await expect(forward).resolves.toEqual({
      revision: 7,
      positions: [{ page: 1, xPt: 10, yPt: 20 }],
    });
    client.close();
  });

  it("completes against the retained document and refuses a superseded revision", async () => {
    const { client, engines } = harness();
    const compile = client.compile({ revision: 3, entryPath: "docs/main.typ" });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
    engines[0]!.respond({
      type: "compiled",
      revision: 3,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [{ widthPt: 240, heightPt: 180 }],
      dependencies: ["docs/main.typ"],
      diagnostics: [],
    });
    await compile;

    const complete = client.complete({
      revision: 3,
      source: "docs/main.typ",
      sourceText: "#im",
      byteOffset: 9,
      explicit: true,
    });
    await vi.waitFor(() =>
      expect(engines[0]?.calls.at(-1)).toEqual({
        kind: "complete",
        payload: {
          revision: 3,
          source: "docs/main.typ",
          sourceText: "#im",
          byteOffset: 9,
          explicit: true,
        },
      }),
    );
    engines[0]!.respond({
      type: "completions",
      revision: 3,
      byteOffset: 8,
      completions: [
        { kind: "func", label: "image", apply: "image(\"${}\")", detail: "An image." },
        { kind: "label", label: "intro" },
      ],
    });
    await expect(complete).resolves.toEqual({
      revision: 3,
      byteOffset: 8,
      completions: [
        { kind: "func", label: "image", apply: "image(\"${}\")", detail: "An image." },
        { kind: "label", label: "intro" },
      ],
    });

    const sent = engines[0]!.calls.length;
    const empty = client.complete({
      revision: 3,
      source: "docs/main.typ",
      sourceText: "#im",
      byteOffset: 9,
      explicit: false,
    });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(sent + 1));
    engines[0]!.respond({ type: "no-completions", revision: 3 });
    await expect(empty).resolves.toEqual({ revision: 3, byteOffset: 9, completions: [] });

    // Completion never compiles: a revision the engine no longer retains is
    // refused before it reaches the engine at all.
    const callCount = engines[0]!.calls.length;
    await expect(
      client.complete({
        revision: 4,
        source: "docs/main.typ",
        sourceText: "#im",
        byteOffset: 0,
        explicit: true,
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(engines[0]!.calls).toHaveLength(callCount);

    await expect(
      client.complete({
        revision: 3,
        source: "../outside.typ",
        sourceText: "#im",
        byteOffset: 0,
        explicit: true,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    // The live buffer rides on the request, so it carries its own bound; the
    // 64 KiB request cap that guards the compile path would refuse ordinary
    // documents here.
    const large = "x".repeat(200 * 1024);
    const beforeWide = engines[0]!.calls.length;
    const wide = client.complete({
      revision: 3,
      source: "docs/main.typ",
      sourceText: large,
      byteOffset: large.length,
      explicit: true,
    });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(beforeWide + 1));
    engines[0]!.respond({ type: "no-completions", revision: 3 });
    await expect(wide).resolves.toMatchObject({ completions: [] });

    await expect(
      client.complete({
        revision: 3,
        source: "docs/main.typ",
        sourceText: "y".repeat(2 * 1024 * 1024 + 1),
        byteOffset: 0,
        explicit: true,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    // A malformed completion reply is refused on its own; jump and compile
    // still take the session down, so the engine survives here.
    const engineCount = engines.length;
    const beforeMalformed = engines[0]!.calls.length;
    const malformed = client.complete({
      revision: 3,
      source: "docs/main.typ",
      sourceText: "#im",
      byteOffset: 9,
      explicit: true,
    });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(beforeMalformed + 1));
    engines[0]!.respond({ type: "completions", revision: 3, byteOffset: 2, completions: "nope" });
    await expect(malformed).rejects.toMatchObject({ code: "malformed-protocol" });
    expect(engines[0]!.dispose).not.toHaveBeenCalled();
    expect(engines).toHaveLength(engineCount);

    client.close();
  });

  it("resolves a definition from the retained document with the exact live cursor", async () => {
    const { client, engines } = harness();
    const compile = client.compile({ revision: 31, entryPath: "docs/main.typ" });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
    engines[0]!.respond({
      type: "compiled",
      revision: 31,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [{ widthPt: 240, heightPt: 180 }],
      dependencies: ["docs/main.typ", "docs/defs.typ"],
      diagnostics: [],
    });
    await compile;

    const result = client.definition({
      revision: 31,
      source: "docs/main.typ",
      sourceText: "#let 한글 = 1\n#한글",
      byteOffset: 25,
    });
    await vi.waitFor(() => expect(engines[0]?.calls.at(-1)).toEqual({
      kind: "definition",
      payload: {
        revision: 31,
        source: "docs/main.typ",
        sourceText: "#let 한글 = 1\n#한글",
        byteOffset: 25,
      },
    }));
    engines[0]!.respond({
      type: "source",
      revision: 31,
      path: "docs/defs.typ",
      byteOffset: 7,
    });

    await expect(result).resolves.toEqual({
      revision: 31,
      location: { path: "docs/defs.typ", byteOffset: 7 },
    });
    client.close();
  });


  it("returns no definition from the retained document", async () => {
    const { client, engines } = harness();
    const engine = await retainRevision(client, engines, 32);

    const result = client.definition({
      revision: 32,
      source: "docs/main.typ",
      sourceText: "#let value = 1",
      byteOffset: 4,
    });
    await vi.waitFor(() => expect(engine.calls.at(-1)?.kind).toBe("definition"));
    engine.respond({ type: "no-definition", revision: 32 });

    await expect(result).resolves.toEqual({ revision: 32, location: null });
    client.close();
  });

  it("refuses definition without a retained revision before loading the engine", async () => {
    const { client, engineFactory } = harness();

    await expect(
      client.definition({
        revision: 1,
        source: "docs/main.typ",
        sourceText: "#value",
        byteOffset: 1,
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(engineFactory).not.toHaveBeenCalled();
    client.close();
  });

  it("refuses invalid definition requests before loading the engine", async () => {
    const { client, engineFactory } = harness();
    const invalidRequests = [
      {
        revision: 1,
        source: "../outside.typ",
        sourceText: "#value",
        byteOffset: 1,
      },
      {
        revision: 1,
        source: "docs/main.typ",
        sourceText: "#value",
        byteOffset: -1,
      },
      {
        revision: 1,
        source: "docs/main.typ",
        sourceText: "x".repeat(2 * 1024 * 1024 + 1),
        byteOffset: 1,
      },
    ];

    for (const request of invalidRequests) {
      await expect(client.definition(request)).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(engineFactory).not.toHaveBeenCalled();
    client.close();
  });

  it("rejects malformed definition replies without failing the retained session", async () => {
    const { client, engines } = harness();
    const engine = await retainRevision(client, engines, 33);
    const request = {
      revision: 33,
      source: "docs/main.typ",
      sourceText: "#value",
      byteOffset: 1,
    };
    const malformedReplies = [
      { type: "unknown", revision: 33 },
      { type: "source", revision: 33, path: "../outside.typ", byteOffset: 0 },
      { type: "source", revision: 33, path: "docs/defs.typ", byteOffset: -1 },
      { type: "no-definition", revision: 34 },
    ];

    for (const reply of malformedReplies) {
      const callCount = engine.calls.length;
      const result = client.definition(request);
      await vi.waitFor(() => expect(engine.calls).toHaveLength(callCount + 1));
      engine.respond(reply);
      await expect(result).rejects.toMatchObject({ code: "malformed-protocol" });
    }
    expect(engine.dispose).not.toHaveBeenCalled();

    const survivorCallCount = engine.calls.length;
    const survivor = client.definition(request);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(survivorCallCount + 1));
    engine.respond({ type: "no-definition", revision: 33 });
    await expect(survivor).resolves.toEqual({ revision: 33, location: null });
    client.close();
  });

  it("rejects an oversized definition reply without failing the retained session", async () => {
    const { client, engines } = harness({ maxOutputBytes: 512 });
    const engine = await retainRevision(client, engines, 34);
    const request = {
      revision: 34,
      source: "docs/main.typ",
      sourceText: "#value",
      byteOffset: 1,
    };

    const oversized = client.definition(request);
    await vi.waitFor(() => expect(engine.calls.at(-1)?.kind).toBe("definition"));
    engine.respondRaw("x".repeat(513));
    await expect(oversized).rejects.toMatchObject({ code: "output-limit" });
    expect(engine.dispose).not.toHaveBeenCalled();

    const survivorCallCount = engine.calls.length;
    const survivor = client.definition(request);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(survivorCallCount + 1));
    engine.respond({ type: "no-definition", revision: 34 });
    await expect(survivor).resolves.toEqual({ revision: 34, location: null });
    client.close();
  });

  it("aborts one definition without failing the retained session", async () => {
    const { client, engines } = harness();
    const engine = await retainRevision(client, engines, 35);
    const controller = new AbortController();
    const request = {
      revision: 35,
      source: "docs/main.typ",
      sourceText: "#value",
      byteOffset: 1,
    };
    const callCount = engine.calls.length;

    const aborted = client.definition({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(callCount + 1));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    expect(engine.dispose).not.toHaveBeenCalled();

    const survivor = client.definition(request);
    engine.respond({ type: "no-definition", revision: 35 });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(callCount + 2));
    engine.respond({ type: "no-definition", revision: 35 });
    await expect(survivor).resolves.toEqual({ revision: 35, location: null });
    client.close();
  });

it("passes the pinned overlay snapshot to the engine compile request", async () => {
    const { client, engines } = harness();
    const overlay = new Map([
      ["docs/main.typ", Uint8Array.from([1, 2, 3])],
    ]);
    const compile = client.compile({
      revision: 1,
      entryPath: "docs/main.typ",
      overlay,
    });

    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
    expect(engines[0]?.calls[0]).toMatchObject({
      kind: "compile",
      payload: { revision: 1, entryPath: "docs/main.typ" },
    });
    expect((engines[0]?.calls[0]?.payload as EngineCompileRequest).overlay).toBe(overlay);

    client.close();
    await expect(compile).rejects.toMatchObject({ code: "closed" });
  });

  it("does not supply a settled compile overlay to a later compile without one", async () => {
    const { client, engines } = harness();
    const overlay = new Map([
      ["docs/main.typ", Uint8Array.from([1, 2, 3])],
    ]);
    const first = client.compile({
      revision: 1,
      entryPath: "docs/main.typ",
      overlay,
    });

    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
    expect((engines[0]?.calls[0]?.payload as EngineCompileRequest).overlay).toBe(overlay);
    engines[0]!.respond({
      type: "compiled",
      revision: 1,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [{ widthPt: 240, heightPt: 180 }],
      dependencies: ["docs/main.typ"],
      diagnostics: [],
    });
    await first;

    const second = client.compile({
      revision: 2,
      entryPath: "docs/main.typ",
    });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(2));
    expect(engines[0]?.calls[1]).toEqual({
      kind: "compile",
      payload: { revision: 2, entryPath: "docs/main.typ" },
    });
    engines[0]!.respond({
      type: "compiled",
      revision: 2,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [{ widthPt: 240, heightPt: 180 }],
      dependencies: ["docs/main.typ"],
      diagnostics: [],
    });

    await second;
    client.close();
  });

  it("returns compile diagnostics without classifying them as an engine crash", async () => {
    const { client, engines } = harness();
    const result = client.compile({ revision: 1, entryPath: "bad.typ" });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
    engines[0]!.respond({
      type: "error",
      requestType: "compile",
      revision: 1,
      code: "compile",
      message: "expected expression",
      dependencies: ["bad.typ"],
      diagnostics: [
        { severity: "error", message: "expected expression", file: "bad.typ", line: 2, column: 4 },
      ],
    });

    await expect(result).resolves.toEqual({
      ok: false,
      revision: 1,
      reason: "compile-error",
      message: "expected expression",
      dependencies: ["bad.typ"],
      diagnostics: [
        { severity: "error", message: "expected expression", path: "bad.typ", line: 2, column: 4 },
      ],
    });
    expect(engines[0]!.dispose).not.toHaveBeenCalled();
    client.close();
  });

  it("disposes a superseded compile session before starting the newer revision", async () => {
    const { client, engines } = harness();
    const first = client.compile({ revision: 3, entryPath: "main.typ" });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));

    const second = client.compile({ revision: 4, entryPath: "main.typ" });

    await expect(first).rejects.toMatchObject({ code: "stale" });
    expect(engines[0]!.dispose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(engines[1]?.calls).toHaveLength(1));
    expect(engines[1]!.calls[0]).toEqual({
      kind: "compile",
      payload: { revision: 4, entryPath: "main.typ" },
    });
    engines[1]!.respond({
      type: "compiled",
      revision: 4,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [],
      dependencies: ["main.typ"],
      diagnostics: [],
    });

    await expect(second).resolves.toMatchObject({ ok: true, revision: 4 });
    await expect(client.jump({ revision: 3, page: 1, xPt: 0, yPt: 0 })).rejects.toMatchObject({
      code: "stale",
    });
    client.close();
  });

  it("rejects an aborted jump while preserving the retained revision and request ordering", async () => {
    const { client, engines } = harness();
    const compile = client.compile({ revision: 7, entryPath: "main.typ" });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
    engines[0]!.respond({
      type: "compiled",
      revision: 7,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [{ widthPt: 100, heightPt: 100 }],
      dependencies: ["main.typ"],
      diagnostics: [],
    });
    await compile;

    const controller = new AbortController();
    const first = client.jump({
      revision: 7,
      page: 1,
      xPt: 10,
      yPt: 20,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(2));
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "aborted" });

    const second = client.jump({ revision: 7, page: 1, xPt: 30, yPt: 40 });
    expect(engines[0]!.calls).toHaveLength(2);
    engines[0]!.respond({
      type: "source",
      revision: 7,
      path: "docs/old.typ",
      byteOffset: 1,
    });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(3));
    engines[0]!.respond({
      type: "source",
      revision: 7,
      path: "docs/latest.typ",
      byteOffset: 9,
    });

    await expect(second).resolves.toEqual({
      revision: 7,
      location: { path: "docs/latest.typ", byteOffset: 9 },
    });
    expect(engines[0]!.dispose).not.toHaveBeenCalled();
    client.close();
  });

  it("disposes an aborted compile session and can load a fresh engine", async () => {
    const { client, engines } = harness();
    const controller = new AbortController();
    const compile = client.compile({ revision: 1, entryPath: "main.typ", signal: controller.signal });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));

    controller.abort();

    await expect(compile).rejects.toMatchObject({ code: "aborted" });
    expect(engines[0]!.dispose).toHaveBeenCalledOnce();

    const environment = client.checkEnvironment();
    await vi.waitFor(() => expect(engines[1]?.calls).toHaveLength(1));
    engines[1]!.respond({ type: "environment", protocolVersion: 6, typstVersion: "0.15.1" });
    await expect(environment).resolves.toEqual({ protocolVersion: 6, typstVersion: "0.15.1" });
    client.close();
  });

  it("disposes the engine and rejects pending work on timeout", async () => {
    vi.useFakeTimers();
    try {
      const { client, engines } = harness({ timeoutMs: 25 });
      const result = client.checkEnvironment();
      const rejection = expect(result).rejects.toMatchObject({
        code: "timeout",
        message: "Typst engine request timed out.",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(engines[0]?.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(engines[0]!.dispose).toHaveBeenCalledOnce();
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the first compile of a session a wider deadline than the next one", async () => {
    vi.useFakeTimers();
    try {
      const { client, engines } = harness({ timeoutMs: 25 });
      const first = client.compile({ revision: 1, entryPath: "main.typ" });
      await vi.advanceTimersByTimeAsync(0);

      // A cold session pays for font residency and a first layout pass, so the
      // steady-state budget alone must not kill it.
      await vi.advanceTimersByTimeAsync(25);
      expect(engines[0]?.dispose).not.toHaveBeenCalled();

      engines[0]!.respond({
        type: "compiled",
        revision: 1,
        pdfBase64: pdf.toString("base64"),
        pdfBytes: pdf.length,
        pages: [{ widthPt: 240, heightPt: 180 }],
        dependencies: ["main.typ"],
        diagnostics: [],
      });
      await expect(first).resolves.toMatchObject({ ok: true, revision: 1 });

      const second = client.compile({ revision: 2, entryPath: "main.typ" });
      const rejection = expect(second).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(engines[0]!.dispose).toHaveBeenCalledOnce();
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["invalid JSON", "not-json"],
    [
      "malformed shape",
      JSON.stringify({ type: "environment", protocolVersion: "one", typstVersion: "0.15.1" }),
    ],
  ])("disposes an engine returning %s", async (_case, response) => {
    const { client, engines } = harness();
    const result = client.checkEnvironment();
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));

    engines[0]!.respond(response);

    await expect(result).rejects.toMatchObject({ code: "malformed-protocol" });
    expect(engines[0]!.dispose).toHaveBeenCalledOnce();
    client.close();
  });

  it("enforces encoded response and decoded PDF bounds", async () => {
    const outputHarness = harness({ maxOutputBytes: 32 });
    const environment = outputHarness.client.checkEnvironment();
    await vi.waitFor(() => expect(outputHarness.engines[0]?.calls).toHaveLength(1));
    outputHarness.engines[0]!.respond({
      type: "environment",
      protocolVersion: 6,
      typstVersion: "0.15.1",
    });
    await expect(environment).rejects.toMatchObject({ code: "output-limit" });
    expect(outputHarness.engines[0]!.dispose).toHaveBeenCalledOnce();
    outputHarness.client.close();

    const pdfHarness = harness({ maxPdfBytes: 8 });
    const compile = pdfHarness.client.compile({ revision: 1, entryPath: "main.typ" });
    await vi.waitFor(() => expect(pdfHarness.engines[0]?.calls).toHaveLength(1));
    pdfHarness.engines[0]!.respond({
      type: "compiled",
      revision: 1,
      pdfBase64: pdf.toString("base64"),
      pdfBytes: pdf.length,
      pages: [],
      dependencies: [],
      diagnostics: [],
    });
    await expect(compile).rejects.toMatchObject({ code: "output-limit" });
    expect(pdfHarness.engines[0]!.dispose).toHaveBeenCalledOnce();
    pdfHarness.client.close();
  });

  it("accepts a decoded PDF transferred from the browser worker", async () => {
    const { client, engines } = harness();
    const compile = client.compile({ revision: 9, entryPath: "main.typ" });
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));
    const transferredPdf = Uint8Array.from(pdf).buffer;

    engines[0]!.respondRaw({
      type: "compiled",
      revision: 9,
      pdfBuffer: transferredPdf,
      pdfBytes: pdf.byteLength,
      pages: [],
      dependencies: ["main.typ"],
      diagnostics: [],
    });

    const result = await compile;
    expect(result).toMatchObject({
      ok: true,
      revision: 9,
      pdf: new Uint8Array(transferredPdf),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pdf.buffer).toBe(transferredPdf);
      expect(result.pdf.byteOffset).toBe(0);
      expect(result.pdf.byteLength).toBe(transferredPdf.byteLength);
    }
    client.close();
  });

  it("starts the request timeout after engine initialization", async () => {
    let finishInitialization!: () => void;
    const readiness = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const { client, engines } = harness({ timeoutMs: 50, readiness });

    let settled = false;
    const environment = client.checkEnvironment();
    void environment.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);

    finishInitialization();
    await vi.waitFor(
      () => expect(engines[0]?.calls).toHaveLength(1),
      { interval: 1, timeout: 20 },
    );
    engines[0]!.respond({
      type: "environment",
      protocolVersion: 6,
      typstVersion: "0.15.1",
    });
    await expect(environment).resolves.toMatchObject({ typstVersion: "0.15.1" });
    client.close();
  });

  it("rejects oversized requests before loading the engine", async () => {
    const { client, engineFactory } = harness({ maxRequestBytes: 32 });

    await expect(
      client.compile({ revision: 1, entryPath: "docs/long-file-name.typ" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(engineFactory).not.toHaveBeenCalled();
    client.close();
  });

  it("disposes its exact engine once on close and refuses later work", async () => {
    const { client, engines } = harness();
    const pending = client.checkEnvironment();
    await vi.waitFor(() => expect(engines[0]?.calls).toHaveLength(1));

    client.close();
    client.close();

    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(engines[0]!.dispose).toHaveBeenCalledOnce();
    await expect(client.checkEnvironment()).rejects.toMatchObject({ code: "closed" });
  });
});
