/** Verify serialized producer and output-budget cursors using the packed SDK public export. */
import assert from "node:assert/strict";
import { PmClient, isItemAlreadyExistsError } from "@unbrained/pm-cli/sdk";
import { isItemAlreadyExistsError as coreConflictGuard } from "@unbrained/pm-cli/sdk/core";

const [pmRoot, emptyRoot, blockedRoot] = process.argv.slice(2);
const client = new PmClient({ pmRoot, noExtensions: true });
const emptyClient = new PmClient({ pmRoot: emptyRoot, noExtensions: true });
const blockedClient = new PmClient({ pmRoot: blockedRoot, noExtensions: true });

/** Check only advertised SDK counters, including compact focus summaries. */
function deliveredRows(page, blocked) {
  const sections = page.items ? { items: page.items } : {
    high_level: page.high_level ?? [],
    low_level: page.low_level ?? [],
    blocked_fallback: page.blocked_fallback ?? [],
  };
  const rows = Object.entries(sections).flatMap(([section, items]) => items.map(({ id }) => ({ section, id })));
  if (page.items && page.count !== undefined) assert.equal(page.count, page.items.length);
  if (page.summary?.returned_focus) {
    assert.deepEqual(page.summary.returned_focus, {
      active_items: rows.length,
      in_progress: blocked ? 0 : rows.length,
      open: blocked ? rows.length : 0,
      blocked: blocked ? rows.length : 0,
    });
  }
  assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length, "A page must not duplicate delivered focus rows");
  return rows;
}

/** Count repeated companion focus rows while retaining every resumed collection row for uniqueness checks. */
function appendProducerRows(rows, continuedSection, producerRows, ids) {
  let companions = 0;
  for (const row of rows) {
    if (continuedSection && row.section !== continuedSection && producerRows.has(row.id)) companions += 1;
    else ids.push(row.id);
    producerRows.add(row.id);
  }
  return companions;
}

/** Traverse advertised serialized cursors and require unique, accurate delivered rows. */
async function collect(reader, options, expected, blocked = false) {
  let after;
  let outputCursor;
  let continuedSection;
  let reads = 0;
  let producerTransitions = 0;
  let budgetTransitions = 0;
  let companionRows = 0;
  const ids = [];
  const producerRows = new Set();
  do {
    if (!outputCursor) producerRows.clear();
    const page = JSON.parse(JSON.stringify(await reader({ ...options, ...(after ? { after } : {}), ...(outputCursor ? { outputCursor } : {}) })));
    companionRows += appendProducerRows(deliveredRows(page, blocked), outputCursor ? continuedSection : undefined, producerRows, ids);
    outputCursor = page.output_budget_truncation?.recovery?.cursor;
    if (outputCursor) {
      continuedSection = page.output_budget_truncation.continuations.find(({ cursor }) => cursor === outputCursor)?.path;
      assert(continuedSection, "Advertised output recovery must identify its resumed collection");
      budgetTransitions += 1;
    }
    else {
      after = page.next_cursor ?? undefined;
      if (after) producerTransitions += 1;
    }
    reads += 1;
    assert(reads <= 100, "Serialized continuation must finish");
  } while (after || outputCursor);
  assert.equal(ids.length, new Set(ids).size, "Continuation must not duplicate delivered rows");
  assert.equal(ids.length, expected);
  return { reads, producerTransitions, budgetTransitions, companionRows, uniqueRows: ids.length };
}

const results = [];
for (const [name, reader, options] of [
  ["list", (options) => client.list(options), { all: true }],
  ["search", (options) => client.search("Matrix", options), { mode: "keyword", status: "all" }],
]) {
  const base = { ...options, tag: "matrix", limit: 25, json: true };
  const full = await reader({ ...base, limit: 100, outputBudget: "unbounded" });
  const orderedIds = full.items.map(({ id }) => id);
  for (const outputBudget of ["unbounded", 100000]) {
    const ids = [];
    let after;
    let reads = 0;
    do {
      const page = JSON.parse(JSON.stringify(await reader({ ...base, outputLimit: 2, outputBudget, ...(after ? { after } : {}) })));
      const rows = deliveredRows(page, false).map(({ id }) => id);
      assert.deepEqual(rows, orderedIds.slice(ids.length, ids.length + 2));
      assert.equal(page.read_output.within_budget, true);
      assert.equal(page.read_output.rows_compacted, false);
      assert.equal(page.output_budget_truncation, undefined);
      reads += 1;
      if (!page.next_cursor) {
        assert.equal(page.has_more, true, "Explicit terminal caps still disclose withheld rows");
        const tail = await reader({ ...base, outputLimit: "unbounded", outputBudget, ...(after ? { after } : {}) });
        const tailIds = tail.items.map(({ id }) => id);
        assert.deepEqual(tailIds.slice(0, rows.length), rows);
        ids.push(...tailIds);
        break;
      }
      ids.push(...rows);
      after = page.next_cursor;
      assert(reads < 30, "Advertised amount-only continuation must advance");
    } while (after);
    assert.deepEqual(ids, orderedIds, "Every advertised cursor resumes at the first undisplayed row");
    results.push({ name, amountOnly: true, outputBudget, reads, uniqueRows: ids.length });
  }
}
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
const blockedOptions = { limit: 12, tokenBudget: 100000, tag: "blocked-matrix", json: true };
results.push({ name: "context", blocked: true, ...await collect((options) => blockedClient.context(options), { ...blockedOptions, outputBudget: 2000 }, 12, true) });
const boundedBlocked = JSON.parse(JSON.stringify(await blockedClient.context({ ...blockedOptions, outputBudget: 1500 })));
const boundedRows = deliveredRows(boundedBlocked, true);
assert(boundedRows.length > 0 && boundedRows.length < 12);
assert.equal(boundedBlocked.summary.blocked, 12, "Population counters must include withheld fallback rows");
const recoveryBudget = boundedBlocked.output_budget_truncation?.recovery?.sdk?.outputBudget;
assert.equal(typeof recoveryBudget, "number", "Fallback recovery must advertise a usable SDK budget");
assert(recoveryBudget > 1500);
results.push({ name: "context", blocked: true, recovery: true, ...await collect((options) => blockedClient.context(options), { ...blockedOptions, outputBudget: recoveryBudget }, 12, true) });
const conflictId = `packed-conflict-${process.versions.bun ? "bun" : "node"}`;
const attempts = await Promise.allSettled(["First packed intent", "Second packed intent"].map((title) =>
  client.create({ id: conflictId, title, type: "Task", createMode: "progressive" }),
));
const winners = attempts.filter(({ status }) => status === "fulfilled");
const losers = attempts.filter(({ status }) => status === "rejected");
assert.equal(winners.length, 1);
assert.equal(losers.length, 1);
const conflict = losers[0].reason;
assert(isItemAlreadyExistsError(conflict));
assert(coreConflictGuard(conflict), "Separate public entrypoints recognize the same structural conflict");
assert.equal((await client.get(conflict.context.id)).item.title, winners[0].value.item.title);
console.log(JSON.stringify({ publicExport: "@unbrained/pm-cli/sdk", results, conflicts: { oneWinner: true, coreGuard: true } }));
