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

const { NPM_REGISTRY_LOOKUP_TIMED_OUT, checkNpmUpdate, withUpdateCheckTeardownScope } = await import("../../../src/sdk/extension/update-check.js");

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
  it("settles each lookup at its budget, and the action only once the teardown it started finished", async () => {
    vi.useFakeTimers();
    stall();
    let outcome: unknown;
    let actionDone = false;
    void withUpdateCheckTeardownScope(async () => {
      outcome = await checkNpmUpdate(source, undefined, 1_000);
      return outcome;
    }).then(() => {
      actionDone = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // The lookup is not held for its teardown, so a lock holder keeps its timing.
    expect(outcome).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242, expect.anything());
    expect(actionDone).toBe(false);
    // Another action in the same worker that started no provider is not held.
    await expect(withUpdateCheckTeardownScope(async () => "describe")).resolves.toBe("describe");
    expect(actionDone).toBe(false);
    teardownDone.release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(actionDone).toBe(true);
  });

  it("waits for the teardowns of an action that threw, then rethrows", async () => {
    vi.useFakeTimers();
    stall();
    let rejected: unknown;
    void withUpdateCheckTeardownScope(async () => {
      await checkNpmUpdate(source, undefined, 1_000);
      throw new Error("action failed");
    }).catch((error: unknown) => {
      rejected = error;
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(rejected).toBeUndefined();
    teardownDone.release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toMatchObject({ message: "action failed" });
  });
});
