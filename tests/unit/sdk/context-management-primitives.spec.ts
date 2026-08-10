import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFilesLookupCommand } from "../../../src/cli/register-files-lookup.js";
import { runFiles, runFilesLookup } from "../../../src/sdk/files.js";
import { filesLookup, PmClient, runAction } from "../../../src/sdk/runtime.js";
import {
  generateBashScript,
  generateFishScript,
  generateZshScript,
} from "../../../src/sdk/completion.js";
import { runGet } from "../../../src/sdk/query/get.js";
import { runTelemetry } from "../../../src/sdk/telemetry.js";
import { classifyLinkedTestFailure } from "../../../src/sdk/test/execution.js";
import { runUpdate } from "../../../src/sdk/lifecycle/update.js";
import {
  listAllDocumentCandidatesCached,
  readItemMetadataDerivedIndexState,
} from "../../../src/core/store/item-metadata-cache.js";
import {
  queryLinkedFileMetadataIndex,
  rebuildItemMetadataQueryIndex,
} from "../../../src/core/store/item-metadata-query-index.js";
import { listAllItemMetadata } from "../../../src/core/store/item-store.js";
import { resolveItemTypeRegistry } from "../../../src/core/item/type-registry.js";
import { getActiveExtensionRegistrations } from "../../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  readSettings,
  writeSettings,
} from "../../../src/core/store/settings.js";
import { withTempGlobalRoot } from "../../helpers/temp.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

const originalFetch = globalThis.fetch;
const originalGlobalPath = process.env.PM_GLOBAL_PATH;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGlobalPath === undefined) {
    delete process.env.PM_GLOBAL_PATH;
  } else {
    process.env.PM_GLOBAL_PATH = originalGlobalPath;
  }
  vi.restoreAllMocks();
});

function createTask(context: TempPmContext, title: string): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--create-mode",
      "progressive",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

async function historyEntries(pmPath: string, id: string): Promise<number> {
  const raw = await fs.readFile(
    path.join(pmPath, "history", `${id}.jsonl`),
    "utf8",
  );
  return raw.split("\n").filter((line) => line.trim().length > 0).length;
}

function createFilesLookupCli(pmPath: string): Command {
  const command = new Command()
    .exitOverride()
    .option("--pm-path <path>")
    .option("--json");
  registerFilesLookupCommand(command.command("files"));
  command.setOptionValue("pmPath", pmPath);
  command.setOptionValue("json", true);
  return command;
}

describe("context-management SDK primitives", () => {
  it("preserves canonical file ranking when explanations have equal evidence", async () => {
    await withTempPmPath(async (context) => {
      const first = createTask(context, "Equal source evidence one");
      const second = createTask(context, "Equal source evidence two");
      for (const id of [first, second]) {
        await runFiles(
          id,
          { add: ["path=src/equal.ts,scope=project"] },
          { path: context.pmPath },
        );
      }
      const baseline = await runFilesLookup(
        { paths: ["src/equal.ts"] },
        { path: context.pmPath },
      );
      const explained = await runFilesLookup(
        { paths: ["src/equal.ts"], explain: true },
        { path: context.pmPath },
      );
      expect(explained.matches.map((match) => match.item.id)).toEqual(
        baseline.matches.map((match) => match.item.id),
      );
    });
  });

  it("treats repeated linked-file additions as true no-op mutations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "No-op evidence");
      const first = await runFiles(
        id,
        { add: ["path=src/sdk/files.ts,scope=project"] },
        { path: context.pmPath },
      );
      const historyBefore = await historyEntries(context.pmPath, id);
      const repeated = await runFiles(
        id,
        { add: ["path=src/sdk/files.ts,scope=project"] },
        { path: context.pmPath },
      );

      expect(first.changed).toBe(true);
      expect(repeated).toMatchObject({ changed: false, count: 1 });
      expect(await historyEntries(context.pmPath, id)).toBe(historyBefore);
    });
  });

  it("atomically replaces linked files and docs in one update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Replace evidence");
      await runUpdate(
        id,
        {
          file: ["path=old-a.ts,scope=project", "path=old-b.ts,scope=project"],
          doc: [
            "path=docs/old-a.md,scope=project",
            "path=docs/old-b.md,scope=project",
          ],
        },
        { path: context.pmPath },
      );
      const replaced = await runUpdate(
        id,
        {
          file: ["path=src/new.ts,scope=project,note=current source"],
          doc: ["path=docs/new.md,scope=project,note=current contract"],
          replaceFiles: true,
          replaceDocs: true,
        },
        { path: context.pmPath },
      );
      const loaded = await runGet(id, { path: context.pmPath }, { full: true });

      expect(replaced.changed_fields).toEqual(
        expect.arrayContaining(["files", "docs"]),
      );
      expect(loaded.item.files).toEqual([
        { path: "src/new.ts", scope: "project", note: "current source" },
      ]);
      expect(loaded.item.docs).toEqual([
        { path: "docs/new.md", scope: "project", note: "current contract" },
      ]);
    });
  });

  it("accepts files/docs replacement through the guarded CLI flag contract", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "CLI replace evidence");
      const updated = context.runCli(
        [
          "update",
          id,
          "--file",
          "path=src/cli.ts,scope=project",
          "--replace-files",
          "--doc",
          "path=docs/cli.md,scope=project",
          "--replace-docs",
          "--json",
        ],
        { expectJson: true },
      );
      const loaded = await runGet(id, { path: context.pmPath }, { full: true });

      expect(updated).toMatchObject({ code: 0 });
      expect(loaded.item.files?.[0]?.path).toBe("src/cli.ts");
      expect(loaded.item.docs?.[0]?.path).toBe("docs/cli.md");
    });
  });

  it("advertises evidence primitives consistently across shell completions", () => {
    for (const script of [generateBashScript(), generateZshScript()]) {
      expect(script).toContain("--replace-files");
      expect(script).toContain("--replace-docs");
      expect(script).toContain("lookup");
      expect(script).toContain("--strict-read");
      expect(script).toContain("--explain");
      expect(script).toContain("--lines");
    }
    const fish = generateFishScript();
    expect(fish).toContain("-l replace-files");
    expect(fish).toContain("-l replace-docs");
    expect(fish).toContain("discover lookup");
    expect(fish).toContain("-l strict-read");
    expect(fish).toContain("-l explain");
    expect(fish).toContain("-l lines");
  });

  it("finds source-linked items with bounded source-scan receipts", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "Trace source first");
      const secondId = createTask(context, "Trace source second");
      await runFiles(
        firstId,
        {
          add: [
            "path=src/sdk/files.ts,scope=project,note=implementation",
            "path=src/sdk/files.ts,scope=global,note=global implementation",
          ],
        },
        { path: context.pmPath },
      );
      await runFiles(
        secondId,
        { add: ["path=src/sdk/files.ts,scope=project,note=verification"] },
        { path: context.pmPath },
      );

      const result = await runFilesLookup(
        { paths: ["src/sdk/files.ts"], limit: 1 },
        { path: context.pmPath },
      );

      expect(result).toMatchObject({
        paths: ["src/sdk/files.ts"],
        total: 2,
        count: 1,
        has_more: true,
        truncated: true,
        completeness: { status: "complete", source: "source_scan" },
      });
      expect([firstId, secondId]).toContain(result.matches[0]?.item.id);
      expect(result.matches[0]?.files[0]?.path).toBe("src/sdk/files.ts");
      await expect(
        runFilesLookup(
          { paths: ["src/sdk/files.ts"], explain: true, noTruncate: true },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject({
        total: 2,
        traceability_receipt: { line_range: null, decision_depth: 8 },
      });
    });
  });

  it("exposes reverse lookup through CLI, client, one-shot, and action dispatch", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Trace every transport");
      await runFiles(
        id,
        { add: ["path=src/sdk/files.ts,scope=project"] },
        { path: context.pmPath },
      );
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      await createFilesLookupCli(context.pmPath).parseAsync([
        "node",
        "pm",
        "files",
        "lookup",
        "src/sdk/files.ts",
        "--scope",
        "project",
        "--limit",
        "1",
        "--offset",
        "0",
        "--strict-read",
      ]);
      expect(stdout).toHaveBeenCalled();
      await createFilesLookupCli(context.pmPath).parseAsync([
        "node",
        "pm",
        "files",
        "lookup",
        "src/sdk/files.ts",
      ]);
      await createFilesLookupCli(context.pmPath).parseAsync([
        "node",
        "pm",
        "files",
        "lookup",
        "src/sdk/files.ts",
        "--scope",
        "global",
        "--explain",
        "--lines",
        "1:1",
        "--decision-depth",
        "4",
      ]);
      await expect(
        createFilesLookupCli(context.pmPath).parseAsync([
          "node",
          "pm",
          "files",
          "lookup",
          "src/sdk/files.ts",
          "--scope",
          "unsupported",
        ]),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        createFilesLookupCli(context.pmPath).parseAsync([
          "node",
          "pm",
          "files",
          "lookup",
          "src/sdk/files.ts",
          "--limit",
          "0",
        ]),
      ).rejects.toThrow("--limit must be an integer");
      await expect(
        createFilesLookupCli(context.pmPath).parseAsync([
          "node",
          "pm",
          "files",
          "lookup",
          "src/sdk/files.ts",
          "--offset",
          "-1",
        ]),
      ).rejects.toThrow("--offset must be an integer");
      const cli = await context.runCliInProcess(
        [
          "files",
          "lookup",
          "src/sdk/files.ts",
          "--scope",
          "project",
          "--limit",
          "1",
          "--offset",
          "0",
          "--strict-read",
          "--explain",
          "--lines",
          "1:1",
          "--decision-depth",
          "4",
          "--json",
        ],
        { expectJson: true },
      );
      expect(cli).toMatchObject({
        code: 0,
        json: {
          total: 1,
          traceability_receipt: {
            line_range: { start: 1, end: 1 },
            decision_depth: 4,
          },
        },
      });
      expect(
        await context.runCliInProcess([
          "files",
          "lookup",
          "src/sdk/files.ts",
          "--scope",
          "unsupported",
          "--no-truncate",
          "--json",
        ]),
      ).toMatchObject({ code: 2 });
      expect(
        await context.runCliInProcess([
          "files",
          "lookup",
          "src/sdk/files.ts",
          "--limit",
          "0",
        ]),
      ).toMatchObject({ code: 2 });
      expect(
        await context.runCliInProcess([
          "files",
          "lookup",
          "src/sdk/files.ts",
          "--offset",
          "-1",
        ]),
      ).toMatchObject({ code: 2 });

      const clientOptions = { pmRoot: context.pmPath, noExtensions: true };
      await expect(
        new PmClient(clientOptions).filesLookup({
          paths: ["src/sdk/files.ts"],
          explain: true,
          lineRange: { start: 1, end: 1 },
        }),
      ).resolves.toMatchObject({
        total: 1,
        traceability_receipt: { line_range: { start: 1, end: 1 } },
      });
      for (const lineRange of ["invalid", null, []]) {
        await expect(
          new PmClient(clientOptions).filesLookup({
            paths: ["src/sdk/files.ts"],
            lineRange: lineRange as never,
          }),
        ).rejects.toThrow("must be an object");
      }
      await expect(
        filesLookup(
          { paths: ["src/sdk/files.ts"], scope: "project" },
          clientOptions,
        ),
      ).resolves.toMatchObject({ total: 1 });
      await expect(
        runAction({
          action: "files",
          options: {
            lookupPath: ["src/sdk/files.ts"],
            scope: "project",
            limit: "1",
            offset: "0",
            explain: true,
            lines: "1:1",
            decisionDepth: 4,
          },
          pmRoot: context.pmPath,
          noExtensions: true,
        }),
      ).resolves.toMatchObject({
        total: 1,
        traceability_receipt: {
          line_range: { start: 1, end: 1 },
          decision_depth: 4,
        },
      });
      await expect(
        runAction({
          action: "files",
          options: {
            lookupPath: ["src/sdk/files.ts"],
            scope: "global",
          },
          pmRoot: context.pmPath,
          noExtensions: true,
        }),
      ).resolves.toMatchObject({ total: 0 });
      await expect(
        runAction({
          action: "files",
          options: {
            lookupPath: ["src/sdk/files.ts"],
            scope: "unsupported",
          },
          pmRoot: context.pmPath,
          noExtensions: true,
        }),
      ).resolves.toMatchObject({ total: 1 });
    });
  });

  it("validates lookup paths and reports partial or strict authoritative reads", async () => {
    await withTempPmPath(async (context) => {
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      const sourcePath = path.join(workspaceRoot, "src", "absolute.ts");
      const globalEvidencePath = path.join(
        os.tmpdir(),
        "pm-cli-global-evidence.ts",
      );
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, "export {};\n", "utf8");
      const id = createTask(context, "Lookup validation");
      const peerId = createTask(context, "Lookup validation peer");
      const laterPeerId = createTask(context, "Lookup validation later peer");
      createTask(context, "Lookup without evidence");
      await runFiles(
        id,
        {
          add: [
            "path=src/absolute.ts,scope=project",
            "path=src/absolute.ts,scope=global",
            "path=src/other.ts,scope=project",
            `path=${globalEvidencePath},scope=global`,
          ],
        },
        { path: context.pmPath },
      );
      for (const peer of [peerId, laterPeerId]) {
        await runFiles(
          peer,
          { add: ["path=src/absolute.ts,scope=project"] },
          { path: context.pmPath },
        );
      }
      await runUpdate(id, { priority: 1 }, { path: context.pmPath });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
      await runUpdate(
        peerId,
        { title: "Lookup validation peer revised" },
        { path: context.pmPath },
      );
      await runUpdate(
        laterPeerId,
        { title: "Lookup validation later peer revised" },
        { path: context.pmPath },
      );
      vi.useRealTimers();

      await expect(
        runFilesLookup({ paths: [] }, { path: context.pmPath }),
      ).rejects.toThrow("at least one path");
      await expect(
        runFilesLookup({ paths: [" "] }, { path: context.pmPath }),
      ).rejects.toThrow("must not be empty");
      await expect(
        runFilesLookup(
          { paths: ["src/absolute.ts"], limit: -1 },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("non-negative integer");
      await expect(
        runFilesLookup(
          { paths: ["src/absolute.ts"], offset: 0.5 },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("non-negative integer");
      await expect(
        runFilesLookup(
          {
            paths: ["src/absolute.ts", "src/other.ts"],
            lineRange: { start: 1, end: 1 },
          },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("exactly one source path");
      await expect(
        runFilesLookup(
          {
            paths: [sourcePath, "src/other.ts", sourcePath],
            scope: "project",
            noTruncate: true,
          },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject({
        paths: ["src/absolute.ts", "src/other.ts"],
        total: 3,
        limit: null,
      });
      await expect(
        runFilesLookup(
          {
            paths: [globalEvidencePath],
            scope: "global",
          },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject({ total: 1 });

      await fs.writeFile(
        path.join(context.pmPath, "tasks", "pm-unreadable.toon"),
        "not: [valid",
        "utf8",
      );
      await expect(
        runFilesLookup(
          { paths: ["src/absolute.ts"], noTruncate: true },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject({ completeness: { status: "partial" } });
      await expect(
        runFilesLookup(
          {
            paths: ["src/absolute.ts"],
            noTruncate: true,
            strictRead: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("could not read every item");
    });

    await expect(
      runFilesLookup(
        { paths: ["src/missing.ts"] },
        { path: path.join(process.cwd(), "missing-tracker") },
      ),
    ).rejects.toThrow("Tracker is not initialized");
  });

  it("queries the reverse linked-file projection without heavy item reads", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Indexed trace source");
      await runFiles(
        id,
        { add: ["path=src/sdk/files.ts,scope=project,note=indexed"] },
        { path: context.pmPath },
      );
      const settings = await readSettings(context.pmPath);
      const typeRegistry = resolveItemTypeRegistry(
        settings,
        getActiveExtensionRegistrations(),
      );
      await listAllDocumentCandidatesCached(
        context.pmPath,
        settings.item_format,
        typeRegistry.type_to_folder,
        [],
        settings.schema,
        { includeBody: false, derivedIndexMinimumItems: 1 },
      );
      const indexedLookup = await runFilesLookup(
        { paths: ["src/sdk/files.ts"], limit: 10 },
        { path: context.pmPath },
      );
      expect(indexedLookup.completeness).toEqual({
        status: "unchecked",
        source: "index",
      });
      const [item] = await listAllItemMetadata(
        context.pmPath,
        settings.item_format,
        typeRegistry.type_to_folder,
        undefined,
        settings.schema,
      );
      expect(item).toBeDefined();
      const indexState = await readItemMetadataDerivedIndexState(
        context.pmPath,
      );
      expect(indexState).not.toBeNull();
      await rebuildItemMetadataQueryIndex({
        pmRoot: context.pmPath,
        contextFingerprint: "test-context",
        sourceCursor: "test-cursor",
        rows: [
          {
            relativePath: `tasks/${id}.toon`,
            metadata: { ...item!, files: undefined },
            linkedFiles: [
              ...(item!.files ?? []),
              { path: "src/no-note.ts", scope: "project" },
            ],
          },
        ],
      });

      const result = await queryLinkedFileMetadataIndex({
        pmRoot: context.pmPath,
        expectedSourceCursor: "test-cursor",
        paths: ["src/sdk/files.ts", "src/no-note.ts"],
        limit: 10,
      });

      expect(result).toMatchObject({
        source_cursor: "test-cursor",
        total: 1,
        matches: [
          {
            item: { id },
            files: [
              {
                path: "src/no-note.ts",
                scope: "project",
              },
              {
                path: "src/sdk/files.ts",
                scope: "project",
                note: "indexed",
              },
            ],
          },
        ],
      });
      await expect(
        queryLinkedFileMetadataIndex({
          pmRoot: context.pmPath,
          expectedSourceCursor: "stale-cursor",
          paths: ["src/sdk/files.ts"],
        }),
      ).resolves.toBeNull();
      await expect(
        queryLinkedFileMetadataIndex({
          pmRoot: context.pmPath,
          expectedSourceCursor: "test-cursor",
          paths: [],
        }),
      ).resolves.toBeNull();
      await expect(
        queryLinkedFileMetadataIndex({
          pmRoot: context.pmPath,
          expectedSourceCursor: "test-cursor",
          paths: ["src/sdk/files.ts"],
          scope: "global",
          limit: 0,
          offset: 1,
        }),
      ).resolves.toMatchObject({ total: 0, matches: [] });
      const queryIndexPath = path.join(
        context.pmPath,
        "runtime",
        "metadata-query-index.sqlite",
      );
      const database = new DatabaseSync(queryIndexPath);
      database
        .prepare("UPDATE items SET metadata_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...item!, id: "pm-projection-mismatch" }), id);
      database.close();
      await expect(
        queryLinkedFileMetadataIndex({
          pmRoot: context.pmPath,
          expectedSourceCursor: "test-cursor",
          paths: ["src/sdk/files.ts"],
        }),
      ).resolves.toMatchObject({
        matches: [
          {
            item: { id: "pm-projection-mismatch" },
            files: [
              {
                path: "src/sdk/files.ts",
                scope: "project",
                note: "indexed",
              },
            ],
          },
        ],
      });
      await fs.writeFile(queryIndexPath, "invalid sqlite", "utf8");
      await expect(
        queryLinkedFileMetadataIndex({
          pmRoot: context.pmPath,
          expectedSourceCursor: "test-cursor",
          paths: ["src/sdk/files.ts"],
        }),
      ).resolves.toBeNull();
    });
  });

  it("classifies compound lock-acquisition failures without generic lock false positives", () => {
    const base = {
      stdout: "",
      spawnError: undefined,
      signal: null,
      timedOut: false,
      maxBufferExceeded: false,
    };
    expect(
      classifyLinkedTestFailure({
        ...base,
        stderr:
          "Could not acquire workspace lock: another process is already running",
      }),
    ).toBe("infra_collision");
    expect(
      classifyLinkedTestFailure({
        ...base,
        stderr:
          "Assertion failed: lock metadata should be retained after timeout",
      }),
    ).toBe("assertion_failure");
    expect(
      classifyLinkedTestFailure({
        ...base,
        stderr:
          "Could not acquire workspace lock\nAssertion failed after timeout",
      }),
    ).toBe("assertion_failure");
  });

  it("distinguishes partial queue progress from complete telemetry draining", async () => {
    await withTempGlobalRoot(
      "pm-cli-telemetry-partial-drain-",
      async (globalRoot) => {
        process.env.PM_GLOBAL_PATH = globalRoot;
        const settings = await readSettings(globalRoot);
        settings.telemetry.enabled = true;
        settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
        settings.telemetry.installation_id = "test-installation";
        await writeSettings(globalRoot, settings, "test:partial_flush");
        const queuePath = path.join(
          globalRoot,
          "runtime",
          "telemetry",
          "events.jsonl",
        );
        await fs.mkdir(path.dirname(queuePath), { recursive: true });
        const occurredAt = new Date().toISOString();
        await fs.writeFile(
          queuePath,
          `${Array.from({ length: 101 }, (_, index) =>
            JSON.stringify({
              client_schema_version: 1,
              attempts: 0,
              event: {
                event_id: `evt-${index}`,
                event_type: "command_finish",
                schema_version: 1,
                occurred_at: occurredAt,
                installation_id: "test-installation",
                session_id: "session-a",
                command: "list-open",
                payload: {},
              },
            }),
          ).join("\n")}\n`,
          "utf8",
        );
        globalThis.fetch = vi.fn(
          async () => new Response("ok", { status: 200 }),
        ) as unknown as typeof fetch;

        const result = await runTelemetry({ subcommand: "flush" }, {});

        expect(result).toMatchObject({
          queue_entries_before: 101,
          queue_entries_after: 1,
          queue_entries_drained: 100,
          queue_progressed: true,
          queue_empty: false,
          queue_drained: false,
        });
      },
    );
  });
});
