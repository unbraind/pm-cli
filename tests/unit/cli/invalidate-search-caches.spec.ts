import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { SEARCH_CACHE_ARTIFACT_PATHS } from "../../../src/core/search/cache.js";

const printError = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/output/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/output/output.js")>();
  return { ...actual, printError };
});

import { invalidateSearchCachesForMutation } from "../../../src/cli/registration-helpers.js";

async function writeSearchArtifacts(pmRoot: string): Promise<void> {
  await fs.mkdir(path.join(pmRoot, "index"), { recursive: true });
  await fs.mkdir(path.join(pmRoot, "search"), { recursive: true });
  await fs.writeFile(path.join(pmRoot, "index", "manifest.json"), '{"ok":true}\n', "utf8");
  await fs.writeFile(path.join(pmRoot, "search", "embeddings.jsonl"), '{"id":"pm-1"}\n', "utf8");
}

describe("invalidateSearchCachesForMutation", () => {
  beforeEach(() => {
    printError.mockClear();
  });

  it("invalidates real cache artifacts for mutation results without profiling noise", async () => {
    await withTempPmPath(async (context) => {
      await writeSearchArtifacts(context.pmPath);

      await invalidateSearchCachesForMutation({ quiet: false, profile: false, path: context.pmPath }, { id: "pm-1" });

      for (const relativePath of SEARCH_CACHE_ARTIFACT_PATHS) {
        await expect(fs.access(path.join(context.pmPath, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(printError).not.toHaveBeenCalled();
    });
  });

  it("emits real semantic-refresh warnings only when profiling is enabled", async () => {
    await withTempPmPath(async (context) => {
      await invalidateSearchCachesForMutation({ quiet: false, profile: false, path: context.pmPath }, { id: "pm-2" });
      expect(printError).not.toHaveBeenCalled();

      await invalidateSearchCachesForMutation({ quiet: false, profile: true, path: context.pmPath }, { id: "pm-2" });
      expect(printError).toHaveBeenCalledWith(
        "profile:search_refresh_warnings=search_semantic_refresh_skipped:provider_unconfigured",
      );
    });
  });
});
