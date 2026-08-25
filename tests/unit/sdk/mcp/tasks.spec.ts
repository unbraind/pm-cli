import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PM_MCP_TASKS_EXTENSION,
  PM_MCP_TASK_STATUSES,
  PmMcpProtocolError,
  PmMcpTaskStore,
  createMcpTaskStore,
  resolveMcpRequestContext,
} from "../../../../src/sdk/index.js";

const TASK_ID = "mcp-task-123e4567-e89b-42d3-a456-426614174000";
const SECOND_TASK_ID = "mcp-task-123e4567-e89b-42d3-a456-426614174001";
const PRINCIPAL = "test-host@1";
const REQUEST_CONTEXT = resolveMcpRequestContext({
  _meta: {
    [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
    [PM_MCP_META_KEYS.clientCapabilities]: {
      elicitation: {},
      extensions: { [PM_MCP_TASKS_EXTENSION]: {} },
    },
  },
});

async function withTaskStore(
  callback: (input: {
    pmRoot: string;
    store: PmMcpTaskStore;
    setNow: (value: string) => void;
  }) => Promise<void>,
): Promise<void> {
  const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-mcp-tasks-"));
  let now = new Date("2026-08-25T12:00:00.000Z");
  const ids = [TASK_ID, SECOND_TASK_ID];
  const store = createMcpTaskStore({
    pmRoot,
    now: () => now,
    taskIdFactory: () => ids.shift() ?? SECOND_TASK_ID,
  });
  try {
    await callback({
      pmRoot,
      store,
      setNow: (value) => {
        now = new Date(value);
      },
    });
  } finally {
    await rm(pmRoot, { recursive: true, force: true });
  }
}

function elicitationRequest(message = "Approve this operation") {
  return {
    method: "elicitation/create",
    params: {
      mode: "form",
      message,
      requestedSchema: { type: "object" },
    },
  };
}

describe("official MCP tasks extension store", () => {
  it("publishes the extension identifier and complete status vocabulary", () => {
    expect(PM_MCP_TASKS_EXTENSION).toBe("io.modelcontextprotocol/tasks");
    expect(PM_MCP_TASK_STATUSES).toEqual([
      "working",
      "input_required",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("durably creates a task before returning its working handle", async () => {
    await withTaskStore(async ({ store }) => {
      const task = await store.create({
        principal: PRINCIPAL,
        statusMessage: `  ${"w".repeat(1100)}  `,
      });
      expect(task).toMatchObject({
        resultType: "task",
        taskId: TASK_ID,
        status: "working",
        createdAt: "2026-08-25T12:00:00.000Z",
        lastUpdatedAt: "2026-08-25T12:00:00.000Z",
        ttlMs: 3_600_000,
        pollIntervalMs: 1000,
      });
      expect(task.statusMessage).toHaveLength(1024);
      await expect(store.get(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "working",
      });
    });
  });

  it("supports partial mid-flight input, duplicate ignores, and deterministic resume", async () => {
    await withTaskStore(async ({ store, setNow }) => {
      await store.create({
        principal: PRINCIPAL,
        ttlMs: null,
        pollIntervalMs: 0,
      });
      setNow("2026-08-25T12:01:00.000Z");
      await expect(
        store.requireInput({
          taskId: TASK_ID,
          principal: PRINCIPAL,
          requestContext: REQUEST_CONTEXT,
          inputRequests: {
            approval: elicitationRequest(),
            reason: elicitationRequest("Explain the approval"),
          },
          statusMessage: "Waiting for approval.",
        }),
      ).resolves.toMatchObject({
        status: "input_required",
        inputRequests: {
          approval: { method: "elicitation/create" },
          reason: { method: "elicitation/create" },
        },
      });
      await expect(
        store.update(TASK_ID, PRINCIPAL, {
          approval: { action: "accept", content: { approved: true } },
          unknown: { action: "accept" },
        }),
      ).resolves.toEqual({
        acceptedKeys: ["approval"],
        remainingKeys: ["reason"],
      });
      await expect(
        store.update(TASK_ID, PRINCIPAL, {
          approval: { action: "accept" },
        }),
      ).resolves.toEqual({ acceptedKeys: [], remainingKeys: ["reason"] });
      await expect(
        store.update(TASK_ID, PRINCIPAL, {
          reason: { action: "accept", content: { text: "safe" } },
        }),
      ).resolves.toEqual({ acceptedKeys: ["reason"], remainingKeys: [] });
      await expect(store.get(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "working",
      });
      await expect(
        store.takeInputResponses(TASK_ID, PRINCIPAL),
      ).resolves.toEqual({
        approval: { action: "accept", content: { approved: true } },
        reason: { action: "accept", content: { text: "safe" } },
      });
      await expect(
        store.takeInputResponses(TASK_ID, PRINCIPAL),
      ).resolves.toEqual({});
      await expect(
        store.requireInput({
          taskId: TASK_ID,
          principal: PRINCIPAL,
          requestContext: REQUEST_CONTEXT,
          inputRequests: { approval: elicitationRequest() },
        }),
      ).rejects.toThrow(/unique for the task lifetime/u);
    });
  });

  it("records immutable completed, failed, and cancelled terminal variants", async () => {
    await withTaskStore(async ({ store }) => {
      await store.create({ principal: PRINCIPAL });
      await expect(
        store.complete(TASK_ID, PRINCIPAL, { content: [], isError: false }),
      ).resolves.toMatchObject({
        status: "completed",
        result: { content: [], isError: false },
      });
      await expect(
        store.complete(TASK_ID, PRINCIPAL, { content: [{ late: true }] }),
      ).resolves.toMatchObject({
        status: "completed",
        result: { content: [], isError: false },
      });
      await expect(store.get(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "completed",
      });
      await expect(
        store.requireInput({
          taskId: TASK_ID,
          principal: PRINCIPAL,
          requestContext: REQUEST_CONTEXT,
          inputRequests: { approval: elicitationRequest() },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(store.cancel(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "completed",
      });
      await expect(
        store.fail(TASK_ID, PRINCIPAL, { code: -32603, message: "late" }),
      ).resolves.toMatchObject({ status: "completed" });

      await store.create({ principal: PRINCIPAL });
      await expect(
        store.fail(SECOND_TASK_ID, PRINCIPAL, {
          code: -32022,
          message: "x".repeat(1100),
          data: { supported: [PM_MCP_PROTOCOL_VERSION] },
        }),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          code: -32022,
          message: "x".repeat(1024),
          data: { supported: [PM_MCP_PROTOCOL_VERSION] },
        },
      });
      await expect(store.get(SECOND_TASK_ID, PRINCIPAL)).resolves.toMatchObject(
        {
          status: "failed",
        },
      );
    });
  });

  it("cancels active work and idempotently ignores later updates", async () => {
    await withTaskStore(async ({ store }) => {
      await store.create({ principal: PRINCIPAL });
      await expect(store.cancel(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(
        store.update(TASK_ID, PRINCIPAL, { unknown: { action: "accept" } }),
      ).resolves.toEqual({ acceptedKeys: [], remainingKeys: [] });
      await expect(store.cancel(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "cancelled",
      });
    });
  });

  it("fails expired tasks with actionable create-new-task recovery", async () => {
    await withTaskStore(async ({ store, setNow }) => {
      await store.create({ principal: PRINCIPAL, ttlMs: 1000 });
      setNow("2026-08-25T12:00:01.000Z");
      await expect(store.get(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "failed",
        error: {
          message: "MCP task expired",
          data: { recoverable: false, createNewTask: true },
        },
      });
    });
  });

  it("recovers a durable working handle after its worker process disappeared", async () => {
    await withTaskStore(async ({ pmRoot }) => {
      const oldWorker = createMcpTaskStore({
        pmRoot,
        workerPid: 99_999_999,
        taskIdFactory: () => TASK_ID,
      });
      await oldWorker.create({ principal: PRINCIPAL });
      const restarted = createMcpTaskStore({ pmRoot, workerPid: process.pid });
      await expect(restarted.get(TASK_ID, PRINCIPAL)).resolves.toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("worker unavailable") },
      });
    });
  });

  it("hides unknown, malformed, and cross-principal task records", async () => {
    await withTaskStore(async ({ pmRoot, store }) => {
      await store.create({ principal: PRINCIPAL });
      await expect(store.get(TASK_ID, "other@1")).rejects.toMatchObject({
        data: { code: "mcp_task_not_found_or_not_authorized" },
      });
      await expect(store.get("../escape", PRINCIPAL)).rejects.toThrow(
        /Unknown/u,
      );
      await expect(store.get(SECOND_TASK_ID, PRINCIPAL)).rejects.toThrow(
        /Unknown/u,
      );

      const recordRoot = path.join(pmRoot, "runtime", "mcp-tasks", "records");
      await mkdir(recordRoot, { recursive: true });
      await writeFile(
        path.join(recordRoot, `${SECOND_TASK_ID}.json`),
        "{bad",
        "utf8",
      );
      await expect(store.get(SECOND_TASK_ID, PRINCIPAL)).rejects.toThrow(
        /Unknown/u,
      );
      await writeFile(
        path.join(recordRoot, `${SECOND_TASK_ID}.json`),
        `${JSON.stringify({ version: 2 })}\n`,
        "utf8",
      );
      await expect(store.get(SECOND_TASK_ID, PRINCIPAL)).rejects.toThrow(
        /Corrupt/u,
      );
    });
  });

  it("fails closed on corrupt durable task fields and status payloads", async () => {
    await withTaskStore(async ({ pmRoot, store }) => {
      const recordRoot = path.join(pmRoot, "runtime", "mcp-tasks", "records");
      await mkdir(recordRoot, { recursive: true });
      const base = {
        version: 1,
        taskId: SECOND_TASK_ID,
        status: "working",
        principal: PRINCIPAL,
        workerPid: process.pid,
        createdAt: "2026-08-25T12:00:00.000Z",
        lastUpdatedAt: "2026-08-25T12:00:00.000Z",
        ttlMs: null,
        consumedInputKeys: [],
      };
      const variants = [
        { ...base, createdAt: "not-a-date" },
        { ...base, taskId: undefined },
        { ...base, status: "queued" },
        { ...base, principal: "" },
        { ...base, workerPid: 0 },
        { ...base, ttlMs: -1 },
        { ...base, pollIntervalMs: -1 },
        { ...base, consumedInputKeys: [1] },
        { ...base, status: "failed" },
        { ...base, status: "failed", error: { code: "bad", message: 1 } },
      ];
      for (const value of variants) {
        await writeFile(
          path.join(recordRoot, `${SECOND_TASK_ID}.json`),
          `${JSON.stringify(value)}\n`,
          "utf8",
        );
        await expect(store.get(SECOND_TASK_ID, PRINCIPAL)).rejects.toThrow(
          /Corrupt|Unknown/u,
        );
      }
      await writeFile(
        path.join(recordRoot, `${SECOND_TASK_ID}.json`),
        `${JSON.stringify(base)}\n`,
        "utf8",
      );
      await expect(store.get(SECOND_TASK_ID, PRINCIPAL)).resolves.toEqual(
        expect.not.objectContaining({ pollIntervalMs: expect.anything() }),
      );
    });
  });

  it("rejects unsafe task creation and failure payloads", async () => {
    await withTaskStore(async ({ pmRoot, store }) => {
      for (const input of [
        { principal: " " },
        { principal: PRINCIPAL, ttlMs: -1 },
        { principal: PRINCIPAL, pollIntervalMs: 1.5 },
      ]) {
        await expect(store.create(input)).rejects.toThrow(/creation options/u);
      }
      const badIdStore = createMcpTaskStore({
        pmRoot,
        taskIdFactory: () => "task-unsafe",
      });
      await expect(badIdStore.create({ principal: PRINCIPAL })).rejects.toThrow(
        /Unknown MCP task/u,
      );
      await store.create({ principal: PRINCIPAL });
      await expect(
        store.fail(TASK_ID, PRINCIPAL, {
          code: Number.NaN,
          message: "invalid",
        }),
      ).rejects.toThrow(/task error/u);
    });
  });

  it("returns the public class from the convenience factory", async () => {
    await withTaskStore(async ({ pmRoot }) => {
      const generated = createMcpTaskStore({ pmRoot });
      expect(generated).toBeInstanceOf(PmMcpTaskStore);
      await expect(
        generated.create({ principal: PRINCIPAL }),
      ).resolves.toMatchObject({
        taskId: expect.stringMatching(/^mcp-task-[0-9a-f-]{36}$/u),
      });
      expect(new PmMcpProtocolError("failure", -32602)).toBeInstanceOf(Error);
    });
  });
});
