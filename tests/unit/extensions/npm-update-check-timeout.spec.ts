import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedExtensionSource } from "../../../src/sdk/extension/managed-state.js";

// pm-5kfzjh and pm-43p2c3: a lookup that runs out of its budget reports its
// own stable reason and the budget, never the provider's command, stderr or
// environment.
const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn(async (_pid: number) => undefined));
const untrackMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn((_pid: number | undefined) => untrackMock));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("../../../src/core/shared/process-tree.js", () => ({ killProcessTree: killProcessTreeMock, trackDetachedProcessGroup: trackMock }));

const {
  EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS,
  GITHUB_REMOTE_LOOKUP_FAILED,
  GITHUB_REMOTE_LOOKUP_TIMED_OUT,
  NPM_REGISTRY_LOOKUP_FAILED,
  NPM_REGISTRY_LOOKUP_TIMED_OUT,
  PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV,
  checkGithubUpdate,
  checkNpmUpdate,
  resolveExtensionUpdateCheckTimeoutMs,
} = await import("../../../src/sdk/extension/update-check.js");
const { normalizeManagedState } = await import("../../../src/sdk/extension/managed-state.js");
const { refreshManagedExtensionUpdates } = await import("../../../src/sdk/extension/managed-update-status.js");

const source: ManagedExtensionSource = { kind: "npm", input: "npm:@scope/example@1.0.0", location: "@scope/example@1.0.0", package: "@scope/example", version: "1.0.0" };
const github: ManagedExtensionSource = { kind: "github", input: "github:o/r", location: "o/r", repository: "https://github.com/o/r.git", commit: "abc123" };
// Assembled from parts so the repository never holds a credential-shaped literal.
const PRIVATE_FIXTURE = ["npm ERR! //registry.example.test/:", "_auth", "Token=", "private-fixture-value"].join("");

class FakeStream extends EventEmitter {
  readonly setEncoding = vi.fn();
  readonly destroy = vi.fn();
  readonly resume = vi.fn();
}

/** A spawned provider whose events the test drives. */
class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number | undefined = 4242) {
    super();
  }

  /** Write stdout and stderr, then close with `code` and `signal`. */
  finish(code: number | null, signal: NodeJS.Signals | null = null, stdout = "", stderr = PRIVATE_FIXTURE): void {
    if (stdout) this.stdout.emit("data", stdout);
    this.stderr.emit("data", stderr);
    this.emit("close", code, signal);
  }
}

let children: FakeChild[] = [];

/** Spawn fake children and drive each one once its listeners are attached. */
function provide(drive: (child: FakeChild, file: string) => void): void {
  spawnMock.mockImplementation((file: string) => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => drive(child, file));
    return child;
  });
}

const succeedWith = (stdout: string): void => provide((child) => child.finish(0, null, stdout));
const hang = (): void => provide(() => undefined);
const spawnOptions = (call = 0): Record<string, unknown> => spawnMock.mock.calls[call]?.[2] as Record<string, unknown>;

/** Run a lookup under fake timers, advancing past `budget` while it is pending. */
async function settleAfter<T>(budget: number, lookup: () => Promise<T>): Promise<T> {
  const pending = lookup();
  await vi.advanceTimersByTimeAsync(budget);
  return pending;
}

beforeEach(() => {
  // Isolate from a budget the contributor's shell may export.
  vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, undefined);
});

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  killProcessTreeMock.mockReset();
  killProcessTreeMock.mockImplementation(async () => undefined);
  trackMock.mockClear();
  untrackMock.mockClear();
  children = [];
  vi.unstubAllEnvs();
});

describe("npm update lookup budget", () => {
  it("settles a lookup at its budget as timed out with the budget and tears down its process tree", async () => {
    vi.useFakeTimers();
    hang();
    const pending = checkNpmUpdate(source);
    await vi.advanceTimersByTimeAsync(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS - 1);
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const status = await pending;
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS });
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(children[0]?.stdout.destroy).toHaveBeenCalled();
    expect(children[0]?.stderr.destroy).toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith(4242);
    expect(untrackMock).toHaveBeenCalledTimes(1);
    // The tree teardown ran; a direct child still running is killed as well.
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not signal a direct child that already exited after the tree teardown", async () => {
    vi.useFakeTimers();
    hang();
    killProcessTreeMock.mockImplementationOnce(async () => {
      children[0]!.signalCode = "SIGKILL";
    });
    expect(await settleAfter(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, () => checkNpmUpdate(source))).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT });
    expect(children[0]?.kill).not.toHaveBeenCalled();
  });

  it("still kills the direct child when the tree teardown fails", async () => {
    vi.useFakeTimers();
    hang();
    killProcessTreeMock.mockImplementationOnce(async () => {
      throw new Error("taskkill unavailable");
    });
    const pending = checkNpmUpdate(source);
    await vi.advanceTimersByTimeAsync(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS);
    expect(await pending).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT });
    await vi.waitFor(() => expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL"));
  });

  it("kills the child itself when it has no process id", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      Object.defineProperty(child, "pid", { value: undefined });
      children.push(child);
      return child;
    });
    expect(await settleAfter(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, () => checkNpmUpdate(source))).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT });
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith(undefined);
  });

  it("keeps the timed-out result when the provider exits cleanly with partial output after the deadline", async () => {
    vi.useFakeTimers();
    hang();
    killProcessTreeMock.mockImplementationOnce(async () => children[0]?.finish(0, null, '"2.0'));
    expect(await settleAfter(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, () => checkNpmUpdate(source))).toEqual({
      checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS,
    });
  });

  it.each([
    ["an exit status", (child: FakeChild) => child.finish(1)],
    ["a signal", (child: FakeChild) => child.finish(null, "SIGKILL")],
    ["a spawn error", (child: FakeChild) => { child.emit("error", new Error(PRIVATE_FIXTURE)); child.emit("close", null, null); }],
    ["stdout beyond its buffer", (child: FakeChild) => { child.stdout.emit("data", "x".repeat(64 * 1024 + 1)); child.finish(0, null, '"2.0.0"'); }],
  ])("reports %s before the deadline as a failed lookup without a budget", async (label, drive) => {
    provide(drive);
    const status = await checkNpmUpdate(source);
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_FAILED });
    expect(JSON.stringify(status)).not.toContain("private-fixture-value");
    if (label === "stdout beyond its buffer") expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
  });

  it("reports a spawn that throws as a failed lookup", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error(PRIVATE_FIXTURE);
    });
    expect(await checkNpmUpdate(source)).toEqual({ checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_FAILED });
  });

  it("applies the configured budget and names it when it runs out", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "45000");
    vi.useFakeTimers();
    hang();
    const pending = checkNpmUpdate(source);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: 45000 });
  });

  it("runs npm detached with closed stdin, discarded stderr and no lifecycle scripts, and clears its deadline", async () => {
    vi.useFakeTimers();
    succeedWith('"2.0.0"\n');
    expect(await checkNpmUpdate(source)).toEqual({ checked_at: expect.any(String), available: true, remote_version: "2.0.0" });
    expect(vi.getTimerCount()).toBe(0);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["view", "@scope/example", "dist-tags.latest", "--json", "--ignore-scripts"]);
    expect(spawnOptions()).toMatchObject({
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
      env: expect.objectContaining({ npm_config_ignore_scripts: "true" }),
    });
    expect(children[0]?.stderr.resume).toHaveBeenCalled();
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(untrackMock).toHaveBeenCalledTimes(1);
  });

  it("passes the configured budget to an injected GitHub runner", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "2500");
    const runner = vi.fn(async () => "abc123\trefs/heads/main");
    await checkGithubUpdate(github, runner);
    expect(runner).toHaveBeenCalledWith(["ls-remote", "https://github.com/o/r.git", "HEAD", "HEAD^{}"], 2500);
  });
});

describe("GitHub update lookup reasons", () => {
  it("runs a bounded git ls-remote without interactive prompts and compares the peeled commit", async () => {
    succeedWith("def456\tHEAD\n");
    expect(await checkGithubUpdate(github)).toEqual({ checked_at: expect.any(String), available: true, remote_commit: "def456" });
    expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual(["git", ["ls-remote", "https://github.com/o/r.git", "HEAD", "HEAD^{}"]]);
    expect(spawnOptions()).toMatchObject({
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }),
    });
    expect(spawnOptions().shell).toBeUndefined();
  });

  it("reports a lookup still running at its budget as timed out and names the budget", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "3000");
    vi.useFakeTimers();
    hang();
    const status = await settleAfter(3000, () => checkGithubUpdate(github));
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, timeout_ms: 3000 });
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
  });

  it.each([
    ["an exit status", (child: FakeChild) => child.finish(128)],
    ["stdout beyond its buffer", (child: FakeChild) => child.stdout.emit("data", "x".repeat(1024 * 1024 + 1))],
  ])("reports %s as a failed lookup without git's command line or stderr", async (_label, drive) => {
    provide(drive);
    const status = await checkGithubUpdate(github);
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_FAILED });
    expect(JSON.stringify(status)).not.toMatch(/private-fixture-value|ls-remote|github\.com/u);
  });
});

describe("resolveExtensionUpdateCheckTimeoutMs", () => {
  it.each([
    [undefined, 10000],
    ["", 10000],
    ["   ", 10000],
    ["not-a-number", 10000],
    ["Infinity", 10000],
    ["30000", 30000],
    [" 2500.9 ", 2500],
    ["1", 1000],
    ["-5", 1000],
    ["999999", 120000],
  ])("resolves %j to %i ms", (raw, expected) => {
    expect(resolveExtensionUpdateCheckTimeoutMs(raw === undefined ? {} : { [PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV]: raw })).toBe(expected);
  });

  it("reads the process environment by default", () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "15000");
    expect(resolveExtensionUpdateCheckTimeoutMs()).toBe(15000);
  });
});

function managedEntry(name: string, entrySource: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, directory: name, scope: "project", manifest_version: "1.0.0", manifest_entry: "index.js", capabilities: ["commands"],
    installed_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", source: entrySource, ...extra,
  };
}

describe("managed update status budget evidence", () => {
  const npmSource = { kind: "npm", input: "npm:@scope/example", location: "@scope/example", package: "@scope/example", version: "1.0.0" };
  const githubSource = { kind: "github", input: "o/r", location: "https://github.com/o/r.git", repository: "https://github.com/o/r.git", owner: "o", repo: "r", commit: "abc123" };

  it("carries the budget only for a timed-out lookup and drops it offline and on the next completed check", async () => {
    vi.useFakeTimers();
    provide((child, file) => {
      if (file === "git") child.finish(0, null, "abc123\tHEAD\n");
    });
    const state = normalizeManagedState({ version: 1, updated_at: "2026-01-01T00:00:00.000Z", entries: [managedEntry("npm-example", npmSource), managedEntry("github-example", githubSource, { update_error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, update_check_timeout_ms: 5000 })] })!;
    expect(state.entries.find((entry) => entry.name === "github-example")?.update_check_timeout_ms).toBe(5000);
    const refreshed = await settleAfter(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, () => refreshManagedExtensionUpdates(state));
    expect(refreshed.entries.find((entry) => entry.name === "npm-example")).toMatchObject({ update_available: null, update_error: NPM_REGISTRY_LOOKUP_TIMED_OUT, update_check_timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS });
    const checked = refreshed.entries.find((entry) => entry.name === "github-example");
    expect(checked).toMatchObject({ update_available: false, last_update_remote_commit: "abc123" });
    expect(checked).not.toHaveProperty("update_check_timeout_ms");
    const offline = await refreshManagedExtensionUpdates(refreshed, true);
    expect(offline.entries.map((entry) => entry.name)).toEqual(refreshed.entries.map((entry) => entry.name));
    expect(offline.entries).toHaveLength(2);
    for (const entry of offline.entries) expect(entry).not.toHaveProperty("update_check_timeout_ms");
  });

  it.each([
    [1000, 1000],
    [45000, 45000],
    [0, undefined],
    [-5, undefined],
    [1.5, undefined],
    [Number.NaN, undefined],
    [2 ** 60, undefined],
    ["1000", undefined],
    [null, undefined],
  ])("normalizes a recorded budget of %j to %j", (recorded, expected) => {
    const state = normalizeManagedState({ version: 1, updated_at: "2026-01-01T00:00:00.000Z", entries: [managedEntry("npm-example", npmSource, { update_error: NPM_REGISTRY_LOOKUP_TIMED_OUT, update_check_timeout_ms: recorded })] });
    const entry = state?.entries[0];
    expect(state?.entries).toHaveLength(1);
    expect(entry).toMatchObject({ name: "npm-example", update_error: NPM_REGISTRY_LOOKUP_TIMED_OUT, source: { package: "@scope/example" } });
    expect(entry?.update_check_timeout_ms).toBe(expected);
    expect(entry !== undefined && Object.hasOwn(entry, "update_check_timeout_ms")).toBe(expected !== undefined);
  });

  it.each([NPM_REGISTRY_LOOKUP_TIMED_OUT, GITHUB_REMOTE_LOOKUP_TIMED_OUT])("keeps a recorded budget beside %s", (reason) => {
    const state = normalizeManagedState({ version: 1, updated_at: "2026-01-01T00:00:00.000Z", entries: [managedEntry("npm-example", npmSource, { update_error: reason, update_check_timeout_ms: 2500 })] });
    expect(state?.entries[0]?.update_check_timeout_ms).toBe(2500);
  });

  it.each([undefined, NPM_REGISTRY_LOOKUP_FAILED, GITHUB_REMOTE_LOOKUP_FAILED, "no_remote_reference_found", `${NPM_REGISTRY_LOOKUP_TIMED_OUT}_stale`, 7])("drops a stale budget beside update_error %j", (reason) => {
    const state = normalizeManagedState({ version: 1, updated_at: "2026-01-01T00:00:00.000Z", entries: [managedEntry("npm-example", npmSource, { update_error: reason, update_check_timeout_ms: 2500 })] });
    expect(state?.entries).toHaveLength(1);
    expect(state?.entries[0]).toMatchObject({ name: "npm-example" });
    expect(state?.entries[0]).not.toHaveProperty("update_check_timeout_ms");
  });
});
