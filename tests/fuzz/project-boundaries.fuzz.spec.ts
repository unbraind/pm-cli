import { encode as encodeToon } from "@toon-format/toon";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  historyEntriesToRaw,
  reanchorHistoryEntries,
  verifyHistoryChain,
} from "../../src/core/history/replay.js";
import { replayHistoryToTarget } from "../../src/core/history/projection.js";
import { decodeToonItemContent } from "../../src/core/item/toon-decode.js";
import { resolveIsoOrRelative } from "../../src/core/shared/time.js";
import {
  mergeHistoryStreams,
  mergeItemDocuments,
} from "../../src/sdk/merge/three-way.js";
import {
  canonicalDocument,
  parseItemDocument,
  serializeItemDocument,
} from "../../src/core/item/item-format.js";
import {
  decodeQueryCursorState,
  encodeQueryCursor,
} from "../../src/sdk/pagination.js";
import type { HistoryEntry, HistoryPatchOp } from "../../src/types/index.js";

const FUZZ_RUNS = 250;

describe("project boundary property fuzzing", () => {
  it("round-trips bounded TOON records through the strict decoder", () => {
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string({ maxLength: 80 }),
          priority: fc.integer({ min: 0, max: 4 }),
          tags: fc.array(fc.string({ maxLength: 32 }), { maxLength: 8 }),
        }),
        (record) => {
          expect(decodeToonItemContent(encodeToon(record)).value).toEqual(
            record,
          );
        },
      ),
      { numRuns: FUZZ_RUNS },
    );
  });

  it("round-trips adversarial item content through the guarded write path", () => {
    const adversarialText = fc.oneof(
      fc.string({ maxLength: 160 }),
      fc.constantFrom(
        "notes[]:",
        "comments[2]:",
        'quotes " and backslashes \\',
        "multiple\nlines\nwith: colons",
        "Unicode 🤖 你好 مرحبا",
        "# comment-shaped scalar",
        "POST [redacted_endpoint]: HTTP 200",
      ),
    );
    fc.assert(
      fc.property(
        fc.record({
          title: adversarialText,
          description: adversarialText,
          body: adversarialText,
          tags: fc.array(adversarialText, { maxLength: 8 }),
        }),
        ({ title, description, body, tags }) => {
          const document = {
            metadata: {
              id: "pm-toon-roundtrip",
              title,
              description,
              type: "Task",
              status: "open",
              priority: 1,
              tags,
              created_at: "2026-07-27T00:00:00.000Z",
              updated_at: "2026-07-27T00:00:00.000Z",
            },
            body,
          };
          const serialized = serializeItemDocument(document, {
            format: "toon",
          });
          expect(parseItemDocument(serialized, { format: "toon" })).toEqual(
            canonicalDocument(document),
          );
        },
      ),
      { numRuns: FUZZ_RUNS },
    );
  });

  it("round-trips opaque cursor state without losing Unicode or positions", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.nat({ max: 1_000_000 }),
        fc.option(fc.string({ minLength: 1, maxLength: 64 }), {
          nil: undefined,
        }),
        (fingerprint, afterId, afterIndex, snapshot) => {
          const cursor = encodeQueryCursor(
            fingerprint,
            afterId,
            afterIndex,
            snapshot,
          );
          expect(decodeQueryCursorState(cursor, fingerprint)).toEqual({
            after_id: afterId,
            after_index: afterIndex,
            ...(snapshot === undefined ? {} : { snapshot }),
          });
        },
      ),
      { numRuns: FUZZ_RUNS },
    );
  });

  it("rejects arbitrary values that cannot be valid query cursors", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.constant(null),
          fc
            .string({ maxLength: 96 })
            .filter((value) => /[^A-Za-z0-9_-]/u.test(value)),
        ),
        (cursor) => {
          expect(() => decodeQueryCursorState(cursor, "fingerprint")).toThrow(
            /Query cursor (?:is malformed|version or payload is unsupported)\./u,
          );
        },
      ),
      { numRuns: FUZZ_RUNS },
    );
  });

  it("reanchors, serializes, merges, and replays generated history streams", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 80 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (bodies) => {
          const entries = bodies.map(
            (body, index): HistoryEntry => ({
              ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
              author: "property-fuzz",
              op: index === 0 ? "create" : "update",
              patch:
                index === 0
                  ? ([
                      {
                        op: "replace",
                        path: "",
                        value: { metadata: { id: "pm-fuzz" }, body },
                      },
                    ] satisfies HistoryPatchOp[])
                  : ([
                      { op: "replace", path: "/body", value: body },
                    ] satisfies HistoryPatchOp[]),
              before_hash: "",
              after_hash: "",
            }),
          );
          const anchored = reanchorHistoryEntries(entries).entries;
          const raw = historyEntriesToRaw(anchored);
          const merged = mergeHistoryStreams("", raw, raw);
          const parsed = merged.merged
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as HistoryEntry);

          expect(merged.strategy).toBe("identical");
          expect(verifyHistoryChain(parsed)).toEqual({ ok: true, errors: [] });
          expect(replayHistoryToTarget(parsed, parsed.length - 1).body).toBe(
            bodies.at(-1),
          );
        },
      ),
      { numRuns: FUZZ_RUNS },
    );
  });

  it("resolves generated hour, day, and week offsets exactly", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2100-01-01T00:00:00.000Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.constantFrom(
          ["h", 60 * 60 * 1000] as const,
          ["d", 24 * 60 * 60 * 1000] as const,
          ["w", 7 * 24 * 60 * 60 * 1000] as const,
        ),
        (now, amount, [unit, milliseconds]) => {
          const sign = amount < 0 ? "" : "+";
          expect(
            resolveIsoOrRelative(`${sign}${amount}${unit}`, now, "fuzz date"),
          ).toBe(
            new Date(now.getTime() + amount * milliseconds).toISOString(),
          );
        },
      ),
      { numRuns: FUZZ_RUNS },
    );
  });

  it("converges randomized N-branch item appends independent of merge order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,24}$/), {
          minLength: 2,
          maxLength: 12,
        }),
        (tags) => {
          const base = {
            metadata: {
              id: "pm-fuzz-merge",
              title: "N-branch convergence",
              description: "property merge",
              type: "Task",
              status: "open",
              priority: 2,
              tags: [],
              created_at: "2026-07-27T00:00:00.000Z",
              updated_at: "2026-07-27T00:00:00.000Z",
            },
            body: "",
          };
          const baseRaw = serializeItemDocument(base, { format: "toon" });
          const converge = (order: string[]): string[] => {
            let current = baseRaw;
            for (const [index, tag] of order.entries()) {
              const branch = structuredClone(base);
              branch.metadata.tags = [tag];
              branch.metadata.updated_at = new Date(
                Date.UTC(2026, 6, 27, 0, 0, index + 1),
              ).toISOString();
              current = mergeItemDocuments(
                baseRaw,
                current,
                serializeItemDocument(branch, { format: "toon" }),
                { format: "toon" },
              ).merged;
            }
            return parseItemDocument(current, { format: "toon" }).metadata.tags;
          };

          expect(converge(tags).sort()).toEqual(
            converge([...tags].reverse()).sort(),
          );
          expect(converge(tags).sort()).toEqual([...tags].sort());
        },
      ),
      { numRuns: FUZZ_RUNS },
    );
  });
});
