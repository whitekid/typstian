import { describe, expect, it } from "vitest";

import { OptionalReadScheduler } from "../src/optional-read-scheduler";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("OptionalReadScheduler", () => {
  it("runs one request at a time and answers superseded ones with null", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const scheduler = new OptionalReadScheduler<string, string>((request) => {
      started.push(request);
      const gate = deferred<string>();
      gates.set(request, gate);
      return gate.promise;
    });

    const first = scheduler.schedule("a", () => true);
    const second = scheduler.schedule("b", () => true);
    const third = scheduler.schedule("c", () => true);

    // A burst of keystrokes must not become a burst of compiler requests: only
    // the running request and the newest one survive.
    expect(started).toEqual(["a"]);
    gates.get("a")!.resolve("A");

    // "a" was superseded while it ran, so its answer must not reach the editor.
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    // The queued request only starts once the running one has settled.
    expect(started).toEqual(["a", "c"]);
    gates.get("c")!.resolve("C");
    await expect(third).resolves.toBe("C");

    scheduler.dispose();
  });

  it("answers with null when the editor has moved on before the run starts", async () => {
    const started: string[] = [];
    const scheduler = new OptionalReadScheduler<string, string>((request) => {
      started.push(request);
      return Promise.resolve(request.toUpperCase());
    });

    await expect(scheduler.schedule("a", () => false)).resolves.toBeNull();
    expect(started).toEqual([]);

    scheduler.dispose();
    await expect(scheduler.schedule("b", () => true)).resolves.toBeNull();
    expect(started).toEqual([]);
  });

  it("hands the run a currency check that fails once a newer request arrives", async () => {
    const gate = deferred<string>();
    const currency: boolean[] = [];
    const scheduler = new OptionalReadScheduler<string, string>((request, isCurrent) =>
      gate.promise.then(() => {
        currency.push(isCurrent());
        return request;
      }),
    );

    const first = scheduler.schedule("a", () => true);
    void scheduler.schedule("b", () => true);
    gate.resolve("done");

    await expect(first).resolves.toBeNull();
    expect(currency[0]).toBe(false);

    scheduler.dispose();
  });

  it("answers with null when an optional read fails", async () => {
    const scheduler = new OptionalReadScheduler<string, string>(() =>
      Promise.reject(new Error("optional read failed")),
    );

    await expect(scheduler.schedule("request", () => true)).resolves.toBeNull();

    scheduler.dispose();
  });
});
