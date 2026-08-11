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
      itemPath: '".agents/pm/tasks/pm-double-quoted.toon"',
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
    expect(receipt).toMatchObject({ requested_preference: "ours" });
    expect(receipt).not.toHaveProperty("preferred");
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
      requested_preference: "ours",
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
    expect(
      summarizeMergeReceipt({
        ...receipt!,
        requested_preference: undefined,
        preferred: "theirs",
      }).requested_preference,
    ).toBe("theirs");
    expect(
      summarizeMergeReceipt({
        ...receipt!,
        requested_preference: undefined,
        preferred: undefined,
      }).requested_preference,
    ).toBe("ours");
    expect(
      summarizeMergeReceipt({
        ...receipt!,
        decisions: [
          {
            field: "title",
            base: null,
            ours: null,
            theirs: null,
            retained: { pm_value_hash: "not-a-hash" },
            discarded: null,
          },
        ],
      }).decisions[0]?.retained_hash,
    ).toMatch(/^[a-f0-9]{64}$/);

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
      conflict_resolution: "preferred_side",
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
    await writeFile(
      path.join(receiptDirectory, "legacy.json"),
      JSON.stringify({
        version: 1,
        id: "legacy",
        item_path: ".agents/pm/tasks/pm-legacy.toon",
        item_id: "pm-legacy",
        preferred: "ours",
        fields_from_theirs: [],
        union_fields: [],
        decisions: [],
        state: "pending",
        created_at: "2026-07-27T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      path.join(receiptDirectory, "pre-preference.json"),
      JSON.stringify({
        version: 1,
        id: "pre-preference",
        item_path: ".agents/pm/tasks/pm-pre-preference.toon",
        item_id: "pm-pre-preference",
        fields_from_theirs: [],
        union_fields: [],
        decisions: [],
        state: "pending",
        created_at: "2026-07-26T00:00:00.000Z",
      }),
      "utf8",
    );
    expect(await listMergeReceipts(workspace)).toMatchObject([
      {
        id: "pre-preference",
        requested_preference: "ours",
        conflict_resolution: "preferred_side",
      },
      {
        id: "legacy",
        requested_preference: "ours",
        conflict_resolution: "preferred_side",
      },
    ]);
    expect((await listMergeReceipts(workspace))[0]).not.toHaveProperty(
      "preferred",
    );
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

  it("carries privacy-safe decision evidence into a fresh clone", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "pm-receipts-source-"),
    );
    const clone = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-clone-"));
    workspaces.push(workspace, clone);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "PM Test"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "pm-test@example.invalid"], {
      cwd: workspace,
    });
    const pmRoot = path.join(workspace, ".agents", "pm");
    await mkdir(path.join(pmRoot, "tasks"), { recursive: true });
    await writeFile(path.join(pmRoot, "settings.json"), "{}\n");
    const receipt = await writeMergeReceipt({
      cwd: workspace,
      itemPath: ".agents/pm/tasks/pm-durable.toon",
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [
        {
          field: "title",
          base: "base-private",
          ours: "ours-private",
          theirs: "theirs-private",
          retained: "ours-private",
          discarded: "theirs-private",
        },
      ],
    });
    execFileSync("git", ["add", ".agents/pm"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "Track durable merge evidence"], {
      cwd: workspace,
    });
    await rm(clone, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", workspace, clone]);

    const clonedReceipts = await listMergeReceipts(clone, {
      pmRoot: path.join(clone, ".agents", "pm"),
    });
    expect(clonedReceipts).toHaveLength(1);
    expect(clonedReceipts[0]).toMatchObject({
      id: receipt?.id,
      state: "pending",
      value_availability: "hash_only",
    });
    const serialized = JSON.stringify(clonedReceipts[0]);
    expect(serialized).not.toContain("private");
    expect(summarizeMergeReceipt(clonedReceipts[0]!)).toEqual(
      summarizeMergeReceipt(receipt!),
    );
    await markMergeReceiptReconciled(clone, clonedReceipts[0]!);
    expect(
      await listMergeReceipts(clone, {
        pmRoot: path.join(clone, ".agents", "pm"),
      }),
    ).toEqual([]);
    expect(
      await listMergeReceipts(clone, {
        includeReconciled: true,
        pmRoot: path.join(clone, ".agents", "pm"),
      }),
    ).toMatchObject([{ state: "reconciled", value_availability: "hash_only" }]);
    await markMergeReceiptReconciled(clone, {
      ...clonedReceipts[0]!,
      id: "durable-sidecar-missing",
    });
  });
});
