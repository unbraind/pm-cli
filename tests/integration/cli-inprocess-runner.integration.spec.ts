import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("create/update --body-file (GH-214)", () => {
  it("loads the item body from a file on create and update", async () => {
    await withTempPmPath(async (context) => {
      const bodyPath = path.join(context.tempRoot, "spec.md");
      // Trailing newlines are normalized away on store, so keep the fixture
      // body free of a trailing newline to assert exact round-trip equality.
      const bodyContent = "# Spec\n\n## Acceptance\n- one\n- two";
      await writeFile(bodyPath, bodyContent, "utf8");

      const created = await context.runCliInProcess(
        ["create", "--json", "--type", "Feature", "--title", "body-file feature", "--body-file", bodyPath],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdId = (created.json as { item: { id: string; body?: string } }).item.id;

      const fetched = await context.runCliInProcess(["get", createdId, "--json"], { expectJson: true });
      expect((fetched.json as { body?: string }).body).toBe(bodyContent);

      const updatedPath = path.join(context.tempRoot, "updated.md");
      await writeFile(updatedPath, "updated from file", "utf8");
      const updated = await context.runCliInProcess(
        ["update", createdId, "--json", "--body-file", updatedPath],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);
      const refetched = await context.runCliInProcess(["get", createdId, "--json"], { expectJson: true });
      expect((refetched.json as { body?: string }).body).toBe("updated from file");
    });
  });

  it("rejects combining --body and --body-file", async () => {
    await withTempPmPath(async (context) => {
      const bodyPath = path.join(context.tempRoot, "conflict.md");
      await writeFile(bodyPath, "file body", "utf8");
      const result = await context.runCliInProcess([
        "create",
        "--type",
        "Task",
        "--title",
        "conflict",
        "--body",
        "inline body",
        "--body-file",
        bodyPath,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("mutually exclusive");
    });
  });

  it("errors with an actionable message when the file is missing", async () => {
    await withTempPmPath(async (context) => {
      const result = await context.runCliInProcess([
        "create",
        "--type",
        "Task",
        "--title",
        "missing body file",
        "--body-file",
        path.join(context.tempRoot, "nope.md"),
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("could not read");
    });
  });
});

describe("pm close short aliases (GH-226)", () => {
  it("accepts -r/--reason, -m/--message, and -d/--duplicate-of", async () => {
    await withTempPmPath(async (context) => {
      const reasonItem = (context.runCli(
        ["create", "--json", "--type", "Task", "--title", "close -r alias"],
        { expectJson: true },
      ).json as { item: { id: string } }).item.id;
      const closedByReason = await context.runCliInProcess(
        ["close", reasonItem, "-r", "done via -r", "-m", "history note", "--json"],
        { expectJson: true },
      );
      expect(closedByReason.code).toBe(0);
      expect((closedByReason.json as { item: { status: string; close_reason: string } }).item).toMatchObject({
        status: "closed",
        close_reason: "done via -r",
      });

      const canonicalId = (context.runCli(
        ["create", "--json", "--type", "Task", "--title", "canonical"],
        { expectJson: true },
      ).json as { item: { id: string } }).item.id;
      const duplicateId = (context.runCli(
        ["create", "--json", "--type", "Task", "--title", "duplicate"],
        { expectJson: true },
      ).json as { item: { id: string } }).item.id;
      const closedByDuplicate = await context.runCliInProcess(
        ["close", duplicateId, "-d", canonicalId, "--json"],
        { expectJson: true },
      );
      expect(closedByDuplicate.code).toBe(0);
      expect((closedByDuplicate.json as { item: { duplicate_of: string } }).item.duplicate_of).toBe(canonicalId);
    });
  });
});

describe("CLI in-process runner integration", () => {
  it("keeps subprocess and in-process runner behavior aligned for core flows", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--json", "--title", "In-process parity", "--description", "runner parity", "--type", "Task"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      const subprocessList = context.runCli(["list-open", "--json", "--limit", "10"], { expectJson: true });
      const inProcessList = await context.runCliInProcess(["list-open", "--json", "--limit", "10"], { expectJson: true });
      expect(inProcessList.code).toBe(subprocessList.code);
      const subprocessIds = ((subprocessList.json as { items?: Array<{ id?: string }> }).items ?? [])
        .map((entry) => entry.id)
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));
      const inProcessIds = ((inProcessList.json as { items?: Array<{ id?: string }> }).items ?? [])
        .map((entry) => entry.id)
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));
      expect(inProcessIds).toEqual(subprocessIds);

      const subprocessUsage = context.runCli(["list-open", "--bogus-flag"]);
      const inProcessUsage = await context.runCliInProcess(["list-open", "--bogus-flag"]);
      expect(inProcessUsage.code).toBe(subprocessUsage.code);
      expect(inProcessUsage.stderr).toContain("--bogus-flag");
    });
  });

  it("keeps concurrent in-process runs isolated and restores globals", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--json", "--title", "In-process globals", "--description", "runner globals", "--type", "Task"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdId = (created.json as { item: { id: string } }).item.id;
      const sentinelEnvKey = "PM_INPROCESS_SENTINEL";
      const hadSentinelBefore = Object.prototype.hasOwnProperty.call(process.env, sentinelEnvKey);
      const sentinelBefore = process.env[sentinelEnvKey];
      const cwdBefore = process.cwd();
      const argvBefore = [...process.argv];
      const nestedCwd = path.join(context.tempRoot, "nested-cwd");
      await mkdir(nestedCwd, { recursive: true });
      context.env[sentinelEnvKey] = "set-only-during-inprocess-run";
      try {
        const [listOpen, fetched] = await Promise.all([
          context.runCliInProcess(["list-open", "--json", "--limit", "20"], {
            expectJson: true,
            cwd: nestedCwd,
          }),
          context.runCliInProcess(["get", createdId, "--json"], { expectJson: true }),
        ]);

        expect(listOpen.code).toBe(0);
        expect(fetched.code).toBe(0);
        const openIds = ((listOpen.json as { items?: Array<{ id?: string }> }).items ?? [])
          .map((entry) => entry.id)
          .filter((value): value is string => typeof value === "string");
        expect(openIds).toContain(createdId);
        expect((fetched.json as { item: { id: string } }).item.id).toBe(createdId);
        expect(process.cwd()).toBe(cwdBefore);
        expect(process.argv).toEqual(argvBefore);
        expect(process.env[sentinelEnvKey]).toBe(sentinelBefore);
      } finally {
        delete context.env[sentinelEnvKey];
        if (hadSentinelBefore) {
          if (sentinelBefore === undefined) {
            delete process.env[sentinelEnvKey];
          } else {
            process.env[sentinelEnvKey] = sentinelBefore;
          }
        } else {
          delete process.env[sentinelEnvKey];
        }
      }
    });
  });
});
