/** Read exact metadata through the selected published package's public SDK. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { get, CURRENT_ITEM_FORMAT_VERSION } from "@unbrained/pm-cli/sdk/runtime";

const [id, pmRoot, expectedPath, formatVersion, mode] = process.argv.slice(2);
assert.ok(CURRENT_ITEM_FORMAT_VERSION >= Number(formatVersion), "Runtime cannot read the required compatibility format");
const expected = JSON.parse(await readFile(expectedPath, "utf8"));
if (mode === "refused") {
  await assert.rejects(get(id, { full: true, outputBudget: "unbounded" }, { pmRoot, noExtensions: true }), (error) => error.context?.code === "item_format_version_unsupported");
} else {
  const result = await get(id, { full: true, outputBudget: "unbounded" }, { pmRoot, noExtensions: true });
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(JSON.parse(JSON.stringify(result.item[key])), value, key);
}
