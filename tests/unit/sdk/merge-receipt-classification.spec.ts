/**
 * @module tests/unit/sdk/merge-receipt-classification
 *
 * Verifies that blocking receipt reads exclude lossless merge provenance while
 * the explicit report retains the complete local merge history.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listMergeReceipts,
  partitionMergeReceipts,
  runMergeReceiptReport,
  writeMergeReceipt,
} from "../../../src/sdk/merge/receipts.js";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("merge receipt classification", () => {
  it("blocks only lossy receipts while reporting both receipt classes", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pm-receipts-"));
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryDirectory });

    await writeMergeReceipt({
      cwd: temporaryDirectory,
      itemPath: ".agents/pm/items/pm-lossless.toon",
      preferred: "ours",
      fieldsFromTheirs: ["status"],
      unionFields: ["comments"],
      decisions: [],
    });
    await writeMergeReceipt({
      cwd: temporaryDirectory,
      itemPath: ".agents/pm/items/pm-lossy.toon",
      preferred: "ours",
      fieldsFromTheirs: [],
      unionFields: [],
      decisions: [
        {
          field: "title",
          base: "base",
          ours: "alpha",
          theirs: "zeta",
          retained: "alpha",
          discarded: "zeta",
        },
      ],
    });

    expect(
      (
        await listMergeReceipts(temporaryDirectory, { includeLossless: false })
      ).map(({ item_id }) => item_id),
    ).toEqual(["pm-lossy"]);
    expect(
      (await runMergeReceiptReport({ cwd: temporaryDirectory })).count,
    ).toBe(2);
    const partitioned = partitionMergeReceipts(
      await listMergeReceipts(temporaryDirectory),
    );
    expect(partitioned.pendingDecisions.map(({ item_id }) => item_id)).toEqual([
      "pm-lossy",
    ]);
    expect(partitioned.lossless.map(({ item_id }) => item_id)).toEqual([
      "pm-lossless",
    ]);
  });
});
