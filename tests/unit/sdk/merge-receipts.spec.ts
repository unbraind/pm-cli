import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listMergeReceipts,
  markMergeReceiptReconciled,
  runMergeReceiptReport,
  summarizeMergeReceipt,
  writeMergeReceipt,
} from "../../../src/sdk/merge/receipts.js";

const workspaces: string[] = [];

describe("clone-local merge decision receipts", () => {
  afterEach(async () => {
    await Promise.all(
      workspaces
        .splice(0)
        .map((workspace) => rm(workspace, { recursive: true, force: true })),
    );
  });

  it("preserves recoverable values locally and exposes privacy-safe summaries", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });

    const receipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: ".agents/pm/tasks/pm-merge.toon",
      preferred: "ours",
      fieldsFromTheirs: ["priority"],
      unionFields: ["comments"],
      decisions: [
        {
          field: "title",
          base: "base",
          ours: "retained",
          theirs: "discarded",
          retained: "retained",
          discarded: "discarded",
        },
      ],
    });
    const laterReceipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: ".agents/pm/tasks/pm-later.toon",
      preferred: "theirs",
      fieldsFromTheirs: [],
      unionFields: ["tags"],
      decisions: [],
    });
    const shellQuotedReceipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: "'.agents/pm/tasks/pm-shell-quoted.toon'",
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [],
    });
    const doubleQuotedReceipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: "\".agents/pm/tasks/pm-double-quoted.toon\"",
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [],
    });
    const receiptDirectory = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd: workspace, encoding: "utf8" },
    ).trim();
    await writeFile(path.join(receiptDirectory, "README"), "local only\n");

    expect(receipt).not.toBeNull();
    expect(laterReceipt).not.toBeNull();
    expect(shellQuotedReceipt).toMatchObject({
      item_path: ".agents/pm/tasks/pm-shell-quoted.toon",
      item_id: "pm-shell-quoted",
    });
    expect(doubleQuotedReceipt).toMatchObject({
      item_path: ".agents/pm/tasks/pm-double-quoted.toon",
      item_id: "pm-double-quoted",
    });
    expect(await listMergeReceipts(workspace)).toHaveLength(4);
    expect((await listMergeReceipts(workspace))[0]).toMatchObject({
      item_id: "pm-merge",
      state: "pending",
      decisions: [{ discarded: "discarded" }],
    });
    const summary = summarizeMergeReceipt(receipt!);
    expect(summary).toMatchObject({
      item_id: "pm-merge",
      conflict_fields: ["title"],
      decisions: [
        {
          field: "title",
          retained_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          discarded_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('"discarded"');

    await markMergeReceiptReconciled(workspace, receipt!);
    await markMergeReceiptReconciled(workspace, laterReceipt!);
    await markMergeReceiptReconciled(workspace, shellQuotedReceipt!);
    await markMergeReceiptReconciled(workspace, doubleQuotedReceipt!);
    expect(await listMergeReceipts(workspace)).toEqual([]);
    expect(
      await runMergeReceiptReport({
        cwd: workspace,
        includeReconciled: true,
      }),
    ).toMatchObject({
      ok: true,
      count: 4,
      receipts: [
        { state: "reconciled" },
        { state: "reconciled" },
        { state: "reconciled" },
        { state: "reconciled" },
      ],
    });
  });

  it("is a safe no-op outside Git and ignores damaged receipt files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    workspaces.push(workspace);
    expect(
      await writeMergeReceipt({
        cwd: workspace,
        itemPath: "tasks/pm-none.toon",
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: [],
        decisions: [],
      }),
    ).toBeNull();
    expect(await listMergeReceipts(workspace)).toEqual([]);
    await markMergeReceiptReconciled(workspace, {
      version: 1,
      id: "missing",
      item_path: "tasks/pm-none.toon",
      item_id: "pm-none",
      preferred: "ours",
      fields_from_theirs: [],
      union_fields: [],
      decisions: [],
      state: "pending",
      created_at: "2026-07-27T00:00:00.000Z",
    });

    execFileSync("git", ["init", "-q"], { cwd: workspace });
    const receiptDirectory = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "pm-merge-receipts",
      ],
      { cwd: workspace, encoding: "utf8" },
    ).trim();
    await mkdir(receiptDirectory, { recursive: true });
    await rm(receiptDirectory, { recursive: true });
    await writeFile(
      path.join(workspace, ".git", "pm-merge-receipts"),
      "not a directory",
      "utf8",
    );
    expect(receiptDirectory).toContain("pm-merge-receipts");
    expect(await listMergeReceipts(workspace)).toEqual([]);
    expect(await runMergeReceiptReport({})).toMatchObject({
      ok: true,
      count: expect.any(Number),
    });
  });
});
