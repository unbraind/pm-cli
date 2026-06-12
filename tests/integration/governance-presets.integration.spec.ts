import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDirectDistCli } from "../helpers/cliRunner.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function createCliEnv(tempRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PM_PATH: path.join(tempRoot, ".agents", "pm"),
    PM_GLOBAL_PATH: path.join(tempRoot, ".pm-cli-global"),
    PM_AUTHOR: "integration-governance",
    PM_TELEMETRY_DISABLED: "1",
    PM_TELEMETRY_OTEL_DISABLED: "1",
    PM_TELEMETRY_PROMPT: "0",
    PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1",
    FORCE_COLOR: "0",
  };
}

describe("governance presets", () => {
  it("initializes with --preset minimal in non-interactive mode", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-governance-init-minimal-"));
    try {
      const env = createCliEnv(tempRoot);
      const init = runDirectDistCli(["init", "--json", "--preset", "minimal"], { env, expectJson: true });
      expect(init.code).toBe(0);
      const payload = init.json as {
        governance_preset: string;
        wizard_used: boolean;
        settings: {
          governance: {
            preset: string;
            ownership_enforcement: string;
            create_mode_default: string;
            close_validation_default: string;
            force_required_for_stale_lock: boolean;
          };
        };
      };
      expect(payload.governance_preset).toBe("minimal");
      expect(payload.wizard_used).toBe(false);
      expect(payload.settings.governance).toMatchObject({
        preset: "minimal",
        ownership_enforcement: "none",
        create_mode_default: "progressive",
        close_validation_default: "off",
        force_required_for_stale_lock: false,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes with --preset strict in non-interactive mode", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-governance-init-strict-"));
    try {
      const env = createCliEnv(tempRoot);
      const init = runDirectDistCli(["init", "--json", "--preset", "strict"], { env, expectJson: true });
      expect(init.code).toBe(0);
      const payload = init.json as {
        governance_preset: string;
        wizard_used: boolean;
        settings: {
          governance: {
            preset: string;
            ownership_enforcement: string;
            create_mode_default: string;
            close_validation_default: string;
            parent_reference: string;
            metadata_profile: string;
            force_required_for_stale_lock: boolean;
          };
        };
      };
      expect(payload.governance_preset).toBe("strict");
      expect(payload.wizard_used).toBe(false);
      expect(payload.settings.governance).toMatchObject({
        preset: "strict",
        ownership_enforcement: "strict",
        create_mode_default: "strict",
        close_validation_default: "strict",
        parent_reference: "strict_error",
        metadata_profile: "strict",
        force_required_for_stale_lock: true,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses governance create-mode default when create-mode is omitted", async () => {
    await withTempPmPath(async (context) => {
      const minimalDefaultCreate = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "governance-create-default-minimal",
          "--description",
          "Minimal preset should permit staged create",
          "--type",
          "Task",
        ],
        { expectJson: true },
      );
      expect(minimalDefaultCreate.code).toBe(0);

      const setStrictPreset = context.runCli(
        ["config", "project", "set", "governance-preset", "--policy", "strict", "--json"],
        { expectJson: true },
      );
      expect(setStrictPreset.code).toBe(0);

      const strictDefaultCreate = context.runCli([
        "create",
        "--json",
        "--title",
        "governance-create-default-strict",
        "--description",
        "Strict preset should require strict create fields",
        "--type",
        "Task",
      ]);
      expect(strictDefaultCreate.code).toBe(2);
      expect(strictDefaultCreate.stderr).toContain("Missing required options");
      expect(strictDefaultCreate.stderr).toContain("--create-mode progressive");
      const envelope = JSON.parse(strictDefaultCreate.stderr) as {
        recovery?: {
          recovery_mode?: string;
          attempted_command?: string;
          normalized_args?: string[];
          missing?: string[];
          missing_required_fields?: string[];
          suggested_flags?: string[];
        };
      };
      expect(envelope.recovery?.recovery_mode).toBe("compact");
      expect(envelope.recovery?.attempted_command).toBeUndefined();
      expect(envelope.recovery?.normalized_args).toBeUndefined();
      expect(envelope.recovery?.missing).toBeUndefined();
      expect(envelope.recovery?.missing_required_fields).toEqual(expect.arrayContaining(["--message"]));
      expect(envelope.recovery?.suggested_flags).toEqual(expect.arrayContaining(["--create-mode progressive", "--message"]));

      const strictDefaultCreateExplain = context.runCli([
        "create",
        "--json",
        "--explain",
        "--title",
        "governance-create-default-strict",
        "--description",
        "Strict preset should require strict create fields",
        "--type",
        "Task",
      ]);
      expect(strictDefaultCreateExplain.code).toBe(2);
      const explainEnvelope = JSON.parse(strictDefaultCreateExplain.stderr) as {
        recovery?: {
          attempted_command?: string;
          normalized_args?: string[];
          missing_required_fields?: string[];
        };
      };
      expect(explainEnvelope.recovery?.attempted_command).toContain("pm create");
      expect(explainEnvelope.recovery?.normalized_args).toEqual(expect.arrayContaining(["--explain"]));
      expect(explainEnvelope.recovery?.missing_required_fields).toEqual(expect.arrayContaining(["--message"]));
    });
  });

  it("applies ownership enforcement behavior across minimal/default/strict presets", async () => {
    await withTempPmPath(async (context) => {
      const createSeed = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "governance-ownership-seed",
          "--description",
          "Ownership enforcement preset integration test",
          "--type",
          "Task",
        ],
        { expectJson: true },
      );
      expect(createSeed.code).toBe(0);
      const id = (createSeed.json as { item?: { id?: string } }).item?.id ?? "";
      expect(id.length).toBeGreaterThan(0);

      const claimOwnerA = context.runCli(["claim", id, "--json", "--author", "owner-a", "--message", "Claim seed item"], {
        expectJson: true,
      });
      expect(claimOwnerA.code).toBe(0);

      const minimalUpdate = context.runCli(
        ["update", id, "--json", "--author", "owner-b", "--status", "blocked", "--message", "minimal preset update"],
        { expectJson: true },
      );
      expect(minimalUpdate.code).toBe(0);
      expect((minimalUpdate.json as { warnings?: string[] }).warnings ?? []).toEqual([]);

      const setDefaultPreset = context.runCli(
        ["config", "project", "set", "governance-preset", "--policy", "default", "--json"],
        { expectJson: true },
      );
      expect(setDefaultPreset.code).toBe(0);

      const defaultUpdate = context.runCli(
        ["update", id, "--json", "--author", "owner-b", "--status", "open", "--message", "default preset update"],
        { expectJson: true },
      );
      expect(defaultUpdate.code).toBe(0);
      expect((defaultUpdate.json as { warnings?: string[] }).warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining("ownership_warning:assignee_conflict")]),
      );

      const setStrictPreset = context.runCli(
        ["config", "project", "set", "governance-preset", "--policy", "strict", "--json"],
        { expectJson: true },
      );
      expect(setStrictPreset.code).toBe(0);

      const strictUpdate = context.runCli([
        "update",
        id,
        "--json",
        "--author",
        "owner-b",
        "--status",
        "blocked",
        "--message",
        "strict preset update",
      ]);
      expect(strictUpdate.code).toBe(4);
      expect(strictUpdate.stderr).toContain("assigned to");
    });
  });
});
