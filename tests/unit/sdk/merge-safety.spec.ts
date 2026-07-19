import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHistoryEntry } from "../../../src/core/history/history.js";
import {
  historyEntriesToRaw,
  verifyHistoryChain,
} from "../../../src/core/history/replay.js";
import {
  parseItemDocument,
  serializeItemDocument,
} from "../../../src/core/item/item-format.js";
import {
  mergeHistoryStreams,
  mergeItemDocuments,
  mergeJsonDocuments,
  runMergeDriver,
  runMergeInstall,
} from "../../../src/sdk/index.js";
import type { ItemDocument } from "../../../src/types/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const workspaces: string[] = [];

function item(title: string, updatedAt: string): ItemDocument {
  return {
    metadata: {
      id: "pm-merge",
      title,
      description: "merge safety",
      type: "Task",
      status: "open",
      priority: 2,
      tags: [],
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: updatedAt,
    },
    body: "",
  };
}

describe("public merge-safety SDK primitives", () => {
  afterEach(async () => {
    await Promise.all(
      workspaces
        .splice(0)
        .map((workspace) => rm(workspace, { recursive: true, force: true })),
    );
  });

  it("merges concurrent item collection appends and recomputes TOON headers", () => {
    const base = item("base", "2026-07-19T00:00:00.000Z");
    const ours = structuredClone(base);
    ours.metadata.tags = ["ours"];
    ours.metadata.updated_at = "2026-07-19T00:01:00.000Z";
    const theirs = structuredClone(base);
    theirs.metadata.notes = [
      {
        text: "theirs note",
        author: "agent-b",
        created_at: "2026-07-19T00:02:00.000Z",
      },
    ];
    theirs.metadata.updated_at = "2026-07-19T00:02:00.000Z";

    const merged = mergeItemDocuments(
      serializeItemDocument(base, { format: "toon" }),
      serializeItemDocument(ours, { format: "toon" }),
      serializeItemDocument(theirs, { format: "toon" }),
      { format: "toon" },
    );
    const parsed = parseItemDocument(merged.merged, { format: "toon" });

    expect(merged.conflict_fields).toEqual([]);
    expect(parsed.metadata.tags).toEqual(["ours"]);
    expect(parsed.metadata.notes?.map((note) => note.text)).toEqual([
      "theirs note",
    ]);
    expect(parsed.metadata.updated_at).toBe("2026-07-19T00:02:00.000Z");
    expect(merged.merged).toContain("notes[1]");
  });

  it("reports add/add body divergence and honors the preferred side", () => {
    const ours = item("ours", "2026-07-19T00:01:00.000Z");
    ours.body = "ours body";
    const theirs = item("theirs", "2026-07-19T00:02:00.000Z");
    theirs.body = "theirs body";
    const merged = mergeItemDocuments(
      "",
      serializeItemDocument(ours, { format: "toon" }),
      serializeItemDocument(theirs, { format: "toon" }),
      { format: "toon", preferred: "ours" },
    );

    expect(merged.conflict_fields).toContain("body");
    expect(parseItemDocument(merged.merged, { format: "toon" }).body).toBe(
      "ours body",
    );

    ours.body = "";
    const oneSidedBody = mergeItemDocuments(
      "",
      serializeItemDocument(ours, { format: "toon" }),
      serializeItemDocument(theirs, { format: "toon" }),
      { format: "toon" },
    );
    expect(oneSidedBody.fields_from_theirs).toContain("body");
  });

  it("preserves both divergent history suffixes and emits a valid chain", () => {
    const empty: ItemDocument = {
      metadata: {} as ItemDocument["metadata"],
      body: "",
    };
    const baseDocument = item("base", "2026-07-19T00:00:00.000Z");
    const create = createHistoryEntry({
      nowIso: "2026-07-19T00:00:00.000Z",
      author: "seed",
      op: "create",
      before: empty,
      after: baseDocument,
    });
    const oursDocument = item("ours", "2026-07-19T00:01:00.000Z");
    const theirsDocument = item("theirs", "2026-07-19T00:02:00.000Z");
    const ours = createHistoryEntry({
      nowIso: "2026-07-19T00:01:00.000Z",
      author: "agent-a",
      op: "update",
      before: baseDocument,
      after: oursDocument,
    });
    const theirs = createHistoryEntry({
      nowIso: "2026-07-19T00:02:00.000Z",
      author: "agent-b",
      op: "update",
      before: baseDocument,
      after: theirsDocument,
    });

    const result = mergeHistoryStreams(
      historyEntriesToRaw([create]),
      historyEntriesToRaw([create, ours]),
      historyEntriesToRaw([create, theirs]),
    );
    const entries = result.merged
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as typeof create);

    expect(result.strategy).toBe("union_reanchor");
    expect(entries.map((entry) => entry.author)).toEqual([
      "seed",
      "agent-a",
      "agent-b",
    ]);
    expect(verifyHistoryChain(entries)).toEqual({ ok: true, errors: [] });
  });

  it("covers identical and one-sided history merges plus malformed inputs", () => {
    const empty: ItemDocument = {
      metadata: {} as ItemDocument["metadata"],
      body: "",
    };
    const created = item("base", "2026-07-19T00:00:00.000Z");
    const entry = createHistoryEntry({
      nowIso: "2026-07-19T00:00:00.000Z",
      author: "seed",
      op: "create",
      before: empty,
      after: created,
    });
    const updated = item("updated", "2026-07-19T00:01:00.000Z");
    const update = createHistoryEntry({
      nowIso: "2026-07-19T00:01:00.000Z",
      author: "agent-a",
      op: "update",
      before: created,
      after: updated,
    });
    const baseRaw = historyEntriesToRaw([entry]);
    const advancedRaw = historyEntriesToRaw([entry, update]);

    expect(mergeHistoryStreams(baseRaw, baseRaw, baseRaw).strategy).toBe(
      "identical",
    );
    expect(mergeHistoryStreams(baseRaw, advancedRaw, baseRaw).strategy).toBe(
      "fast_forward_ours",
    );
    expect(mergeHistoryStreams(baseRaw, baseRaw, advancedRaw).strategy).toBe(
      "fast_forward_theirs",
    );
    expect(() => mergeHistoryStreams("", "<<<<<<< ours\n", baseRaw)).toThrow(
      /conflict markers/,
    );
    expect(() => mergeHistoryStreams("", "not-json\n", baseRaw)).toThrow(
      /invalid JSON/,
    );
  });

  it("merges disjoint nested JSON keys and reports real leaf conflicts", () => {
    const result = mergeJsonDocuments(
      '{"governance":{"strict":false},"search":{"limit":10}}\n',
      '{"governance":{"strict":true},"search":{"limit":10}}\n',
      '{"governance":{"strict":false},"search":{"limit":20}}\n',
    );
    expect(JSON.parse(result.merged)).toEqual({
      governance: { strict: true },
      search: { limit: 20 },
    });
    expect(result.conflict_paths).toEqual([]);

    const conflict = mergeJsonDocuments(
      '{"value":1}\n',
      '{"value":2}\n',
      '{"value":3}\n',
    );
    expect(conflict.conflict_paths).toEqual(["value"]);
    expect(JSON.parse(conflict.merged)).toEqual({ value: 2 });
  });

  it("covers item conflicts, add/add documents, and JSON add/delete semantics", () => {
    const base = item("base", "2026-07-19T00:00:00.000Z");
    const ours = item("ours", "2026-07-19T00:01:00.000Z");
    ours.body = "ours body";
    const theirs = item("theirs", "2026-07-19T00:02:00.000Z");
    theirs.body = "theirs body";
    const merged = mergeItemDocuments(
      serializeItemDocument(base, { format: "toon" }),
      serializeItemDocument(ours, { format: "toon" }),
      serializeItemDocument(theirs, { format: "toon" }),
      { format: "toon", preferred: "theirs" },
    );
    expect(merged.conflict_fields).toEqual(["title", "body"]);
    expect(
      parseItemDocument(merged.merged, { format: "toon" }).metadata.title,
    ).toBe("theirs");

    const addAdd = mergeItemDocuments(
      "",
      serializeItemDocument(ours, { format: "toon" }),
      serializeItemDocument(theirs, { format: "toon" }),
      { format: "toon" },
    );
    expect(addAdd.conflict_fields).toContain("title");
    expect(() =>
      mergeItemDocuments(
        "",
        "invalid",
        serializeItemDocument(theirs, { format: "toon" }),
      ),
    ).toThrow(/ours.*readable item document/);

    expect(
      JSON.parse(mergeJsonDocuments("", "", '{"added":1}\n').merged),
    ).toEqual({ added: 1 });
    expect(
      JSON.parse(
        mergeJsonDocuments('{"remove":1}\n', '{"remove":1}\n', "{}\n").merged,
      ),
    ).toEqual({});
    expect(() => mergeJsonDocuments("{}", "<<<<<<< ours", "{}")).toThrow(
      /conflict markers/,
    );
    expect(() => mergeJsonDocuments("{}", "invalid", "{}")).toThrow(
      /not valid JSON/,
    );
  });

  it("covers deterministic tie ordering, collection deletions, and JSON delete conflicts", () => {
    const empty: ItemDocument = {
      metadata: {} as ItemDocument["metadata"],
      body: "",
    };
    const base = item("base", "2026-07-19T00:00:00.000Z");
    const create = createHistoryEntry({
      nowIso: "2026-07-19T00:00:00.000Z",
      author: "seed",
      op: "create",
      before: empty,
      after: base,
    });
    const oursUpdate = createHistoryEntry({
      nowIso: "2026-07-19T00:01:00.000Z",
      author: "a",
      op: "update",
      before: base,
      after: item("a", "2026-07-19T00:01:00.000Z"),
    });
    const oursSecond = createHistoryEntry({
      nowIso: "2026-07-19T00:01:00.000Z",
      author: "z",
      op: "update",
      before: base,
      after: item("z", "2026-07-19T00:01:00.000Z"),
    });
    const theirsUpdate = createHistoryEntry({
      nowIso: "2026-07-19T00:01:00.000Z",
      author: "b",
      op: "update",
      before: base,
      after: item("b", "2026-07-19T00:01:00.000Z"),
    });
    const tied = mergeHistoryStreams(
      historyEntriesToRaw([create]),
      historyEntriesToRaw([create, oursUpdate, oursSecond]),
      historyEntriesToRaw([create, theirsUpdate]),
    );
    expect(tied.entries_from_ours).toBe(2);
    expect(tied.entries_from_theirs).toBe(1);

    const collectionBase = item("base", "2026-07-19T00:00:00.000Z");
    collectionBase.metadata.tags = ["remove", "keep"];
    collectionBase.metadata.assignee = "agent-a";
    const collectionOurs = structuredClone(collectionBase);
    collectionOurs.metadata.tags = ["remove", "keep", "ours"];
    collectionOurs.metadata.description = "ours description";
    const collectionTheirs = structuredClone(collectionBase);
    collectionTheirs.metadata.tags = ["keep", "theirs"];
    collectionTheirs.metadata.description = "base";
    collectionTheirs.metadata.priority = 1;
    delete collectionTheirs.metadata.assignee;
    const collectionMerged = mergeItemDocuments(
      serializeItemDocument(collectionBase, { format: "toon" }),
      serializeItemDocument(collectionOurs, { format: "toon" }),
      serializeItemDocument(collectionTheirs, { format: "toon" }),
      { format: "toon" },
    );
    expect(
      parseItemDocument(collectionMerged.merged, { format: "toon" }).metadata
        .tags,
    ).toEqual(["keep", "ours", "theirs"]);
    expect(collectionMerged.fields_from_theirs).toContain("priority");
    expect(collectionMerged.fields_from_theirs).toContain("assignee");

    expect(
      mergeJsonDocuments('{"value":1}', '{"value":2}', "{}").conflict_paths,
    ).toEqual(["value"]);
    expect(
      mergeJsonDocuments('{"value":1}', '{"value":2}', "{}", {
        preferred: "theirs",
      }).merged,
    ).toBe("{}\n");
    expect(
      mergeJsonDocuments('{"value":1}', "{}", '{"value":2}').conflict_paths,
    ).toEqual(["value"]);
    expect(
      JSON.parse(
        mergeJsonDocuments('{"value":1}', "{}", '{"value":2}', {
          preferred: "theirs",
        }).merged,
      ),
    ).toEqual({ value: 2 });
    expect(mergeJsonDocuments('{"value":1}', "{}", '{"value":1}').merged).toBe(
      "{}\n",
    );
    expect(
      mergeJsonDocuments("{}", "{}", '{"value":2}').paths_from_theirs,
    ).toEqual(["value"]);
    expect(
      JSON.parse(mergeJsonDocuments("", '{"onlyOurs":1}', "").merged),
    ).toEqual({ onlyOurs: 1 });
    expect(mergeJsonDocuments("", "", "").merged).toBe("null\n");
    expect(
      JSON.parse(mergeJsonDocuments("[]", '{"left":1}', '{"right":2}').merged),
    ).toEqual({ left: 1, right: 2 });
    expect(mergeJsonDocuments("null", "null", "null").merged).toBe("null\n");
    expect(mergeJsonDocuments('{"schema":1}', "", '{"schema":1}').merged).toBe(
      "null\n",
    );
    expect(
      mergeJsonDocuments('{"schema":1}', "", '{"schema":2}').conflict_paths,
    ).toEqual([""]);
  });

  it("executes the file-level driver protocol and leaves parseable output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-merge-driver-"));
    workspaces.push(workspace);
    const base = path.join(workspace, "base.json");
    const ours = path.join(workspace, "ours.json");
    const theirs = path.join(workspace, "theirs.json");
    await Promise.all([
      writeFile(base, '{"value":1}\n', "utf8"),
      writeFile(ours, '{"value":2}\n', "utf8"),
      writeFile(theirs, '{"value":3}\n', "utf8"),
    ]);

    const result = await runMergeDriver(
      { artifact: "json", basePath: base, oursPath: ours, theirsPath: theirs },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(["value"]);
    expect(JSON.parse(await readFile(ours, "utf8"))).toEqual({ value: 2 });

    const priorCwd = process.cwd();
    try {
      process.chdir(workspace);
      expect(
        (
          await runMergeDriver(
            {
              artifact: "json",
              basePath: base,
              oursPath: ours,
              theirsPath: theirs,
            },
            { path: path.join(workspace, "missing-pm") },
          )
        ).ok,
      ).toBe(false);
    } finally {
      process.chdir(priorCwd);
    }

    const itemBase = item("base", "2026-07-19T00:00:00.000Z");
    await Promise.all([
      writeFile(
        base,
        serializeItemDocument(itemBase, { format: "toon" }),
        "utf8",
      ),
      writeFile(
        ours,
        serializeItemDocument(item("ours", "2026-07-19T00:01:00.000Z"), {
          format: "toon",
        }),
        "utf8",
      ),
      writeFile(
        theirs,
        serializeItemDocument(itemBase, { format: "toon" }),
        "utf8",
      ),
    ]);
    const priorItemCwd = process.cwd();
    try {
      process.chdir(workspace);
      expect(
        (
          await runMergeDriver(
            {
              artifact: "item",
              basePath: base,
              oursPath: ours,
              theirsPath: theirs,
            },
            { path: path.join(workspace, "missing-pm") },
          )
        ).ok,
      ).toBe(true);

      await Promise.all([
        writeFile(
          base,
          serializeItemDocument(itemBase, { format: "json_markdown" }),
          "utf8",
        ),
        writeFile(
          ours,
          serializeItemDocument(item("ours", "2026-07-19T00:01:00.000Z"), {
            format: "json_markdown",
          }),
          "utf8",
        ),
        writeFile(
          theirs,
          serializeItemDocument(itemBase, { format: "json_markdown" }),
          "utf8",
        ),
      ]);
      expect(
        (
          await runMergeDriver(
            {
              artifact: "item",
              basePath: base,
              oursPath: ours,
              theirsPath: theirs,
              itemPath: ".agents/pm/tasks/pm-merge.md",
            },
            { path: path.join(workspace, "missing-pm") },
          )
        ).ok,
      ).toBe(true);
    } finally {
      process.chdir(priorItemCwd);
    }
  });

  it("runs item/history drivers and validates driver options", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-merge-driver-kinds-"),
    );
    workspaces.push(workspace);
    const basePath = path.join(workspace, "base.toon");
    const oursPath = path.join(workspace, "ours.toon");
    const theirsPath = path.join(workspace, "theirs.toon");
    const base = item("base", "2026-07-19T00:00:00.000Z");
    const ours = structuredClone(base);
    ours.metadata.tags = ["ours"];
    const theirs = structuredClone(base);
    theirs.metadata.notes = [
      { text: "theirs", created_at: "2026-07-19T00:01:00.000Z" },
    ];
    await Promise.all([
      writeFile(
        basePath,
        serializeItemDocument(base, { format: "toon" }),
        "utf8",
      ),
      writeFile(
        oursPath,
        serializeItemDocument(ours, { format: "toon" }),
        "utf8",
      ),
      writeFile(
        theirsPath,
        serializeItemDocument(theirs, { format: "toon" }),
        "utf8",
      ),
    ]);
    expect(
      (
        await runMergeDriver(
          {
            artifact: "item",
            basePath,
            oursPath,
            theirsPath,
            prefer: "theirs",
          },
          {},
        )
      ).ok,
    ).toBe(true);

    const empty: ItemDocument = {
      metadata: {} as ItemDocument["metadata"],
      body: "",
    };
    const create = createHistoryEntry({
      nowIso: "2026-07-19T00:00:00.000Z",
      author: "seed",
      op: "create",
      before: empty,
      after: base,
    });
    const oursUpdate = createHistoryEntry({
      nowIso: "2026-07-19T00:01:00.000Z",
      author: "a",
      op: "update",
      before: base,
      after: item("a", "2026-07-19T00:01:00.000Z"),
    });
    const theirsUpdate = createHistoryEntry({
      nowIso: "2026-07-19T00:02:00.000Z",
      author: "b",
      op: "update",
      before: base,
      after: item("b", "2026-07-19T00:02:00.000Z"),
    });
    await Promise.all([
      writeFile(basePath, historyEntriesToRaw([create]), "utf8"),
      writeFile(oursPath, historyEntriesToRaw([create, oursUpdate]), "utf8"),
      writeFile(
        theirsPath,
        historyEntriesToRaw([create, theirsUpdate]),
        "utf8",
      ),
    ]);
    const history = await runMergeDriver(
      { artifact: "history", basePath, oursPath, theirsPath },
      {},
    );
    expect(history.history?.reanchored).toBe(true);
    expect(history.guidance).toHaveLength(1);
    await expect(
      runMergeDriver(
        { artifact: "unknown", basePath, oursPath, theirsPath },
        {},
      ),
    ).rejects.toThrow(/Unknown merge artifact/);
    await expect(
      runMergeDriver(
        { artifact: "json", basePath, oursPath, theirsPath, prefer: "middle" },
        {},
      ),
    ).rejects.toThrow(/Unknown --prefer/);
    await expect(
      runMergeDriver(
        {
          artifact: "json",
          basePath: path.join(workspace, "missing"),
          oursPath,
          theirsPath,
        },
        {},
      ),
    ).rejects.toThrow(/Cannot read merge base/);
    await Promise.all([
      writeFile(basePath, "null\n", "utf8"),
      writeFile(oursPath, "null\n", "utf8"),
      writeFile(theirsPath, "null\n", "utf8"),
    ]);
    expect(() => mergeHistoryStreams("null\n", "null\n", "null\n")).toThrow(
      /invalid JSON at line 1/,
    );
  });

  it("installs idempotent git attributes/config and exercises the CLI adapter", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const priorCwd = process.cwd();
      process.chdir(context.tempRoot);
      const preview = await runMergeInstall(
        { dryRun: true },
        { path: context.pmPath },
      );
      expect(preview.dry_run).toBe(true);
      expect(preview.gitattributes.changed).toBe(true);
      expect(preview.gitattributes.patterns).toContain(
        '".agents/pm/tasks/*.toon" merge=pm-item-toon',
      );

      const installed = await runMergeInstall({}, { path: context.pmPath });
      expect(installed.git_config).toHaveLength(8);
      expect(
        installed.git_config.find(
          (entry) => entry.key === "merge.pm-item-toon.driver",
        )?.value,
      ).toBe('pm merge driver item "%O" "%A" "%B" --item-path item.toon');
      expect(
        installed.git_config.find(
          (entry) => entry.key === "merge.pm-item-markdown.driver",
        )?.value,
      ).toBe('pm merge driver item "%O" "%A" "%B" --item-path item.md');
      expect(
        installed.git_config.every((entry) => !entry.value.includes("%P")),
      ).toBe(true);
      expect(
        await readFile(path.join(context.tempRoot, ".gitattributes"), "utf8"),
      ).toContain("# pm-cli:merge-drivers:start");
      expect(
        (await runMergeInstall({}, { path: context.pmPath })).gitattributes
          .changed,
      ).toBe(false);
      await writeFile(
        path.join(context.tempRoot, ".gitattributes"),
        "*.bin binary\n# pm-cli:merge-drivers:start\n.agents/pm/tasks/*.toon merge=pm-item-toon\n",
        "utf8",
      );
      await runMergeInstall({}, { path: context.pmPath });
      const repairedAttributes = await readFile(
        path.join(context.tempRoot, ".gitattributes"),
        "utf8",
      );
      expect(
        repairedAttributes.match(/# pm-cli:merge-drivers:start/g),
      ).toHaveLength(1);
      expect(repairedAttributes).toContain("*.bin binary");

      await writeFile(
        path.join(context.tempRoot, "settings.json"),
        await readFile(path.join(context.pmPath, "settings.json"), "utf8"),
        "utf8",
      );
      await writeFile(
        path.join(context.tempRoot, ".gitattributes"),
        "*.bin binary\n",
        "utf8",
      );
      expect(
        (await runMergeInstall({ dryRun: true }, { path: context.tempRoot }))
          .gitattributes.patterns,
      ).toContain('"tasks/*.toon" merge=pm-item-toon');
      const spacedRoot = path.join(context.tempRoot, "Project Docs", "pm");
      await mkdir(spacedRoot, { recursive: true });
      await writeFile(
        path.join(spacedRoot, "settings.json"),
        await readFile(path.join(context.pmPath, "settings.json"), "utf8"),
        "utf8",
      );
      expect(
        (await runMergeInstall({ dryRun: true }, { path: spacedRoot }))
          .gitattributes.patterns,
      ).toContain('"Project Docs/pm/tasks/*.toon" merge=pm-item-toon');
      await runMergeInstall({}, { path: spacedRoot });
      expect(
        execFileSync(
          "git",
          ["check-attr", "merge", "--", "Project Docs/pm/tasks/pm-space.toon"],
          { cwd: context.tempRoot, encoding: "utf8" },
        ),
      ).toContain("merge: pm-item-toon");

      const dotDotNamedRoot = path.join(context.tempRoot, "..pm");
      await mkdir(dotDotNamedRoot, { recursive: true });
      await writeFile(
        path.join(dotDotNamedRoot, "settings.json"),
        await readFile(path.join(context.pmPath, "settings.json"), "utf8"),
        "utf8",
      );
      expect(
        (await runMergeInstall({ dryRun: true }, { path: dotDotNamedRoot }))
          .gitattributes.patterns,
      ).toContain('"..pm/tasks/*.toon" merge=pm-item-toon');
      process.chdir(priorCwd);

      const cliPreview = await context.runCliInProcess(
        ["--profile", "merge", "install", "--dry-run", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(cliPreview.code).toBe(0);
      expect(cliPreview.stderr).toContain("profile:command=merge");
      const wrongInstall = await context.runCliInProcess(
        ["merge", "install", "extra", "--json"],
        {
          cwd: context.tempRoot,
          expectJson: true,
        },
      );
      expect(wrongInstall.code).toBe(2);
      const missingDriver = await context.runCliInProcess(
        ["merge", "driver", "json", "--json"],
        {
          cwd: context.tempRoot,
          expectJson: true,
        },
      );
      expect(missingDriver.code).toBe(2);
      const unknown = await context.runCliInProcess(
        ["merge", "unknown", "--json"],
        {
          cwd: context.tempRoot,
          expectJson: true,
        },
      );
      expect(unknown.code).toBe(2);
    });

    const notGit = await mkdtemp(path.join(os.tmpdir(), "pm-merge-not-git-"));
    workspaces.push(notGit);
    await expect(
      runMergeInstall({}, { path: path.join(notGit, ".agents", "pm") }),
    ).rejects.toThrow(/not initialized/);
  });

  it("selects item formats from paths/settings and rejects an external tracker root", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const base = item("base", "2026-07-19T00:00:00.000Z");
      const ours = item("ours", "2026-07-19T00:01:00.000Z");
      const theirs = item("base", "2026-07-19T00:00:00.000Z");
      for (const extension of [".md", ""] as const) {
        const format = extension === ".md" ? "json_markdown" : "toon";
        const basePath = path.join(context.tempRoot, `base${extension}`);
        const oursPath = path.join(context.tempRoot, `ours${extension}`);
        const theirsPath = path.join(context.tempRoot, `theirs${extension}`);
        await Promise.all([
          writeFile(basePath, serializeItemDocument(base, { format }), "utf8"),
          writeFile(oursPath, serializeItemDocument(ours, { format }), "utf8"),
          writeFile(
            theirsPath,
            serializeItemDocument(theirs, { format }),
            "utf8",
          ),
        ]);
        const priorCwd = process.cwd();
        try {
          process.chdir(context.tempRoot);
          expect(
            (
              await runMergeDriver(
                { artifact: "item", basePath, oursPath, theirsPath },
                { path: context.pmPath },
              )
            ).ok,
          ).toBe(true);
        } finally {
          process.chdir(priorCwd);
        }
      }

      const nestedRepo = await mkdtemp(
        path.join(os.tmpdir(), "pm-merge-nested-git-"),
      );
      workspaces.push(nestedRepo);
      execFileSync("git", ["init", "-q"], { cwd: nestedRepo });
      const priorCwd = process.cwd();
      try {
        process.chdir(nestedRepo);
        await expect(
          runMergeInstall({}, { path: context.pmPath }),
        ).rejects.toThrow(/outside the git repository/);
      } finally {
        process.chdir(priorCwd);
      }
    });
  });

  it("rejects an initialized tracker outside a git repository", async () => {
    await withTempPmPath(async (context) => {
      const priorCwd = process.cwd();
      try {
        process.chdir(context.tempRoot);
        await expect(
          runMergeInstall({}, { path: context.pmPath }),
        ).rejects.toThrow(/requires a git repository/);
      } finally {
        process.chdir(priorCwd);
      }
    });
  });

  it("propagates non-missing gitattributes read failures", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      await mkdir(path.join(context.tempRoot, ".gitattributes"));
      const priorCwd = process.cwd();
      try {
        process.chdir(context.tempRoot);
        await expect(
          runMergeInstall({}, { path: context.pmPath }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^(EISDIR|EACCES)$/),
        });
      } finally {
        process.chdir(priorCwd);
      }
    });
  });
});
