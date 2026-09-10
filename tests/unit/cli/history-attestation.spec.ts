/** @module tests/unit/cli/history-attestation Real registration and operand-boundary contracts. */
import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerHistoryMaintenanceCommands } from "../../../src/cli/register-history-maintenance.js";
import { normalizeBootstrapInvocation } from "../../../src/sdk/cli-bootstrap.js";
import { parseHistoryAttestation } from "../../../src/sdk/history/attestation.js";
import { runHistoryAttest } from "../../../src/sdk/history/attestation-command.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("attestation CLI boundaries", () => {
  it("binds child verification operands while preserving literal option values and terminators", () => {
    expect(normalizeBootstrapInvocation(["history", "attest", "--verify", "proof.json"]).argv).toEqual(["history", "attest", "--verify=proof.json"]);
    const legacy = ["history-attest", "--verify", "proof.json"];
    expect(normalizeBootstrapInvocation(legacy).argv).toEqual(legacy);
    for (const suffix of [[], ["--"]]) {
      expect(() => normalizeBootstrapInvocation(["history", "attest", "--verify", ...suffix])).toThrow("requires a bundle file");
    }
    for (const flag of ["--pm-path", "--output", "--hash-algorithm"]) {
      const argv = ["history", "attest", flag, "--verify", "--verify", "proof.json"];
      expect(normalizeBootstrapInvocation(argv).argv).toEqual(["history", "attest", flag, "--verify", "--verify=proof.json"]);
    }
    const terminated = ["history", "attest", "--", "--verify"];
    expect(normalizeBootstrapInvocation(terminated).argv).toEqual(terminated);
  });

  it("prints a complete proof, honors quiet, returns file receipts, and fails changed verification", async () => {
    await withTempPmPath(async (context) => {
      const output = path.join(context.tempRoot, "proof.json");
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const previousExitCode = process.exitCode;
      try {
        for (const args of [[], ["--quiet"], ["--output", output], ["--verify", output]]) {
          stdout.mockClear();
          const program = new Command().name("pm").option("--json").option("--quiet").option("--pm-path <path>").exitOverride();
          registerHistoryMaintenanceCommands(program.command("history"), true);
          await program.parseAsync(["--pm-path", context.pmPath, "--json", "history", "attest", ...args], { from: "user" });
          const printed = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
          if (args.length === 0) expect(parseHistoryAttestation(JSON.parse(printed)).streams).toEqual([]);
          else if (args[0] === "--quiet") expect(printed).toBe("");
          else if (args[0] === "--output") expect(JSON.parse(printed)).toMatchObject({ output, streams: 0 });
          else expect(JSON.parse(printed)).toMatchObject({ ok: true });
        }
        const original = await readFile(output, "utf8");
        await expect(runHistoryAttest({ output }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("never overwritten") });
        await expect(runHistoryAttest({ verify: `${output}.missing` }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("readable JSON") });
        await writeFile(`${output}.invalid`, "{");
        await expect(runHistoryAttest({ verify: `${output}.invalid` }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("readable JSON") });
        await writeFile(path.join(context.pmPath, "history", "pm-new.jsonl"), "");
        stdout.mockClear();
        const legacy = new Command().name("pm").option("--json").option("--pm-path <path>").exitOverride();
        registerHistoryMaintenanceCommands(legacy, false);
        await legacy.parseAsync(["--pm-path", context.pmPath, "--json", "history-attest", "--verify", output], { from: "user" });
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""))).toMatchObject({ ok: false, added_streams: ["pm-new"] });
        expect(await readFile(output, "utf8")).toBe(original);
      } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
      }
    });
  });
});
