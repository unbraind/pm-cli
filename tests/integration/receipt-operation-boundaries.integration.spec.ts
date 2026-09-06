import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureMergeReceiptOperation,
  isMergeReceiptOperation,
  isOriginalGitStateRestored,
} from "../../src/sdk/merge/receipt-operation.js";
import { writeMergeReceipt } from "../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("receipt operation boundaries", () => {
  it("captures both rebase backends and verifies SHA-256 Git object identities", async () => {
    await withTempPmPath(async (context) => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: context.tempRoot, encoding: "utf8" });
      git("init", "-q", "--object-format=sha256");
      git("config", "user.name", "Receipt Test");
      git("config", "user.email", "receipt@example.invalid");
      const itemPath = "item.toon";
      const raw = "id: pm-receipt\ntitle: Original item\n";
      await writeFile(path.join(context.tempRoot, itemPath), raw);
      git("add", itemPath);
      git("commit", "-qm", "Original state");
      const originalHead = git("rev-parse", "HEAD").trim();
      for (const backend of ["rebase-merge", "rebase-apply"]) {
        const directory = path.join(context.tempRoot, ".git", backend);
        await mkdir(directory);
        const marker = path.join(directory, "orig-head");
        await mkdir(marker);
        expect(
          await captureMergeReceiptOperation(context.tempRoot, itemPath),
        ).toBeUndefined();
        await rm(marker, { recursive: true });
        await writeFile(marker, "invalid-object-id");
        expect(
          await captureMergeReceiptOperation(context.tempRoot, itemPath),
        ).toBeUndefined();
        await writeFile(marker, originalHead);
        const operation = await captureMergeReceiptOperation(
          context.tempRoot,
          itemPath,
        );
        expect(operation).toEqual({
          kind: "rebase",
          original_head: originalHead,
          original_blob: git("rev-parse", `HEAD:${itemPath}`).trim(),
        });
        expect(isMergeReceiptOperation(operation)).toBe(true);
        expect(
          await writeMergeReceipt({
            cwd: context.tempRoot,
            itemPath,
            preferred: "ours",
            fieldsFromTheirs: [],
            unionFields: [],
            decisions: [],
            operation,
          }),
        ).toHaveProperty("operation", operation);
        expect(
          await isOriginalGitStateRestored(
            context.tempRoot,
            itemPath,
            operation!,
            raw,
          ),
        ).toBe(false);
        await rm(directory, { recursive: true });
        expect(
          await isOriginalGitStateRestored(
            context.tempRoot,
            itemPath,
            operation!,
            raw,
          ),
        ).toBe(true);
      }
    });
  });

  it("rejects malformed operation coordinates without trusting extra properties", () => {
    for (const value of [
      null,
      [],
      "rebase",
      {},
      {
        kind: "merge",
        original_head: "a".repeat(40),
        original_blob: "b".repeat(40),
      },
      { kind: "rebase", original_head: 42, original_blob: "b".repeat(40) },
      { kind: "rebase", original_head: "a".repeat(40), original_blob: "bad" },
      {
        kind: "rebase",
        original_head: "a".repeat(40),
        original_blob: "b".repeat(40),
        private_path: "extra",
      },
    ]) {
      expect(isMergeReceiptOperation(value)).toBe(false);
    }
  });
});
