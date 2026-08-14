import { describe, expect, it, vi } from "vitest";
import { loadContextIntentSnapshotForInvocation } from "../../../src/cli/context-intent-invocation.js";
import { TOOLS } from "../../../src/mcp/tool-definitions.js";
import { pmToolActionParameterKeys } from "../../../src/sdk/cli-contracts/tool-schema.js";
import {
  actionGlobalOptions,
  optionsWithAuthor,
} from "../../../src/sdk/runtime-input.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { runDirectDistCli } from "../../helpers/cliRunner.js";

const CANONICAL_KEYS = [
  "outputInclude",
  "outputLimit",
  "outputBudget",
  "outputFormat",
  "outputSession",
  "outputCursor",
] as const;

describe("universal read-output transport contracts", () => {
  it("publishes canonical controls in strict SDK schemas", () => {
    for (const action of ["list", "context", "search", "get", "health"]) {
      expect(pmToolActionParameterKeys(action)).toEqual(
        expect.arrayContaining(CANONICAL_KEYS),
      );
    }
    expect(pmToolActionParameterKeys("create")).not.toEqual(
      expect.arrayContaining(CANONICAL_KEYS),
    );
  });

  it("publishes canonical controls on narrow MCP tools", () => {
    const listTool = TOOLS.find(({ name }) => name === "pm_list");
    const runTool = TOOLS.find(({ name }) => name === "pm_run");
    const properties = listTool?.inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    const runProperties = runTool?.inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(CANONICAL_KEYS),
    );
    expect(properties?.outputInclude).toMatchObject({ minLength: 1 });
    const outputBudgetSchema = {
      anyOf: [{ type: "integer", minimum: 1 }, { const: "unbounded" }],
    };
    expect(properties?.outputBudget).toMatchObject(outputBudgetSchema);
    expect(runProperties?.outputBudget).toMatchObject(outputBudgetSchema);
    const outputSession = properties?.outputSession;
    if (!outputSession) {
      throw new Error("pm_list must expose the canonical outputSession schema");
    }
    expect(outputSession).toMatchObject({
      anyOf: expect.any(Array),
    });
    const sessionAlternatives = (
      outputSession as { anyOf: Record<string, unknown>[] }
    ).anyOf;
    expect(runProperties?.outputSession).toMatchObject({
      anyOf: sessionAlternatives,
    });
    expect(sessionAlternatives[1]).toMatchObject({
      properties: {
        seen_item_ids: { maxItems: 10_000 },
      },
    });
    const objectAlternative = sessionAlternatives[1] as
      | { properties: Record<string, Record<string, unknown>> }
      | undefined;
    if (!objectAlternative) {
      throw new Error("outputSession must expose its object state alternative");
    }
    expect(objectAlternative.properties.seen_item_ids).not.toHaveProperty(
      "uniqueItems",
    );
  });

  it("rejects an unsupported canonical output format at invocation time", () => {
    const result = runDirectDistCli([
      "list",
      "--output-format",
      "yaml",
      "--no-extensions",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--output-format must be toon or json");
  });

  it("carries session state between real CLI reads in a temporary tracker", async () => {
    await withTempPmPath(async ({ runCli }) => {
      for (const title of ["Alpha session item", "Beta session item"]) {
        expect(
          runCli([
            "create",
            "--create-mode",
            "progressive",
            "--title",
            title,
            "--type",
            "Task",
            "--json",
            "--no-extensions",
          ]).code,
        ).toBe(0);
      }
      const initialState = {
        version: 1,
        id: "orientation",
        token_budget: 4_000,
        spent_tokens: 0,
        seen_item_ids: [],
      };
      const first = runCli(
        [
          "list",
          "--output-session",
          JSON.stringify(initialState),
          "--json",
          "--no-extensions",
        ],
        { expectJson: true },
      );
      expect(first.code).toBe(0);
      const firstEnvelope = first.json as Record<string, unknown>;
      const firstReceipt = firstEnvelope.read_session as Record<
        string,
        unknown
      >;
      const second = runCli(
        [
          "list",
          "--output-session",
          JSON.stringify(firstReceipt.next_state),
          "--json",
          "--no-extensions",
        ],
        { expectJson: true },
      );
      expect(second.code).toBe(0);
      const secondEnvelope = second.json as Record<string, unknown>;
      expect(secondEnvelope.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            context_ref: expect.stringMatching(/^session:orientation:pm-/u),
          }),
        ]),
      );
      expect(secondEnvelope.read_session).toMatchObject({
        seen_before_count: 2,
        new_item_count: 0,
        suppressed_repeat_count: 2,
      });
    });
  });

  it("executes a budget-continuation promise through the real CLI", async () => {
    await withTempPmPath(async ({ runCli }) => {
      const createdIds: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const created = runCli(
          [
            "create",
            "--create-mode",
            "progressive",
            "--title",
            `Continuation item ${String(index).padStart(2, "0")}`,
            "--description",
            `Continuation evidence ${"x".repeat(600)}`,
            "--type",
            "Task",
            "--json",
            "--no-extensions",
          ],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
        createdIds.push((created.json as { item: { id: string } }).item.id);
      }
      for (const id of createdIds) {
        expect(
          runCli([
            "close",
            id,
            "Continuation acceptance fixture",
            "--validate-close",
            "off",
            "--json",
            "--no-extensions",
          ]).code,
        ).toBe(0);
      }

      const complete = runCli(
        [
          "list-closed",
          "--full",
          "--output-budget=unbounded",
          "--json",
          "--no-extensions",
        ],
        { expectJson: true },
      );
      expect(complete.code).toBe(0);
      const completeIds = (
        complete.json as { items: Array<{ id: string }> }
      ).items.map((item) => item.id);

      const pagedIds: string[] = [];
      let outputCursor: string | undefined;
      let peakResponseBytes = 0;
      for (let page = 0; page < 20; page += 1) {
        const result = runCli(
          [
            "list-closed",
            "--full",
            "--output-budget=700",
            ...(outputCursor ? ["--output-cursor", outputCursor] : []),
            "--json",
            "--no-extensions",
          ],
          { expectJson: true },
        );
        expect(result.code).toBe(0);
        peakResponseBytes = Math.max(
          peakResponseBytes,
          Buffer.byteLength(JSON.stringify(result.json), "utf8"),
        );
        const envelope = result.json as {
          items: Array<{ id: string }>;
          next_cursor?: string;
          output_budget_truncation?: {
            recovery: {
              cursor: string;
              cli: "--output-cursor";
              sdk: "outputCursor";
              mcp: "outputCursor";
            };
          };
        };
        const pageIds = envelope.items.map((item) => item.id);
        expect(pageIds.length).toBeGreaterThan(0);
        expect(pageIds.filter((id) => pagedIds.includes(id))).toEqual([]);
        pagedIds.push(...pageIds);
        if (!envelope.next_cursor) break;
        expect(envelope.output_budget_truncation?.recovery).toMatchObject({
          cursor: envelope.next_cursor,
          cli: "--output-cursor",
          sdk: "outputCursor",
          mcp: "outputCursor",
        });
        expect(envelope.output_budget_truncation?.recovery.cursor).toBe(
          envelope.next_cursor,
        );
        outputCursor = envelope.next_cursor;
      }

      expect(pagedIds).toEqual(completeIds);
      expect(new Set(pagedIds).size).toBe(completeIds.length);
      expect(peakResponseBytes).toBeLessThan(12_000);
    });
  });

  it("rejects session controls on mutation commands before writing", async () => {
    await withTempPmPath(async ({ runCli }) => {
      const result = runCli([
        "create",
        "--title",
        "Must not exist",
        "--type",
        "Task",
        "--output-session",
        '{"version":1,"id":"invalid-scope","token_budget":2000,"spent_tokens":0,"seen_item_ids":[]}',
        "--no-extensions",
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "Universal output controls apply only to read commands",
      );
      const list = runCli(["list", "--json", "--no-extensions"], {
        expectJson: true,
      });
      expect(list.json).toMatchObject({ count: 0, items: [] });
    });
  });

  it("hoists top-level MCP controls while preserving nested precedence", () => {
    expect(
      optionsWithAuthor({
        outputInclude: "id,title",
        outputLimit: 5,
        outputBudget: 600,
        outputFormat: "toon",
        outputSession: { version: 1 },
        outputCursor: "cursor-1",
        options: { outputLimit: 3 },
      }),
    ).toMatchObject({
      outputInclude: "id,title",
      outputLimit: 3,
      outputBudget: 600,
      outputFormat: "toon",
      outputSession: { version: 1 },
      outputCursor: "cursor-1",
    });
  });

  it("normalizes renderer-facing global controls", () => {
    expect(
      actionGlobalOptions({
        outputInclude: "id,title",
        outputLimit: 5,
        outputBudget: "600",
        outputFormat: "json",
        outputSession: '{"version":1}',
        outputCursor: "cursor-1",
      }),
    ).toMatchObject({
      outputInclude: "id,title",
      outputLimit: "5",
      outputBudget: "600",
      outputFormat: "json",
      outputSession: '{"version":1}',
      outputCursor: "cursor-1",
    });
  });

  it("loads active package declarations only for intent-aware runtime reads", async () => {
    await withTempPmPath(async (context) => {
      const loadSnapshot = vi.fn(async () => null);
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["contracts", "--full"],
          context.pmPath,
          false,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["list", "--for=triage"],
          context.pmPath,
          false,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["list"],
          context.pmPath,
          false,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["contracts", "--full"],
          context.pmPath,
          true,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
      expect(loadSnapshot).toHaveBeenCalledWith(context.pmPath);
    });
  });
});
