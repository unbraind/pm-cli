import { describe, expect, it } from "vitest";
import { assertLinkedTestCommand } from "../../../../src/sdk/test/entry.js";

describe("linked-test command admission", () => {
  it.each([
    "status=passed", "RESULT=", "_RESULT=passed", "A=1 B=two", " A=1\nB=2 ",
    "A='two words' B=\"three words\"", "A=two\\ words", "A='semi;colon'", "A=\"a\\\"b\"", "A='$(literal)'", "A='`literal`'",
    "RESULT=passed # note", "A=1 # note\n B=2 # second", "A=1 #\n# another\nB='literal # value'",
    "# note\nRESULT=passed", "# note", " # first\n # second ",
  ])("refuses assignment-only command %s", (command) => {
    expect(() => assertLinkedTestCommand(command)).toThrow(expect.objectContaining({ code: "linked_test_command_not_executable", exitCode: 2 }));
  });
  it.each([
    undefined, "", "node --version", "A=1 node --version", "A='two words' node --version",
    "A=two\\ words node --version", "A=\"two words\" node --version", "A=1 && node --version",
    "A=1; node --version", "A=$(node --version)", "A=`node --version`", 'A="$(node --version)"', 'A="`node --version`"', "A='unterminated", 'A="unterminated', "A=trailing\\",
    "env A=1 node --version", 'node -e "const status=1"', "A=1 2BAD=2", "A=1 | cat",
    "A=1 # comment\nnode --version", "A=1 # comment\nB=2 node --version", "A=1#literal node --version",
    "# comment\nnode --version",
  ])("preserves executable or compound shell input %s", (command) => {
    expect(() => assertLinkedTestCommand(command)).not.toThrow();
  });
  it("handles long assignment names and repeated assignment words", () => {
    expect(() => assertLinkedTestCommand("A".repeat(100_000))).not.toThrow();
    expect(() => assertLinkedTestCommand(`${"A".repeat(100_000)}=1`)).toThrow(expect.objectContaining({ code: "linked_test_command_not_executable" }));
    expect(() => assertLinkedTestCommand("A=1 ".repeat(10_000))).toThrow(expect.objectContaining({ code: "linked_test_command_not_executable" }));
  });
});
