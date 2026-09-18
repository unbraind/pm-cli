/**
 * @module cli/invocation-profile
 *
 * Measures the executable's runtime lifetime, including module loading and
 * pending output, independently of the narrower command-handler diagnostics.
 */
import type { Writable } from "node:stream";

/** Minimal process boundary, also usable by embedded executable hosts. */
interface InvocationProfileHost {
  /** Register a callback after pending event-loop work and output drain. */
  once(event: "beforeExit", listener: () => void): unknown;
  /** Remove an unconsumed callback when an embedding host disposes it. */
  off(event: "beforeExit", listener: () => void): unknown;
  /** Monotonic seconds since runtime startup, including module initialization. */
  uptime(): number;
  /** Diagnostic destination; command output remains on stdout. */
  stderr: Pick<Writable, "write">;
}

/**
 * Emit exactly one total when the process drains, even for help or refusals.
 * Runtime uptime excludes parent-side spawn and final OS teardown. The legacy
 * command records retain their shape; the receipt explicitly names their scope.
 * Return a disposer for hosts that reuse the process instead of exiting.
 */
export function registerInvocationProfile(
  argv: readonly string[],
  host: InvocationProfileHost = process,
): () => void {
  const terminator = argv.indexOf("--");
  const options = terminator < 0 ? argv : argv.slice(0, terminator);
  const emit = (): void => {
    host.stderr.write(
      `profile:invocation total_ms=${(host.uptime() * 1000).toFixed(3)} scope=process_start_to_output_drain command_took_ms_scope=handler\n`,
    );
  };
  if (options.includes("--profile")) host.once("beforeExit", emit);
  return () => {
    host.off("beforeExit", emit);
  };
}
