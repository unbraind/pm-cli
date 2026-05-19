import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function loadRuntimeModule(): Promise<typeof import("../../packages/pm-search-advanced/extensions/search-advanced/runtime.js")> {
  process.env.PM_CLI_PACKAGE_ROOT = process.cwd();
  const runtimePath = path.join(
    process.cwd(),
    "packages",
    "pm-search-advanced",
    "extensions",
    "search-advanced",
    "runtime.js",
  );
  return import(`${pathToFileURL(runtimePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function importRuntimeWithPackageRoot(packageRoot: string | undefined): Promise<unknown> {
  const previous = process.env.PM_CLI_PACKAGE_ROOT;
  if (packageRoot === undefined) {
    delete process.env.PM_CLI_PACKAGE_ROOT;
  } else {
    process.env.PM_CLI_PACKAGE_ROOT = packageRoot;
  }
  const runtimePath = path.join(
    process.cwd(),
    "packages",
    "pm-search-advanced",
    "extensions",
    "search-advanced",
    "runtime.js",
  );
  try {
    return await import(`${pathToFileURL(runtimePath).href}?failureTest=${Date.now()}-${Math.random()}`);
  } finally {
    if (previous === undefined) {
      delete process.env.PM_CLI_PACKAGE_ROOT;
    } else {
      process.env.PM_CLI_PACKAGE_ROOT = previous;
    }
  }
}

describe("search-advanced package runtime", () => {
  it("keeps search-advanced keyword-first while supporting semantic and hybrid aliases", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "--json",
          "create",
          "--title",
          "Search advanced runtime target",
          "--description",
          "calendar package workflow",
          "--type",
          "Task",
          "--status",
          "open",
          "--create-mode",
          "progressive",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      const runtime = await loadRuntimeModule();
      const global = { json: true, quiet: true, noPager: true, path: context.pmPath };

      const defaultSearch = await runtime.runAdvancedSearchPackage(
        ["calendar package", "--fields", "id,title,score", "--limit", "5"],
        { fields: "id,title,score", limit: "5", full: "false", includeLinked: "false" },
        global,
      );
      expect(defaultSearch.mode).toBe("keyword");
      expect(defaultSearch.query).toBe("calendar package");

      const compactSearch = await runtime.runAdvancedSearchPackage(
        ["calendar package", "--compact", "--limit", "5"],
        { compact: true, limit: "5" },
        global,
      );
      expect(compactSearch.mode).toBe("keyword");

      const fullFilteredSearch = await runtime.runAdvancedSearchPackage(
        ["Search advanced runtime target", "--full", "--include-linked", "--title-exact", "--phrase-exact"],
        {
          full: true,
          includeLinked: true,
          titleExact: true,
          phraseExact: true,
          type: "Task",
          tag: "missing-tag",
          priority: "2",
          deadline_before: "2030-01-01",
          deadline_after: "2000-01-01",
        },
        global,
      );
      expect(fullFilteredSearch.mode).toBe("keyword");

      const aliasFilteredSearch = await runtime.runAdvancedSearchPackage(
        [
          undefined,
          "Search advanced runtime target",
          "--include_linked",
          "--title_exact",
          "--phrase_exact",
          "--deadline-before=2030-01-01",
          "--deadline_after=2000-01-01",
          "--json",
          "",
        ] as unknown as string[],
        {
          include_linked: "no",
          title_exact: "0",
          phrase_exact: "off",
          deadline_before: "2030-01-01",
          deadline_after: "2000-01-01",
        },
        global,
      );
      expect(aliasFilteredSearch.query).toBe("Search advanced runtime target");

      const invalidBooleanSearch = await runtime.runAdvancedSearchPackage(
        ["calendar package"],
        { compact: 1, full: "maybe" },
        global,
      );
      expect(invalidBooleanSearch.mode).toBe("keyword");

      await expect(runtime.runAdvancedSearchPackage(
        ["--hybrid", "calendar package", "--limit", "5"],
        { limit: "5" },
        global,
      )).rejects.toMatchObject({
        message: expect.stringContaining("Search mode 'hybrid' requires"),
      });

      await expect(runtime.runAdvancedSearchPackage(
        ["--semantic", "calendar package", "--limit=5"],
        {},
        global,
      )).rejects.toMatchObject({
        message: expect.stringContaining("Search mode 'semantic' requires"),
      });
    });
  });

  it("validates empty queries and normalizes reindex options", async () => {
    await withTempPmPath(async (context) => {
      const runtime = await loadRuntimeModule();
      const global = { json: true, quiet: true, noPager: true, path: context.pmPath };

      await expect(runtime.runAdvancedSearchPackage(["--limit", "5"], { limit: "5" }, global)).rejects.toMatchObject<
        PmCliError
      >({
        message: "Search query must not be empty",
      });

      const reindex = await runtime.runAdvancedReindexPackage({ mode: "keyword", progress: "true" }, global);
      expect(reindex.mode).toBe("keyword");
      expect(reindex.total_items).toBeGreaterThanOrEqual(0);

      const quietReindex = await runtime.runAdvancedReindexPackage({ mode: "keyword", progress: "false" }, global);
      expect(quietReindex.mode).toBe("keyword");
    });
  });

  it("reports deterministic SDK loading failures", async () => {
    await expect(importRuntimeWithPackageRoot(undefined)).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");
    await expect(importRuntimeWithPackageRoot("/tmp/pm-cli-missing-sdk-root")).rejects.toThrow(
      "failed to load SDK runtime exports",
    );
    const partialRoot = await mkdtemp(path.join(tmpdir(), "pm-search-runtime-partial-"));
    await mkdir(path.join(partialRoot, "dist", "sdk"), { recursive: true });
    await writeFile(path.join(partialRoot, "dist", "sdk", "runtime.js"), "export const runSearch = true;\n", "utf8");
    await expect(importRuntimeWithPackageRoot(partialRoot)).rejects.toThrow("failed to load SDK runtime exports");
  });
});
