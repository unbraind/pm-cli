/**
 * @module sdk/mcp/subscriptions
 *
 * Implements transport-neutral MCP 2026-07-28 subscription filtering,
 * acknowledgment, notification correlation, and graceful closure.
 */
import {
  PM_MCP_ERROR_CODES,
  PmMcpProtocolError,
  attachMcpServerInfo,
  isMcpRecord,
  type PmMcpImplementation,
  type PmMcpServerCapabilities,
} from "./protocol.js";

/** Notification/result metadata key that correlates a subscription stream. */
export const PM_MCP_SUBSCRIPTION_ID_META_KEY =
  "io.modelcontextprotocol/subscriptionId";

/** JSON-RPC identifiers permitted for long-lived subscription requests. */
export type PmMcpSubscriptionId = string | number;

/** Notification families a client may opt into on one listen stream. */
export interface PmMcpSubscriptionFilter {
  /** Receive notifications when the tool list changes. */
  toolsListChanged?: boolean;
  /** Receive notifications when the prompt list changes. */
  promptsListChanged?: boolean;
  /** Receive notifications when the resource list changes. */
  resourcesListChanged?: boolean;
  /** Receive updates for these exact resource URIs. */
  resourceSubscriptions?: string[];
}

/** One JSON-RPC notification emitted by a subscription. */
export interface PmMcpSubscriptionNotification {
  /** JSON-RPC revision. */
  jsonrpc: "2.0";
  /** Notification method. */
  method: string;
  /** Correlated notification parameters. */
  params: Record<string, unknown>;
}

/** Sink used by stdio and HTTP adapters to write subscription messages. */
export type PmMcpSubscriptionSink = (
  notification: PmMcpSubscriptionNotification,
) => void | Promise<void>;

interface PmMcpSubscriptionRecord {
  filter: PmMcpSubscriptionFilter;
  sink: PmMcpSubscriptionSink;
  writeQueue: Promise<void>;
}

const MAX_RESOURCE_SUBSCRIPTIONS = 256;
const MAX_RESOURCE_URI_BYTES = 2_048;
const MCP_SUBSCRIPTION_WRITE_TIMEOUT_MS = 5_000;

function writeSubscriptionNotification(
  sink: PmMcpSubscriptionSink,
  notification: PmMcpSubscriptionNotification,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("MCP subscription sink write timed out")),
      MCP_SUBSCRIPTION_WRITE_TIMEOUT_MS,
    );
    timer.unref();
    Promise.resolve()
      .then(() => sink(notification))
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

function validateOptionalBoolean(
  value: unknown,
  field: keyof PmMcpSubscriptionFilter,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new PmMcpProtocolError(
      "Invalid MCP subscription filter",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: `notifications.${field}`, expected: "boolean" },
    );
  }
  return value || undefined;
}

/** Validate and clone one subscription notification filter. */
export function parseMcpSubscriptionFilter(
  value: unknown,
): PmMcpSubscriptionFilter {
  if (!isMcpRecord(value)) {
    throw new PmMcpProtocolError(
      "Invalid MCP subscription filter",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "notifications", expected: "object" },
    );
  }
  const toolsListChanged = validateOptionalBoolean(
    value.toolsListChanged,
    "toolsListChanged",
  );
  const promptsListChanged = validateOptionalBoolean(
    value.promptsListChanged,
    "promptsListChanged",
  );
  const resourcesListChanged = validateOptionalBoolean(
    value.resourcesListChanged,
    "resourcesListChanged",
  );
  let resourceSubscriptions: string[] | undefined;
  if (value.resourceSubscriptions !== undefined) {
    if (
      !Array.isArray(value.resourceSubscriptions) ||
      value.resourceSubscriptions.length > MAX_RESOURCE_SUBSCRIPTIONS
    ) {
      throw new PmMcpProtocolError(
        "Invalid MCP resource subscriptions",
        PM_MCP_ERROR_CODES.invalidParams,
        {
          field: "notifications.resourceSubscriptions",
          maximum: MAX_RESOURCE_SUBSCRIPTIONS,
        },
      );
    }
    const unique = new Set<string>();
    for (const entry of value.resourceSubscriptions) {
      if (
        typeof entry !== "string" ||
        entry.trim().length === 0 ||
        Buffer.byteLength(entry, "utf8") > MAX_RESOURCE_URI_BYTES
      ) {
        throw new PmMcpProtocolError(
          "Invalid MCP resource subscription URI",
          PM_MCP_ERROR_CODES.invalidParams,
          {
            field: "notifications.resourceSubscriptions",
            maximumBytes: MAX_RESOURCE_URI_BYTES,
          },
        );
      }
      unique.add(entry);
    }
    if (unique.size > 0) resourceSubscriptions = [...unique].sort();
  }
  return {
    ...(toolsListChanged ? { toolsListChanged } : {}),
    ...(promptsListChanged ? { promptsListChanged } : {}),
    ...(resourcesListChanged ? { resourcesListChanged } : {}),
    ...(resourceSubscriptions ? { resourceSubscriptions } : {}),
  };
}

/** Intersect a requested filter with notification capabilities the server advertises. */
export function resolveMcpAcknowledgedSubscriptionFilter(
  requested: PmMcpSubscriptionFilter,
  capabilities: PmMcpServerCapabilities,
): PmMcpSubscriptionFilter {
  return {
    ...(requested.toolsListChanged && capabilities.tools?.listChanged
      ? { toolsListChanged: true }
      : {}),
    ...(requested.promptsListChanged && capabilities.prompts?.listChanged
      ? { promptsListChanged: true }
      : {}),
    ...(requested.resourcesListChanged && capabilities.resources?.listChanged
      ? { resourcesListChanged: true }
      : {}),
    ...(requested.resourceSubscriptions && capabilities.resources?.subscribe
      ? { resourceSubscriptions: [...requested.resourceSubscriptions] }
      : {}),
  };
}

/** Manage concurrent stateless subscriptions without retaining client sessions. */
export class PmMcpSubscriptionRegistry {
  readonly #capabilities: PmMcpServerCapabilities;
  readonly #records = new Map<PmMcpSubscriptionId, PmMcpSubscriptionRecord>();
  readonly #serverInfo: PmMcpImplementation;

  /** Create a registry shared by one concrete transport process. */
  constructor(input: {
    capabilities: PmMcpServerCapabilities;
    serverInfo: PmMcpImplementation;
  }) {
    this.#capabilities = structuredClone(input.capabilities);
    this.#serverInfo = { ...input.serverInfo };
  }

  /** Number of currently open request-scoped subscription streams. */
  get size(): number {
    return this.#records.size;
  }

  /** Open a subscription and emit its required first acknowledgment. */
  async open(input: {
    id: PmMcpSubscriptionId;
    notifications: unknown;
    sink: PmMcpSubscriptionSink;
  }): Promise<PmMcpSubscriptionFilter> {
    if (this.#records.has(input.id)) {
      throw new PmMcpProtocolError(
        "MCP subscription id is already active",
        PM_MCP_ERROR_CODES.invalidParams,
        { subscriptionId: input.id },
      );
    }
    const filter = resolveMcpAcknowledgedSubscriptionFilter(
      parseMcpSubscriptionFilter(input.notifications),
      this.#capabilities,
    );
    const record: PmMcpSubscriptionRecord = {
      filter,
      sink: input.sink,
      writeQueue: Promise.resolve(),
    };
    this.#records.set(input.id, record);
    try {
      await this.#deliver(
        input.id,
        record,
        {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: input.id },
            notifications: structuredClone(filter),
          },
        },
        true,
      );
    } catch (error) {
      this.#records.delete(input.id);
      throw error;
    }
    return structuredClone(filter);
  }

  /** Emit one list-change notification only to streams that opted into it. */
  async emitListChanged(
    family: "tools" | "prompts" | "resources",
  ): Promise<number> {
    const field = `${family}ListChanged` as const;
    const method = `notifications/${family}/list_changed`;
    const writes: Promise<boolean>[] = [];
    for (const [id, record] of this.#records) {
      if (record.filter[field] !== true) continue;
      writes.push(
        this.#deliver(id, record, {
          jsonrpc: "2.0",
          method,
          params: {
            _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: id },
          },
        }),
      );
    }
    return (await Promise.all(writes)).filter(Boolean).length;
  }

  /** Emit a resource update only to streams that opted into the exact URI. */
  async emitResourceUpdated(uri: string): Promise<number> {
    const writes: Promise<boolean>[] = [];
    for (const [id, record] of this.#records) {
      if (!record.filter.resourceSubscriptions?.includes(uri)) continue;
      writes.push(
        this.#deliver(id, record, {
          jsonrpc: "2.0",
          method: "notifications/resources/updated",
          params: {
            _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: id },
            uri,
          },
        }),
      );
    }
    return (await Promise.all(writes)).filter(Boolean).length;
  }

  async #deliver(
    id: PmMcpSubscriptionId,
    record: PmMcpSubscriptionRecord,
    notification: PmMcpSubscriptionNotification,
    propagateFailure = false,
  ): Promise<boolean> {
    const pending = record.writeQueue.then(async () => {
      if (this.#records.get(id) !== record) return false;
      try {
        await writeSubscriptionNotification(record.sink, notification);
        return true;
      } catch (error) {
        if (this.#records.get(id) === record) this.#records.delete(id);
        if (propagateFailure) throw error;
        return false;
      }
    });
    record.writeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /** Gracefully close one subscription and return its final modern result. */
  close(id: PmMcpSubscriptionId): Record<string, unknown> | undefined {
    if (!this.#records.delete(id)) return undefined;
    return {
      ...attachMcpServerInfo(
        {
          resultType: "complete" as const,
          _meta: { [PM_MCP_SUBSCRIPTION_ID_META_KEY]: id },
        },
        this.#serverInfo,
      ),
    };
  }

  /** Gracefully close every stream and preserve stable creation order. */
  closeAll(): Array<{
    id: PmMcpSubscriptionId;
    result: Record<string, unknown>;
  }> {
    const closed: Array<{
      id: PmMcpSubscriptionId;
      result: Record<string, unknown>;
    }> = [];
    for (const id of this.#records.keys()) {
      const result = this.close(id) as Record<string, unknown>;
      closed.push({ id, result });
    }
    return closed;
  }
}
