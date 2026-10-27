import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runClose } from "../../src/cli/commands/lifecycle/close.js";
import { PmClient, runAction } from "../../src/sdk/runtime.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface HistoryPatch {
  op: string;
  path: string;
  value?: unknown;
}

interface HistoryEntry {
  op: string;
  patch: HistoryPatch[];
  context?: Record<string, unknown>;
}

/** Exercise each transport's distinct normalization and compact receipt boundary. */
async function closeThroughTransport(context: TempPmContext, transport: string, id: string, options: { completedAt?: string; force?: boolean }): Promise<unknown> {
  if (transport === "SDK") return new PmClient({ pmRoot: context.pmPath, noExtensions: true }).close(id, "Delivered", options);
  if (transport === "CLI") {
    const closed = context.runCli(["close", id, "Delivered", "--json", ...(options.completedAt ? ["--completed-at", options.completedAt] : []), ...(options.force ? ["--force"] : [])], { expectJson: true, preserveDefaultMutationOutput: true });
    expect(closed.code).toBe(0);
    return closed.json;
  }
  if (transport === "MCP") return runAction({ action: "close", id, reason: "Delivered", path: context.pmPath, options });
  const bulk = await runAction({ action: "close-many", path: context.pmPath, options: { list: { ids: id }, reason: "Delivered", ...options } }) as { rows: unknown[] };
  return bulk.rows[0];
}

describe("close history evidence", () => {
  it.each(["SDK", "CLI", "MCP", "bulk"])("discloses and seals completion provenance through %s", async (transport) => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      for (const source of ["close_time", "asserted", "existing"] as const) {
        const { item } = await client.create({ title: `Completion provenance ${source}` });
        const timestamp = "2026-01-02T03:04:05.000Z";
        if (source === "existing") await client.update(item.id, { status: "closed", completedAt: timestamp, closeReason: "Earlier delivery" });
        const options = { ...(source === "asserted" ? { completedAt: timestamp } : {}), ...(source === "existing" ? { force: true } : {}) };
        const historyPath = path.join(context.pmPath, "history", `${item.id}.jsonl`);
        const before = await readFile(historyPath, "utf8");
        const result = await closeThroughTransport(context, transport, item.id, options);
        const after = await readFile(historyPath, "utf8");
        expect(after.startsWith(before)).toBe(true);
        const entry = JSON.parse(after.trim().split("\n").at(-1)!) as HistoryEntry;
        const completion = { source, timestamp: source === "close_time" ? expect.any(String) : timestamp };
        expect(result).toMatchObject({ completion });
        expect(entry.context).toMatchObject({ completion });
        expect(entry.op).toBe("close");
        if (source === "close_time") {
          expect(result).toMatchObject({ completion: { hint: expect.stringContaining(`update ${item.id} --completed-at`) } });
        } else expect((result as { completion: unknown }).completion).not.toHaveProperty("hint");
        const stored = await client.get(item.id);
        if (source === "close_time") expect(stored.item.completed_at).toBe(stored.item.closed_at);
        expect(stored.item.completed_at).toBe((entry.context!.completion as { timestamp: string }).timestamp);
        expect(await runAction({ action: "history", id: item.id, path: context.pmPath, options: { verify: true } })).toMatchObject({ verification: { ok: true } });
      }
    });
  });
  it.each(["CLI", "MCP"])("preserves successful evidence follow-up in the default compact %s receipt", async (transport) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Successful close receipt" });
      let result: unknown;
      if (transport === "CLI") {
        const closed = context.runCli(["close", id, "Delivered", "--validate-close", "warn", "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
        expect(closed.code).toBe(0);
        result = closed.json;
      } else result = await runAction({ action: "close", id, reason: "Delivered", path: context.pmPath, options: { validateClose: "warn" } });
      const selectedScope = transport === "CLI" ? path.relative(process.cwd(), context.pmPath) : context.pmPath;
      expect(result).toMatchObject({ id, status: "closed", follow_up: { kind: "complete_close_evidence", missing: ["--resolution", "--expected-result", "--actual-result"], suggested_command: expect.stringContaining("update"), suggested_command_args: ["--pm-path", selectedScope, "update", id, "--resolution", "<value>", "--expected-result", "<value>", "--actual-result", "<value>"] } });
      expect(result).not.toHaveProperty("recovery");
    });
  });
  it("routes warning closes and terminal retries to an evidence-only update", async () => {
    await withTempPmPath(async (context) => {
      for (const mode of ["warning", "terminal"]) {
        const id = createTestItemId(context, {
          title: "Recover incomplete close evidence",
        });
        const closed = await runClose(
          id,
          "Delivered",
          { validateClose: "warn", resolution: "Implemented" },
          { path: context.pmPath },
        );
        expect(closed).not.toHaveProperty("recovery");
        expect(closed).toHaveProperty("follow_up.suggested_command_args");
        const followUp = (
          closed as unknown as { follow_up: { suggested_command_args: string[] } }
        ).follow_up;
        const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
        const before = await readFile(historyPath, "utf8");
        let args = followUp.suggested_command_args.map((token) =>
          token === "<value>" ? "Verified evidence" : token,
        );
        if (mode === "terminal") {
          const terminal: unknown = await runClose(
            id,
            "Delivered",
            { expectedResult: "Expected", actualResult: "Observed" },
            { path: context.pmPath },
          ).catch((error: unknown) => error);
          expect(terminal).toMatchObject({
            context: {
              recovery: {
                suggested_retry_args: [
                  "--pm-path",
                  context.pmPath,
                  "update",
                  id,
                  "--expected-result",
                  "Expected",
                  "--actual-result",
                  "Observed",
                ],
              },
            },
          });
          args = (
            terminal as {
              context: { recovery: { suggested_retry_args: string[] } };
            }
          ).context.recovery.suggested_retry_args;
        }
        expect(context.runCli([...args, "--json"]).code).toBe(0);
        const after = await readFile(historyPath, "utf8");
        expect(after.startsWith(before)).toBe(true);
        expect(
          context.runCli(["get", id, "--full", "--json"], { expectJson: true })
            .json,
        ).toMatchObject({
          item: {
            status: "closed",
            expected_result:
              mode === "terminal" ? "Expected" : "Verified evidence",
            actual_result:
              mode === "terminal" ? "Observed" : "Verified evidence",
          },
        });
      }
    });
  });

  it("records structured closure evidence in the immutable close event", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "atomic close history evidence",
        tags: "close,history,integration",
        estimate: "20",
        parent: "none",
      });

      const complete = await runClose(
        id,
        "Acceptance criteria and verification complete",
        {
          validateClose: "strict",
          resolution: "Delivered the requested behavior",
          expectedResult: "Closure metadata is complete at transition time",
          actualResult: "One close event contains the complete evidence",
        },
        { path: context.pmPath },
      );
      expect(complete).not.toHaveProperty("follow_up");

      const history = (
        await readFile(
          path.join(context.pmPath, "history", `${id}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      const closeEntries = history.filter((entry) => entry.op === "close");
      expect(closeEntries).toHaveLength(1);
      expect(closeEntries[0]?.patch).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/metadata/resolution",
            value: "Delivered the requested behavior",
          }),
          expect.objectContaining({
            path: "/metadata/expected_result",
            value: "Closure metadata is complete at transition time",
          }),
          expect.objectContaining({
            path: "/metadata/actual_result",
            value: "One close event contains the complete evidence",
          }),
          expect.objectContaining({
            path: "/metadata/status",
            value: "closed",
          }),
        ]),
      );
      expect(history.at(-1)?.op).toBe("close");
      await expect(
        runClose(id, "Repeat close", {}, { path: context.pmPath }),
      ).rejects.toMatchObject({ context: { recovery: undefined } });
    });
  });
});
