import { LatestRequestScheduler } from "./latest-request-scheduler";

/**
 * Keeps one optional IDE read in flight and only the newest one queued behind
 * it. Cursor movement can produce a request per keystroke, and the compiler client
 * serializes everything it is handed, so a scheduler that queued them all would
 * answer each keystroke with the results of the one before it. Superseded
 * requests answer `null`, which is how CodeMirror says "no completions here".
 *
 * This is `SourceNavigationScheduler`'s coalescing with a return value: a
 * navigation only has to happen, a completion has to be handed back.
 */
export class OptionalReadScheduler<T, R> {
  private readonly scheduler: LatestRequestScheduler<T, R | null>;

  constructor(
    run: (
      request: T,
      isCurrent: () => boolean,
    ) => Promise<R | null>,
  ) {
    this.scheduler = new LatestRequestScheduler<T, R | null>(
      async (request, isCurrent) => {
        let value: R | null = null;
        try {
          value = isCurrent() ? await run(request, isCurrent) : null;
        } catch {
          // An IDE read is an optional convenience: a failed lookup offers
          // nothing rather than surfacing an error over the editor.
          value = null;
        }
        return isCurrent() ? value : null;
      },
      null,
    );
  }

  schedule(request: T, upstreamCurrent: () => boolean): Promise<R | null> {
    if (this.scheduler.isDisposed() || !upstreamCurrent()) return Promise.resolve(null);
    return this.scheduler.schedule(request, upstreamCurrent);
  }

  dispose(): void {
    this.scheduler.dispose();
  }
}
