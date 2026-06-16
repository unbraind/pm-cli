import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFocusedItem,
  getFocusedItem,
  getSessionStatePath,
  readSessionState,
  setFocusedItem,
} from "../../../../src/core/session/session-state.js";

describe("session-state", () => {
  let pmRoot: string;

  beforeEach(async () => {
    pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-session-state-"));
  });

  afterEach(async () => {
    await rm(pmRoot, { recursive: true, force: true });
  });

  it("returns empty state when the file is missing", async () => {
    expect(await readSessionState(pmRoot)).toEqual({});
    expect(await getFocusedItem(pmRoot)).toBeUndefined();
  });

  it("sets and reads the focused item, creating the runtime dir", async () => {
    await setFocusedItem(pmRoot, "pm-abcd");
    expect(await getFocusedItem(pmRoot)).toBe("pm-abcd");
    const raw = await readFile(getSessionStatePath(pmRoot), "utf8");
    expect(JSON.parse(raw)).toEqual({ focused_item: "pm-abcd" });
  });

  it("overwrites a previously focused item", async () => {
    await setFocusedItem(pmRoot, "pm-aaaa");
    await setFocusedItem(pmRoot, "pm-bbbb");
    expect(await getFocusedItem(pmRoot)).toBe("pm-bbbb");
  });

  it("clears a previously focused item", async () => {
    await setFocusedItem(pmRoot, "pm-keep");
    await clearFocusedItem(pmRoot);
    expect(await getFocusedItem(pmRoot)).toBeUndefined();
    const raw = await readFile(getSessionStatePath(pmRoot), "utf8");
    expect(JSON.parse(raw)).toEqual({});
  });

  it("clearing when nothing is focused is a no-op that still writes empty state", async () => {
    await clearFocusedItem(pmRoot);
    expect(await getFocusedItem(pmRoot)).toBeUndefined();
    expect(await readSessionState(pmRoot)).toEqual({});
  });

  it("treats a corrupt (non-JSON) file as empty state", async () => {
    await mkdir(path.dirname(getSessionStatePath(pmRoot)), { recursive: true });
    await writeFile(getSessionStatePath(pmRoot), "{not valid json", "utf8");
    expect(await readSessionState(pmRoot)).toEqual({});
  });

  it("treats a JSON array as empty state", async () => {
    await mkdir(path.dirname(getSessionStatePath(pmRoot)), { recursive: true });
    await writeFile(getSessionStatePath(pmRoot), JSON.stringify(["pm-x"]), "utf8");
    expect(await readSessionState(pmRoot)).toEqual({});
  });

  it("treats a JSON null as empty state", async () => {
    await mkdir(path.dirname(getSessionStatePath(pmRoot)), { recursive: true });
    await writeFile(getSessionStatePath(pmRoot), "null", "utf8");
    expect(await readSessionState(pmRoot)).toEqual({});
  });

  it("ignores a non-string or blank focused_item value", async () => {
    await mkdir(path.dirname(getSessionStatePath(pmRoot)), { recursive: true });
    await writeFile(getSessionStatePath(pmRoot), JSON.stringify({ focused_item: 42 }), "utf8");
    expect(await readSessionState(pmRoot)).toEqual({});
    await writeFile(getSessionStatePath(pmRoot), JSON.stringify({ focused_item: "   " }), "utf8");
    expect(await readSessionState(pmRoot)).toEqual({});
  });
});
