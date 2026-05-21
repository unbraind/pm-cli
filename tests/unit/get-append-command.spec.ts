import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAppend } from "../../src/cli/commands/append.js";
import { runGet } from "../../src/cli/commands/get.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTask(
  context: TempPmContext,
  params: {
    title: string;
    body: string;
    includeLinks?: boolean;
  },
): string {
  const linkArgs = params.includeLinks
    ? [
        "--file",
        "path=src/cli/commands/get.ts,scope=project,note=get-link",
        "--test",
        "command=node --version,scope=project,timeout_seconds=15,note=test-link",
        "--doc",
        "path=README.md,scope=project,note=doc-link",
      ]
    : ["--file", "none", "--test", "none", "--doc", "none"];

  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    "Task",
    "--status",
    "open",
    "--priority",
    "1",
    "--tags",
    "unit,get-append",
    "--body",
    params.body,
    "--deadline",
    "none",
    "--estimate",
    "10",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "test-author",
    "--message",
    `Create ${params.title}`,
    "--assignee",
    "none",
    "--dep",
    "none",
    "--comment",
    "none",
    "--note",
    "none",
    "--learning",
    "none",
    ...linkArgs,
  ];

  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  const payload = created.json as { item?: { id?: string } };
  expect(typeof payload.item?.id).toBe("string");
  return payload.item?.id ?? "";
}

describe("runGet and runAppend", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-get-append-not-init-"));
    try {
      await expect(runGet("pm-missing", { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runAppend("pm-missing", { body: "append text" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns linked entries when present and defaults to empty arrays when absent", async () => {
    await withTempPmPath(async (context) => {
      const linkedId = createTask(context, {
        title: "get-with-links",
        body: "linked body",
        includeLinks: true,
      });
      const linkedResult = await runGet(linkedId, { path: context.pmPath });
      expect(linkedResult.item.id).toBe(linkedId);
      expect(linkedResult.body).toBe("linked body");
      expect(linkedResult.linked.files).toEqual([
        { path: "src/cli/commands/get.ts", scope: "project", note: "get-link" },
      ]);
      expect(linkedResult.linked.docs).toEqual([{ path: "README.md", scope: "project", note: "doc-link" }]);
      expect(linkedResult.linked.tests).toEqual([
        {
          command: "node --version",
          scope: "project",
          timeout_seconds: 15,
          note: "test-link",
        },
      ]);

      const plainId = createTask(context, {
        title: "get-without-links",
        body: "plain body",
      });
      const plainResult = await runGet(plainId, { path: context.pmPath });
      expect(plainResult.linked.files).toEqual([]);
      expect(plainResult.linked.tests).toEqual([]);
      expect(plainResult.linked.docs).toEqual([]);
    });
  });

  it("supports lower-token get depth projections while keeping deep as the default", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-depth-projection",
        body: "depth body",
        includeLinks: true,
      });

      context.runCli(["comments", id, "depth comment", "--json", "--author", "owner-a"], { expectJson: true });
      context.runCli(["notes", id, "--add", "depth note", "--json", "--author", "owner-a"], { expectJson: true });

      const deep = await runGet(id, { path: context.pmPath });
      expect(deep.item.comments).toBeDefined();
      expect(deep.item.notes).toBeDefined();
      expect(deep.linked.files).toHaveLength(1);
      expect(deep.body).toBe("depth body");

      const explicitFull = await runGet(id, { path: context.pmPath }, { full: true });
      expect(explicitFull.item.comments).toBeDefined();
      expect(explicitFull.item.notes).toBeDefined();
      expect(explicitFull.linked.files).toHaveLength(1);
      expect(explicitFull.body).toBe("depth body");

      const fullOverridesDepth = await runGet(id, { path: context.pmPath }, { full: true, depth: "brief" });
      expect(fullOverridesDepth.item.comments).toBeDefined();
      expect(fullOverridesDepth.linked.files).toHaveLength(1);
      expect(fullOverridesDepth.body).toBe("depth body");

      const standard = await runGet(id, { path: context.pmPath }, { depth: "standard" });
      expect(standard.item.id).toBe(id);
      expect(standard.item.comments).toBeUndefined();
      expect(standard.item.notes).toBeUndefined();
      expect(standard.item.files).toBeUndefined();
      expect(standard.linked.files).toHaveLength(1);
      expect(standard.body).toBe("depth body");

      const brief = await runGet(id, { path: context.pmPath }, { depth: "brief" });
      expect(brief.item.id).toBe(id);
      expect(brief.item.comments).toBeUndefined();
      expect(brief.linked.files).toEqual([]);
      expect(brief.linked.tests).toEqual([]);
      expect(brief.linked.docs).toEqual([]);
      expect(brief.body).toBe("");

      await expect(runGet(id, { path: context.pmPath }, { depth: "verbose" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runGet(id, { path: context.pmPath }, { full: true, fields: "id,title" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("supports custom get field projections for narrow agent reads", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-fields-projection",
        body: "fields body",
        includeLinks: true,
      });

      const focused = await runGet(id, { path: context.pmPath }, { fields: "id,title,status,parent,type" });
      expect(focused.item).toEqual({
        id,
        title: "get-fields-projection",
        status: "open",
        parent: undefined,
        type: "Task",
      });
      expect(focused.body).toBeUndefined();
      expect(focused.linked).toBeUndefined();
      expect(focused.claim_state).toBeUndefined();

      const withBodyAndFiles = await runGet(id, { path: context.pmPath }, { fields: "item.id,body,linked.files" });
      expect(withBodyAndFiles.item).toEqual({ id });
      expect(withBodyAndFiles.body).toBe("fields body");
      expect(withBodyAndFiles.linked.files).toHaveLength(1);
      expect(withBodyAndFiles.linked.tests).toEqual([]);

      const withClaimState = await runGet(id, { path: context.pmPath }, { fields: "id,claim_state" });
      expect(withClaimState.item).toEqual({ id });
      expect(withClaimState.claim_state).toEqual({
        claimed: false,
        assignee: null,
        last_claim: null,
        last_release: null,
      });

      const withDottedClaimState = await runGet(id, { path: context.pmPath }, { fields: "id,claim_state.claimed" });
      expect(withDottedClaimState.item).toEqual({ id });
      expect(withDottedClaimState.claim_state?.claimed).toBe(false);

      await expect(runGet(id, { path: context.pmPath }, { fields: " , " })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runGet(id, { path: context.pmPath }, { fields: "id,bogus" })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Unknown get --fields value(s): bogus"),
      });
    });
  });

  it("allows configured runtime metadata fields in get projections", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "customer_segment",
          type: "string",
          commands: ["create", "update", "list", "search"],
          cli_aliases: ["segment"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");
      const created = context.runCli([
        "create",
        "--json",
        "--title",
        "Runtime field get",
        "--description",
        "Runtime field get description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--customer-segment",
        "enterprise",
      ], { expectJson: true });
      const id = (created.json as { item: { id: string } }).item.id;

      const projected = await runGet(id, { path: context.pmPath }, { fields: "id,customer_segment" });
      expect(projected.item).toEqual({ id, customer_segment: "enterprise" });
    });
  });

  it("surfaces claim state metadata with latest claim/release context", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-claim-state",
        body: "claim metadata body",
      });

      const initial = await runGet(id, { path: context.pmPath });
      expect(initial.claim_state).toEqual({
        claimed: false,
        assignee: null,
        last_claim: null,
        last_release: null,
      });

      const claim = context.runCli(["claim", id, "--json", "--author", "owner-a", "--message", "claim metadata context"], {
        expectJson: true,
      });
      expect(claim.code).toBe(0);

      const afterClaim = await runGet(id, { path: context.pmPath });
      expect(afterClaim.claim_state.claimed).toBe(true);
      expect(afterClaim.claim_state.assignee).toBe("owner-a");
      expect(afterClaim.claim_state.last_claim?.author).toBe("owner-a");
      expect(afterClaim.claim_state.last_release).toBeNull();

      const release = context.runCli(
        ["release", id, "--json", "--author", "audit-reviewer", "--allow-audit-release", "--message", "release metadata context"],
        { expectJson: true },
      );
      expect(release.code).toBe(0);

      const afterRelease = await runGet(id, { path: context.pmPath });
      expect(afterRelease.claim_state.claimed).toBe(false);
      expect(afterRelease.claim_state.assignee).toBeNull();
      expect(afterRelease.claim_state.last_claim?.author).toBe("owner-a");
      expect(afterRelease.claim_state.last_release?.author).toBe("audit-reviewer");
    });
  });

  it("falls back to empty claim history when history entries cannot be decoded", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-history-decode-fallback",
        body: "claim metadata fallback body",
      });

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(historyPath, "{not valid jsonl}\n", "utf8");

      const result = await runGet(id, { path: context.pmPath });
      expect(result.item.id).toBe(id);
      expect(result.claim_state).toEqual({
        claimed: false,
        assignee: null,
        last_claim: null,
        last_release: null,
      });

      const projected = await runGet(id, { path: context.pmPath }, { fields: "id,title" });
      expect(projected.item).toEqual({ id, title: "get-history-decode-fallback" });
      expect(projected.claim_state).toBeUndefined();
    });
  });

  it("normalizes missing claim/release history messages to null", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "get-claim-state-message-null",
        body: "claim metadata null message body",
      });

      const claim = context.runCli(["claim", id, "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(claim.code).toBe(0);

      const release = context.runCli(["release", id, "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(release.code).toBe(0);

      const result = await runGet(id, { path: context.pmPath });
      expect(result.claim_state.last_claim?.message).toBeNull();
      expect(result.claim_state.last_release?.message).toBeNull();
    });
  });

  it("returns not found for unknown ids", async () => {
    await withTempPmPath(async (context) => {
      await expect(runGet("pm-does-not-exist", { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("requires body for append operations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-missing-body",
        body: "seed body",
      });
      await expect(
        runAppend(id, {} as unknown as { body: string; author?: string; message?: string; force?: boolean }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("accepts append text as positional shorthand or --text alias and rejects conflicting/missing sources", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "append-text-forms", body: "seed body" });

      const positional = context.runCli(["append", id, "appended via positional", "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(positional.code).toBe(0);
      expect((positional.json as { appended?: string }).appended).toBe("appended via positional");

      const aliased = context.runCli(["append", id, "--text", "appended via text alias", "--json", "--author", "owner-a"], {
        expectJson: true,
      });
      expect(aliased.code).toBe(0);
      expect((aliased.json as { appended?: string }).appended).toBe("appended via text alias");

      const stdinText = context.runCli(["append", id, "--text", "-", "--json", "--author", "owner-a"], {
        expectJson: true,
        input: "appended from stdin",
      });
      expect(stdinText.code).toBe(0);
      expect((stdinText.json as { appended?: string }).appended).toBe("appended from stdin");

      const conflictCases = [
        ["append", id, "positional", "--text", "alias", "--author", "owner-a"],
        ["append", id, "--body", "from-body", "--text", "from-text", "--author", "owner-a"],
        ["append", id, "from-positional", "--body", "from-body", "--author", "owner-a"],
      ];
      for (const args of conflictCases) {
        const conflicting = context.runCli(args);
        expect(conflicting.code).toBe(EXIT_CODE.USAGE);
        expect(conflicting.stderr).toContain("exactly one source");
      }

      const missing = context.runCli(["append", id, "--author", "owner-a"]);
      expect(missing.code).toBe(EXIT_CODE.USAGE);
      expect(missing.stderr).toContain("Missing append text");
    });
  });

  it("returns empty append output when incoming body is blank", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-blank",
        body: "seed body",
      });
      const appendResult = await runAppend(
        id,
        {
          body: "   ",
          author: "append-author",
          message: "Blank append should be ignored",
        },
        { path: context.pmPath },
      );

      expect(appendResult.appended).toBe("");
      expect(appendResult.changed_fields).toEqual([]);

      const getResult = await runGet(id, { path: context.pmPath });
      expect(getResult.body).toBe("seed body");
    });
  });

  it("appends with and without spacer and falls back to unknown author", async () => {
    await withTempPmPath(async (context) => {
      const emptyBodyId = createTask(context, {
        title: "append-empty-body",
        body: "",
      });
      const firstAppend = await runAppend(
        emptyBodyId,
        {
          body: "first entry",
          message: "append empty body",
        },
        { path: context.pmPath },
      );
      expect(firstAppend.appended).toBe("first entry");
      expect(firstAppend.changed_fields).toContain("body");
      const afterFirstAppend = await runGet(emptyBodyId, { path: context.pmPath });
      expect(afterFirstAppend.body).toBe("first entry");
      const firstHistory = context.runCli(["history", emptyBodyId, "--json", "--full"], { expectJson: true });
      expect(firstHistory.code).toBe(0);
      const firstHistoryJson = firstHistory.json as { history: Array<{ op: string; author: string }> };
      const firstAppendAuthor = [...firstHistoryJson.history]
        .reverse()
        .find((entry) => entry.op === "append")?.author;
      expect(firstAppendAuthor).toBe("test-author");

      const spacedBodyId = createTask(context, {
        title: "append-existing-body",
        body: "existing body   \n",
      });
      const settingsAuthorId = createTask(context, {
        title: "append-settings-author",
        body: "",
      });
      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const secondAppend = await runAppend(
          spacedBodyId,
          {
            body: "second entry",
            author: "   ",
            message: "append with unknown author fallback",
          },
          { path: context.pmPath },
        );
        expect(secondAppend.appended).toBe("second entry");
        expect(secondAppend.changed_fields).toContain("body");

        const afterSecondAppend = await runGet(spacedBodyId, { path: context.pmPath });
        expect(afterSecondAppend.body).toBe("existing body\n\nsecond entry");

        const history = context.runCli(["history", spacedBodyId, "--json", "--full"], { expectJson: true });
        expect(history.code).toBe(0);
        const historyJson = history.json as { history: Array<{ op: string; author: string }> };
        const appendAuthor = [...historyJson.history]
          .reverse()
          .find((entry) => entry.op === "append")?.author;
        expect(appendAuthor).toBe("unknown");

        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
          author_default?: string;
        };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsAppend = await runAppend(
          settingsAuthorId,
          {
            body: "from settings fallback",
            message: "append with settings author fallback",
          },
          { path: context.pmPath },
        );
        expect(settingsAppend.changed_fields).toContain("body");
        const settingsHistory = context.runCli(["history", settingsAuthorId, "--json", "--full"], { expectJson: true });
        expect(settingsHistory.code).toBe(0);
        const settingsHistoryJson = settingsHistory.json as {
          history: Array<{ op: string; author: string }>;
        };
        const settingsAppendAuthor = [...settingsHistoryJson.history]
          .reverse()
          .find((entry) => entry.op === "append")?.author;
        expect(settingsAppendAuthor).toBe("settings-author");
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("accepts stdin token payload for append body", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-stdin-token",
        body: "existing body",
      });
      const stdin = new PassThrough();
      stdin.end("markdown from stdin");
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const appendResult = await runAppend(id, { body: "-", message: "append stdin payload" }, { path: context.pmPath });
      expect(appendResult.changed_fields).toContain("body");
      const getResult = await runGet(id, { path: context.pmPath });
      expect(getResult.body).toBe("existing body\n\nmarkdown from stdin");
    });
  });
});
