import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  readSettings,
  writeSettings,
} from "../../../src/core/store/settings.js";
import { runInit } from "../../../src/sdk/init.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import {
  _testOnly,
  runDedupeAudit,
} from "../../../packages/pm-governance-audit/extensions/governance-audit/dedupe-audit.ts";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";

describe("package duplicate filter parity", () => {
  it("keeps simultaneous workspace workflows isolated and limits clusters after complete collection", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      const other = path.join(tempRoot, "other", ".agents", "pm");
      await runInit(undefined, { path: other }, { defaults: true });
      for (const [root, terminal] of [
        [pmPath, true],
        [other, false],
      ] as const) {
        const settings = await readSettings(root);
        settings.schema.statuses.push({
          id: "reviewing",
          aliases: ["review"],
          roles: terminal ? ["terminal_done"] : ["active"],
        });
        await writeSettings(root, settings);
        for (const [id, status, priority] of [
          ["review", "reviewing", "1"],
          ["open", "open", "2"],
          ["closed", "closed", "1"],
        ] as const) {
          await runCreate(
            {
              id,
              title: "Identical context",
              type: "Task",
              status,
              priority,
              closeReason: "Historical duplicate fixture",
              createMode: "progressive",
            },
            { path: root },
          );
        }
      }
      const results = await Promise.all(
        [pmPath, other].map((root) =>
          runDedupeAudit({ status: "all", limit: "1" }, { path: root }),
        ),
      );
      expect(results.map((result) => result.totals.items_considered)).toEqual([
        3, 3,
      ]);
      expect(results.map((result) => result.clusters[0]!.canonical.id)).toEqual(
        ["pm-open", "pm-review"],
      );
      const filtered = await runDedupeAudit(
        { status: "review,open" },
        { path: pmPath },
      );
      expect(filtered.filters.status).toBe("reviewing,open");
      expect(filtered.totals.items_considered).toBe(2);
      expect(filtered.clusters[0]!.canonical.id).toBe("pm-open");
    });
  });

  it("shares all, CSV, aliases, custom statuses and strict refusals with the SDK", () => {
    const registry = resolveRuntimeStatusRegistry({
      ...SETTINGS_DEFAULTS.schema,
      statuses: [
        ...SETTINGS_DEFAULTS.schema.statuses,
        { id: "reviewing", aliases: ["review"], roles: ["active"] },
      ],
    });
    expect(_testOnly.parseStatus(" ALL ", registry)).toBe("all");
    expect(_testOnly.parseStatus("review", registry)).toBe("reviewing");
    expect(_testOnly.parseStatus("open,review,reviewing", registry)).toBe(
      "open,reviewing",
    );
    expect(_testOnly.parseStatus("cancelled", registry)).toBe("canceled");
    expect(() => _testOnly.parseStatus("all,open", registry)).toThrow(
      /by itself/,
    );
    expect(() => _testOnly.parseStatus("invented", registry)).toThrow(
      /Invalid --status/,
    );
    expect(() => _testOnly.parseStatus("review")).toThrow(/Invalid --status/);
  });
});
