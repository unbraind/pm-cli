import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import type { GlobalOptions } from "../../../../src/core/shared/command-types.js";
import {
  readSettings,
  writeSettings,
} from "../../../../src/core/store/settings.js";
import { runConfig } from "../../../../src/sdk/config.js";
import { withTempRoot } from "../../../helpers/temp.js";

const GLOBAL: GlobalOptions = { json: false, quiet: false, profile: false };

describe("agent identity config command", () => {
  it("gets and sets the sparse probe policy through the shared nested-setting contract", async () => {
    await withTempRoot("pm-agent-config-", async (root) => {
      const pmRoot = path.join(root, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const global = { ...GLOBAL, path: pmRoot };

      expect(
        await runConfig(
          "project",
          "get",
          "agent-identity-probes-enabled",
          {},
          global,
        ),
      ).toMatchObject({
        nested_setting: { value: true, kind: "boolean" },
        changed: false,
      });
      expect(
        await runConfig(
          "project",
          "set",
          "agent-identity-probes-enabled",
          {},
          global,
          "false",
        ),
      ).toMatchObject({
        nested_setting: { value: false },
        changed: true,
      });
      expect((await readSettings(pmRoot)).agent_identity?.probes_enabled).toBe(
        false,
      );
    });
  });

  it("previews then commits typed vocabulary changes without exposing alias spellings in discovery", async () => {
    await withTempRoot("pm-agent-config-", async (root) => {
      const pmRoot = path.join(root, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const global = { ...GLOBAL, path: pmRoot };

      const preview = await runConfig(
        "project",
        "set",
        "agent-identity-vocabulary",
        {
          policy: "preview-add",
          value: "Legacy Codex=codex",
          criterion: ["Legacy Codex", "Alice", "Alice"],
        },
        global,
      );
      expect(preview).toMatchObject({
        changed: false,
        identity_vocabulary: { version: 1, alias_count: 0 },
        vocabulary_mutation: {
          changed: true,
          version_before: 1,
          version_after: 2,
          residual_author_count: 1,
        },
      });
      expect(
        (await readSettings(pmRoot)).agent_identity?.identity_vocabulary,
      ).toEqual({ version: 1, aliases: {} });

      const committed = await runConfig(
        "project",
        "set",
        "agent-identity-vocabulary",
        { policy: "add", value: "Legacy Codex=codex" },
        global,
      );
      expect(committed).toMatchObject({
        changed: true,
        identity_vocabulary: { version: 2, alias_count: 1 },
      });

      for (const result of [
        await runConfig(
          "project",
          "get",
          "agent-identity-vocabulary",
          {},
          global,
        ),
        await runConfig("project", "list", undefined, {}, global),
        await runConfig("project", "export", undefined, {}, global),
      ]) {
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("Legacy Codex");
        expect(serialized).not.toContain('"privateAuthor"');
      }
    });
  });

  it("validates every vocabulary operation and persists remove and clear receipts", async () => {
    await withTempRoot("pm-agent-config-", async (root) => {
      const pmRoot = path.join(root, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      delete settings.agent_identity;
      await writeSettings(pmRoot, settings);
      const global = { ...GLOBAL, path: pmRoot };

      for (const options of [
        { policy: "invalid" },
        { policy: "add" },
        { policy: "add", value: "Legacy=" },
        { policy: "remove" },
        { policy: "clear", value: "unexpected" },
      ]) {
        await expect(
          runConfig(
            "project",
            "set",
            "agent-identity-vocabulary",
            options,
            global,
          ),
        ).rejects.toThrow();
      }

      expect(
        await runConfig(
          "project",
          "set",
          "agent-identity-vocabulary",
          { policy: "add", value: "Legacy=codex" },
          global,
        ),
      ).toMatchObject({ changed: true, identity_vocabulary: { alias_count: 1 } });
      expect(
        await runConfig(
          "project",
          "set",
          "agent-identity-vocabulary",
          { policy: "remove", value: "Legacy" },
          global,
        ),
      ).toMatchObject({ changed: true, identity_vocabulary: { alias_count: 0 } });
      expect(
        await runConfig(
          "project",
          "set",
          "agent-identity-vocabulary",
          { policy: "clear" },
          global,
        ),
      ).toMatchObject({ changed: false, identity_vocabulary: { alias_count: 0 } });
      await expect(
        runConfig(
          "project",
          "set",
          "agent-identity-vocabulary",
          { policy: "add", value: "codex=codex" },
          global,
        ),
      ).rejects.toThrow(/already canonical/u);
    });
  });
});
