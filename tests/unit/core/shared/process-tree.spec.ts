import { describe, expect, it } from "vitest";
import { descendantsFromProcessTable } from "../../../../src/core/shared/process-tree.js";

// pm-5kfzjh: the deadline teardown walks a provider's live descendants from a
// `ps -A -o pid= -o ppid=` snapshot.
describe("descendantsFromProcessTable", () => {
  it("lists every live descendant deepest first", () => {
    const table = ["  100     1", "  200   100", "  300   200", "  301   200", "  400   100", "  500     1", ""].join("\n");
    // Breadth first from 100 is 200, 400, 300, 301; deepest first is its reverse.
    expect(descendantsFromProcessTable(table, 100)).toEqual([301, 300, 400, 200]);
  });

  it("returns nothing for a root without children or absent from the table", () => {
    expect(descendantsFromProcessTable("100 1\n200 1\n", 100)).toEqual([]);
    expect(descendantsFromProcessTable("100 1\n", 999)).toEqual([]);
    expect(descendantsFromProcessTable("", 100)).toEqual([]);
  });

  it("skips malformed rows and lists each process once even through a cycle", () => {
    const table = ["header row", "200 100 extra", "abc 100", "0 100", "-5 100", "200 100", "300 200", "200 300", "100 300", "9007199254740993 100"].join("\n");
    expect(descendantsFromProcessTable(table, 100)).toEqual([300, 200]);
  });

  it("does not list a process re-parented away from the root", () => {
    // The launcher 100 exited, so its former helper 200 now belongs to init.
    expect(descendantsFromProcessTable("200 1\n300 200\n", 100)).toEqual([]);
  });
});
