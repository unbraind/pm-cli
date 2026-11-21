/** A stream the reseed created and only partly wrote is removed again; anyone else's bytes keep it (pm-3os5p6). */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../../../src/types/index.js";

/** What the next appendFile does before it fails: write a prefix, add a peer's bytes, or move the path. */
const failure = vi.hoisted(() => ({ next: null as null | ((file: string, data: string) => void) }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const file = String(args[0]);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "appendFile" && failure.next !== null) {
            const inject = failure.next;
            failure.next = null;
            return async (data: string) => {
              inject(file, data);
              throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
});
const { appendRecordToVerifiedStream } = await import("../../../../src/sdk/history/append-only-repair.js");

const record = { op: "history_repair", ts: "2026-11-21T00:00:00.000Z" } as unknown as HistoryEntry;

describe("reseed partial writes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pm-reseed-partial-"));
  });
  afterEach(() => {
    failure.next = null;
  });

  it("removes a stream it created and only partly wrote", async () => {
    const file = path.join(dir, "pm-a.jsonl");
    failure.next = (target, data) => appendFileSync(target, data.slice(0, 5));
    await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps a stream that holds another writer's bytes", async () => {
    const file = path.join(dir, "pm-a.jsonl");
    failure.next = (target) => appendFileSync(target, "peer\n");
    await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(readFileSync(file, "utf8")).toBe("peer\n");
  });

  it("leaves a path another file took over in place", async () => {
    const file = path.join(dir, "pm-a.jsonl");
    failure.next = (target) => {
      renameSync(target, `${target}.moved`);
      writeFileSync(target, "");
    };
    await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("leaves nothing to remove when the path vanished", async () => {
    const file = path.join(dir, "pm-a.jsonl");
    failure.next = (target) => renameSync(target, `${target}.moved`);
    await expect(appendRecordToVerifiedStream("pm-a", file, null, record)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await readdir(dir)).toEqual(["pm-a.jsonl.moved"]);
  });

  it("never removes an existing stream when its append fails", async () => {
    const file = path.join(dir, "pm-a.jsonl");
    writeFileSync(file, " ");
    failure.next = () => undefined;
    await expect(appendRecordToVerifiedStream("pm-a", file, " ", record)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(readFileSync(file, "utf8")).toBe(" ");
  });
});
