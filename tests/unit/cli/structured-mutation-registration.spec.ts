import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as itemParseModule from "../../../src/core/item/parse.js";
import type * as itemTransactionModule from "../../../src/sdk/item-transaction.js";
import { parseBootstrapGlobalOptions } from "../../../src/sdk/cli-bootstrap.js";
import { formatCommanderUsageJson } from "../../../src/cli/commander-usage.js";
import { projectLeanErrorEnvelope } from "../../../src/cli/error-guidance.js";
import { getGlobalOptions } from "../../../src/cli/registration-helpers.js";
import { formatOutput } from "../../../src/core/output/output.js";

const mocks = vi.hoisted(() => ({
  stdin: "" as string | undefined,
  commitItemMutations: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
}));

vi.mock("../../../src/core/item/parse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof itemParseModule>();
  return {
    ...actual,
    createStdinTokenResolver: () => ({
      resolveValue: vi.fn(async () => mocks.stdin),
    }),
  };
});

vi.mock("../../../src/sdk/item-transaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof itemTransactionModule>();
  return { ...actual, commitItemMutations: mocks.commitItemMutations };
});

vi.mock("../../../src/cli/commands/create.js", () => ({
  runCreate: mocks.runCreate,
}));
vi.mock("../../../src/cli/commands/update.js", () => ({
  runUpdate: mocks.runUpdate,
}));

import { registerMutationCommands } from "../../../src/cli/register-mutation.js";
import {
  registerStructuredMutationCommands,
  structuredMutationTestOnly,
} from "../../../src/cli/register-structured-mutation.js";

function programWithGlobals(): Command {
  return new Command()
    .exitOverride()
    .option("--json")
    .option("--quiet")
    .option("--author <value>")
    .option("--pm-path <value>");
}

describe("structured mutation command registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PM_AUTHOR", "");
    mocks.stdin = "";
    mocks.runCreate.mockResolvedValue({ item: { id: "pm-created" } });
    mocks.runUpdate.mockResolvedValue({ item: { id: "pm-updated" } });
    mocks.commitItemMutations.mockResolvedValue({
      transactionId: "batch",
      status: "committed",
      recovered: false,
      results: {},
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes whole-item stdin through create and update adapters", async () => {
    const createProgram = programWithGlobals();
    registerMutationCommands(createProgram);
    mocks.stdin = JSON.stringify({ title: "Document", type: "Task" });
    await createProgram.parseAsync(
      ["create", "--stdin-json", "--title", "Explicit"],
      { from: "user" },
    );
    expect(mocks.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Explicit", type: "Task" }),
      expect.any(Object),
    );

    const updateProgram = programWithGlobals();
    registerMutationCommands(updateProgram);
    mocks.stdin = JSON.stringify({ item: { id: "pm-a", title: "Updated" } });
    await updateProgram.parseAsync(["update", "pm-a", "--stdin-json"], {
      from: "user",
    });
    expect(mocks.runUpdate).toHaveBeenCalledWith(
      "pm-a",
      expect.objectContaining({ title: "Updated" }),
      expect.any(Object),
    );

    mocks.stdin = undefined;
    const emptyCreateProgram = programWithGlobals();
    registerMutationCommands(emptyCreateProgram);
    await expect(
      emptyCreateProgram.parseAsync(["create", "--stdin-json"], {
        from: "user",
      }),
    ).rejects.toThrow("must be valid JSON");

    const emptyUpdateProgram = programWithGlobals();
    registerMutationCommands(emptyUpdateProgram);
    await expect(
      emptyUpdateProgram.parseAsync(["update", "pm-a", "--stdin-json"], {
        from: "user",
      }),
    ).rejects.toThrow("must be valid JSON");
  });

  it("previews and commits validated batches with every transaction control", async () => {
    const mutations = [
      {
        op: "create",
        id: "pm-batch",
        options: { title: "Batch", type: "Task" },
      },
    ];
    const dryRunProgram = programWithGlobals();
    registerStructuredMutationCommands(dryRunProgram);
    mocks.stdin = JSON.stringify(mutations);
    await dryRunProgram.parseAsync(
      ["item", "mutate", "--transaction-id", " batch ", "--dry-run"],
      { from: "user" },
    );
    expect(mocks.commitItemMutations).not.toHaveBeenCalled();

    const commitProgram = programWithGlobals();
    registerStructuredMutationCommands(commitProgram);
    await commitProgram.parseAsync(
      [
        "--pm-path",
        "/tmp/pm-structured-unit",
        "item",
        "mutate",
        "--transaction-id",
        "batch",
        "--author",
        "batch-agent",
        "--create-compensation",
        "delete",
        "--lock-ttl-seconds",
        "45",
        "--lock-wait-ms",
        "900",
      ],
      { from: "user" },
    );
    expect(mocks.commitItemMutations).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "batch",
        author: "batch-agent",
        createCompensation: "delete",
        lockTtlSeconds: 45,
        lockWaitMs: 900,
      }),
    );

    const invalidProgram = programWithGlobals();
    registerStructuredMutationCommands(invalidProgram);
    await expect(
      invalidProgram.parseAsync(
        [
          "item",
          "mutate",
          "--transaction-id",
          "invalid",
          "--lock-ttl-seconds",
          "not-a-number",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("lockTtlSeconds must be a finite number");

    await expect(
      structuredMutationTestOnly.runItemMutateAction(
        {
          transactionId: "invalid-compensation",
          createCompensation: "archive",
        },
        invalidProgram,
      ),
    ).rejects.toThrow("createCompensation must be close or delete");
  });

  it("covers missing input, invalid transaction ids, defaults, and existing groups", async () => {
    const command = programWithGlobals();
    await expect(
      structuredMutationTestOnly.runItemMutateAction(
        { transactionId: "batch" },
        command,
      ),
    ).rejects.toThrow("non-empty JSON batch");

    mocks.stdin = JSON.stringify([
      { op: "update", id: "pm-a", options: { title: "A" } },
    ]);
    await expect(
      structuredMutationTestOnly.runItemMutateAction({}, command),
    ).rejects.toThrow("requires --transaction-id");
    await structuredMutationTestOnly.runItemMutateAction(
      { transactionId: "batch" },
      command,
    );
    expect(mocks.commitItemMutations).toHaveBeenCalledWith(
      expect.objectContaining({ author: "unknown", transactionId: "batch" }),
    );

    const globalAuthorCommand = programWithGlobals();
    globalAuthorCommand.parse(["--author", "global-agent"], { from: "user" });
    await structuredMutationTestOnly.runItemMutateAction(
      { transactionId: "global-author" },
      globalAuthorCommand,
    );
    expect(mocks.commitItemMutations).toHaveBeenLastCalledWith(
      expect.objectContaining({
        author: "global-agent",
        transactionId: "global-author",
      }),
    );
    await structuredMutationTestOnly.runItemMutateAction(
      { author: "", transactionId: "empty-author" },
      command,
    );
    expect(mocks.commitItemMutations).toHaveBeenLastCalledWith(
      expect.objectContaining({
        author: "unknown",
        transactionId: "empty-author",
      }),
    );

    const existingGroupProgram = programWithGlobals();
    existingGroupProgram.command("item");
    registerStructuredMutationCommands(existingGroupProgram);
    expect(existingGroupProgram.commands).toHaveLength(1);
  });

  it("covers lean bootstrap, command, JSON, and actionable error projections", async () => {
    expect(parseBootstrapGlobalOptions(["--lean"])).toMatchObject({
      lean: true,
    });
    const leanCommand = new Command().option("--lean");
    leanCommand.parse(["--lean"], { from: "user" });
    expect(getGlobalOptions(leanCommand)).toMatchObject({ lean: true });
    expect(
      formatOutput({ empty: [], nil: null }, { json: true, lean: true }),
    ).toBe("null\n");
    expect(
      projectLeanErrorEnvelope({
        type: "usage",
        code: "bad_input",
        title: "Bad input",
        detail: "Retry",
        exit_code: 2,
        required: "A value",
        why: "Needed",
      }),
    ).toEqual({
      type: "usage",
      code: "bad_input",
      detail: "Retry",
      exit_code: 2,
    });
    const usage = JSON.parse(
      await formatCommanderUsageJson(
        new Error("error: unknown option '--unknwon'"),
        new Command(),
        new Map(),
        true,
      ),
    ) as Record<string, unknown>;
    expect(usage).not.toHaveProperty("title");
  });
});
