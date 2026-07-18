import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkspaceTransactionInterruptedError,
  commitWorkspaceTransaction,
  type WorkspaceTransactionStep,
  type WorkspaceTransactionStepState,
} from "../../../src/sdk/workspace-transaction.js";

interface TestStepState {
  state: WorkspaceTransactionStepState;
  value: number;
}

/** Create an inspectable, idempotent transaction step over test-owned state. */
function createTestStep(
  id: string,
  state: TestStepState,
  events: string[],
): WorkspaceTransactionStep {
  return {
    id,
    inspect: async () => ({
      state: state.state,
      ...(state.state === "applied" ? { result: { value: state.value } } : {}),
    }),
    apply: async () => {
      state.state = "applied";
      state.value += 1;
      events.push(`apply:${id}`);
      return { value: state.value };
    },
    compensate: async () => {
      state.state = "compensated";
      state.value -= 1;
      events.push(`compensate:${id}`);
    },
  };
}

describe("workspace SDK transactions", () => {
  it("commits multiple ordered mutations and replays the durable result", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      const events: string[] = [];
      const first = { state: "pending" as const, value: 0 };
      const second = { state: "pending" as const, value: 10 };
      const options = {
        pmRoot,
        transactionId: "multi-item-commit",
        author: "transaction-agent",
        lockTtlSeconds: 60,
        lockWaitMs: 5_000,
        steps: [
          createTestStep("first", first, events),
          createTestStep("second", second, events),
        ],
      };
      await expect(commitWorkspaceTransaction(options)).resolves.toMatchObject({
        transactionId: "multi-item-commit",
        status: "committed",
        recovered: false,
        results: { first: { value: 1 }, second: { value: 11 } },
      });
      await expect(commitWorkspaceTransaction(options)).resolves.toMatchObject({
        recovered: true,
      });
      expect(events).toEqual(["apply:first", "apply:second"]);
      expect(
        JSON.parse(
          await readFile(
            path.join(pmRoot, "transactions", "sdk", "multi-item-commit.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        status: "committed",
        completedStepIds: ["first", "second"],
      });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("compensates every applied mutation in reverse order on ordinary failure", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      const events: string[] = [];
      const states = [0, 10, 20].map((value) => ({
        state: "pending" as WorkspaceTransactionStepState,
        value,
      }));
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "compensate-all",
          author: "transaction-agent",
          steps: states.map((state, index) =>
            createTestStep(`step-${index + 1}`, state, events),
          ),
          onTransition: ({ transition }) => {
            if (transition === "committing")
              throw new Error("commit gate failed");
          },
        }),
      ).rejects.toThrow("commit gate failed");
      expect(events).toEqual([
        "apply:step-1",
        "apply:step-2",
        "apply:step-3",
        "compensate:step-3",
        "compensate:step-2",
        "compensate:step-1",
      ]);
      expect(states).toEqual([
        { state: "compensated", value: 0 },
        { state: "compensated", value: 10 },
        { state: "compensated", value: 20 },
      ]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("recovers crashes before and after step journal writes", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      const events: string[] = [];
      const first = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const second = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const steps = [
        createTestStep("first", first, events),
        createTestStep("second", second, events),
      ];
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "crash-recovery",
          author: "transaction-agent",
          steps,
          onTransition: ({ transition, stepId }) => {
            if (transition === "step_applied" && stepId === "first")
              throw new WorkspaceTransactionInterruptedError(
                "crash before record",
              );
          },
        }),
      ).rejects.toThrow("crash before record");
      expect(first.state).toBe("applied");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "crash-recovery",
          author: "transaction-agent",
          steps,
          onTransition: ({ transition, stepId }) => {
            if (transition === "step_recorded" && stepId === "second")
              throw new WorkspaceTransactionInterruptedError(
                "crash after record",
              );
          },
        }),
      ).rejects.toThrow("crash after record");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "crash-recovery",
          author: "transaction-agent",
          steps,
        }),
      ).resolves.toMatchObject({ status: "committed", recovered: true });
      expect(events).toEqual(["apply:first", "apply:second"]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("resumes interrupted compensation before starting the next attempt", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      const events: string[] = [];
      const first = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const second = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const steps = [
        createTestStep("first", first, events),
        createTestStep("second", second, events),
      ];
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "compensation-recovery",
          author: "transaction-agent",
          steps,
          onTransition: ({ transition, stepId }) => {
            if (transition === "committing") throw new Error("abort attempt");
            if (transition === "step_compensated" && stepId === "second")
              throw new WorkspaceTransactionInterruptedError(
                "crash during compensation",
              );
          },
        }),
      ).rejects.toThrow("crash during compensation");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "compensation-recovery",
          author: "transaction-agent",
          steps,
        }),
      ).resolves.toMatchObject({ status: "committed", recovered: true });
      expect(events).toEqual([
        "apply:first",
        "apply:second",
        "compensate:second",
        "compensate:first",
        "apply:first",
        "apply:second",
      ]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("durably compensates when inspection itself reports a conflict", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      const events: string[] = [];
      const item = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      let conflict = true;
      let conflictInspections = 0;
      let relationshipApplied = false;
      const relationship: WorkspaceTransactionStep = {
        id: "relationship",
        inspect: async () => {
          conflictInspections += 1;
          if (conflict && conflictInspections > 1)
            throw new TypeError("conflicting relationship winner");
          return { state: relationshipApplied ? "applied" : "pending" };
        },
        apply: async () => {
          relationshipApplied = true;
          events.push("apply:relationship");
          return { relationship: "committed" };
        },
        compensate: async () => {
          if (relationshipApplied) relationshipApplied = false;
          events.push("reconcile:relationship");
        },
      };
      const options = {
        pmRoot,
        transactionId: "inspection-conflict",
        author: "agent",
        steps: [createTestStep("item", item, events), relationship],
      };
      await expect(commitWorkspaceTransaction(options)).rejects.toThrow(
        "conflicting relationship winner",
      );
      expect(
        JSON.parse(
          await readFile(
            path.join(
              pmRoot,
              "transactions",
              "sdk",
              "inspection-conflict.json",
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({ status: "compensated", completedStepIds: [] });
      expect(item.state).toBe("compensated");

      conflict = false;
      await expect(commitWorkspaceTransaction(options)).resolves.toMatchObject({
        status: "committed",
        recovered: true,
        results: { relationship: { relationship: "committed" } },
      });
      expect(events).toEqual([
        "apply:item",
        "reconcile:relationship",
        "compensate:item",
        "apply:item",
        "apply:relationship",
      ]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed plans and journal drift", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "empty-plan",
          author: "agent",
          steps: [],
        }),
      ).rejects.toThrow("at least one step");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "bad/id",
          author: "agent",
          steps: [],
        }),
      ).rejects.toThrow("Transaction id");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "empty",
          author: " ",
          steps: [],
        }),
      ).rejects.toThrow("author");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: null as unknown as string,
          author: "agent",
          steps: [],
        }),
      ).rejects.toThrow("Transaction id must be a string");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "wrong-author-type",
          author: 42 as unknown as string,
          steps: [],
        }),
      ).rejects.toThrow("Transaction author must be a string");
      const state = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const duplicate = createTestStep("same", state, []);
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "bad-lock-ttl",
          author: "agent",
          lockTtlSeconds: 0,
          steps: [duplicate],
        }),
      ).rejects.toThrow("lock TTL");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "bad-lock-wait",
          author: "agent",
          lockWaitMs: 1.5,
          steps: [duplicate],
        }),
      ).rejects.toThrow("lock wait");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "duplicate",
          author: "agent",
          steps: [duplicate, duplicate],
        }),
      ).rejects.toThrow("must be unique");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "wrong-step-type",
          author: "agent",
          steps: [{ ...duplicate, id: false as unknown as string }],
        }),
      ).rejects.toThrow("Transaction step id must be a string");
      const journalDir = path.join(pmRoot, "transactions", "sdk");
      await mkdir(journalDir, { recursive: true });
      await writeFile(
        path.join(journalDir, "drift.json"),
        '{"schemaVersion":1,"transactionId":"other"}\n',
        "utf8",
      );
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "drift",
          author: "agent",
          steps: [createTestStep("step", state, [])],
        }),
      ).rejects.toThrow("does not match");
      await writeFile(
        path.join(journalDir, "drift.json"),
        "not-json\n",
        "utf8",
      );
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "drift",
          author: "agent",
          steps: [createTestStep("step", state, [])],
        }),
      ).rejects.toThrow("invalid JSON");
      await writeFile(path.join(journalDir, "drift.json"), "null\n", "utf8");
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "drift",
          author: "agent",
          steps: [createTestStep("step", state, [])],
        }),
      ).rejects.toThrow("journal is invalid");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("rejects forged journal lifecycle state before replay", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      const journalDir = path.join(pmRoot, "transactions", "sdk");
      await mkdir(journalDir, { recursive: true });
      const state = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const steps = [createTestStep("step", state, [])];
      const base = {
        schemaVersion: 1,
        transactionId: "forged",
        author: "agent",
        status: "applying",
        attempt: 1,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
        stepIds: ["step"],
        completedStepIds: [] as string[],
        results: {},
      };
      const malformed = [
        [],
        { ...base, results: [] },
        { ...base, completedStepIds: ["unknown"] },
        { ...base, completedStepIds: ["step", "step"] },
        { ...base, results: { step: { value: 1 } } },
        { ...base, status: "committed" },
        { ...base, status: "compensated", completedStepIds: ["step"] },
      ];
      for (const journal of malformed) {
        await writeFile(
          path.join(journalDir, "forged.json"),
          `${JSON.stringify(journal)}\n`,
          "utf8",
        );
        await expect(
          commitWorkspaceTransaction({
            pmRoot,
            transactionId: "forged",
            author: "agent",
            steps,
          }),
        ).rejects.toThrow(/journal (?:is invalid|does not match)/);
      }
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("keeps adversarial step ids safe and rebuilds stale recovery state", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      const events: string[] = [];
      const adversarial = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const result = await commitWorkspaceTransaction({
        pmRoot,
        transactionId: "prototype-safe",
        author: "agent",
        steps: [createTestStep("__proto__", adversarial, events)],
      });
      expect(Object.getPrototypeOf(result.results)).toBeNull();
      expect(Object.hasOwn(result.results, "__proto__")).toBe(true);
      expect(result.results.__proto__).toEqual({ value: 1 });

      const stale = {
        state: "pending" as WorkspaceTransactionStepState,
        value: 0,
      };
      const staleStep = createTestStep("stale", stale, events);
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "stale-recovery",
          author: "agent",
          steps: [staleStep],
          onTransition: ({ transition }) => {
            if (transition === "step_recorded")
              throw new WorkspaceTransactionInterruptedError("crash");
          },
        }),
      ).rejects.toThrow("crash");
      stale.state = "pending";
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "stale-recovery",
          author: "agent",
          steps: [staleStep],
        }),
      ).resolves.toMatchObject({
        status: "committed",
        results: { stale: { value: 2 } },
      });
      expect(events).toEqual(["apply:__proto__", "apply:stale", "apply:stale"]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("commits result-free recovered steps and skips already compensated work", async () => {
    const pmRoot = await mkdtemp(path.join(tmpdir(), "pm-sdk-transaction-"));
    try {
      let inspectionCount = 0;
      let recoveredInspections = 0;
      const recovered: WorkspaceTransactionStep = {
        id: "recovered",
        inspect: async () => ({
          state: ++recoveredInspections === 1 ? "pending" : "applied",
        }),
        apply: async () => {
          throw new Error("recovered step must not be applied twice");
        },
        compensate: async () => undefined,
      };
      const resultFree: WorkspaceTransactionStep = {
        id: "result-free",
        inspect: async () => ({ state: "pending" }),
        apply: async () => undefined,
        compensate: async () => undefined,
      };
      const discovered: WorkspaceTransactionStep = {
        id: "discovered",
        inspect: async () => ({ state: "applied" }),
        apply: async () => {
          throw new Error("discovered step must not be applied twice");
        },
        compensate: async () => undefined,
      };
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "result-free",
          author: "agent",
          steps: [discovered, recovered, resultFree],
        }),
      ).resolves.toMatchObject({ results: {} });

      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "already-compensated",
          author: "agent",
          steps: [
            {
              id: "step",
              inspect: async () => ({
                state: ++inspectionCount < 3 ? "pending" : "compensated",
              }),
              apply: async () => undefined,
              compensate: async () => {
                throw new Error("compensated step must not run again");
              },
            },
          ],
          onTransition: ({ transition }) => {
            if (transition === "committing") throw new Error("abort");
          },
        }),
      ).rejects.toThrow("abort");

      let raceInspection = 0;
      await expect(
        commitWorkspaceTransaction({
          pmRoot,
          transactionId: "compensation-race",
          author: "agent",
          steps: [
            {
              id: "step",
              inspect: async () => ({
                state:
                  ++raceInspection === 2
                    ? "applied"
                    : ("compensated" as WorkspaceTransactionStepState),
              }),
              apply: async () => undefined,
              compensate: async () => {
                throw new Error("concurrently compensated step must not run");
              },
            },
          ],
          onTransition: ({ transition }) => {
            if (transition === "committing") throw new Error("race abort");
          },
        }),
      ).rejects.toThrow("race abort");
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
