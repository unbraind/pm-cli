/** Preserve original storage bytes while retaining absent-file and native IO semantics. */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { readHistorySnapshot } from "../../../../src/core/history/read.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

it("distinguishes absent and empty byte snapshots and propagates non-absence read failures", async () => {
  await withTempPmPath(async (context) => {
    const historyPath = path.join(context.pmPath, "history", "pm-byte-read.jsonl");
    expect(await readHistorySnapshot(historyPath, "pm-byte-read")).toEqual({ raw: null, raw_bytes: null, entries: [] });
    const bytes = Buffer.from(" \r\n");
    await fs.writeFile(historyPath, bytes);
    expect(await readHistorySnapshot(historyPath, "pm-byte-read")).toEqual({ raw: bytes.toString("utf8"), raw_bytes: bytes, entries: [] });
    await expect(readHistorySnapshot(context.pmPath, "pm-byte-read")).rejects.toHaveProperty("code");
  });
});
