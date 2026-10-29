import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runDirectDistCli } from "../../helpers/cliRunner.js";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

it.skipIf(process.platform !== "linux").each([["acquired", process.execPath], ["fenced", process.execPath], ["fenced", "bun"]])(
  "recovers a killed SDK owner at %s with %s before TTL through health, GC and ordinary CLI writes",
  async (phase, runtime) => {
    await withTempPmPath(async ({ pmPath, tempRoot, env, runCli }) => {
      const id = "pm-crash-owner";
      const created = runCli(
        [
          "create",
          "--id",
          id,
          "--title",
          "Crash recovery",
          "--type",
          "Task",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const sdkUrl = pathToFileURL(path.resolve("dist/cli-bundle/sdk.js")).href;
      const holder = spawn(
        runtime!,
        [
          "--input-type=module",
          "-e",
          `
      import { acquireLockLease } from ${JSON.stringify(sdkUrl)};
      const lease = await acquireLockLease(process.argv[1], process.argv[2], 3600, "crash-holder");
      const hold = async () => {
        process.send("held");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      };
      if (${JSON.stringify(phase)} === "fenced") await lease.fence(hold);
      else await hold();
    `,
          pmPath,
          id,
        ],
        {
          cwd: tempRoot,
          env,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          timeout: 20_000,
        },
      );
      const exited = once(holder, "exit");
      try {
        await Promise.race([
          once(holder, "message"),
          exited.then(() => {
            throw new Error("Holder exited before acquisition");
          }),
        ]);
        holder.kill("SIGKILL");
        await exited;
        const receipt = await fs.readFile(
          path.join(pmPath, "locks", `${id}.lock`),
          "utf8",
        );
        const health = runCli(["health", "--check-only", "--full", "--json"], {
          expectJson: true,
        });
        const locks = (
          health.json as {
            checks: Array<{ name: string; details: Record<string, unknown> }>;
          }
        ).checks.find((check) => check.name === "locks");
        expect(locks?.details).toMatchObject({
          stale_lock_count: 1,
          active_lock_count: 0,
        });
        const sdkHealth = await runHealth(
          { path: pmPath, json: true },
          { checkOnly: true, full: true },
        );
        expect(
          sdkHealth.checks.find((check) => check.name === "locks")?.details,
        ).toMatchObject({
          stale_lock_count: 1,
          owner_dead_lock_samples: [
            {
              id,
              owner: "crash-holder",
              pid: holder.pid,
              reason: "owner_dead",
            },
          ],
          recovery_command: "pm gc --scope locks",
        });
        const preview = runCli(
          ["gc", "--scope", "locks", "--dry-run", "--json"],
          { expectJson: true },
        );
        expect(preview.code).toBe(0);
        expect(preview.json).toMatchObject({ removed: [`locks/${id}.lock`] });
        expect(
          await fs.readFile(path.join(pmPath, "locks", `${id}.lock`), "utf8"),
        ).toBe(receipt);
        const updated = runCli(
          ["comments", id, "--add", "Acknowledged after crash", "--json"],
          { expectJson: true },
        );
        expect(updated.code, updated.stderr).toBe(0);
        const audits = await fs.readdir(
          path.join(pmPath, "locks", "recoveries"),
        );
        const gateAudits = audits.filter((entry) => entry.startsWith("gate-"));
        expect(gateAudits).toHaveLength(phase === "fenced" ? 1 : 0);
        const lockAudits = audits.filter((entry) => entry.endsWith(".json"));
        expect(lockAudits).toHaveLength(1);
        const audit = JSON.parse(
          await fs.readFile(
            path.join(pmPath, "locks", "recoveries", lockAudits[0]!),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(audit).toMatchObject({
          event: "owner_dead_recovery_attempt",
          lock: { id, owner: "crash-holder" },
        });
        const item = runCli(["get", id, "--full", "--json"], {
          expectJson: true,
        });
        expect(item.stdout).toContain("Acknowledged after crash");
        const history = runCli(
          ["history", id, "--verify", "--strict-exit", "--json"],
          { expectJson: true },
        );
        expect(history.code, history.stderr).toBe(0);
      } finally {
        if (holder.exitCode === null && holder.signalCode === null)
          holder.kill("SIGKILL");
        await exited;
      }
    });
  },
  30_000,
);

it("preserves a live owner's lock and suggests the exact contending command without force", async () => {
  await withTempPmPath(async ({ pmPath, tempRoot, env, runCli }) => {
    const id = "pm-live-owner";
    const created = runCli(
      [
        "create",
        "--id",
        id,
        "--title",
        "Live recovery",
        "--type",
        "Task",
        "--json",
      ],
      { expectJson: true },
    );
    expect(created.code, created.stderr).toBe(0);
    const { acquireLock } = await import("../../../src/core/lock/lock.js");
    const release = await acquireLock(pmPath, id, 3600, "live-holder");
    const lockPath = path.join(pmPath, "locks", `${id}.lock`);
    const before = await fs.readFile(lockPath, "utf8");
    try {
      const payload = "  Keep $HOME and `literal` exactly  ";
      const refused = runDirectDistCli(
        ["comments", id, "--add", payload, "--json"],
        { cwd: tempRoot, env: { ...env, PM_LOCK_WAIT_MS: "0" } },
      );
      expect(refused.code).toBe(4);
      const error = JSON.parse(refused.stderr) as {
        required: string;
        detail: string;
        examples: string[];
        recovery: { suggested_retry_args: string[] };
      };
      expect(error.required).toContain("PM_LOCK_WAIT_MS");
      expect(error.detail).toMatch(/owner process (alive|unknown)/u);
      expect(error.examples.join(" ")).not.toMatch(/--force|pm-a1b2/);
      expect(error.recovery.suggested_retry_args).toEqual([
        "item",
        "comments",
        id,
        "--add",
        payload,
        "--json",
      ]);
      expect(await fs.readFile(lockPath, "utf8")).toBe(before);
    } finally {
      await release();
    }
  });
}, 15_000);
