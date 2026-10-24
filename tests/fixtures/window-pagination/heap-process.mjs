/** Exercise bounded cursor pages over patch content larger than the child heap. */

const { paginateWindowQuery } = await import(process.argv[2]);
const payload = "x".repeat(256 * 1024);
const rows = Array.from({ length: 1536 }, (_, index) => ({
  index,
  patch: [{ op: "replace", path: "/body", value: payload }],
}));
const options = { command: "activity", clock: "2026-01-01T00:00:00.000Z", query: { mode: "full" }, limit: 1 };
const first = paginateWindowQuery(rows, options);
const second = paginateWindowQuery(rows, { ...options, after: first.next_cursor });
console.log(JSON.stringify({
  first: first.rows[0].index,
  second: second.rows[0].index,
  total: second.total_count,
  remaining: second.omitted_count,
}));
