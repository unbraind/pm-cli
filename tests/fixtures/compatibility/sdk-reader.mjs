/** Read exact metadata through the selected published package's public SDK. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { get, CURRENT_ITEM_FORMAT_VERSION } from "@unbrained/pm-cli/sdk/runtime";

const [id, pmRoot, expectedPath, formatVersion] = process.argv.slice(2);
assert.equal(CURRENT_ITEM_FORMAT_VERSION, Number(formatVersion), "Runtime storage format drifted from compatibility policy");
const expected = JSON.parse(await readFile(expectedPath, "utf8"));
const result = await get(id, { full: true, outputBudget: "unbounded" }, { pmRoot, noExtensions: true });
for (const [key, value] of Object.entries(expected)) assert.deepEqual(result.item[key], value, key);
