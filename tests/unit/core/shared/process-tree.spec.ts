import { afterEach, describe, expect, it, vi } from "vitest";
import { trackDetachedProcessGroup } from "../../../../src/core/shared/process-tree.js";

// pm-5kfzjh: a detached lookup group is stopped by the host's exit or
// interruption, which it would otherwise survive outside the terminal's
// foreground process group.
type Listener = (...args: unknown[]) => void;
const EVENTS = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(EVENTS.map((event) => [event, process.listenerCount(event)]));
}

/** The listener `track` added for `event`, found by comparing before and after. */
function addedListener(event: (typeof EVENTS)[number], before: Listener[]): Listener {
  const added = (process.listeners(event) as Listener[]).filter((listener) => !before.includes(listener));
  expect(added).toHaveLength(1);
  return added[0]!;
}

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("trackDetachedProcessGroup", () => {
  it("installs one set of listeners while any group is tracked and removes them after the last release", () => {
    const before = listenerCounts();
    const first = trackDetachedProcessGroup(111);
    releases.push(first);
    const during = listenerCounts();
    for (const event of EVENTS) expect(during[event]).toBe(before[event]! + 1);
    const second = trackDetachedProcessGroup(222);
    releases.push(second);
    expect(listenerCounts()).toEqual(during);
    first();
    expect(listenerCounts()).toEqual(during);
    first();
    expect(listenerCounts()).toEqual(during);
    second();
    expect(listenerCounts()).toEqual(before);
  });

  it("tracks nothing for a child without a process id", () => {
    const before = listenerCounts();
    const release = trackDetachedProcessGroup(undefined);
    expect(listenerCounts()).toEqual(before);
    release();
    expect(listenerCounts()).toEqual(before);
  });

  it("kills every tracked group when the host exits, ignoring groups already gone", () => {
    const beforeExit = process.listeners("exit") as Listener[];
    const countsBefore = listenerCounts();
    const first = trackDetachedProcessGroup(111);
    const second = trackDetachedProcessGroup(222);
    releases.push(first, second);
    const onExit = addedListener("exit", beforeExit);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === -222) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    onExit(0);
    expect(kill.mock.calls).toEqual([[-111, "SIGKILL"], [-222, "SIGKILL"]]);
    kill.mockRestore();
    first();
    second();
    expect(listenerCounts()).toEqual(countsBefore);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("kills the tracked groups on %s and re-raises it with its default action", (signal) => {
    const beforeSignal = process.listeners(signal) as Listener[];
    const countsBefore = listenerCounts();
    releases.push(trackDetachedProcessGroup(333));
    const onSignal = addedListener(signal, beforeSignal);
    expect(process.listeners(signal)[0]).toBe(onSignal);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process, "listenerCount").mockReturnValue(1);
    onSignal(signal);
    expect(kill.mock.calls).toEqual([[-333, "SIGKILL"], [process.pid, signal]]);
    vi.mocked(process.listenerCount).mockRestore();
    expect(listenerCounts()).toEqual(countsBefore);
  });

  it("leaves the signal to another listener instead of re-raising it", () => {
    const beforeSignal = process.listeners("SIGINT") as Listener[];
    releases.push(trackDetachedProcessGroup(444));
    const onSignal = addedListener("SIGINT", beforeSignal);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process, "listenerCount").mockReturnValue(2);
    onSignal("SIGINT");
    expect(kill.mock.calls).toEqual([[-444, "SIGKILL"]]);
  });
});

describe("trackDetachedProcessGroup on Windows", () => {
  it("tracks nothing, because Windows children are never detached", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const before = listenerCounts();
      const release = trackDetachedProcessGroup(555);
      expect(listenerCounts()).toEqual(before);
      release();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
