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
  commitItemCompletion: vi.fn(),
  commitItemMutations: vi.fn(),
  runReopen: vi.fn(),
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
  return {
    ...actual,
    commitItemCompletion: mocks.commitItemCompletion,
    commitItemMutations: mocks.commitItemMutations,
  };
});

vi.mock("../../../src/cli/commands/create.js", () => ({
  runCreate: mocks.runCreate,
}));
vi.mock("../../../src/cli/commands/update.js", () => ({
  runUpdate: mocks.runUpdate,
}));
vi.mock("../../../src/sdk/lifecycle/reopen.js", () => ({
  runReopen: mocks.runReopen,
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
    mocks.runReopen.mockResolvedValue({
      item: { id: "pm-reopened", status: "open" },
      changed_fields: ["status"],
      warnings: [],
      recurrence: {
        reason: "Recurrence",
        from_status: "closed",
        to_status: "open",
        previous_terminal: {},
      },
    });
    mocks.runUpdate.mockResolvedValue({ item: { id: "pm-updated" } });
    mocks.commitItemMutations.mockResolvedValue({
      transactionId: "batch",
      status: "committed",
      recovered: false,
      results: {},
    });
    mocks.commitItemCompletion.mockResolvedValue({
      transactionId: "complete",
      status: "committed",
      recovered: false,
      results: {
        "1-update-pm-a": { id: "pm-a", op: "update" },
        "2-close-pm-a": { id: "pm-a", op: "close" },
        "3-release-pm-a": { id: "pm-a", op: "release" },
      },
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

  it("routes the description stdin token through create and update", async () => {
    mocks.stdin = "Multiline\nproject context";
    const createProgram = programWithGlobals();
    registerMutationCommands(createProgram);
    await createProgram.parseAsync(
      ["create", "--title", "Intent", "--description", "-"],
      { from: "user" },
    );
    expect(mocks.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Multiline\nproject context" }),
      expect.any(Object),
    );

    const updateProgram = programWithGlobals();
    registerMutationCommands(updateProgram);
    await updateProgram.parseAsync(["update", "pm-a", "--description", "-"], {
      from: "user",
    });
    expect(mocks.runUpdate).toHaveBeenCalledWith(
      "pm-a",
      expect.objectContaining({ description: "Multiline\nproject context" }),
      expect.any(Object),
    );

    mocks.stdin = undefined;
    const emptyProgram = programWithGlobals();
    registerMutationCommands(emptyProgram);
    await emptyProgram.parseAsync(
      ["create", "--title", "Empty", "--description", "-"],
      { from: "user" },
    );
    expect(mocks.runCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "" }),
      expect.any(Object),
    );
    await emptyProgram.parseAsync(["update", "pm-a", "--description", "-"], {
      from: "user",
    });
    expect(mocks.runUpdate).toHaveBeenLastCalledWith(
      "pm-a",
      expect.objectContaining({ description: "" }),
      expect.any(Object),
    );
  });

  it("routes noun-first recurrence options through the SDK adapter", async () => {
    const command = programWithGlobals();
    await structuredMutationTestOnly.runItemReopenAction(
      "pm-a",
      "Recurring failure",
      {},
      command,
    );
    expect(mocks.runReopen).toHaveBeenLastCalledWith(
      "pm-a",
      "Recurring failure",
      {
        status: undefined,
        author: undefined,
        message: undefined,
        force: false,
      },
      expect.any(Object),
    );

    await structuredMutationTestOnly.runItemReopenAction(
      "pm-a",
      "Recurring failure",
      {
        status: "in_progress",
        author: "incident-agent",
        message: "Resume response",
        force: true,
      },
      command,
    );
    expect(mocks.runReopen).toHaveBeenLastCalledWith(
      "pm-a",
      "Recurring failure",
      {
        status: "in_progress",
        author: "incident-agent",
        message: "Resume response",
        force: true,
      },
      expect.any(Object),
    );

    const globalAuthorCommand = programWithGlobals();
    globalAuthorCommand.parse(["--author", "global-agent"], { from: "user" });
    await structuredMutationTestOnly.runItemReopenAction(
      "pm-a",
      "Recurring through a global author",
      {},
      globalAuthorCommand,
    );
    expect(mocks.runReopen).toHaveBeenLastCalledWith(
      "pm-a",
      "Recurring through a global author",
      expect.objectContaining({ author: "global-agent" }),
      expect.any(Object),
    );
  });

  it("rejects mixing whole-item JSON with other stdin consumers", async () => {
    const createProgram = programWithGlobals();
    registerMutationCommands(createProgram);
    await expect(
      createProgram.parseAsync(["create", "--stdin-json", "--body", "-"], {
        from: "user",
      }),
    ).rejects.toThrow(
      "--stdin-json cannot be combined with other stdin consumers: --body",
    );

    await expect(
      createProgram.parseAsync(
        ["create", "--stdin-json", "--description", "-"],
        { from: "user" },
      ),
    ).rejects.toThrow(
      "--stdin-json cannot be combined with other stdin consumers: --description",
    );

    const updateProgram = programWithGlobals();
    registerMutationCommands(updateProgram);
    await expect(
      updateProgram.parseAsync(
        [
          "update",
          "pm-a",
          "--stdin-json",
          "--dep",
          "-",
          "--field",
          "-",
          "--type-option",
          "-",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("other stdin consumers: --dep, --type-option, --field");
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

    mocks.stdin = JSON.stringify({
      schema_version: 1,
      mutations: [
        {
          op: "create",
          ref: "parent",
          options: { title: "Parent", type: "Epic" },
        },
        {
          op: "create",
          ref: "child",
          options: { title: "Child", type: "Feature", parent: "@parent" },
        },
      ],
    });
    await commitProgram.parseAsync(
      ["item", "mutate", "--transaction-id", "referenced-batch"],
      { from: "user" },
    );
    const referencedCall = mocks.commitItemMutations.mock.lastCall;
    if (referencedCall === undefined) {
      throw new Error(
        "Expected the referenced mutation batch to be committed.",
      );
    }
    const committedBatch = referencedCall[0] as {
      mutations: Array<{
        op: string;
        id: string;
        options?: { parent?: string };
      }>;
    };
    const [parentMutation, childMutation] = committedBatch.mutations;
    expect(parentMutation?.op).toBe("create");
    expect(parentMutation?.id).not.toMatch(/^@/u);
    expect(childMutation?.options?.parent).toBe(parentMutation?.id);

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
    ).rejects.toThrow("lockTtlSeconds must be a positive safe integer");

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

  it("previews and commits evidence, closure, and release as one completion", async () => {
    const dryRunProgram = programWithGlobals();
    registerStructuredMutationCommands(dryRunProgram);
    await dryRunProgram.parseAsync(
      [
        "item",
        "complete",
        "pm-a",
        "All gates passed",
        "--transaction-id",
        "complete-dry",
        "--comment",
        "text=Verified",
        "--dry-run",
      ],
      { from: "user" },
    );
    expect(mocks.commitItemCompletion).not.toHaveBeenCalled();

    const commitProgram = programWithGlobals();
    registerStructuredMutationCommands(commitProgram);
    await commitProgram.parseAsync(
      [
        "item",
        "complete",
        "pm-a",
        "--transaction-id",
        "complete-42",
        "--reason",
        "All gates passed",
        "--file",
        "path=src/a.ts",
        "--doc",
        "path=docs/SDK.md",
        "--test",
        "command=pnpm test",
        "--comment",
        "text=Verified",
        "--note",
        "text=Decision",
        "--learning",
        "text=Reusable",
        "--resolution",
        "Delivered",
        "--expected-result",
        "Green",
        "--actual-result",
        "Green",
        "--completed-at",
        "2026-08-05T00:00:00.000Z",
        "--validate-close",
        "warn",
        "--lock-ttl-seconds",
        "45",
        "--lock-wait-ms",
        "900",
        "--force",
        "--author",
        "completion-agent",
      ],
      { from: "user" },
    );
    expect(mocks.commitItemCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pm-a",
        reason: "All gates passed",
        transactionId: "complete-42",
        author: "completion-agent",
        evidence: {
          file: ["path=src/a.ts"],
          doc: ["path=docs/SDK.md"],
          test: ["command=pnpm test"],
          comment: ["text=Verified"],
          note: ["text=Decision"],
          learning: ["text=Reusable"],
        },
        closeOptions: expect.objectContaining({
          resolution: "Delivered",
          expectedResult: "Green",
          actualResult: "Green",
          completedAt: "2026-08-05T00:00:00.000Z",
          validateClose: "warn",
          force: true,
        }),
        releaseOptions: { force: true },
        lockTtlSeconds: 45,
        lockWaitMs: 900,
      }),
    );
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

    await expect(
      structuredMutationTestOnly.runItemCompleteAction(
        "pm-a",
        undefined,
        { transactionId: 42 },
        command,
      ),
    ).rejects.toThrow("requires --transaction-id");
    await expect(
      structuredMutationTestOnly.runItemCompleteAction(
        "pm-a",
        undefined,
        { transactionId: "" },
        command,
      ),
    ).rejects.toThrow("requires --transaction-id");
    await expect(
      structuredMutationTestOnly.runItemCompleteAction(
        "pm-a",
        undefined,
        { transactionId: "complete" },
        command,
      ),
    ).rejects.toThrow("requires a close reason");
    await structuredMutationTestOnly.runItemCompleteAction(
      "pm-a",
      "Minimal completion",
      { transactionId: "complete-minimal" },
      globalAuthorCommand,
    );
    expect(mocks.commitItemCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        author: "global-agent",
        id: "pm-a",
        reason: "Minimal completion",
        transactionId: "complete-minimal",
      }),
    );
    await structuredMutationTestOnly.runItemCompleteAction(
      "pm-a",
      "Direct author completion",
      { author: "direct-agent", transactionId: "complete-direct-author" },
      command,
    );
    expect(mocks.commitItemCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({ author: "direct-agent" }),
    );
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
