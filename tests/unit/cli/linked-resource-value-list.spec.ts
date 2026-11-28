/**
 * Several values after one repeatable linked-resource flag (GH-1791,
 * pm-gh1791): `pm files <id> --add a b c` is refused with the repeat-flag fix
 * and the exact retry, judged with Commander's own option arity.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCommanderUsageContext } from "../../../src/cli/commander-usage.js";
import { formatCommanderErrorForDisplay, formatCommanderErrorForJson } from "../../../src/cli/error-guidance.js";
import {
  findInvokedCommand,
  readCommandOptionArity,
  resolveLinkedResourceValueListRecovery,
  type OptionArityTable,
} from "../../../src/cli/linked-resource-value-list.js";
import { collect } from "../../../src/sdk/cli-contracts/registration-helpers.js";
import { PM_ERROR_CODE_CATALOG } from "../../../src/sdk/generated-error-code-catalog.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

type Arity = Omit<OptionArityTable[string], "name">;
const repeatable: Arity = { value: "required", repeatable: true };
const single: Arity = { value: "required", repeatable: false };
const toggle: Arity = { value: "none", repeatable: false };

/** An arity table whose options are known under their own spellings, unless a long name is given. */
function table(entries: Record<string, Arity & { name?: string }>): OptionArityTable {
  return Object.fromEntries(Object.entries(entries).map(([spelling, arity]) => [spelling, { name: spelling, ...arity }]));
}

/** The global options the program declares, which every command's arity table inherits. */
const GLOBAL = {
  "--json": toggle,
  "--output-budget": single,
  "--output-limit": single,
  "--pm-path": single,
};

const FILES = table({
  ...GLOBAL,
  "--add": repeatable,
  "--add-glob": repeatable,
  "--remove": repeatable,
  "--migrate": repeatable,
  "--note": single,
  "--message": single,
  "--list": toggle,
  "--maybe": { value: "optional", repeatable: false },
});
const TEST = table({
  ...GLOBAL,
  "--other": repeatable,
  "--add": repeatable,
  "--add-json": repeatable,
  "--remove": repeatable,
  "--remove-index": repeatable,
  "--measure": repeatable,
  "--run": toggle,
});

const resolve = (command: string | undefined, argv: string[], table: OptionArityTable = FILES) =>
  resolveLinkedResourceValueListRecovery(command, argv, table);

describe("Commander option arity", () => {
  it("reads required, optional and switch values, the collect processor and inherited spellings", () => {
    const root = new Command().name("pm").option("--json").option("-p, --pm-path <path>");
    const item = root.command("item");
    const files = item
      .command("files")
      .option("-a, --add <value>", "add", collect)
      .option("--note <value>")
      .option("--maybe [value]")
      .option("--json <shadow>")
      .option("-x <value>", "short only", collect);
    expect(readCommandOptionArity(files)).toEqual({
      "--add": { name: "--add", value: "required", repeatable: true },
      "-a": { name: "--add", value: "required", repeatable: true },
      "--note": { name: "--note", value: "required", repeatable: false },
      "--maybe": { name: "--maybe", value: "optional", repeatable: false },
      "-x": { name: "-x", value: "required", repeatable: true },
      // The nearest declaration wins over an ancestor's spelling.
      "--json": { name: "--json", value: "required", repeatable: false },
      "--pm-path": { name: "--pm-path", value: "required", repeatable: false },
      "-p": { name: "--pm-path", value: "required", repeatable: false },
    });
  });
});

describe("value-list recovery", () => {
  it.each([
    [["files", "pm-x", "--add", "a.ts", "b.ts", "c.ts"], ["files", "pm-x", "--add", "a.ts", "--add", "b.ts", "--add", "c.ts"]],
    [["item", "docs", "pm-x", "--add", "README.md", "CHANGELOG.md", "--json"], ["item", "docs", "pm-x", "--add", "README.md", "--add", "CHANGELOG.md", "--json"]],
    [["files", "pm-x", "--add=a.ts", "b.ts"], ["files", "pm-x", "--add=a.ts", "--add", "b.ts"]],
    [["files", "pm-x", "--note", "hi", "--add", "a", "b", "--message", "m", "--list"], ["files", "pm-x", "--note", "hi", "--add", "a", "--add", "b", "--message", "m", "--list"]],
    [["files", "pm-x", "--add", "x", "--add-glob", "src/*.ts", "lib/*.ts"], ["files", "pm-x", "--add", "x", "--add-glob", "src/*.ts", "--add-glob", "lib/*.ts"]],
    [["files", "pm-x", "--add", "a", "b", "--output-budget", "500", "--json"], ["files", "pm-x", "--add", "a", "--add", "b", "--output-budget", "500", "--json"]],
    [["files", "pm-x", "--maybe", "v", "--add", "a", "b"], ["files", "pm-x", "--maybe", "v", "--add", "a", "--add", "b"]],
    [["files", "pm-x", "--maybe", "--add", "a", "b"], ["files", "pm-x", "--maybe", "--add", "a", "--add", "b"]],
    [["files", "pm-x", "--add", "-", "b"], ["files", "pm-x", "--add", "-", "--add", "b"]],
    // Commander takes the first operand as the id even after a flag's value, then reads later lists (Codex review).
    [["item", "files", "--add", "a.ts", "pm-x", "--remove", "b.ts", "c.ts"], ["item", "files", "--add", "a.ts", "pm-x", "--remove", "b.ts", "--remove", "c.ts"]],
    // Global options are the program's own declared options, read wherever Commander reads them (Codex review).
    [["files", "--json", "pm-x", "--add", "a", "b"], ["files", "--json", "pm-x", "--add", "a", "--add", "b"]],
    [["--pm-path", "/t/.agents/pm", "files", "pm-x", "--add", "a", "b", "--pm-path=/t/.agents/pm"], ["--pm-path", "/t/.agents/pm", "files", "pm-x", "--add", "a", "--add", "b", "--pm-path=/t/.agents/pm"]],
  ])("gives each value its own occurrence: %j", (argv, retry) => {
    const command = argv.find((token) => ["files", "docs", "test"].includes(token));
    expect(resolve(command, argv)?.retryArgs).toEqual(retry);
  });

  it("reads a short spelling whole, without an inline value", () => {
    expect(resolve("files", ["files", "pm-x", "-a", "x", "y"], table({ "-a": { ...repeatable, name: "--add" } }))?.retryArgs).toEqual(["files", "pm-x", "-a", "x", "-a", "y"]);
  });

  it("reports the item, the flags in argv order and the extra values", () => {
    expect(resolve("files", ["files", "pm-x", "--add-glob", "a", "b", "--add", "c", "d", "e", "--add-glob", "f", "g"])).toMatchObject({
      itemId: "pm-x",
      flags: ["--add-glob", "--add"],
      extraValues: ["b", "d", "e", "g"],
    });
  });

  it("keeps the fix but gives no executable retry when a value may be one argument the shell split", () => {
    for (const argv of [
      ["files", "pm-x", "--add", "path=a.ts,note=fix", "the", "bug"],
      ["files", "pm-x", "--add", "a.ts", "note=x"],
      ["files", "pm-x", "--add", "path=a.ts", "note=x"],
      ["files", "pm-x", "--list", "--note", "n", "--other", "k=v", "k=w"],
      // Structured values may be one argument the shell split: colon forms, globs with notes, doc labels (Codex review).
      ["files", "pm-x", "--add", "path:a,note:fix", "the", "bug"],
      ["files", "pm-x", "--add-glob", "pattern:src,note:fix", "the", "bug"],
      ["docs", "pm-x", "--add", "Release", "notes,https://example.org"],
      ["files", "pm-x", "--add", "path=a.ts,scope=project", "path=b.ts"],
      ["files", "pm-x", "--migrate", "from=a,to=b", "from=c,to=d"],
      ["files", "pm-x", "--add", "path=a.ts", "path=b.ts,lable=x"],
    ]) {
      const recovery = resolve(argv[0], argv, { ...FILES, ...table({ "--other": repeatable }) });
      expect(recovery?.extraValues.length).toBeGreaterThan(0);
      expect(recovery?.retryArgs).toBeUndefined();
    }
  });

  it.each([
    [["test", "pm-x", "--add", "command=node -e 1", "cmd=node -e 2,path=t.spec.ts"]],
    [["item", "test", "pm-x", "--add-json", '{"command":"a"}', '[{"command":"b"}]']],
    [["test", "pm-x", "--remove-index", "1", "2", "--run"]],
    [["test", "pm-x", "--remove", "command=a", "command=b"]],
    [["test", "pm-x", "--remove", "command:a", "path:t.spec.ts"]],
  ])("replays complete linked-test entries: %j", (argv) => {
    expect(resolve("test", argv, TEST)?.retryArgs).toBeDefined();
  });

  it.each([
    [["test", "pm-x", "--add", "command=npm", "run", "test"]],
    [["test", "pm-x", "--add-json", '{"command":"a', 'b"}']],
    [["test", "pm-x", "--add-json", "{}", "5"]],
    [["test", "pm-x", "--remove-index", "1", "two"]],
    [["test", "pm-x", "--measure", "p95=3", "slow"]],
    // --measure has its own attribute grammar, which bootstrap coalesces, so it gets no replay (Codex review).
    [["test", "pm-x", "--measure", "latency=12", "threshold=5", "--run"]],
    // Each value is judged by the flag's own parser (Codex review): path= alone is metadata, --remove takes no cmd=, positions start at 1.
    [["test", "pm-x", "--add", "command=check", "path=t.spec.ts"]],
    [["test", "pm-x", "--add", "command=check", "node -e 1"]],
    [["test", "pm-x", "--remove", "cmd=a", "cmd=b"]],
    [["test", "pm-x", "--remove-index", "1", "0"]],
    [["test", "pm-x", "--other", "a", "b"]],
    // An assignment-only command passes the entry parser but not the write path's executability check (Codex review).
    [["test", "pm-x", "--add", "command=node -v", "command=MODE=ci"]],
    [["test", "pm-x", "--add-json", '{"command":"node -v"}', '{"command":"MODE=ci"}']],
  ])("leaves a linked-test value that is not a complete entry to the quoting guidance: %j", (argv) => {
    expect(resolve("test", argv, TEST)).toBeUndefined();
  });

  it.each([
    [undefined, ["files", "pm-x", "--add", "a", "b"]],
    ["get", ["get", "pm-x", "--add", "a", "b"]],
    ["docs", ["files", "pm-x", "--add", "a", "b"]],
    ["files", []],
    ["files", ["--json"]],
    ["files", ["files"]],
    ["files", ["files", "--add", "a", "b"]],
    ["files", ["files", "--add", "a", "b", "c"]],
    ["files", ["files", "-", "--add", "a", "b"]],
    ["files", ["files", "pm-x", "extra", "--add", "a", "b"]],
    ["files", ["files", "pm-x", "--add", "a", "--", "b"]],
    ["files", ["files", "pm-x", "--unknown", "--add", "a", "b"]],
    ["files", ["files", "pm-x", "--list=yes", "--add", "a", "b"]],
    ["files", ["files", "pm-x", "--add", "a", "b", "--note"]],
    ["files", ["files", "pm-x", "--add", "a", "-"]],
    ["files", ["files", "pm-x", "--add", "a", "--add", "b"]],
    ["files", ["files", "pm-x", "--maybe", "--list"]],
    // A value that does not directly follow its flag, and a global flag missing its value, are Commander's operands (Codex review).
    ["files", ["files", "pm-x", "--add", "a", "--pm-path=/t", "b"]],
    ["files", ["files", "pm-x", "--add", "a", "b", "--pm-path"]],
    // Commander gives --output-limit the next token as its value, so --add is never a flag here (Codex review).
    ["files", ["files", "pm-x", "--output-limit", "--add", "a", "b", "--json"]],
    // A required value that reads as an option is where Commander's ancestor-first parse disagrees with a flat scan.
    ["files", ["files", "pm-x", "--add", "--json", "a", "b"]],
    ["files", ["files", "pm-x", "--message", "--json", "--add", "a", "b"]],
    // An attached value that reads as an option is declined like a separate one (Codex review).
    ["test", ["test", "pm-x", "--measure=--p95=3", "p99=4", "--run"]],
    // Options before the command path are read the same way (Codex review).
    ["files", ["--pm-path=--sandbox", "files", "pm-x", "--add", "a", "b"]],
    ["files", ["--unknown", "files", "pm-x", "--add", "a", "b"]],
  ] as const)("does not guess for %s %j", (command, argv) => {
    expect(resolve(command, [...argv], command === "test" ? TEST : FILES)).toBeUndefined();
  });

  it("declines when Commander would read a prefix token as an operand the bootstrap took as a value", () => {
    // Here the table declares --pm-path a switch, so its bootstrap value would be a stray root operand.
    const switchPath = { ...FILES, ...table({ "--pm-path": toggle }) };
    expect(resolveLinkedResourceValueListRecovery("files", ["--pm-path", "/t", "files", "pm-x", "--add", "a", "b"], switchPath)).toBeUndefined();
    expect(resolveLinkedResourceValueListRecovery("files", ["--pm-path", "/t", "files", "pm-x", "--add", "a", "b"], FILES)?.retryArgs).toEqual(["--pm-path", "/t", "files", "pm-x", "--add", "a", "--add", "b"]);
  });

  it("declines when a subcommand, not the collection command, refused the invocation (Codex review)", () => {
    const argv = ["files", "--note", "N", "discover", "--add", "a", "pm-x", "b"];
    expect(resolveLinkedResourceValueListRecovery("files", argv, FILES, new Set(["discover", "lookup"]))).toBeUndefined();
    expect(resolveLinkedResourceValueListRecovery("files", ["files", "pm-x", "--add", "a", "b"], FILES, new Set(["discover"]))?.retryArgs).toBeDefined();
  });
});

describe("value-list guidance", () => {
  const context = (argv: string[], arity: OptionArityTable = FILES) => {
    const command = argv.find((token) => ["files", "docs", "test"].includes(token));
    return { normalizedInvocationArgs: argv, linkedResourceValueList: resolveLinkedResourceValueListRecovery(command, argv, arity) };
  };

  it("names the repeat-flag fix first and carries the exact retry in JSON", () => {
    const argv = ["item", "files", "pm-x", "--add", "a.ts", "b.ts", "c.ts", "--json"];
    const envelope = formatCommanderErrorForJson("error: too many arguments for 'files'", "files", "Task", 2, context(argv));
    expect(envelope).toMatchObject({ code: "linked_resource_value_list", exit_code: 2, title: "Repeat --add once per value (or use --add-glob)" });
    expect(envelope.recovery?.suggested_retry_args).toEqual(["item", "files", "pm-x", "--add", "a.ts", "--add", "b.ts", "--add", "c.ts", "--json"]);
    expect(envelope.recovery?.suggested_retry).toBe("pm item files pm-x --add a.ts --add b.ts --add c.ts --json");
    expect(envelope.detail).toContain("2 more values followed the value of --add");
    expect(PM_ERROR_CODE_CATALOG.find(({ code }) => code === envelope.code)).toMatchObject({ exit_code: 2, class: "usage" });
    const text = formatCommanderErrorForDisplay("error: too many arguments for 'files'", "files", "Task", context(argv));
    expect(text.split("\n")[0]).toBe("Error: Repeat --add once per value (or use --add-glob)");
    expect(text).toContain("Retry with one --add per value: pm item files pm-x --add a.ts --add b.ts --add c.ts --json");
    expect(text).toContain('pm files pm-x --add-glob "<pattern>"');
  });

  it("asks for quoting without an executable retry when a value may have been split", () => {
    const envelope = formatCommanderErrorForJson("too many arguments", "docs", "Task", 2, context(["docs", "pm-x", "--add", "path=a.md,note=fix", "it"]));
    expect(envelope.code).toBe("linked_resource_value_list");
    expect(envelope.required).toContain("quote a value that contains spaces or commas");
    expect(envelope.required).toContain("pm docs pm-x --add <value> --add <value>");
    expect(envelope.detail).toContain("1 more value followed");
    expect(envelope.recovery?.suggested_retry).toBeUndefined();
    expect(envelope.recovery?.suggested_retry_args).toBeUndefined();
  });

  it("offers the copyable retry only when it is the exact argv, and argv otherwise (Codex review)", () => {
    const retryFor = (shell: string, argv: string[]) => {
      vi.stubEnv("PM_COMMAND_SHELL", shell);
      try {
        return formatCommanderErrorForJson("too many arguments", "test", "Task", 2, context(argv, TEST));
      } finally {
        vi.unstubAllEnvs();
      }
    };
    const multiline = ["test", "pm-x", "--add", "command=echo a\necho b", "command=node -v"];
    const json = ["test", "pm-x", "--add-json", '{"command":"node tests/A&B.js"}', '{"command":"node -v"}'];
    const tab = ["test", "pm-x", "--add", 'command=printf "a\tb"', "command=node -v"];
    // cmd.exe cannot carry a line break, and npm's pm.cmd re-parses a quoted metacharacter; text output replaces a tab.
    for (const [shell, argv] of [["cmd", multiline], ["cmd", json], ["posix", tab]] as const) {
      const envelope = retryFor(shell, [...argv]);
      expect(envelope.recovery?.suggested_retry).toBeUndefined();
      expect(envelope.recovery?.suggested_retry_args).toHaveLength(argv.length + 1);
      expect(envelope.required).toContain("replaying recovery.suggested_retry_args");
    }
    expect(retryFor("posix", multiline).recovery?.suggested_retry).toBeUndefined();
    expect(retryFor("posix", json).recovery?.suggested_retry).toBeDefined();
    expect(retryFor("cmd", ["test", "pm-x", "--add", "command=a", "command=b"]).recovery?.suggested_retry).toBe("pm test pm-x --add command=a --add command=b");
  });

  it("offers no glob for linked tests or for a flag other than --add", () => {
    const tests = formatCommanderErrorForJson("too many arguments", "test", "Task", 2, context(["test", "pm-x", "--add", "command=a", "command=b"], TEST));
    expect(tests.title).toBe("Repeat --add once per value");
    expect(tests.examples).not.toContain('pm test pm-x --add-glob "<pattern>"');
    const removal = formatCommanderErrorForJson("too many arguments", "files", "Task", 2, context(["files", "pm-x", "--remove", "a", "b"]));
    expect(removal.title).toBe("Repeat --remove once per value");
  });

  it("keeps the earlier guidance when the arity is unknown or the shape is not a value list", () => {
    expect(formatCommanderErrorForJson("too many arguments", "files", "Task", 2, { normalizedInvocationArgs: ["files", "pm-x", "--add", "a", "b"] }).code).toBe("invalid_command_usage");
    expect(formatCommanderErrorForJson("too many arguments", "files", "Task", 2, { linkedResourceValueList: undefined }).code).toBe("invalid_command_usage");
    expect(formatCommanderErrorForJson("too many arguments", "files", "Task", 2, context(["files", "pm-x", "a.ts"])).code).toBe("linked_resource_positional_value");
    expect(formatCommanderErrorForJson("too many arguments", "test", "Task", 2, context(["test", "pm-x", "--add", "command=npm", "run"], TEST)).code).toBe("linked_test_value_not_quoted");
    expect(formatCommanderErrorForJson("missing required argument", "files", "Task", 2, context(["files", "pm-x", "--add", "a", "b"])).code).not.toBe("linked_resource_value_list");
  });
});

describe("usage context arity", () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
  });

  /** A program whose collection command is registered under its namespace, as the CLI registers it. */
  function program(): Command {
    const root = new Command().name("pm").option("--json");
    const files = root.command("item").command("files").argument("<id>").option("--add <value>", "add", collect);
    files.command("discover").alias("find").argument("<id>");
    return root;
  }

  it("reads the namespaced command's declaration for an overflowing linked-resource command", async () => {
    process.argv = ["node", "pm", "files", "pm-x", "--add", "a", "b"];
    const context = await resolveCommanderUsageContext({ message: "error: too many arguments for 'files'" }, program(), new Map());
    expect(context.linkedResourceValueList).toMatchObject({ itemId: "pm-x", flags: ["--add"], retryArgs: ["item", "files", "pm-x", "--add", "a", "--add", "b"] });
  });

  it("walks the canonical path, or the command name when the invocation declares no namespace", () => {
    const root = program();
    root.command("docs");
    expect(findInvokedCommand(root, ["item", "files", "pm-x"], "files")?.name()).toBe("files");
    expect(findInvokedCommand(root, ["--json"], "docs")?.name()).toBe("docs");
    expect(findInvokedCommand(root, ["item", "test", "pm-x"], "test")).toBeUndefined();
  });

  it("reads nothing when the program does not register the invoked command", async () => {
    process.argv = ["node", "pm", "files", "pm-x", "--add", "a", "b"];
    const context = await resolveCommanderUsageContext({ message: "error: too many arguments for 'files'" }, new Command().name("pm"), new Map());
    expect(context.linkedResourceValueList).toBeUndefined();
  });

  it.each([
    ["error: unknown option '--x'", ["files", "pm-x", "--x"]],
    ["error: too many arguments for 'get'", ["get", "pm-x", "y"]],
    ["error: too many arguments for 'files'", ["files", "lookup", "a", "b"]],
    ["error: too many arguments", []],
    ["error: too many arguments for 'discover'", ["files", "--json", "find", "pm-x", "--add", "a", "b"]],
  ])("reads nothing for %s %j", async (message, argv) => {
    process.argv = ["node", "pm", ...argv];
    const context = await resolveCommanderUsageContext({ message }, program(), new Map());
    expect(context.linkedResourceValueList).toBeUndefined();
  });
});

describe("value-list refusal through the CLI (GH-1791)", () => {
  it("refuses several values after one --add, and the suggested retry links every value", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Value list" });
      const refused = context.runCli(["files", id, "--add", "a.ts", "b.ts", "c.ts", "--json"]);
      expect(refused.code).toBe(2);
      const envelope = JSON.parse(refused.stderr || refused.stdout) as { code: string; recovery: { suggested_retry_args: string[] } };
      expect(envelope.code).toBe("linked_resource_value_list");
      const listed = () => (context.runCli(["files", id, "--list", "--json"], { expectJson: true }).json as { files: Array<{ path: string }> }).files.map((file) => file.path);
      expect(listed()).toEqual([]);
      expect(context.runCli(envelope.recovery.suggested_retry_args).code).toBe(0);
      expect(listed()).toEqual(["a.ts", "b.ts", "c.ts"]);
      // An item id written after the flag keeps working.
      expect(context.runCli(["docs", "--add", "README.md", id, "--json"]).code).toBe(0);
      const text = context.runCli(["docs", id, "--add", "a.md", "b.md"]);
      expect(text.code).toBe(2);
      expect(`${text.stdout}${text.stderr}`).toContain("Error: Repeat --add once per value (or use --add-glob)");
    });
  });

  it("offers no executable retry where the shell may have split one value or Commander owns the token (Codex review)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Ambiguous value lists" });
      const refusal = (argv: string[]) => JSON.parse(context.runCli(argv).stderr || "{}") as { code?: string; recovery?: { suggested_retry_args?: string[] } };
      for (const argv of [
        ["files", id, "--add-glob", "pattern:src,note:fix", "the", "bug", "--json"],
        ["docs", id, "--add", "Release", "notes,https://example.org", "--json"],
      ]) {
        expect(refusal(argv)).toMatchObject({ code: "linked_resource_value_list" });
        expect(refusal(argv).recovery?.suggested_retry_args).toBeUndefined();
      }
      // Commander reads --add as the value of --output-limit, so this is not a value list at all.
      expect(refusal(["files", id, "--output-limit", "--add", "a", "b", "--json"]).code).not.toBe("linked_resource_value_list");
    });
  });
});
