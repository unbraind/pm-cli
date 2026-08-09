import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const UTILS_SPECIFIER = "../../../../scripts/release/utils.mjs";

const harness = createScriptHarness([UTILS_SPECIFIER]);

type RunCommandResult = { status: number; stdout: string; stderr: string };

interface ScenarioOptions {
  argv: string[];
  existsSync?: boolean;
  runCommand?: (command: string, args: string[]) => RunCommandResult;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  failThrows?: boolean;
}

const TELEMETRY_TOKENS = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_PERSONAL_ADMIN_TOKEN",
  "SENTRY_ORG_TOKEN",
];

async function runSentryGate(options: ScenarioOptions) {
  for (const key of TELEMETRY_TOKENS) {
    delete process.env[key];
  }
  delete process.env.PM_TELEMETRY_QUERY_COMMAND;
  delete process.env.SENTRY_URL;
  delete process.env.SENTRY_BASE_URL;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const existsSync = vi.fn(() => options.existsSync ?? false);
  vi.doMock("node:fs", () => ({ existsSync }));

  const runCommand = vi.fn(
    options.runCommand ?? (() => ({ status: 0, stdout: "[]", stderr: "" })),
  );
  vi.doMock(UTILS_SPECIFIER, async () => {
    const actual =
      await vi.importActual<
        typeof import("../../../../scripts/release/utils.mjs")
      >(UTILS_SPECIFIER);
    return {
      ...actual,
      runCommand,
      commandFor(binary: string) {
        return binary;
      },
      fail(message: string, exitCode = 1) {
        if (options.failThrows) {
          throw new Error(`FAIL:${exitCode}:${message}`);
        }
        process.exitCode = exitCode;
        console.error(message);
      },
    };
  });

  if (options.fetchImpl) {
    globalThis.fetch = options.fetchImpl;
  }

  process.argv = [
    "node",
    "scripts/release/sentry-telemetry-gate.mjs",
    ...options.argv,
  ];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    errors.push(String(value ?? ""));
  });

  let failure: unknown = null;
  try {
    await harness.importModuleStable(
      "scripts/release/sentry-telemetry-gate.mjs",
    );
  } catch (error) {
    failure = error;
  }

  await harness.waitForCondition(() => {
    expect(
      stdoutSpy.mock.calls.length + logs.length + errors.length,
    ).toBeGreaterThan(0);
  });

  const lastJson = (() => {
    const raw = String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "");
    if (!raw.trim().startsWith("{")) {
      return null;
    }
    return JSON.parse(raw);
  })();

  return { failure, stdoutSpy, logs, errors, runCommand, json: lastJson };
}

const TELEMETRY_CSV = [
  "### overall finish error rate",
  "finish_error_rate_pct,sample_size",
  "1,50",
  "(1 rows)",
  "",
  "### missing error code coverage",
  "error_code,count",
  "(0 rows)",
].join("\n");

function buildSentryFetch(
  issues: unknown[],
  overrides: { ok?: boolean; status?: number } = {},
): typeof fetch {
  return vi.fn(async () => ({
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    text: async () => JSON.stringify(issues),
  })) as unknown as typeof fetch;
}

describe("scripts/release/sentry-telemetry-gate: usage and arg validation", () => {
  it("prints usage for --help", async () => {
    const { logs, runCommand } = await runSentryGate({ argv: ["--help"] });
    expect(logs.join("\n")).toContain(
      "scripts/release/sentry-telemetry-gate.mjs",
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails on an unsupported --telemetry-mode", async () => {
    const { errors } = await runSentryGate({
      argv: ["--telemetry-mode", "weird"],
    });
    expect(errors.join("\n")).toContain(
      'Unsupported --telemetry-mode value "weird"',
    );
  });

  it("fails on a negative numeric flag value", async () => {
    const { errors } = await runSentryGate({ argv: ["--max-critical", "-1"] });
    expect(errors.join("\n")).toContain('Invalid --max-critical value "-1"');
  });

  it("fails on a non-numeric flag value", async () => {
    const { errors } = await runSentryGate({ argv: ["--sentry-limit", "abc"] });
    expect(errors.join("\n")).toContain('Invalid --sentry-limit value "abc"');
  });

  it("fails on a negative --sentry-window-days value", async () => {
    const { errors } = await runSentryGate({
      argv: ["--sentry-window-days", "-3"],
    });
    expect(errors.join("\n")).toContain(
      'Invalid --sentry-window-days value "-3"',
    );
  });

  it("fails on a fractional --sentry-window-days value (Sentry lastSeen needs whole days)", async () => {
    const { errors } = await runSentryGate({
      argv: ["--sentry-window-days", "14.5"],
    });
    expect(errors.join("\n")).toContain(
      'Invalid --sentry-window-days value "14.5"',
    );
  });

  it("rejects a blank --sentry-window-days value instead of silently disabling the window", async () => {
    const { errors } = await runSentryGate({
      argv: ["--sentry-window-days", " "],
    });
    expect(errors.join("\n")).toContain(
      'Invalid --sentry-window-days value " "',
    );
  });
});

describe("scripts/release/sentry-telemetry-gate: recent-activity window", () => {
  it("bounds the default Sentry query to a 14-day lastSeen window", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "[]",
    }));
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0] ?? ""));
    expect(calledUrl.searchParams.get("query")).toBe(
      "is:unresolved level:[fatal,error] lastSeen:-14d",
    );
    expect(json.sentry.window_days).toBe(14);
  });

  it("honors a custom --sentry-window-days value in the query and output", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "[]",
    }));
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--sentry-window-days", "30"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0] ?? ""));
    expect(calledUrl.searchParams.get("query")).toBe(
      "is:unresolved level:[fatal,error] lastSeen:-30d",
    );
    expect(json.sentry.window_days).toBe(30);
  });

  it("leaves the query unbounded when --sentry-window-days is 0", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "[]",
    }));
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--sentry-window-days", "0"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0] ?? ""));
    expect(calledUrl.searchParams.get("query")).toBe(
      "is:unresolved level:[fatal,error]",
    );
    expect(json.sentry.window_days).toBe(0);
  });
});

describe("scripts/release/sentry-telemetry-gate: sentry-project parsing", () => {
  it("rejects a project string that is not org/project", async () => {
    const { errors } = await runSentryGate({
      argv: [
        "--json",
        "--sentry-project",
        "too/many/parts",
        "--telemetry-mode",
        "off",
      ],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([]),
    });
    expect(errors.join("\n")).toContain(
      'Invalid --sentry-project value "too/many/parts"',
    );
  });
});

describe("scripts/release/sentry-telemetry-gate: telemetry modes", () => {
  it("required mode fails when no telemetry command is configured", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "required"],
      existsSync: false,
    });
    expect(json.ok).toBe(false);
    expect(json.telemetry.mode).toBe("required");
    expect(String(json.telemetry.warning ?? "")).toContain(
      "telemetry_query_command_missing",
    );
    expect(process.exitCode).toBe(1);
  });

  it("off mode skips telemetry entirely and passes when sentry is clean", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([]),
    });
    expect(json.telemetry.checked).toBe(false);
    expect(json.ok).toBe(true);
  });

  it("best-effort mode with no token skips sentry access requirement and passes", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "best-effort"],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "bash" && args[0]?.includes("query-telemetry.sh")) {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.checked).toBe(false);
    expect(json.sentry.access_ok).toBe(true);
    expect(json.telemetry.checked).toBe(true);
    expect(json.telemetry.ok).toBe(true);
    expect(json.ok).toBe(true);
  });

  it("best-effort telemetry threshold failure with token-based sentry tally", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "scripts/prod/telemetry/query-telemetry.sh",
        "--max-critical",
        "0",
        "--max-high",
        "0",
      ],
      existsSync: true,
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      runCommand: (command, args) => {
        if (command === "bash" && args[0]?.includes("query-telemetry.sh")) {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-1",
          level: "fatal",
          logger: "node",
          metadata: { value: "fatal crash", type: "Error" },
        },
        {
          shortId: "PM-2",
          level: "error",
          logger: "node",
          metadata: { value: "error crash", type: "Error" },
        },
        {
          shortId: "PM-3",
          level: "error",
          logger: "console",
          title: "[starter-extension] activating",
          metadata: { value: "all 8 capabilities registered.", type: "Error" },
        },
        {
          shortId: "PM-4",
          level: "error",
          logger: "node",
          isUnhandled: false,
          tags: [
            {
              key: "pm.error_code",
              value: "invalid_workspace_snapshot_target",
            },
            { key: "pm.exit_code", value: "2" },
          ],
          metadata: { value: "rewritten usage failure", type: "CommandError" },
        },
        {
          shortId: "PM-5",
          level: "error",
          logger: "node",
          isUnhandled: false,
          tags: [
            { key: "pm.error_code", value: "item_not_found" },
            { key: "pm.exit_code", value: "3" },
          ],
          title: "CommandError: rewritten missing resource",
          metadata: {
            value: "rewritten missing resource",
            type: "CommandError",
          },
        },
        {
          shortId: "PM-6",
          level: "error",
          logger: "node",
          isUnhandled: false,
          tags: [
            { key: "pm.error_code", value: "ownership_conflict" },
            { key: "pm.exit_code", value: "4" },
          ],
          title: "CommandError: rewritten conflict",
          metadata: { value: "rewritten conflict", type: "CommandError" },
        },
      ]),
    });
    expect(json.ok).toBe(false);
    expect(json.sentry.critical).toBe(1);
    expect(json.sentry.high).toBe(2);
    expect(json.sentry.ignored_noise_total).toBe(0);
    expect(json.sentry.ignored_expected_handled_total).toBe(3);
    expect(json.telemetry.checked).toBe(true);
    expect(json.telemetry.ok).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("passes with a clean sentry tally and prints the text success line", async () => {
    const { logs } = await runSentryGate({
      argv: ["--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-9",
          level: "warning",
          logger: "node",
          priority: "low",
          metadata: { value: "noise" },
        },
      ]),
    });
    expect(logs.join("\n")).toContain("Sentry/telemetry gate passed");
  });

  it("reports pre-contract producer events without letting them block the current gate", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-LEGACY",
          level: "error",
          release: "@unbrained/pm-cli@2026.8.6",
          title: "legacy producer without canonical tags",
        },
      ]),
    });
    expect(json.ok).toBe(true);
    expect(json.thresholds.sentry.minimum_contract_producer_version).toBe(
      "2026.8.7",
    );
    expect(json.sentry.legacy_pre_contract_total).toBe(1);
    expect(json.sentry.legacy_pre_contract_short_ids).toEqual(["PM-LEGACY"]);
    expect(json.sentry.blocking_short_ids).toEqual([]);
  });

  it("continues across malformed producer candidates before accepting a tagged legacy version", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-LEGACY-TAG",
          level: "error",
          release: "not-a-version",
          lastRelease: { version: "v2026.8.6+build.1" },
          title: "legacy tagged producer",
        },
      ]),
    });
    expect(json.ok).toBe(true);
    expect(json.sentry.legacy_pre_contract_short_ids).toEqual([
      "PM-LEGACY-TAG",
    ]);
  });

  it("classifies handled failures from the SDK error and exit contract independently of message prose", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "2"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-CONTRACT-REWORDED",
          level: "error",
          isUnhandled: false,
          title:
            "This wording is intentionally unrelated to the historical waiver",
          tags: [
            {
              key: "pm.error_code",
              value: "invalid_workspace_snapshot_target",
            },
            { key: "pm.exit_code", value: "2" },
          ],
          metadata: {
            value: "Completely reworded handled validation failure",
            type: "CommandError",
          },
        },
        {
          shortId: "PM-PROSE-ONLY",
          level: "error",
          isUnhandled: false,
          title: "CommandError: tracker_not_initialized",
          metadata: { value: "tracker_not_initialized", type: "CommandError" },
        },
        {
          shortId: "PM-EXIT-MISMATCH",
          level: "error",
          isUnhandled: false,
          tags: [
            {
              key: "pm.error_code",
              value: "invalid_workspace_snapshot_target",
            },
            { key: "pm.exit_code", value: "1" },
          ],
          metadata: { value: "Snapshot target rejected", type: "CommandError" },
        },
      ]),
    });
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-CONTRACT-REWORDED",
    ]);
    expect(json.sentry.blocking_short_ids).toEqual([
      "PM-PROSE-ONLY",
      "PM-EXIT-MISMATCH",
    ]);
  });

  it("reads object and extra contract fields while unknown codes remain blocking", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "1"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-OBJECT-TAGS",
          level: "error",
          tags: {
            handled: "yes",
            "pm.error_code": "item_not_found",
            "pm.exit_code": 3,
          },
        },
        {
          shortId: "PM-EXTRA-CONTRACT",
          level: "error",
          extra: { error_code: "ownership_conflict", exit_code: 4 },
        },
        {
          shortId: "PM-OBJECT-NONSCALAR",
          level: "error",
          tags: { handled: true },
          error_code: "item_not_found",
          exit_code: 3,
        },
        {
          shortId: "PM-UNKNOWN-CODE",
          level: "error",
          error_code: "not_in_the_catalog",
          exit_code: 2,
        },
      ]),
    });
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-OBJECT-TAGS",
      "PM-EXTRA-CONTRACT",
      "PM-OBJECT-NONSCALAR",
    ]);
    expect(json.sentry.blocking_short_ids).toEqual(["PM-UNKNOWN-CODE"]);
  });

  it("enriches issue-list rows from the latest event before applying the SDK contract", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const payload = url.pathname.includes(
        "/organizations/unbrained/issues/123/events/latest/",
      )
        ? {
            tags: [
              { key: "handled", value: "yes" },
              { key: "pm.error_code", value: "item_not_found" },
              { key: "pm.exit_code", value: "3" },
            ],
          }
        : [
            {
              id: "123",
              shortId: "PM-EVENT-CONTRACT",
              level: "error",
              isUnhandled: false,
              title: "Resource wording can change freely",
            },
          ];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      };
    });
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-EVENT-CONTRACT",
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fails safe when token-based latest-event enrichment is unavailable or malformed", async () => {
    const issues = ["http", "empty", "scalar", "malformed", "fallback"].map(
      (id) => ({
        id,
        shortId: `PM-EVENT-${id.toUpperCase()}`,
        level: "error",
        isUnhandled: false,
      }),
    );
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issues/")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(issues),
        };
      }
      if (url.pathname.includes("/http/")) {
        return { ok: false, status: 503, text: async () => "" };
      }
      if (url.pathname.includes("/empty/")) {
        return { ok: true, status: 200, text: async () => " " };
      }
      if (url.pathname.includes("/scalar/")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify("invalid"),
        };
      }
      if (url.pathname.includes("/malformed/")) {
        return { ok: true, status: 200, text: async () => "not-json" };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            extra: { error_code: "item_not_found", exit_code: 3 },
          }),
      };
    });
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "4"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(json.sentry.blocking_short_ids).toEqual([
      "PM-EVENT-HTTP",
      "PM-EVENT-EMPTY",
      "PM-EVENT-SCALAR",
      "PM-EVENT-MALFORMED",
    ]);
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-EVENT-FALLBACK",
    ]);
  });

  it("keeps handled and unhandled unclassified ENOSPC capacity failures release-blocking", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "2"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-ENOSPC-HANDLED",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title: "Error: ENOSPC: no space left on device, write",
          metadata: {
            value: "ENOSPC: no space left on device, write",
            type: "Error",
          },
        },
        {
          shortId: "PM-ENOSPC-UNHANDLED",
          level: "error",
          logger: "node",
          isUnhandled: true,
          title: "Error: ENOSPC: no space left on device, write",
          metadata: {
            value: "ENOSPC: no space left on device, write",
            type: "Error",
          },
        },
      ]),
    });
    expect(json.sentry.high).toBe(2);
    expect(json.sentry.blocking_short_ids).toEqual([
      "PM-ENOSPC-HANDLED",
      "PM-ENOSPC-UNHANDLED",
    ]);
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([]);
    expect(json.sentry.threshold_ok).toBe(true);
  });

  it("keeps generic-failure gitignore errors blocking even when handled", async () => {
    const message = "The workspace .gitignore is not writable.";
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "3"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-GITIGNORE-HANDLED",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title: `PmCliError: ${message}`,
          tags: [
            { key: "pm.error_code", value: "init_gitignore_unwritable" },
            { key: "pm.exit_code", value: "1" },
          ],
          metadata: { value: message, type: "PmCliError" },
        },
        {
          shortId: "PM-GITIGNORE-RAW",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title: "Error: EACCES: permission denied, open",
          metadata: { value: "EACCES: permission denied, open", type: "Error" },
        },
        {
          shortId: "PM-GITIGNORE-UNHANDLED",
          level: "error",
          logger: "node",
          isUnhandled: true,
          title: `PmCliError: ${message}`,
          metadata: { value: message, type: "PmCliError" },
        },
      ]),
    });
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([]);
    expect(json.sentry.blocking_short_ids).toEqual([
      "PM-GITIGNORE-HANDLED",
      "PM-GITIGNORE-RAW",
      "PM-GITIGNORE-UNHANDLED",
    ]);
    expect(json.sentry.threshold_ok).toBe(true);
  });

  it("keeps torn-bundle and genuine module failures blocking because both are generic failures", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "3"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-TORN-HANDLED",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title: "Error: bundle_integrity_torn_install",
          tags: [
            { key: "pm.error_code", value: "bundle_integrity_torn_install" },
            { key: "pm.exit_code", value: "1" },
          ],
          metadata: {
            value: "bundle_integrity_torn_install: partial upgrade detected",
            type: "Error",
          },
        },
        {
          shortId: "PM-MODULE-MISSING",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './chunk.js'",
          metadata: { value: "Cannot find module './chunk.js'", type: "Error" },
        },
        {
          shortId: "PM-TORN-UNHANDLED",
          level: "error",
          logger: "node",
          isUnhandled: true,
          title: "Error: bundle_integrity_torn_install",
          metadata: { value: "bundle_integrity_torn_install", type: "Error" },
        },
      ]),
    });
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([]);
    expect(json.sentry.blocking_short_ids).toEqual([
      "PM-TORN-HANDLED",
      "PM-MODULE-MISSING",
      "PM-TORN-UNHANDLED",
    ]);
    expect(json.sentry.threshold_ok).toBe(true);
  });

  it("requires a declared conflict code before ignoring handled refusal prose", async () => {
    const duplicateImportMessage =
      'merge-strategy "fail": bead "bd-1" is already imported as pm-buex; aborting before any writes.';
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "1"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-DUPLICATE-HANDLED",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title: `CommandError: ${duplicateImportMessage}`,
          tags: [
            { key: "pm.error_code", value: "ownership_conflict" },
            { key: "pm.exit_code", value: "4" },
          ],
          metadata: { value: duplicateImportMessage, type: "CommandError" },
        },
        {
          shortId: "PM-DUPLICATE-UNHANDLED",
          level: "error",
          logger: "node",
          isUnhandled: true,
          title: `CommandError: ${duplicateImportMessage}`,
          tags: [
            { key: "pm.error_code", value: "ownership_conflict" },
            { key: "pm.exit_code", value: "4" },
          ],
          metadata: { value: duplicateImportMessage, type: "CommandError" },
        },
      ]),
    });
    expect(json.sentry.high).toBe(1);
    expect(json.sentry.blocking_short_ids).toEqual(["PM-DUPLICATE-UNHANDLED"]);
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-DUPLICATE-HANDLED",
    ]);
    expect(json.sentry.threshold_ok).toBe(true);
  });

  it("ignores handled snapshot identifier validation without hiding unhandled or unrelated errors", async () => {
    const validationMessage =
      "Snapshot names and fingerprints must use lowercase letters, digits, dots, underscores, or hyphens";
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "2"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-SNAPSHOT-HANDLED",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title: `CommandError: ${validationMessage}`,
          tags: [
            {
              key: "pm.error_code",
              value: "invalid_workspace_snapshot_target",
            },
            { key: "pm.exit_code", value: "2" },
          ],
          metadata: { value: validationMessage, type: "CommandError" },
        },
        {
          shortId: "PM-SNAPSHOT-HANDLED-ERROR",
          level: "error",
          logger: "node",
          title: `Error: ${validationMessage}`,
          tags: [
            {
              key: "pm.error_code",
              value: "invalid_workspace_snapshot_target",
            },
            { key: "pm.exit_code", value: "2" },
          ],
          metadata: { value: validationMessage, type: "Error" },
        },
        {
          shortId: "PM-SNAPSHOT-UNHANDLED",
          level: "error",
          logger: "node",
          isUnhandled: true,
          title: `Error: ${validationMessage}`,
          tags: [
            {
              key: "pm.error_code",
              value: "invalid_workspace_snapshot_target",
            },
            { key: "pm.exit_code", value: "2" },
          ],
          metadata: { value: validationMessage, type: "Error" },
        },
        {
          shortId: "PM-UNRELATED-HANDLED",
          level: "error",
          logger: "node",
          isUnhandled: false,
          title: "Error: unrelated runtime failure",
          metadata: { value: "unrelated runtime failure", type: "Error" },
        },
      ]),
    });
    expect(json.sentry.high).toBe(2);
    expect(json.sentry.blocking_short_ids).toEqual([
      "PM-SNAPSHOT-UNHANDLED",
      "PM-UNRELATED-HANDLED",
    ]);
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-SNAPSHOT-HANDLED",
      "PM-SNAPSHOT-HANDLED-ERROR",
    ]);
    expect(json.sentry.threshold_ok).toBe(true);
  });

  it("handles malformed issue entries while still tallying high-priority items", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off", "--max-high", "1"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        "raw issue payload",
        { shortId: "PM-11", priority: "high" },
      ]),
    });
    expect(json.sentry.total).toBe(2);
    expect(json.sentry.high).toBe(1);
    expect(json.sentry.threshold_ok).toBe(true);
  });

  it("prints the text failure line when thresholds are exceeded without --json", async () => {
    const { errors } = await runSentryGate({
      argv: ["--telemetry-mode", "off", "--max-high", "0"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: buildSentryFetch([
        {
          shortId: "PM-10",
          level: "error",
          logger: "node",
          metadata: { value: "boom", type: "Error" },
          isUnhandled: true,
        },
      ]),
    });
    expect(errors.join("\n")).toContain("Sentry/telemetry gate failed");
    expect(process.exitCode).toBe(1);
  });
});

describe("scripts/release/sentry-telemetry-gate: telemetry metric parsing", () => {
  it("flags telemetry as not-ok when the overall section is missing", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) => {
        if (command === "bash") {
          return { status: 0, stdout: "### unrelated\nfoo,bar\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.telemetry.checked).toBe(true);
    expect(json.telemetry.warning).toBe(
      "missing_overall_finish_error_rate_section",
    );
  });

  it("treats a present-but-headerless overall section as missing", async () => {
    const csv = [
      "### overall finish error rate",
      "no-comma-line-here",
      "another-line",
    ].join("\n");
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 0, stdout: csv, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.warning).toBe(
      "missing_overall_finish_error_rate_section",
    );
  });

  it("skips non-comma and wrong-column rows when counting missing-coverage rows", async () => {
    const csv = [
      "### overall finish error rate",
      "finish_error_rate_pct,sample_size",
      "1,50",
      "(1 rows)",
      "",
      "### missing error code coverage",
      "error_code,count",
      "no-comma-row",
      "too,many,columns",
      "valid,7",
      "(1 rows)",
    ].join("\n");
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
        "--max-telemetry-missing-error-rows",
        "5",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 0, stdout: csv, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    // Only the single well-formed "valid,7" row is counted.
    expect(json.telemetry.failures_without_error_code_rows).toBe(1);
  });

  it("flags telemetry as not-ok when the finish error rate is non-numeric", async () => {
    const csv = [
      "### overall finish error rate",
      "finish_error_rate_pct,sample_size",
      "not-a-number,50",
      "(1 rows)",
    ].join("\n");
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 0, stdout: csv, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.warning).toBe("invalid_finish_error_rate_value");
  });

  it("flags telemetry as not-ok when finish_error_rate_pct is missing", async () => {
    const csv = [
      "### overall finish error rate",
      "different_metric,sample_size",
      "1,50",
      "(1 rows)",
    ].join("\n");
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 0, stdout: csv, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.warning).toBe("invalid_finish_error_rate_value");
  });

  it("defaults missing-error-code rows to zero when that section is absent", async () => {
    const csv = [
      "### overall finish error rate",
      "finish_error_rate_pct,sample_size",
      "1,50",
      "(1 rows)",
    ].join("\n");
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 0, stdout: csv, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.failures_without_error_code_rows).toBe(0);
    expect(json.telemetry.ok).toBe(true);
  });

  it("uses an explicit non-.sh telemetry command and counts missing-coverage rows", async () => {
    const csv = [
      "### overall finish error rate",
      "finish_error_rate_pct,sample_size",
      "2,40",
      "(1 rows)",
      "",
      "### missing error code coverage",
      "error_code,count",
      "abc,3",
      "def,4",
      "(2 rows)",
    ].join("\n");
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "/usr/bin/telemetry-adapter",
        "--max-telemetry-missing-error-rows",
        "0",
      ],
      runCommand: (command) =>
        command === "/usr/bin/telemetry-adapter"
          ? { status: 0, stdout: csv, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.failures_without_error_code_rows).toBe(2);
    expect(json.telemetry.ok).toBe(false);
  });

  it("best-effort telemetry stays ok when the query command fails", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 1, stdout: "", stderr: "  query exploded  " }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.checked).toBe(true);
    expect(json.telemetry.ok).toBe(true);
    expect(json.telemetry.warning).toBe("query exploded");
  });

  it("best-effort telemetry falls back to a default warning when the command fails silently", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 1, stdout: "", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.warning).toBe("telemetry_query_failed");
  });

  it("best-effort telemetry handles missing stderr on failed query commands", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command) =>
        command === "bash"
          ? { status: 1, stdout: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.warning).toBe("telemetry_query_failed");
  });

  it("auto-discovers the telemetry command from the default path when present", async () => {
    const { json, runCommand } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "best-effort"],
      existsSync: true,
      runCommand: (command, args) =>
        command === "bash" &&
        args[0] === "scripts/prod/telemetry/query-telemetry.sh"
          ? { status: 0, stdout: TELEMETRY_CSV, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(json.telemetry.checked).toBe(true);
    expect(runCommand.mock.calls.some((c) => c[0] === "bash")).toBe(true);
  });

  it("reads the telemetry command from PM_TELEMETRY_QUERY_COMMAND", async () => {
    const { runCommand } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "best-effort"],
      existsSync: false,
      env: { PM_TELEMETRY_QUERY_COMMAND: "scripts/prod/telemetry/custom.sh" },
      runCommand: (command, args) =>
        command === "bash" && args[0] === "scripts/prod/telemetry/custom.sh"
          ? { status: 0, stdout: TELEMETRY_CSV, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(
      runCommand.mock.calls.some(
        (c) =>
          c[0] === "bash" &&
          (c[1] as string[])[0] === "scripts/prod/telemetry/custom.sh",
      ),
    ).toBe(true);
  });

  it("best-effort telemetry with no command produces the missing-command warning (status 127)", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "best-effort"],
      existsSync: false,
    });
    expect(json.telemetry.checked).toBe(true);
    expect(String(json.telemetry.warning ?? "")).toContain(
      "telemetry_query_command_missing",
    );
  });
});

describe("scripts/release/sentry-telemetry-gate: sentry fetch fallbacks", () => {
  it("enriches sentry CLI issue rows from their latest event contracts", async () => {
    const { json, runCommand } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue" && args[1] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                shortId: "PM-CLI-EVENT",
                level: "error",
                isUnhandled: false,
                title: "Reworded missing item",
              },
            ]),
            stderr: "",
          };
        }
        if (
          command === "sentry" &&
          args[0] === "issue" &&
          args[1] === "events"
        ) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                tags: [
                  { key: "handled", value: "yes" },
                  { key: "pm.error_code", value: "item_not_found" },
                  { key: "pm.exit_code", value: "3" },
                ],
              },
            ]),
            stderr: "",
          };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-CLI-EVENT",
    ]);
    expect(
      runCommand.mock.calls.some(
        ([command, args]) =>
          command === "sentry" && args[0] === "issue" && args[1] === "events",
      ),
    ).toBe(true);
  });

  it("fails safe across skipped, failed, empty, and malformed CLI event enrichment", async () => {
    const { json, runCommand } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
        "--sentry-window-days",
        "0",
        "--max-high",
        "4",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue" && args[1] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                shortId: "PM-CLI-COMPLETE",
                level: "error",
                tags: [
                  { key: "pm.error_code", value: "item_not_found" },
                  { key: "pm.exit_code", value: "3" },
                ],
              },
              { shortId: 7, level: "error", isUnhandled: false },
              { shortId: "PM-CLI-FAILED", level: "error", isUnhandled: false },
              { shortId: "PM-CLI-EMPTY", level: "error", isUnhandled: false },
              {
                shortId: "PM-CLI-MALFORMED",
                level: "error",
                isUnhandled: false,
              },
            ]),
            stderr: "",
          };
        }
        if (
          command === "sentry" &&
          args[0] === "issue" &&
          args[1] === "events"
        ) {
          const shortId = String(args[2] ?? "");
          if (shortId.endsWith("PM-CLI-FAILED")) {
            return { status: 1, stdout: "", stderr: "event unavailable" };
          }
          if (shortId.endsWith("PM-CLI-EMPTY")) {
            return { status: 0, stdout: " ", stderr: "" };
          }
          return { status: 0, stdout: "not-json", stderr: "" };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.ignored_expected_handled_short_ids).toEqual([
      "PM-CLI-COMPLETE",
    ]);
    expect(json.sentry.high).toBe(4);
    expect(
      runCommand.mock.calls.some(
        ([command, args]) => command === "sentry" && args.includes("90d"),
      ),
    ).toBe(true);
  });

  it("required mode falls back to the sentry CLI when no token is present", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                shortId: "PM-50",
                level: "info",
                logger: "node",
                metadata: { value: "ok" },
              },
            ]),
            stderr: "",
          };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.token_source).toBe("sentry_cli");
    expect(json.sentry.checked).toBe(true);
  });

  it("sentry CLI fallback surfaces a query failure reason", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return { status: 2, stdout: "", stderr: "cli auth failed" };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.checked).toBe(false);
    expect(String(json.sentry.warning ?? "")).toContain(
      "sentry_cli_query_failed:cli auth failed",
    );
    expect(json.sentry.access_ok).toBe(false);
  });

  it("sentry CLI fallback uses the prior failure reason when stderr is empty", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return { status: 2, stdout: "", stderr: "" };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.warning).toBe("missing_sentry_auth_token");
  });

  it("sentry CLI fallback surfaces a JSON parse failure", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return { status: 0, stdout: "not-json{", stderr: "" };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(String(json.sentry.warning ?? "")).toContain(
      "sentry_cli_json_parse_failed",
    );
  });

  it("sentry CLI fallback stringifies non-Error JSON parse failures", async () => {
    const realParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation(((
      ...parseArgs: Parameters<typeof JSON.parse>
    ) => {
      const [payload] = parseArgs;
      if (typeof payload === "string" && payload.includes('"PM-98"')) {
        throw "raw cli parse failure";
      }
      return realParse(...parseArgs);
    }) as typeof JSON.parse);
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return {
            status: 0,
            stdout: JSON.stringify([{ shortId: "PM-98", level: "info" }]),
            stderr: "",
          };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(String(json.sentry.warning ?? "")).toContain(
      "sentry_cli_json_parse_failed:raw cli parse failure",
    );
  });

  it("sentry CLI fallback treats empty stdout as an empty issue list", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return { status: 0, stdout: "   ", stderr: "" };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.checked).toBe(true);
    expect(json.sentry.total).toBe(0);
  });

  it("best-effort mode without a token does not fall back to the CLI", async () => {
    const { json, runCommand } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
    });
    expect(json.sentry.checked).toBe(false);
    expect(json.sentry.warning).toBe("missing_sentry_auth_token");
    expect(runCommand.mock.calls.some((c) => c[0] === "sentry")).toBe(false);
  });

  it("token fetch returns a non-ok HTTP status and reports sentry_api_<status>", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "",
      })) as unknown as typeof fetch,
    });
    expect(String(json.sentry.warning ?? "")).toContain("sentry_api_503");
    expect(json.sentry.access_ok).toBe(false);
  });

  it("token fetch that throws reports sentry_query_error", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => {
        throw new Error("network boom");
      }) as unknown as typeof fetch,
    });
    expect(String(json.sentry.warning ?? "")).toContain(
      "sentry_query_error:network boom",
    );
  });

  it("token fetch stringifies non-Error failures", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => {
        throw "raw fetch boom";
      }) as unknown as typeof fetch,
    });
    expect(String(json.sentry.warning ?? "")).toContain(
      "sentry_query_error:raw fetch boom",
    );
  });

  it("token fetch parses an empty body as an empty issue list", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "   ",
      })) as unknown as typeof fetch,
    });
    expect(json.sentry.total).toBe(0);
    expect(json.sentry.checked).toBe(true);
  });

  it("token fetch parses a wrapped {data:[...]} payload", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ data: [{ shortId: "PM-77", level: "warning" }] }),
      })) as unknown as typeof fetch,
    });
    expect(json.sentry.total).toBe(1);
  });

  it("handles parser-overridden function-shaped issue entries", async () => {
    const realParse = JSON.parse;
    const functionIssue = Object.assign(function syntheticIssue() {}, {
      logger: "console",
      title: "non-pattern console issue",
    });
    vi.spyOn(JSON, "parse").mockImplementation(((
      ...parseArgs: Parameters<typeof JSON.parse>
    ) => {
      const [payload] = parseArgs;
      if (payload === "FUNCTION_ISSUE_PAYLOAD") {
        return [functionIssue];
      }
      return realParse(...parseArgs);
    }) as typeof JSON.parse);
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "FUNCTION_ISSUE_PAYLOAD",
      })) as unknown as typeof fetch,
    });
    expect(json.sentry.checked).toBe(true);
    expect(json.sentry.total).toBe(1);
  });

  it("treats a token-fetch payload that is neither an array nor {data} as an empty issue list", async () => {
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ unexpected: "shape" }),
      })) as unknown as typeof fetch,
    });
    expect(json.sentry.total).toBe(0);
    expect(json.sentry.checked).toBe(true);
  });

  it("required mode with a token falls back to the sentry CLI after every token fetch fails", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "required",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      env: { SENTRY_AUTH_TOKEN: "token-test" },
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "",
      })) as unknown as typeof fetch,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                shortId: "PM-90",
                level: "info",
                logger: "node",
                metadata: { value: "ok" },
              },
            ]),
            stderr: "",
          };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.token_source).toBe("sentry_cli");
    expect(json.sentry.checked).toBe(true);
  });

  it("best-effort mode falls back to the sentry CLI when a configured token is rejected", async () => {
    const { json } = await runSentryGate({
      argv: [
        "--json",
        "--telemetry-mode",
        "best-effort",
        "--telemetry-command",
        "telemetry.sh",
      ],
      existsSync: true,
      env: { SENTRY_AUTH_TOKEN: "stale-token" },
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => "",
      })) as unknown as typeof fetch,
      runCommand: (command, args) => {
        if (command === "sentry" && args[0] === "issue") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                shortId: "PM-91",
                level: "info",
                logger: "node",
                metadata: { value: "ok" },
              },
            ]),
            stderr: "",
          };
        }
        if (command === "bash") {
          return { status: 0, stdout: TELEMETRY_CSV, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.sentry.token_source).toBe("sentry_cli");
    expect(json.sentry.checked).toBe(true);
    expect(json.sentry.access_ok).toBe(true);
    expect(json.ok).toBe(true);
  });

  it("honors a custom SENTRY_URL when building the issues URL and dedupes tokens", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "[]",
    }));
    const { json } = await runSentryGate({
      argv: ["--json", "--telemetry-mode", "off"],
      env: {
        SENTRY_URL: "https://sentry.example.test",
        SENTRY_AUTH_TOKEN: "dup-token",
        SENTRY_PERSONAL_ADMIN_TOKEN: "dup-token",
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(json.sentry.checked).toBe(true);
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("https://sentry.example.test");
    // duplicate token values collapse to a single fetch attempt
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
