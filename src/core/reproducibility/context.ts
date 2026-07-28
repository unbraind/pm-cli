/**
 * @module core/reproducibility/context
 *
 * Provides opt-in deterministic time and identifier entropy for reproducible
 * workspace executions. The default CLI path never installs this context.
 */
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** Low-level deterministic execution settings shared by SDK recipes. */
export interface ReproducibleExecutionSettings {
  /** Stable seed used to derive identifier entropy. */
  seed: string;
  /** ISO timestamp returned for the first clock read. */
  clock: string;
  /** Milliseconds advanced after each clock read. */
  tickMs: number;
}

interface ReproducibleExecutionState extends ReproducibleExecutionSettings {
  clockReads: number;
  tokenReads: number;
}

const executionStorage = new AsyncLocalStorage<ReproducibleExecutionState>();

/** Run an isolated async operation with deterministic clock and entropy state. */
export async function runWithReproducibleExecution<T>(
  settings: ReproducibleExecutionSettings,
  operation: () => Promise<T>,
): Promise<T> {
  const clockMs = Date.parse(settings.clock);
  if (!Number.isFinite(clockMs)) {
    throw new Error(`Invalid reproducible workspace clock: ${settings.clock}`);
  }
  if (!Number.isSafeInteger(settings.tickMs) || settings.tickMs < 0) {
    throw new Error("Reproducible workspace tickMs must be a non-negative integer");
  }
  if (settings.seed.length === 0) {
    throw new Error("Reproducible workspace seed must not be empty");
  }
  return executionStorage.run(
    {
      ...settings,
      clock: new Date(clockMs).toISOString(),
      clockReads: 0,
      tokenReads: 0,
    },
    operation,
  );
}

/** Return the next deterministic clock value, or undefined outside a recipe. */
export function nextReproducibleTimestamp(): string | undefined {
  const state = executionStorage.getStore();
  if (state === undefined) {
    return undefined;
  }
  const timestamp = new Date(
    Date.parse(state.clock) + state.clockReads * state.tickMs,
  ).toISOString();
  state.clockReads += 1;
  return timestamp;
}

/** Return a deterministic base36 token, or undefined outside a recipe. */
export function nextReproducibleToken(length: number): string | undefined {
  const state = executionStorage.getStore();
  if (state === undefined) {
    return undefined;
  }
  let token = "";
  while (token.length < length) {
    const digest = crypto
      .createHash("sha256")
      .update(`${state.seed}\0${state.tokenReads}`)
      .digest();
    state.tokenReads += 1;
    for (const byte of digest) {
      token += (byte % 36).toString(36);
      if (token.length === length) {
        break;
      }
    }
  }
  return token;
}
