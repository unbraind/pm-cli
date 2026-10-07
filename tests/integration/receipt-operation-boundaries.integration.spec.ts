import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  captureMergeReceiptOperation,
  isMergeReceiptOperation,
  isOriginalGitStateRestored,
  type MergeReceiptOperation,
} from "../../src/sdk/merge/receipt-operation.js";
import { writeMergeReceipt } from "../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("receipt operation boundaries", () => {
  it.each(["sha1", "sha256"])("captures both rebase backends and verifies %s Git object identities", async (format) => {
    await withTempPmPath(async (context) => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: context.tempRoot, encoding: "utf8" });
      git("init", "-q", "-b", "main", `--object-format=${format}`);
      git("config", "core.autocrlf", "false");
      git("config", "user.name", "Receipt Test");
      git("config", "user.email", "receipt@example.invalid");
      const itemPath = "item with spaces.toon";
      const raw = "id: pm-receipt\ntitle: Original item\n";
      await writeFile(path.join(context.tempRoot, ".gitattributes"), "*.toon merge=operation-probe\n");
      await writeFile(path.join(context.tempRoot, itemPath), "id: pm-receipt\ntitle: Base item\n");
      git("add", ".gitattributes", itemPath);
      git("commit", "-qm", "Base state");
      git("switch", "-qc", "incoming");
      await writeFile(path.join(context.tempRoot, itemPath), "id: pm-receipt\ntitle: Incoming item\n");
      git("commit", "-qam", "Incoming state");
      const incomingHead = git("rev-parse", "HEAD").trim();
      git("switch", "-q", "main");
      await writeFile(path.join(context.tempRoot, itemPath), raw);
      git("add", itemPath);
      git("commit", "-qm", "Original state");
      const originalHead = git("rev-parse", "HEAD").trim();
      expect(originalHead).toHaveLength(format === "sha1" ? 40 : 64);
      expect(await captureMergeReceiptOperation(context.tempRoot, itemPath, raw)).toBeUndefined();
      const mergeOperation: MergeReceiptOperation = {
        kind: "merge", original_head: originalHead,
        original_blob: git("rev-parse", `HEAD:${itemPath}`).trim(),
      };
      const driverPath = path.join(context.tempRoot, ".git", "operation-probe.mjs");
      const probePath = path.join(context.tempRoot, ".git", "operation-proof.json");
      await writeFile(driverPath, `
import { readFileSync, writeFileSync } from "node:fs";
import { captureMergeReceiptOperation } from ${JSON.stringify(pathToFileURL(path.resolve("dist/sdk/merge/receipt-operation.js")).href)};
const operation = await captureMergeReceiptOperation(process.cwd(), process.argv[3], readFileSync(process.argv[2], "utf8"));
writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ operation: operation ?? null, mergeEnvironment: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GITHEAD_"))) }));
process.exitCode = 1;
`);
      git("config", "merge.operation-probe.driver", `"${process.execPath.replaceAll("\\", "/")}" "${driverPath.replaceAll("\\", "/")}" "%A" "%P"`);
      for (const kind of ["merge", "cherry-pick", "revert"] as const) {
        git("update-ref", "ORIG_HEAD", originalHead);
        const result = spawnSync("git", [kind, incomingHead], {
          cwd: context.tempRoot, env: context.env, encoding: "utf8",
        });
        expect(result.status, result.stderr).not.toBe(0);
        const captured: { operation: MergeReceiptOperation | null; mergeEnvironment: Record<string, string> } = JSON.parse(await readFile(probePath, "utf8"));
        expect(captured.operation).toEqual(kind === "merge" ? mergeOperation : null);
        expect(Object.keys(captured.mergeEnvironment)).toEqual(kind === "merge" ? [`GITHEAD_${incomingHead}`] : []);
        for (const [key, value] of Object.entries(captured.mergeEnvironment)) vi.stubEnv(key, value);
        try {
          expect(await captureMergeReceiptOperation(context.tempRoot, itemPath, raw)).toEqual(kind === "merge" ? mergeOperation : undefined);
          if (kind === "merge") {
            expect(await captureMergeReceiptOperation(context.tempRoot, itemPath)).toBeUndefined();
            expect(await captureMergeReceiptOperation(context.tempRoot, itemPath, `${raw}\n`)).toBeUndefined();
            git("update-ref", "-d", "ORIG_HEAD");
            expect(await captureMergeReceiptOperation(context.tempRoot, itemPath, raw)).toBeUndefined();
            git("update-ref", "ORIG_HEAD", mergeOperation.original_blob);
            expect(await captureMergeReceiptOperation(context.tempRoot, itemPath, raw)).toBeUndefined();
            git("update-ref", "ORIG_HEAD", originalHead);
          }
        } finally {
          vi.unstubAllEnvs();
          git(kind, "--abort");
        }
      }
      expect(isMergeReceiptOperation(mergeOperation)).toBe(true);
      git("update-ref", "ORIG_HEAD", originalHead);
      expect(await captureMergeReceiptOperation(context.tempRoot, itemPath, raw)).toBeUndefined();
      vi.stubEnv("GITHEAD_invalid", "incoming");
      try {
        expect(await captureMergeReceiptOperation(context.tempRoot, itemPath, raw)).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
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
        for (const quotedPath of [`'${itemPath}'`, `"${itemPath}"`]) {
          expect(
            await captureMergeReceiptOperation(context.tempRoot, quotedPath),
          ).toEqual(operation);
        }
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
        kind: "cherry_pick",
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
