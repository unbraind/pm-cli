import { bench, describe } from "vitest";

import { stableStringify } from "../src/core/shared/serialization.js";
import {
  createQueryFingerprint,
  decodeQueryCursor,
  encodeQueryCursor,
} from "../src/sdk/pagination.js";

/**
 * Opaque query cursors are encoded/decoded on every paginated CLI, SDK, and
 * MCP query, and each cursor fingerprint is derived from a canonical
 * (`stableStringify`) serialization of the query contract. These primitives
 * therefore run on the hot path of list/search pagination. The benchmarks use
 * a nested contract object representative of a real advanced query.
 */

const CONTRACT = {
  command: "list",
  filters: {
    status: ["open", "in-progress", "blocked"],
    tags: ["release", "sprint", "backlog", "governance"],
    priority: { gte: 1, lte: 5 },
    assignee: "agent-42",
  },
  sort: [
    { field: "updated_at", direction: "desc" },
    { field: "priority", direction: "asc" },
  ],
  window: { limit: 50, snapshot: "2026-06-20T00:00:00.000Z" },
  nested: {
    deep: { deeper: { deepest: [1, 2, 3, { flag: true, note: "leaf" }] } },
  },
};

const fingerprint = createQueryFingerprint("list", CONTRACT);
const cursor = encodeQueryCursor(fingerprint, "pm-abcd", 49, "snap-token");

describe("query pagination primitives", () => {
  bench("stableStringify (nested contract)", () => {
    stableStringify(CONTRACT);
  });

  bench("createQueryFingerprint", () => {
    createQueryFingerprint("list", CONTRACT);
  });

  bench("encodeQueryCursor", () => {
    encodeQueryCursor(fingerprint, "pm-abcd", 49, "snap-token");
  });

  bench("decodeQueryCursor", () => {
    decodeQueryCursor(cursor, fingerprint);
  });
});
