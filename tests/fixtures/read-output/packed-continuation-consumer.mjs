/** Verify serialized producer and output-budget cursors using the packed SDK public export. */
import assert from "node:assert/strict";
import { PmClient } from "@unbrained/pm-cli/sdk";

const [pmRoot, emptyRoot] = process.argv.slice(2);
const client = new PmClient({ pmRoot, noExtensions: true });
const emptyClient = new PmClient({ pmRoot: emptyRoot, noExtensions: true });

/** Check only advertised SDK counters, including compact focus summaries. */
function deliveredRows(page) {
  const rows = page.items ?? page.low_level ?? [];
  if (page.items && page.count !== undefined) assert.equal(page.count, page.items.length);
  if (page.summary?.returned_focus) {
    const focusCount = ["high_level", "low_level", "blocked_fallback"].reduce((sum, section) => sum + (page[section]?.length ?? 0), 0);
    assert.equal(page.summary.returned_focus.active_items, focusCount);
  }
  return rows;
}

/** Traverse advertised serialized cursors and require unique, accurate delivered rows. */
async function collect(reader, options, expected) {
  let after;
  let outputCursor;
  let reads = 0;
  let producerTransitions = 0;
  let budgetTransitions = 0;
  const ids = [];
  const hierarchy = new Set();
  do {
    const page = JSON.parse(JSON.stringify(await reader({ ...options, ...(after ? { after } : {}), ...(outputCursor ? { outputCursor } : {}) })));
    const rows = deliveredRows(page);
    ids.push(...rows.map((row) => row.id));
    for (const row of page.high_level ?? []) hierarchy.add(row.id);
    outputCursor = page.output_budget_truncation?.recovery?.cursor;
    if (outputCursor) budgetTransitions += 1;
    else {
      after = page.next_cursor ?? undefined;
      if (after) producerTransitions += 1;
    }
    reads += 1;
    assert(reads <= 100, "Serialized continuation must finish");
  } while (after || outputCursor);
  assert.equal(ids.length, new Set(ids).size, "Continuation must not duplicate delivered rows");
  assert.equal(new Set([...ids, ...hierarchy]).size, expected);
  return { reads, producerTransitions, budgetTransitions };
}

const results = [];
for (const limit of [1, 25]) {
  for (const [name, reader, options, expected] of [
    ["list", (options) => client.list(options), { all: true, outputBudget: 1700 }, 30],
    ["search", (options) => client.search("Matrix", options), { mode: "keyword", status: "all", outputBudget: 1500 }, 30],
    ["context", (options) => client.context(options), { outputBudget: 1500 }, 26],
  ]) {
    const result = await collect(reader, { ...options, limit, tag: "matrix", json: true }, expected);
    assert(result.producerTransitions > 0);
    if (limit === 25) assert(result.budgetTransitions > 0, "Large producer pages must compose output-budget continuation");
    results.push({ name, limit, ...result });
  }
}
for (const [name, reader] of [
  ["list", (options) => emptyClient.list(options)],
  ["search", (options) => emptyClient.search("Matrix", options)],
  ["context", (options) => emptyClient.context(options)],
]) results.push({ name, empty: true, ...await collect(reader, { limit: 1, outputBudget: 1500, json: true }, 0) });
console.log(JSON.stringify({ publicExport: "@unbrained/pm-cli/sdk", results }));
