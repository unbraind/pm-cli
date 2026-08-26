import { describe, expect, it, vi } from "vitest";
import {
  PM_MCP_META_KEYS,
  PM_MCP_SUBSCRIPTION_ID_META_KEY,
  PmMcpProtocolError,
  PmMcpSubscriptionRegistry,
  parseMcpSubscriptionFilter,
  resolveMcpAcknowledgedSubscriptionFilter,
} from "../../../../src/sdk/index.js";

const CAPABILITIES = {
  tools: { listChanged: true },
  prompts: { listChanged: false },
  resources: { listChanged: true, subscribe: true },
};

describe("MCP subscription SDK contracts", () => {
  it("validates, deduplicates, and bounds subscription filters", () => {
    expect(
      parseMcpSubscriptionFilter({
        toolsListChanged: true,
        promptsListChanged: false,
        resourcesListChanged: true,
        resourceSubscriptions: [
          "pm://workspace/context",
          "pm://workspace/context",
        ],
      }),
    ).toEqual({
      toolsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: ["pm://workspace/context"],
    });
    expect(parseMcpSubscriptionFilter({ resourceSubscriptions: [] })).toEqual(
      {},
    );
    expect(parseMcpSubscriptionFilter({ promptsListChanged: true })).toEqual({
      promptsListChanged: true,
    });
    expect(() => parseMcpSubscriptionFilter([])).toThrow(PmMcpProtocolError);
    expect(() =>
      parseMcpSubscriptionFilter({ toolsListChanged: "yes" }),
    ).toThrow(/subscription filter/u);
    expect(() =>
      parseMcpSubscriptionFilter({
        resourceSubscriptions: new Array(257).fill("x"),
      }),
    ).toThrow(/resource subscriptions/u);
    for (const entry of [7, "", "x".repeat(2_049)]) {
      expect(() =>
        parseMcpSubscriptionFilter({ resourceSubscriptions: [entry] }),
      ).toThrow(/subscription URI/u);
    }
  });

  it("acknowledges only server-supported notification families", () => {
    expect(
      resolveMcpAcknowledgedSubscriptionFilter(
        {
          toolsListChanged: true,
          promptsListChanged: true,
          resourcesListChanged: true,
          resourceSubscriptions: ["pm://workspace/context"],
        },
        CAPABILITIES,
      ),
    ).toEqual({
      toolsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: ["pm://workspace/context"],
    });
    expect(resolveMcpAcknowledgedSubscriptionFilter({}, {})).toEqual({});
    expect(
      resolveMcpAcknowledgedSubscriptionFilter(
        { promptsListChanged: true },
        { prompts: { listChanged: true } },
      ),
    ).toEqual({ promptsListChanged: true });
  });

  it("correlates acknowledgments and opted-in notifications per stream", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const registry = new PmMcpSubscriptionRegistry({
      capabilities: CAPABILITIES,
      serverInfo: { name: "pm-mcp", version: "1" },
    });
    await expect(
      registry.open({
        id: 1,
        notifications: {
          toolsListChanged: true,
          resourceSubscriptions: ["pm://workspace/context"],
        },
        sink: first,
      }),
    ).resolves.toEqual({
      toolsListChanged: true,
      resourceSubscriptions: ["pm://workspace/context"],
    });
    await registry.open({
      id: "two",
      notifications: { resourcesListChanged: true },
      sink: second,
    });
    expect(registry.size).toBe(2);
    expect(first.mock.calls[0]?.[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: 1 } },
    });
    await expect(registry.emitListChanged("tools")).resolves.toBe(1);
    await expect(registry.emitListChanged("prompts")).resolves.toBe(0);
    await expect(registry.emitListChanged("resources")).resolves.toBe(1);
    await expect(
      registry.emitResourceUpdated("pm://workspace/context"),
    ).resolves.toBe(1);
    await expect(
      registry.emitResourceUpdated("pm://workspace/claims"),
    ).resolves.toBe(0);
    expect(first.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "notifications/resources/updated",
      params: {
        _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: 1 },
        uri: "pm://workspace/context",
      },
    });
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate streams, removes failed opens, and closes gracefully", async () => {
    const registry = new PmMcpSubscriptionRegistry({
      capabilities: CAPABILITIES,
      serverInfo: { name: "pm-mcp", version: "1" },
    });
    await expect(
      registry.open({
        id: 4,
        notifications: {},
        sink: () => {
          throw new Error("closed transport");
        },
      }),
    ).rejects.toThrow("closed transport");
    expect(registry.size).toBe(0);
    await registry.open({ id: 4, notifications: {}, sink: vi.fn() });
    await expect(
      registry.open({ id: 4, notifications: {}, sink: vi.fn() }),
    ).rejects.toThrow(/already active/u);
    expect(registry.close("missing")).toBeUndefined();
    expect(registry.close(4)).toMatchObject({
      resultType: "complete",
      _meta: {
        [PM_MCP_SUBSCRIPTION_ID_META_KEY]: 4,
        [PM_MCP_META_KEYS.serverInfo]: { name: "pm-mcp" },
      },
    });
    await registry.open({ id: 5, notifications: {}, sink: vi.fn() });
    await registry.open({ id: 6, notifications: {}, sink: vi.fn() });
    expect(registry.closeAll().map((entry) => entry.id)).toEqual([5, 6]);
    expect(registry.closeAll()).toEqual([]);
  });

  it("drops a failed sink without failing unrelated notification delivery", async () => {
    const registry = new PmMcpSubscriptionRegistry({
      capabilities: CAPABILITIES,
      serverInfo: { name: "pm-mcp", version: "1" },
    });
    await registry.open({
      id: "stale",
      notifications: { toolsListChanged: true },
      sink: (notification) => {
        if (!notification.method.includes("acknowledged")) {
          throw new Error("transport closed");
        }
      },
    });
    const healthy = vi.fn();
    await registry.open({
      id: "healthy",
      notifications: { toolsListChanged: true },
      sink: healthy,
    });
    await expect(registry.emitListChanged("tools")).resolves.toBe(1);
    expect(registry.size).toBe(1);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("serializes asynchronous sink writes so backpressure preserves ordering", async () => {
    const deliveries: string[] = [];
    const releases: Array<() => void> = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const registry = new PmMcpSubscriptionRegistry({
      capabilities: CAPABILITIES,
      serverInfo: { name: "pm-mcp", version: "1" },
    });
    await registry.open({
      id: "backpressure",
      notifications: {
        toolsListChanged: true,
        resourceSubscriptions: ["pm://workspace/context"],
      },
      sink: async (notification) => {
        if (notification.method.includes("acknowledged")) return;
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        deliveries.push(notification.method);
        activeWrites -= 1;
      },
    });
    const first = registry.emitListChanged("tools");
    const second = registry.emitResourceUpdated("pm://workspace/context");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(deliveries).toEqual([]);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(deliveries).toEqual(["notifications/tools/list_changed"]);
    releases.shift()?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(deliveries).toEqual([
      "notifications/tools/list_changed",
      "notifications/resources/updated",
    ]);
    expect(maximumActiveWrites).toBe(1);
  });

  it("drops a sink that remains backpressured beyond the write deadline", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PmMcpSubscriptionRegistry({
        capabilities: CAPABILITIES,
        serverInfo: { name: "pm-mcp", version: "1" },
      });
      await registry.open({
        id: "slow",
        notifications: { toolsListChanged: true },
        sink: (notification) =>
          notification.method.includes("acknowledged")
            ? undefined
            : new Promise<void>(() => undefined),
      });
      const pending = registry.emitListChanged("tools");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBe(0);
      expect(registry.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates queued writes after a concurrent close and non-Error rejection", async () => {
    let rejectWrite: ((error: string) => void) | undefined;
    const registry = new PmMcpSubscriptionRegistry({
      capabilities: CAPABILITIES,
      serverInfo: { name: "pm-mcp", version: "1" },
    });
    await registry.open({
      id: "closing",
      notifications: { toolsListChanged: true },
      sink: (notification) =>
        notification.method.includes("acknowledged")
          ? undefined
          : new Promise<void>((_resolve, reject) => {
              rejectWrite = reject;
            }),
    });
    const first = registry.emitListChanged("tools");
    const second = registry.emitListChanged("tools");
    await vi.waitFor(() => expect(rejectWrite).toBeTypeOf("function"));
    expect(registry.close("closing")).toMatchObject({ resultType: "complete" });
    rejectWrite?.("closed transport");
    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
  });
});
