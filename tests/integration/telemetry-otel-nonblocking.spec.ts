import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * GH-209 process-level regression: the OTLP trace POST must NOT keep the
 * foreground CLI process alive when the traces endpoint is unreachable. Before
 * the fix, an inline fire-and-forget `fetch` to the traces endpoint left a
 * connecting socket draining its 5s timeout, so the process stayed alive ~10s.
 * The fix defers OTLP export to a detached, unref'd flush worker via a bounded
 * pending-spans queue, so both reads and mutations return ~immediately.
 *
 * This test spawns the real `node dist/cli.js` with telemetry enabled and an
 * OTLP traces endpoint pointed at a non-routable blackhole address, then asserts
 * a read (`get`) and a mutation (`update`) each exit 0 well under the 2s budget
 * the bug used to blow through. run-tests.mjs builds dist before running, so
 * dist/cli.js is current.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const distCli = path.join(repoRoot, "dist", "cli.js");
// RFC 5737 TEST-NET-1 documentation address: not routed, so connections hang
// then time out rather than refusing immediately, which is the worst case the
// GH-209 fix addresses. The foreground command never touches this endpoint after
// the fix (the detached worker owns OTLP export), so the measured timing is
// independent of the address's connect behaviour.
const BLACKHOLE_TRACES_ENDPOINT = "http://192.0.2.1:4318/v1/traces";
const FAST_EXIT_BUDGET_MS = 3000;

interface SandboxContext {
  tempRoot: string;
  pmPath: string;
  globalPath: string;
  itemId: string;
}

function runCli(
  context: SandboxContext,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { code: number | null; stdout: string; stderr: string; durationMs: number } {
  // The spawned CLI must behave like a real user invocation, NOT a Vitest child.
  // shouldFlushInline() forces the OTLP POST inline whenever VITEST / NODE_ENV=test
  // / the inline-flush env vars are present, which is exactly the foreground-blocking
  // path GH-209 fixed. Strip them so the detached flush worker owns the OTLP export.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PM_PATH: context.pmPath,
    PM_GLOBAL_PATH: context.globalPath,
    ...extraEnv,
  };
  delete childEnv.VITEST;
  delete childEnv.VITEST_WORKER_ID;
  delete childEnv.NODE_ENV;
  delete childEnv.PM_TELEMETRY_INLINE_FLUSH;
  delete childEnv.PM_TELEMETRY_FLUSH_CHILD;
  const startedAt = Date.now();
  const completed = spawnSync(process.execPath, [distCli, ...args], {
    cwd: context.tempRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: childEnv,
  });
  return {
    code: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
    durationMs: Date.now() - startedAt,
  };
}

describe("telemetry OTLP export is non-blocking at the process level (GH-209)", () => {
  let context: SandboxContext;

  beforeAll(async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-cli-otel-nonblocking-"),
    );
    const pmPath = path.join(tempRoot, "proj", ".agents", "pm");
    const globalPath = path.join(tempRoot, "global");
    const bootstrap: SandboxContext = {
      tempRoot,
      pmPath,
      globalPath,
      itemId: "",
    };

    const init = runCli(bootstrap, ["init", "--json"]);
    expect(init.code, `init failed: ${init.stderr}`).toBe(0);

    const enable = runCli(bootstrap, [
      "config",
      "set",
      "telemetry-tracking",
      "on",
    ]);
    expect(enable.code, `config set failed: ${enable.stderr}`).toBe(0);

    const create = runCli(bootstrap, [
      "create",
      "task",
      "otel non-blocking regression item",
      "--json",
    ]);
    expect(create.code, `create failed: ${create.stderr}`).toBe(0);
    const created = JSON.parse(create.stdout) as { id?: string };
    const itemId = created.id;
    expect(typeof itemId, "expected created item id").toBe("string");

    context = { tempRoot, pmPath, globalPath, itemId: itemId as string };
  }, 60_000);

  afterAll(async () => {
    if (context) {
      const cleanupAttempts = 8;
      for (let attempt = 0; attempt < cleanupAttempts; attempt += 1) {
        try {
          await rm(context.tempRoot, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt === cleanupAttempts - 1) {
            throw new Error(
              `Failed to clean telemetry OTLP temp root after ${cleanupAttempts} attempts`,
              {
                cause: error,
              },
            );
          }
          await delay(100 * (attempt + 1));
        }
      }
    }
  });

  it("returns from a read (get) quickly even when the OTLP traces endpoint is a blackhole", () => {
    const result = runCli(context, ["get", context.itemId, "--json"], {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: BLACKHOLE_TRACES_ENDPOINT,
    });
    expect(result.code, `get stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(
      result.durationMs,
      `get took ${result.durationMs}ms (budget ${FAST_EXIT_BUDGET_MS}ms); OTLP export must not block the foreground process`,
    ).toBeLessThan(FAST_EXIT_BUDGET_MS);
  });

  it("returns from a mutation (update) quickly even when the OTLP traces endpoint is a blackhole", () => {
    const result = runCli(
      context,
      ["update", context.itemId, "--priority", "1", "--json"],
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: BLACKHOLE_TRACES_ENDPOINT,
      },
    );
    expect(result.code, `update stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(
      result.durationMs,
      `update took ${result.durationMs}ms (budget ${FAST_EXIT_BUDGET_MS}ms); OTLP export must not block the foreground process`,
    ).toBeLessThan(FAST_EXIT_BUDGET_MS);
  });
});
