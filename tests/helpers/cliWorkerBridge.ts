/**
 * Main-thread side of the synchronous CLI bridge used by the test suite.
 *
 * `runWorkerCli` keeps the exact synchronous `runCli` contract the specs rely
 * on (1,500+ call sites) while eliminating the dominant cost of the previous
 * implementation: one `spawnSync(node dist/cli.js …)` per invocation, i.e. a
 * fresh Node boot plus a full ESM bundle load for every CLI call. A single
 * persistent worker thread imports the dist bundle once and executes each
 * invocation in-process; the main thread blocks on `Atomics.wait` and reads
 * the result synchronously via `receiveMessageOnPort`.
 *
 * Correctness fallback: if the worker dies mid-call (e.g. an unexpected
 * `process.exit` inside the CLI) or a call exceeds the deadline, the bridge
 * re-runs that invocation through the original spawn runner so the test still
 * observes real process semantics, and a fresh worker is created for
 * subsequent calls. Calls that need stdin input or a custom working directory
 * are routed to the spawn runner by the caller (`withTempPmPath`), never here.
 */
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import path from "node:path";
import { runDirectDistCli, type DirectCliRunOptions, type DirectCliRunResult } from "./cliRunner.js";

/** Per-call deadline before falling back to the spawn runner. */
const WORKER_CALL_TIMEOUT_MS = 60_000;

interface WorkerCliOutcome {
  status: number;
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

interface WorkerResponse {
  ok: boolean;
  result?: WorkerCliOutcome;
  errorMessage?: string;
}

let bridgeWorker: Worker | null = null;

function workerScriptPath(): string {
  return path.resolve(process.cwd(), "tests/helpers/cliWorkerBridge.worker.mjs");
}

function ensureBridgeWorker(): Worker {
  if (bridgeWorker === null) {
    bridgeWorker = new Worker(workerScriptPath());
    // Never keep the vitest fork alive just because the bridge exists.
    bridgeWorker.unref();
  }
  return bridgeWorker;
}

function teardownBridgeWorker(): void {
  if (bridgeWorker !== null) {
    void bridgeWorker.terminate();
    bridgeWorker = null;
  }
}

/**
 * Build the plain-object environment snapshot sent to the worker. Only string
 * values survive structured clone into the worker cleanly, and the CLI only
 * ever reads string env values.
 */
function snapshotEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function parseExpectedJson(result: DirectCliRunResult, args: string[], expectJson: boolean | undefined): DirectCliRunResult {
  if (expectJson && result.stdout.trim().length > 0) {
    try {
      result.json = JSON.parse(result.stdout);
    } catch (error) {
      const preview = result.stdout.slice(0, 500);
      throw new Error(
        `Failed to parse bridged CLI JSON stdout for args ${JSON.stringify(args)}: ${String(error)}\nstdout: ${preview}`,
        { cause: error },
      );
    }
  }
  return result;
}

/**
 * Execute one CLI invocation synchronously through the persistent worker.
 * Falls back to the spawn runner on worker failure or timeout so behavior is
 * never worse than the previous implementation, only faster.
 */
export function runWorkerCli(args: string[], options: DirectCliRunOptions = {}): DirectCliRunResult {
  if (options.input !== undefined || options.stdin !== undefined || options.cwd !== undefined) {
    // Real process semantics required — the worker cannot chdir or provide a
    // readable stdin. The caller normally routes these before reaching us;
    // this guard keeps the contract even for direct callers.
    return runDirectDistCli(args, options);
  }

  const worker = ensureBridgeWorker();
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));

  worker.postMessage(
    {
      port: port2,
      signal,
      request: {
        args,
        env: snapshotEnv(options.env ?? process.env),
        workspaceRoot: process.cwd(),
      },
    },
    [port2],
  );

  const waitOutcome = Atomics.wait(signal, 0, 0, WORKER_CALL_TIMEOUT_MS);
  const message = receiveMessageOnPort(port1) as { message: WorkerResponse } | undefined;
  port1.close();

  if (waitOutcome === "timed-out" || message === undefined || !message.message.ok || message.message.result === undefined) {
    // The worker is in an unknown state — replace it and preserve correctness
    // by re-running this invocation as a real child process.
    teardownBridgeWorker();
    return runDirectDistCli(args, options);
  }

  const outcome = message.message.result;
  if (outcome.status !== 0 && process.env.PM_TEST_CLI_BRIDGE_DEBUG === "1") {
    // Debug aid: surfacing bridged-CLI stderr, which assertion failures on
    // exit codes otherwise swallow.
    console.error(`[cli-bridge] pm ${args.join(" ")} -> ${outcome.status}\n${outcome.stderr}`);
  }
  const result: DirectCliRunResult = {
    code: outcome.status,
    status: outcome.status,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    ...(outcome.errorMessage !== undefined ? { error: new Error(outcome.errorMessage) } : {}),
  };
  return parseExpectedJson(result, args, options.expectJson);
}
