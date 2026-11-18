import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedExtensionSource } from "../../../src/sdk/extension/managed-state.js";

// pm-5kfzjh: inside a worker thread no shutdown hook is sure to run, so a
// lookup that needs a teardown finishes it before handing back its outcome.
const spawnMock = vi.hoisted(() => vi.fn());
const teardownDone = vi.hoisted(() => ({ release: undefined as (() => void) | undefined }));
const killProcessTreeMock = vi.hoisted(() =>
  vi.fn(
    (_pid: number, _root?: { kill(): void; alive(): boolean }) =>
      new Promise<void>((resolve) => {
        teardownDone.release = resolve;
      }),
  ),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: false,
}));
vi.mock("../../../src/core/shared/process-tree.js", () => ({ killProcessTree: killProcessTreeMock }));

const { NPM_REGISTRY_LOOKUP_FAILED, NPM_REGISTRY_LOOKUP_TIMED_OUT, checkNpmUpdate } = await import("../../../src/sdk/extension/update-check.js");

const source: ManagedExtensionSource = { kind: "npm", input: "npm:example@1.0.0", location: "example@1.0.0", package: "example", version: "1.0.0" };

class FakeStream extends EventEmitter {
  readonly setEncoding = vi.fn();
  readonly destroy = vi.fn();
}

/** A provider that never exits on its own; SIGKILL takes effect a moment after the request. */
class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = "SIGKILL";
      this.emit("exit", null, "SIGKILL");
    });
    return true;
  });
  readonly unref = vi.fn();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid = 4242;
}

let children: FakeChild[] = [];

/** Spawn stalled fake providers, letting `drive` act once listeners are attached. */
function stall(drive: (child: FakeChild) => void = () => undefined): void {
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => drive(child));
    return child;
  });
}

afterEach(async () => {
  teardownDone.release?.();
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.clearAllMocks();
  children = [];
  teardownDone.release = undefined;
});

describe("update lookups inside a worker thread", () => {
  it("hands back a timeout only after the provider's teardown finished", async () => {
    vi.useFakeTimers();
    stall();
    let outcome: unknown;
    void checkNpmUpdate(source, undefined, 1_000).then((status) => {
      outcome = status;
    });
    await vi.advanceTimersByTimeAsync(1_001);
    // The teardown has started, but the outcome waits for it.
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242, expect.anything());
    expect(outcome).toBeUndefined();
    // A late exit or output from the provider changes nothing.
    children[0]?.emit("close", 0, null);
    teardownDone.release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: 1_000 });
  });

  it("finishes the teardown before reporting an overflow, and reports it as a timeout once the deadline passed", async () => {
    vi.useFakeTimers();
    stall((child) => child.stdout.emit("data", "x".repeat(70 * 1024)));
    let overflow: unknown;
    void checkNpmUpdate(source, undefined, 1_000).then((status) => {
      overflow = status;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(killProcessTreeMock).toHaveBeenCalledTimes(1);
    expect(overflow).toBeUndefined();
    teardownDone.release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(overflow).toMatchObject({ error: NPM_REGISTRY_LOOKUP_FAILED });
    expect(overflow).not.toHaveProperty("timeout_ms");

    // The same overflow classified after the deadline is a timeout.
    let lateOverflow: unknown;
    stall();
    void checkNpmUpdate(source, undefined, 1_000).then((status) => {
      lateOverflow = status;
    });
    await vi.advanceTimersByTimeAsync(1);
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now + 5_000);
    try {
      children[1]?.stdout.emit("data", "x".repeat(70 * 1024));
    } finally {
      clock.mockRestore();
    }
    // The deferred teardown starts on the next tick; the outcome waits for it.
    await vi.advanceTimersByTimeAsync(1);
    expect(killProcessTreeMock).toHaveBeenCalledTimes(2);
    expect(lateOverflow).toBeUndefined();
    teardownDone.release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(lateOverflow).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: 1_000 });
  });
});
