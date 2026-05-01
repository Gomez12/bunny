/**
 * In-process FIFO semaphore that bounds the number of in-flight upstream LLM
 * chat-completion requests. See ADR 0035.
 *
 * Why: `bunqueue` is a logging spine, not a throttle. Multiple `runAgent`
 * instances can fire `chat()` in parallel and overwhelm a single-GPU upstream
 * like llama.cpp. The gate is the single chokepoint — every caller shares
 * one process-wide instance via `getGlobalGate()`.
 */

export interface AcquireTicket {
  /**
   * Position the caller had in the queue when it called `acquire()`. 0 means
   * the gate had a free permit and the caller proceeded without waiting; >0
   * means the caller queued behind that many other waiters (1 = next-up).
   * Drives the "In wachtrij (positie X)" badge in the UI.
   */
  initialPosition: number;
  /** `Date.now()` when `acquire()` started. */
  queuedSinceMs: number;
  /** Resolves with the wall-clock wait time once a permit is available. */
  ready: Promise<{ waitedMs: number }>;
}

export interface ConcurrencyGate {
  acquire(): AcquireTicket;
  release(): void;
  setCap(n: number): void;
  getCap(): number;
  getInFlight(): number;
  getQueued(): number;
}

interface Waiter {
  resolve: (r: { waitedMs: number }) => void;
  queuedSinceMs: number;
}

let _globalGate: ConcurrencyGate | null = null;

/**
 * Get-or-create the process-wide gate. Mutates the singleton's cap when
 * `cap` changes — supports a future hot-reload of `bunny.config.toml` without
 * the caller having to know whether the gate exists yet.
 */
export function ensureGlobalGate(cap: number): ConcurrencyGate {
  if (_globalGate === null) {
    _globalGate = createConcurrencyGate(cap);
  } else if (_globalGate.getCap() !== cap) {
    _globalGate.setCap(cap);
  }
  return _globalGate;
}

export function __resetGlobalGateForTests(): void {
  _globalGate = null;
}

export function __setGlobalGateForTests(g: ConcurrencyGate): void {
  _globalGate = g;
}

export function createConcurrencyGate(initialCap: number): ConcurrencyGate {
  if (!Number.isInteger(initialCap) || initialCap < 1) {
    throw new Error(
      `createConcurrencyGate: cap must be a positive integer, got ${initialCap}`,
    );
  }

  let cap = initialCap;
  let inFlight = 0;
  const waiters: Waiter[] = [];

  function pump(): void {
    while (inFlight < cap && waiters.length > 0) {
      const w = waiters.shift()!;
      inFlight++;
      w.resolve({ waitedMs: Date.now() - w.queuedSinceMs });
    }
  }

  return {
    acquire(): AcquireTicket {
      const queuedSinceMs = Date.now();
      if (inFlight < cap) {
        inFlight++;
        return {
          initialPosition: 0,
          queuedSinceMs,
          ready: Promise.resolve({ waitedMs: 0 }),
        };
      }
      const initialPosition = waiters.length + 1;
      const ready = new Promise<{ waitedMs: number }>((resolve) => {
        waiters.push({ resolve, queuedSinceMs });
      });
      return { initialPosition, queuedSinceMs, ready };
    },
    release(): void {
      if (inFlight === 0) {
        // Either a double-release or a release before acquire — surface to
        // stderr so a caller bug isn't silent, but stay non-fatal.
        process.stderr.write(
          "[bunny/llm/concurrency_gate] release() called with inFlight=0\n",
        );
        return;
      }
      inFlight--;
      pump();
    },
    setCap(n: number): void {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`setCap: cap must be a positive integer, got ${n}`);
      }
      cap = n;
      pump();
    },
    getCap(): number {
      return cap;
    },
    getInFlight(): number {
      return inFlight;
    },
    getQueued(): number {
      return waiters.length;
    },
  };
}
