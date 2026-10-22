import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPmCliErrorForDisplay, formatPmCliErrorForJson } from "../../../src/cli/error-guidance.js";
import { acquireLockLease } from "../../../src/core/lock/lock.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import type { PmCliError } from "../../../src/core/shared/errors.js";
import { getLockPath } from "../../../src/core/store/paths.js";
import { projectPmDiagnosticOutput } from "../../../src/sdk/cli-contracts/agent-output-contracts.js";
import { withTempDir } from "../../helpers/temp.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function lockConflict(root: string): Promise<PmCliError> {
  vi.stubEnv("PM_LOCK_WAIT_MS", "");
  const holder = await acquireLockLease(root, "shared", 60, "holder", false, false, 0);
  try {
    return (await acquireLockLease(root, "shared", 60, "waiter", false, false, 50).catch((error: unknown) => error)) as PmCliError;
  } finally {
    await holder.release();
  }
}

describe("lock diagnostics in CLI output", () => {
  it("keeps waited_ms and owner_handoffs in JSON, text and compact projections", async () => {
    await withTempDir("pm-lock-diag-conflict-", async (root) => {
      const error = await lockConflict(root);
      expect(error.code).toBe("lock_conflict");

      const json = formatPmCliErrorForJson(error.message, EXIT_CODE.CONFLICT, error.context);
      expect(json.recovery).toMatchObject({ owner_handoffs: 0 });
      expect(json.recovery?.waited_ms).toBeGreaterThanOrEqual(50);

      const text = formatPmCliErrorForDisplay(error.message, error.context);
      expect(text).toMatch(/waited_ms: \d+/u);
      expect(text).toContain("owner_handoffs: 0");

      const compact = projectPmDiagnosticOutput(
        { ...json, why: "y".repeat(4_000), examples: Array.from({ length: 40 }, (_, index) => `pm demo ${index}`) },
        { maxEstimatedTokens: 192 },
      ) as { recovery?: Record<string, unknown> };
      expect(compact.recovery).toMatchObject({ owner_handoffs: 0 });
      expect(compact.recovery?.waited_ms).toEqual(json.recovery?.waited_ms);
    });
  });

  it("keeps lease, current_owner and item_id for a lost lease", async () => {
    await withTempDir("pm-lock-diag-lost-", async (root) => {
      const stale = await acquireLockLease(root, "shared", 1, "stale-writer", false, false, 0);
      await sleep(1_150);
      const newer = await acquireLockLease(root, "shared", 1, "newer-writer", false, false, 0);
      const error = (await stale.fence(async () => "written").catch((caught: unknown) => caught)) as PmCliError;
      await newer.release();

      const json = formatPmCliErrorForJson(error.message, EXIT_CODE.CONFLICT, error.context) as Record<string, unknown>;
      expect(json).toMatchObject({
        code: "lock_lost",
        item_id: "shared",
        lease: { owner: "stale-writer", ttl_seconds: 1 },
        current_owner: { owner: "newer-writer", pid: process.pid },
      });
    });
  });

  it("reports a null current_owner when the lost lease's lock is gone", async () => {
    await withTempDir("pm-lock-diag-released-", async (root) => {
      const lease = await acquireLockLease(root, "shared", 60, "writer", false, false, 0);
      await fs.rm(getLockPath(root, "shared"));
      const error = (await lease.fence(async () => "written").catch((caught: unknown) => caught)) as PmCliError;
      const json = formatPmCliErrorForJson(error.message, EXIT_CODE.CONFLICT, error.context) as Record<string, unknown>;
      expect(json).toMatchObject({ code: "lock_lost", lease: { owner: "writer" }, current_owner: null });
    });
  });
});
