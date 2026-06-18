import { describe, expect, it } from "vitest";

import { parseRemoveEntries } from "../../../src/cli/commands/linked-artifacts.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";

describe("parseRemoveEntries (GH-277 note/scope guidance)", () => {
  it("rejects an embedded note= key with path-only guidance toward --message", () => {
    expect(() => parseRemoveEntries(["path=foo.ts,note=obsolete"])).toThrow(/note/);
    expect(() => parseRemoveEntries(["path=foo.ts,note=obsolete"])).toThrow(/path only/);
    expect(() => parseRemoveEntries(["path=foo.ts,note=obsolete"])).toThrow(/--message/);
  });

  it("rejects an embedded scope= key the same way", () => {
    expect(() => parseRemoveEntries(["path=foo.ts,scope=project"])).toThrow(/scope/);
    expect(() => parseRemoveEntries(["path=foo.ts,scope=project"])).toThrow(/path only/);
    expect(() => parseRemoveEntries(["path=foo.ts,scope=project"])).toThrow(/--message/);
  });

  it("matches note/scope keys case-insensitively", () => {
    expect(() => parseRemoveEntries(["path=foo.ts,Note=x"])).toThrow(/path only/);
    expect(() => parseRemoveEntries(["path=foo.ts,SCOPE=global"])).toThrow(/path only/);
  });

  it("lists both unsupported keys when note and scope are present together", () => {
    let captured: unknown;
    try {
      parseRemoveEntries(["path=foo.ts,note=a,scope=b"]);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PmCliError);
    expect((captured as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((captured as PmCliError).message).toContain('"note"');
    expect((captured as PmCliError).message).toContain('"scope"');
  });

  it("still accepts bare paths, path= form, and undefined (regression)", () => {
    expect(parseRemoveEntries(undefined)).toEqual([]);
    expect(parseRemoveEntries(["foo.ts"])).toEqual(["foo.ts"]);
    expect(parseRemoveEntries(["path=foo.ts"])).toEqual(["foo.ts"]);
  });

  it("throws on an empty entry and routes truly-unknown keys to the unrecognized-key error", () => {
    expect(() => parseRemoveEntries([" "])).toThrow(/requires a path value/);
    // A non-note/scope unknown key still flows through assertNoUnknownCsvKeys, NOT
    // the GH-277 note/scope guidance branch.
    expect(() => parseRemoveEntries(["path=foo.ts,bogus=1"])).toThrow(/does not recognize key/);
    expect(() => parseRemoveEntries(["path=foo.ts,bogus=1"])).not.toThrow(/path only/);
  });
});
