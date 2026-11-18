import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedExtensionSource } from "../../../src/sdk/extension/managed-state.js";

// pm-5kfzjh and pm-43p2c3: a lookup killed by its budget reports its own
// stable reason and the budget, never the provider's command, stderr or
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
// Assembled from parts so the repository never holds a credential-shaped literal.
const PRIVATE_FIXTURE = ["npm ERR! //registry.example.test/:", "_auth", "Token=", "private-fixture-value"].join("");

type ExecCallback = (error: unknown, result?: { stdout: string; stderr: string }) => void;

function failExecWith(failure: Record<string, unknown>): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
    callback(Object.assign(new Error(`Command failed: npm view\n${PRIVATE_FIXTURE}`), { stderr: PRIVATE_FIXTURE, ...failure }));
  });
}

afterEach(() => {
  execFileMock.mockReset();
  vi.unstubAllEnvs();
});

describe("npm update lookup budget", () => {
  it("reports a lookup that execFile killed at its budget as timed out and names the budget", async () => {
    failExecWith({ killed: true, signal: "SIGTERM", code: null });
    const status = await checkNpmUpdate(source);
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS });
    expect(JSON.stringify(status)).not.toContain("private-fixture-value");
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({ timeout: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS });
  });

  it.each([
    ["an exit status", { killed: false, code: 1 }],
    ["an external signal", { killed: false, signal: "SIGKILL", code: null }],
    ["an overflowing output buffer", { killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
  ])("reports %s as a failed lookup without a budget", async (_label, failure) => {
    failExecWith(failure);
    const status = await checkNpmUpdate(source);
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: NPM_REGISTRY_LOOKUP_FAILED });
    expect(JSON.stringify(status)).not.toContain("private-fixture-value");
  });

  it("reports a non-object rejection as a failed lookup", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => callback("refused"));
    expect(await checkNpmUpdate(source)).toMatchObject({ available: null, error: NPM_REGISTRY_LOOKUP_FAILED });
  });

  it("applies the configured budget to the npm lookup and names it when it runs out", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "45000");
    failExecWith({ killed: true, signal: "SIGTERM", code: null });
    expect(await checkNpmUpdate(source)).toMatchObject({ error: NPM_REGISTRY_LOOKUP_TIMED_OUT, timeout_ms: 45000 });
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 45000, env: expect.objectContaining({ npm_config_ignore_scripts: "true" }) });
  });

  it("reads the registry version when the lookup completes", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => callback(null, { stdout: '"2.0.0"\n', stderr: "" }));
    expect(await checkNpmUpdate(source)).toEqual({ checked_at: expect.any(String), available: true, remote_version: "2.0.0" });
  });

  it("applies the configured budget to the GitHub remote lookup", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "2500");
    const runner = vi.fn(async () => "abc123\trefs/heads/main");
    await checkGithubUpdate({ kind: "github", input: "github:o/r", location: "o/r", repository: "https://github.com/o/r.git", commit: "abc123" }, runner);
    expect(runner).toHaveBeenCalledWith(["ls-remote", "https://github.com/o/r.git", "HEAD", "HEAD^{}"], 2500);
  });
});

describe("GitHub update lookup reasons", () => {
  const github: ManagedExtensionSource = { kind: "github", input: "github:o/r", location: "o/r", repository: "https://github.com/o/r.git", commit: "abc123" };

  it("runs a bounded, prompt-free git ls-remote and compares the peeled commit", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => callback(null, { stdout: "def456\tHEAD\n", stderr: "" }));
    expect(await checkGithubUpdate(github)).toEqual({ checked_at: expect.any(String), available: true, remote_commit: "def456" });
    expect(execFileMock.mock.calls[0]?.slice(0, 3)).toEqual([
      "git",
      ["ls-remote", "https://github.com/o/r.git", "HEAD", "HEAD^{}"],
      expect.objectContaining({ timeout: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS, env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }) }),
    ]);
  });

  it("reports a lookup killed at its budget as timed out and names the budget", async () => {
    vi.stubEnv(PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV, "3000");
    failExecWith({ killed: true, signal: "SIGTERM", code: null });
    const status = await checkGithubUpdate(github);
    expect(status).toEqual({ checked_at: expect.any(String), available: null, error: GITHUB_REMOTE_LOOKUP_TIMED_OUT, timeout_ms: 3000 });
    expect(JSON.stringify(status)).not.toContain("private-fixture-value");
  });

  it.each([
    ["an exit status", { killed: false, code: 128 }],
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

function managedEntry(name: string, source: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, directory: name, scope: "project", manifest_version: "1.0.0", manifest_entry: "index.js", capabilities: ["commands"],
    installed_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", source, ...extra,
  };
}

describe("managed update status budget evidence", () => {
  const npmSource = { kind: "npm", input: "npm:@scope/example", location: "@scope/example", package: "@scope/example", version: "1.0.0" };
  const githubSource = { kind: "github", input: "o/r", location: "https://github.com/o/r.git", repository: "https://github.com/o/r.git", owner: "o", repo: "r", commit: "abc123" };

  it("carries the budget of a timed-out npm lookup and clears it offline", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      if (file === "git") callback(null, { stdout: "abc123\tHEAD\n", stderr: "" });
      else callback(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }));
    });
    const state = normalizeManagedState({ version: 1, updated_at: "2026-01-01T00:00:00.000Z", entries: [managedEntry("npm-example", npmSource), managedEntry("github-example", githubSource)] })!;
    const refreshed = await refreshManagedExtensionUpdates(state);
    expect(refreshed.entries.find((entry) => entry.name === "npm-example")).toMatchObject({ update_available: null, update_error: NPM_REGISTRY_LOOKUP_TIMED_OUT, update_check_timeout_ms: EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS });
    const github = refreshed.entries.find((entry) => entry.name === "github-example");
    expect(github).toMatchObject({ update_available: false, last_update_remote_commit: "abc123" });
    expect(github?.update_check_timeout_ms).toBeUndefined();
    const offline = await refreshManagedExtensionUpdates(refreshed, true);
    expect(offline.entries.map((entry) => entry.update_check_timeout_ms)).toEqual([undefined, undefined]);
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
    expect(state?.entries[0]?.update_check_timeout_ms).toBe(expected);
  });
});
