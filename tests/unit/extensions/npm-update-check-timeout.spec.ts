import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedExtensionSource } from "../../../src/sdk/extension/managed-state.js";

// pm-5kfzjh and pm-43p2c3: a lookup that runs out of its budget reports its
// own stable reason and the budget, never the provider's command, stderr or
// environment.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

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

type ExecCallback = (error: unknown, result?: { stdout: string; stderr: string }) => void;
type ExecOptions = { signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv };

function abortError(): Error {
  return Object.assign(new Error(`The operation was aborted\n${PRIVATE_FIXTURE}`), { name: "AbortError", code: "ABORT_ERR" });
}

/** A child that runs until the deadline aborts it, then fails as Node reports an abort. */
function hangUntilAborted(): void {
  execFileMock.mockImplementation((_file: string, _args: string[], options: ExecOptions, callback: ExecCallback) => {
    options.signal?.addEventListener("abort", () => callback(abortError()), { once: true });
  });
}

/** A child that handles the deadline's signal and exits cleanly with partial output. */
function exitCleanlyWhenAborted(stdout: string): void {
  execFileMock.mockImplementation((_file: string, _args: string[], options: ExecOptions, callback: ExecCallback) => {
    options.signal?.addEventListener("abort", () => callback(null, { stdout, stderr: "" }), { once: true });
  });
}

function failExecWith(failure: Record<string, unknown>): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _options: ExecOptions, callback: ExecCallback) => {
    callback(Object.assign(new Error(`Command failed: provider lookup\n${PRIVATE_FIXTURE}`), { stderr: PRIVATE_FIXTURE, ...failure }));
  });
}

function succeedWith(stdout: string): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _options: ExecOptions, callback: ExecCallback) => callback(null, { stdout, stderr: "" }));
}

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
  execFileMock.mockReset();
  vi.unstubAllEnvs();
});

describe("npm update lookup budget", () => {
  it("aborts a lookup at its budget and reports it as timed out with the budget", async () => {
    vi.useFakeTimers();
    hangUntilAborted();
    const pending = checkNpmUpdate(source);
    await vi.advanceTimersByTimeAsync(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS - 1);
    expect((execFileMock.mock.calls[0]?.[2] as ExecOptions).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const status = await pending;
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS });
    expect(JSON.stringify(status)).not.toContain("private-fixture-value");
    expect(execFileMock.mock.calls[0]?.[2]).not.toHaveProperty("timeout");
  });

  it("reports a lookup that exits cleanly after its deadline as timed out, not as its partial output", async () => {
    vi.useFakeTimers();
    exitCleanlyWhenAborted('"2.0');
    expect(await settleAfter(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, () => checkNpmUpdate(source))).toEqual({
      checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS,
    });
  });

  it.each([
    ["an exit status", { code: 1 }],
    ["an external signal", { killed: false, signal: "SIGKILL", code: null }],
    ["an overflowing output buffer", { killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
  ])("reports %s before the deadline as a failed lookup without a budget", async (_label, failure) => {
    failExecWith(failure);
    const status = await checkNpmUpdate(source);
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_FAILED });
    expect(JSON.stringify(status)).not.toContain("private-fixture-value");
  });

  it("reports a non-object rejection as a failed lookup", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: ExecOptions, callback: ExecCallback) => callback("refused"));
    expect(await checkNpmUpdate(source)).toMatchObject({ available: null, error: NPM_REGISTRY_LOOKUP_FAILED });
  });

  it("applies the configured budget and names it when it runs out", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "45000");
    vi.useFakeTimers();
    hangUntilAborted();
    const pending = checkNpmUpdate(source);
    await vi.advanceTimersByTimeAsync(44_999);
    expect((execFileMock.mock.calls[0]?.[2] as ExecOptions).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: 45000 });
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({ maxBuffer: 64 * 1024, env: expect.objectContaining({ npm_config_ignore_scripts: "true" }) });
  });

  it("reads the registry version when the lookup completes and clears its deadline", async () => {
    vi.useFakeTimers();
    succeedWith('"2.0.0"\n');
    expect(await checkNpmUpdate(source)).toEqual({ checked_at: expect.any(String), available: true, remote_version: "2.0.0" });
    expect(vi.getTimerCount()).toBe(0);
    expect((execFileMock.mock.calls[0]?.[2] as ExecOptions).signal?.aborted).toBe(false);
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
    expect(execFileMock.mock.calls[0]?.slice(0, 3)).toEqual([
      "git",
      ["ls-remote", "https://github.com/o/r.git", "HEAD", "HEAD^{}"],
      expect.objectContaining({ signal: expect.any(AbortSignal), env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }) }),
    ]);
  });

  it("reports a lookup aborted at its budget as timed out and names the budget", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "3000");
    vi.useFakeTimers();
    hangUntilAborted();
    const status = await settleAfter(3000, () => checkGithubUpdate(github));
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, timeout_ms: 3000 });
    expect(JSON.stringify(status)).not.toContain("private-fixture-value");
  });

  it("reports a lookup that exits cleanly after its deadline as timed out", async () => {
    vi.useFakeTimers();
    exitCleanlyWhenAborted("def456\tHEAD\n");
    expect(await settleAfter(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, () => checkGithubUpdate(github))).toMatchObject({ available: null, error: GITHUB_REMOTE_LOOKUP_TIMED_OUT });
  });

  it.each([
    ["an exit status", { code: 128 }],
    ["an overflowing output buffer", { killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
  ])("reports %s as a failed lookup without git's command line or stderr", async (_label, failure) => {
    failExecWith(failure);
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
    execFileMock.mockImplementation((file: string, _args: string[], options: ExecOptions, callback: ExecCallback) => {
      if (file === "git") callback(null, { stdout: "abc123\tHEAD\n", stderr: "" });
      else options.signal?.addEventListener("abort", () => callback(abortError()), { once: true });
    });
    const state = normalizeManagedState({ version: 1, updated_at: "2026-01-01T00:00:00.000Z", entries: [managedEntry("npm-example", npmSource), managedEntry("github-example", githubSource, { update_check_timeout_ms: 5000 })] })!;
    const refreshed = await settleAfter(EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, () => refreshManagedExtensionUpdates(state));
    expect(refreshed.entries.find((entry) => entry.name === "npm-example")).toMatchObject({ update_available: null, update_error: NPM_REGISTRY_LOOKUP_TIMED_OUT, update_check_timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS });
    const checked = refreshed.entries.find((entry) => entry.name === "github-example");
    expect(checked).toMatchObject({ update_available: false, last_update_remote_commit: "abc123" });
    expect(checked).not.toHaveProperty("update_check_timeout_ms");
    const offline = await refreshManagedExtensionUpdates(refreshed, true);
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
    expect(entry?.update_check_timeout_ms).toBe(expected);
    expect(entry !== undefined && Object.hasOwn(entry, "update_check_timeout_ms")).toBe(expected !== undefined);
  });
});
