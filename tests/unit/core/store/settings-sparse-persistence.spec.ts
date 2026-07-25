import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import {
  detectHarnessIdentity,
  runWithWorkspaceHarnessSignalDescriptors,
} from "../../../../src/core/shared/author.js";
import {
  persistSelectedItemFormat,
  readSettings,
  settingsStoreTestOnly,
  writeSettings,
} from "../../../../src/core/store/settings.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

function requiredSparseSettings(): Record<string, unknown> {
  return {
    version: SETTINGS_DEFAULTS.version,
    id_prefix: SETTINGS_DEFAULTS.id_prefix,
    author_default: "test-author",
    item_format: SETTINGS_DEFAULTS.item_format,
    locks: { ttl_seconds: SETTINGS_DEFAULTS.locks.ttl_seconds },
    output: {
      default_format: SETTINGS_DEFAULTS.output.default_format,
    },
    extensions: {
      enabled: [],
      disabled: [],
    },
    search: {
      score_threshold: SETTINGS_DEFAULTS.search.score_threshold,
      max_results: SETTINGS_DEFAULTS.search.max_results,
      embedding_model: SETTINGS_DEFAULTS.search.embedding_model,
      embedding_batch_size: SETTINGS_DEFAULTS.search.embedding_batch_size,
      scanner_max_batch_retries:
        SETTINGS_DEFAULTS.search.scanner_max_batch_retries,
    },
    providers: structuredClone(SETTINGS_DEFAULTS.providers),
    vector_store: structuredClone(SETTINGS_DEFAULTS.vector_store),
  };
}

describe("sparse settings persistence", () => {
  it("persists an explicitly selected format without expanding unrelated defaults", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const sparse = requiredSparseSettings();
      delete sparse.item_format;
      await writeFile(
        settingsPath,
        `${JSON.stringify(sparse, null, 2)}\n`,
        "utf8",
      );
      const settings = await readSettings(context.pmPath);
      persistSelectedItemFormat(settings);
      await writeSettings(context.pmPath, settings);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        ...sparse,
        item_format: "toon",
      });
    });
  });

  it("detaches format provenance before changing a cached settings snapshot", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const sparse = requiredSparseSettings();
      delete sparse.item_format;
      await writeFile(
        settingsPath,
        `${JSON.stringify(sparse, null, 2)}\n`,
        "utf8",
      );

      const selectedSettings = await readSettings(context.pmPath);
      const independentSettings = await readSettings(context.pmPath);
      persistSelectedItemFormat(selectedSettings);
      await writeSettings(context.pmPath, independentSettings);

      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(sparse);
    });
  });

  it("removes an emptied nested sparse object after its final override is removed", () => {
    const target: Record<string, unknown> = {
      context: { default_depth: "deep" },
    };
    settingsStoreTestOnly.applySettingsDelta(
      target,
      { context: { default_depth: "deep" } },
      { context: {} },
    );
    expect(target).not.toHaveProperty("context");
  });

  it("writes only the intended leaf and preserves explicit preset-owned source values", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const sparse = {
        ...requiredSparseSettings(),
        ids: { token_length: 4 },
        validation: {
          sprint_release_format: "warn",
          parent_reference: "warn",
        },
        governance: { preset: "default" },
      };
      await writeFile(
        settingsPath,
        `${JSON.stringify(sparse, null, 2)}\n`,
        "utf8",
      );

      const result = context.runCli(
        ["config", "set", "ids_token_length", "6", "--json"],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const stored = JSON.parse(await readFile(settingsPath, "utf8")) as {
        validation: { parent_reference: string };
        governance: {
          preset: string;
          duplicate_detection_mode?: string;
        };
        locks?: unknown;
        telemetry?: unknown;
        search?: unknown;
      };

      expect(stored.validation.parent_reference).toBe("warn");
      expect(stored.governance).toEqual({
        preset: "default",
      });
      expect(stored).not.toHaveProperty("telemetry");
      expect(stored).not.toHaveProperty("checkpoints");
      expect(stored).not.toHaveProperty("context");
    });
  });

  it("round-trips unrelated sparse keys without materializing defaults", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      await writeFile(
        settingsPath,
        `${JSON.stringify(
          {
            ...requiredSparseSettings(),
            ids: { token_length: 4 },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      expect(
        context.runCli(["config", "set", "ids_token_length", "6", "--json"])
          .code,
      ).toBe(0);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        ...requiredSparseSettings(),
        ids: { token_length: 6 },
      });
    });
  });

  it("round-trips workspace harness descriptors without expanding defaults", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const sparse = {
        ...requiredSparseSettings(),
        agent_identity: {
          harness_signals: [
            {
              harness: "synthetic-agent",
              environment_keys: ["SYNTHETIC_AGENT"],
              model_environment_keys: ["SYNTHETIC_MODEL"],
              session_environment_keys: ["SYNTHETIC_SESSION"],
              argv_markers: ["synthetic-agent"],
              client_names: ["synthetic-client"],
            },
          ],
        },
      };
      await writeFile(
        settingsPath,
        `${JSON.stringify(sparse, null, 2)}\n`,
        "utf8",
      );

      const settings = await readSettings(context.pmPath);
      expect(settings.agent_identity).toEqual(sparse.agent_identity);
      expect(
        runWithWorkspaceHarnessSignalDescriptors(
          settings.agent_identity?.harness_signals ?? [],
          () =>
            detectHarnessIdentity({ env: { SYNTHETIC_AGENT: "1" } }),
        ),
      ).toBe("synthetic-agent");
      await writeSettings(context.pmPath, settings);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(sparse);
    });
  });
});
