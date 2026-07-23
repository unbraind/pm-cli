import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  PmClient,
  RelationshipEventLog,
  RelationshipKindRegistry,
  planProfileApplication,
  type ProfileCurrentState,
  type RelationshipEventInput,
} from "../../../src/sdk/index.js";
import {
  assertExtensionDeactivated,
  createExtensionTestHarness,
} from "../../../src/sdk/testing.js";
import { createExtensionCommandSdk } from "../../../src/sdk/extension-command-context.js";
import {
  resetActiveExtensionRuntimeState,
  setActiveExtensionRegistrations,
} from "../../../src/core/extensions/index.js";
import digitalTwinExtension, {
  TWIN_ITEM_FIELDS,
  TWIN_ITEM_TYPES,
  activate,
  buildTwinCommands,
  deactivate,
  manifest,
  twinProfile,
  type TwinCommandResult,
} from "../../../packages/pm-digital-twin/extensions/digital-twin/index.ts";
import {
  TWIN_RELATIONSHIP_KINDS,
  analyzeTwinImpact,
  createTwinCheckpoint,
  evaluateTwinInvariants,
  exportTwinBundle,
  materializeTwinTopology,
  mergeTwinReplicaEvents,
  normalizeTwinState,
  parseTwinBundle,
  parseTwinStateEvent,
  replayTwinEvents,
  validateTwinImport,
  verifyTwinCheckpoint,
} from "../../../packages/pm-digital-twin/extensions/digital-twin/domain.ts";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function emptyProfileState(): ProfileCurrentState {
  return {
    typesRaw: null,
    statusesRaw: null,
    fieldsRaw: null,
    workflows: [],
    settings: {},
    templates: new Map(),
    installedPackages: new Set(),
  };
}

function twinLog(nodes: readonly string[]): RelationshipEventLog {
  const registry = new RelationshipKindRegistry();
  for (const definition of TWIN_RELATIONSHIP_KINDS)
    registry.register(definition);
  return new RelationshipEventLog(nodes, { registry });
}

const relationshipSdk = createExtensionCommandSdk(
  ".",
  new PmClient({ noExtensions: true }),
);

function stateInput(options: {
  eventId: string;
  facility?: string;
  entity: string;
  state: string;
  timestamp: string;
  replica?: string;
  counter?: number;
  schemaVersion?: number;
  supersedes?: string;
  action?: "add" | "supersede";
}): RelationshipEventInput {
  return {
    eventId: options.eventId,
    relationshipId: `state:${options.entity}`,
    action: options.action ?? "add",
    edge: {
      source: options.facility ?? "facility",
      target: options.entity,
      kind: "twin_state",
      payload: {
        event_id: options.eventId,
        state: options.state,
        observed_at: options.timestamp,
        source: "fixture",
        schema_version: options.schemaVersion ?? 2,
        replica_id: options.replica ?? "edge-a",
        counter: options.counter ?? 1,
        ...(options.supersedes === undefined
          ? {}
          : { supersedes_event_id: options.supersedes }),
      },
    },
    author: "fixture-agent",
    timestamp: options.timestamp,
  };
}

describe("pm-digital-twin public SDK exemplar", () => {
  it("registers the complete schema, ontology, profile, and command surface", async () => {
    const harness = await createExtensionTestHarness(digitalTwinExtension, {
      capabilities: ["commands", "schema"],
    });
    expect(digitalTwinExtension.manifest).toBe(manifest);
    expect(digitalTwinExtension.activate).toBe(activate);
    expect(digitalTwinExtension.deactivate).toBe(deactivate);
    expect(manifest.capabilities).toEqual(["commands", "schema"]);
    expect(buildTwinCommands().map(({ name }) => name)).toEqual([
      "twin entity-create",
      "twin observe",
      "twin relate",
      "twin query",
      "twin export",
      "twin import",
      "twin verify",
    ]);
    for (const itemType of TWIN_ITEM_TYPES)
      expect(
        harness.assertItemType({ itemType: itemType.name }).itemType.name,
      ).toBe(itemType.name);
    for (const field of TWIN_ITEM_FIELDS)
      expect(harness.assertItemField({ field: field.name }).field.name).toBe(
        field.name,
      );
    expect(
      harness.activation.registrations.relationship_kinds.flatMap(
        ({ definitions }) => definitions.map(({ kind }) => kind),
      ),
    ).toEqual(TWIN_RELATIONSHIP_KINDS.map(({ kind }) => kind));
    expect(harness.assertProfile({ profile: "twin" }).profile).toStrictEqual(
      twinProfile,
    );
    assertExtensionDeactivated(await harness.deactivate());
  });

  it("stages the foreign-domain profile idempotently", () => {
    const plan = planProfileApplication(twinProfile, emptyProfileState());
    expect(plan.types.changes.map(({ key }) => key)).toEqual([
      "TwinFacility",
      "TwinAsset",
    ]);
    expect(plan.fields.changes.map(({ key }) => key)).toEqual([
      "twin_external_id",
      "twin_entity_kind",
      "twin_facility",
      "twin_schema_version",
      "twin_replica",
    ]);
    const reapplied = planProfileApplication(twinProfile, {
      ...emptyProfileState(),
      typesRaw: JSON.stringify(plan.types.file),
      fieldsRaw: JSON.stringify(plan.fields.file),
    });
    expect(reapplied.changed).toBe(false);
  });

  it("replays late observations, schema evolution, conflicts, corrections, and removals", () => {
    const log = twinLog(["facility", "machine"]);
    log.append(
      stateInput({
        eventId: "future",
        entity: "machine",
        state: "running",
        timestamp: "2026-07-23T10:00:00Z",
      }),
    );
    log.append(
      stateInput({
        eventId: "offline",
        entity: "machine",
        state: "idle",
        timestamp: "2026-07-23T08:00:00Z",
        counter: 1,
        schemaVersion: 1,
        action: "supersede",
      }),
    );
    log.append(
      stateInput({
        eventId: "correction",
        entity: "machine",
        state: "degraded",
        timestamp: "2026-07-23T08:30:00Z",
        counter: 3,
        supersedes: "missing-event",
        action: "supersede",
      }),
    );
    log.append(
      stateInput({
        eventId: "counter-collision",
        entity: "machine",
        state: "stopped",
        timestamp: "2026-07-23T08:45:00Z",
        counter: 3,
        schemaVersion: 3,
        action: "supersede",
      }),
    );
    const events = [...log.events()];
    const historical = replayTwinEvents(events, {
      atTimestamp: "2026-07-23T09:00:00Z",
    });
    expect(historical.states.machine).toMatchObject({
      event_id: "correction",
      state: "degraded",
      counter: 3,
    });
    expect(historical.version).toBe(4);
    expect(historical.processed).toBe(3);
    expect(historical.violations.map(({ code }) => code)).toEqual([
      "missing_superseded_event",
      "counter_gap",
      "unsupported_schema_version",
    ]);
    expect(historical.conflicts).toEqual([
      expect.objectContaining({ code: "replica_counter_collision" }),
    ]);
    expect(normalizeTwinState(" IDLE ", 1)).toBe("standby");
    expect(normalizeTwinState(" RUNNING ", 2)).toBe("running");
    expect(replayTwinEvents([])).toMatchObject({
      states: {},
      processed: 0,
      version: 0,
    });
    expect(() => replayTwinEvents(events, { atTimestamp: "invalid" })).toThrow(
      /timestamp must be valid/,
    );

    log.append({
      eventId: "retire-state",
      relationshipId: "state:machine",
      action: "remove",
      author: "fixture-agent",
      timestamp: "2026-07-23T11:00:00Z",
    });
    expect(replayTwinEvents(log.events()).states).not.toHaveProperty("machine");
    expect(parseTwinStateEvent(log.events().at(-1)!)).toBeUndefined();
  });

  it("validates state payloads precisely", () => {
    const base = twinLog(["facility", "machine"]).append(
      stateInput({
        eventId: "base",
        entity: "machine",
        state: "running",
        timestamp: "2026-07-23T08:00:00Z",
      }),
    );
    expect(parseTwinStateEvent(base)).toMatchObject({
      entity_id: "machine",
      event_id: "base",
      state: "running",
    });
    for (const [field, value, message] of [
      ["payload", undefined, "requires payload"],
      ["schema_version", 0, "schema_version"],
      ["counter", 0, "counter"],
      ["observed_at", "bad", "observed_at"],
      ["state", "", "requires state"],
      ["source", "", "requires source"],
      ["replica_id", "", "requires replica_id"],
      ["supersedes_event_id", "", "requires supersedes_event_id"],
    ] as const) {
      const payload =
        field === "payload"
          ? undefined
          : {
              ...base.edge!.payload,
              [field]: value,
            };
      expect(() =>
        parseTwinStateEvent({
          ...base,
          eventId: `invalid-${field}`,
          edge: { ...base.edge!, payload },
        }),
      ).toThrow(message);
    }
  });

  it("materializes topology, invariants, and bounded impact at event time", () => {
    const nodes = ["facility", "utility", "upstream", "downstream"];
    const log = twinLog(nodes);
    for (const input of [
      stateInput({
        eventId: "facility-state",
        entity: "facility",
        state: "running",
        timestamp: "2026-07-23T08:00:00Z",
      }),
      stateInput({
        eventId: "utility-state",
        entity: "utility",
        state: "stopped",
        timestamp: "2026-07-23T08:01:00Z",
      }),
      stateInput({
        eventId: "upstream-state",
        entity: "upstream",
        state: "stopped",
        timestamp: "2026-07-23T08:02:00Z",
      }),
      stateInput({
        eventId: "downstream-state",
        entity: "downstream",
        state: "running",
        timestamp: "2026-07-23T08:03:00Z",
      }),
    ])
      log.append(input);
    log.append({
      eventId: "feeds",
      relationshipId: "feeds",
      action: "add",
      edge: { source: "upstream", target: "downstream", kind: "twin_feeds" },
      author: "fixture-agent",
      timestamp: "2026-07-23T08:04:00Z",
    });
    log.append({
      eventId: "utility",
      relationshipId: "utility",
      action: "add",
      edge: {
        source: "downstream",
        target: "utility",
        kind: "twin_depends_on_utility",
      },
      author: "fixture-agent",
      timestamp: "2026-07-23T08:05:00Z",
    });
    const replay = replayTwinEvents(log.events());
    const graph = materializeTwinTopology(relationshipSdk, nodes, log.events());
    expect(evaluateTwinInvariants(graph, replay.states)).toEqual([
      expect.objectContaining({ code: "utility_not_running" }),
      expect.objectContaining({ code: "upstream_not_running" }),
    ]);
    expect(
      analyzeTwinImpact(relationshipSdk, graph, "upstream", {
        limit: 1,
        maxDepth: 1,
      }),
    ).toMatchObject({
      affected: [
        { id: "downstream", distance: 1, path: ["upstream", "downstream"] },
      ],
    });
    expect(analyzeTwinImpact(relationshipSdk, graph, "upstream")).toMatchObject(
      {
        affected: expect.any(Array),
      },
    );

    log.append({
      eventId: "remove-feeds",
      relationshipId: "feeds",
      action: "remove",
      author: "fixture-agent",
      timestamp: "2026-07-23T10:00:00Z",
    });
    expect(
      materializeTwinTopology(
        relationshipSdk,
        nodes,
        log.events(),
        "2026-07-23T09:00:00Z",
      ).edges(),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "twin_feeds" })]),
    );
    expect(
      materializeTwinTopology(relationshipSdk, nodes, log.events()).edges(),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "twin_feeds" })]),
    );
    expect(
      materializeTwinTopology(relationshipSdk, nodes, [
        {
          eventId: "malformed-topology",
          relationshipId: "malformed-topology",
          action: "add",
          author: "fixture-agent",
          timestamp: "2026-07-23T08:00:00Z",
          sequence: 1,
        },
      ]).edges(),
    ).toEqual([]);
  });

  it("exports, verifies, imports, bounds, and detects tampering", () => {
    const log = twinLog(["facility", "machine"]);
    log.append(
      stateInput({
        eventId: "state",
        entity: "machine",
        state: "running",
        timestamp: "2026-07-23T08:00:00Z",
      }),
    );
    const checkpoint = createTwinCheckpoint(log.events());
    expect(verifyTwinCheckpoint(log.events(), checkpoint)).toBe(true);
    expect(createTwinCheckpoint([])).toMatchObject({
      version: 0,
      event_count: 0,
    });
    const full = exportTwinBundle(
      ["machine", "facility", "machine"],
      log.events(),
    );
    expect(full).toMatchObject({
      format_version: 1,
      nodes: ["facility", "machine"],
      truncated: false,
    });
    expect(parseTwinBundle(JSON.parse(JSON.stringify(full)))).toEqual(full);
    const limited = exportTwinBundle(
      ["facility", "machine"],
      [...log.events(), { ...log.events()[0]!, sequence: 2, eventId: "copy" }],
      { limit: 1 },
    );
    expect(limited.truncated).toBe(true);
    expect(() =>
      exportTwinBundle(["facility"], log.events(), { limit: 0 }),
    ).toThrow("limit must be positive");
    expect(() => parseTwinBundle({ format_version: 2 })).toThrow(
      "format_version",
    );
    expect(() =>
      parseTwinBundle({
        ...full,
        nodes: [""],
      }),
    ).toThrow("structure");
    expect(() =>
      parseTwinBundle({
        ...full,
        events: [{ ...full.events[0]!, author: "tampered" }],
      }),
    ).toThrow("checkpoint mismatch");
    expect(
      verifyTwinCheckpoint(
        [{ ...log.events()[0]!, author: "tampered" }],
        checkpoint,
      ),
    ).toBe(false);
  });

  it("merges offline replicas deterministically and validates imported events", () => {
    const first = stateInput({
      eventId: "shared",
      entity: "machine",
      state: "running",
      timestamp: "2026-07-23T08:00:00Z",
    });
    const second = stateInput({
      eventId: "later",
      entity: "machine",
      state: "stopped",
      timestamp: "2026-07-23T09:00:00Z",
      action: "supersede",
      counter: 2,
    });
    const merged = mergeTwinReplicaEvents([
      [second, first],
      [first, { ...first, author: "conflicting-author" }],
      [
        { ...first, eventId: "reverse-collision", author: "z-author" },
        { ...first, eventId: "reverse-collision", author: "a-author" },
        { ...first, eventId: "same-time-a" },
        { ...first, eventId: "same-time-b" },
        { ...first, eventId: "existing-wins", author: "a-author" },
        { ...first, eventId: "existing-wins", author: "z-author" },
      ],
    ]);
    expect(merged.events.map(({ eventId }) => eventId)).toEqual([
      "existing-wins",
      "reverse-collision",
      "same-time-a",
      "same-time-b",
      "shared",
      "later",
    ]);
    expect(merged.conflicts).toEqual([
      expect.objectContaining({ code: "event_id_collision" }),
      expect.objectContaining({ code: "event_id_collision" }),
      expect.objectContaining({ code: "event_id_collision" }),
    ]);
    expect(
      validateTwinImport(
        relationshipSdk,
        ["facility", "machine"],
        [first, second],
      ),
    ).toHaveLength(2);
  });

  it("executes every command handler and guarded boundary through the host SDK", async () => {
    await withTempPmPath(async (context) => {
      expect(
        (
          await context.runCliInProcess([
            "install",
            "packages/pm-digital-twin",
            "--project",
            "--json",
          ])
        ).code,
      ).toBe(0);
      expect(
        (await context.runCliInProcess(["profile", "apply", "twin", "--json"]))
          .code,
      ).toBe(0);
      const harness = await createExtensionTestHarness(digitalTwinExtension, {
        capabilities: ["commands", "schema"],
      });
      setActiveExtensionRegistrations(harness.activation.registrations);
      onTestFinished(async () => {
        resetActiveExtensionRuntimeState();
        assertExtensionDeactivated(await harness.deactivate());
      });
      const client = PmClient.forActiveExtensionHost({
        pmRoot: context.pmPath,
        author: "twin-source-test",
      });
      const sdk = createExtensionCommandSdk(context.pmPath, client);
      const commands = new Map(
        buildTwinCommands().map((command) => [command.name, command]),
      );
      const invoke = (
        name: string,
        args: string[] = [],
        options: Record<string, unknown> = {},
        author = "twin-source-test",
      ) =>
        commands.get(name)!.run!({
          command: name,
          args,
          options,
          global: { author },
          pm_root: context.pmPath,
          sdk,
        });

      expect(
        await invoke(
          "twin entity-create",
          ["source-facility"],
          {
            externalId: "SOURCE-FACILITY",
            kind: "facility",
            state: "running",
            eventId: "source-facility-created",
            observedAt: "2026-07-23T08:00:00Z",
          },
          "",
        ),
      ).toMatchObject({
        action: "twin-entity-create",
        id: "pm-source-facility",
        details: { type: "TwinFacility" },
      });
      expect(
        await invoke("twin entity-create", ["source-facility"], {
          external_id: "SOURCE-FACILITY",
          kind: "facility",
          state: "running",
          event_id: "source-facility-created",
          observed_at: "2026-07-23T08:00:00Z",
        }),
      ).toMatchObject({ id: "pm-source-facility" });
      expect(
        await invoke("twin entity-create", ["pm-source-facility"], {
          external_id: "SOURCE-FACILITY",
          kind: "facility",
          state: "running",
          event_id: "source-facility-created",
          observed_at: "2026-07-23T08:00:00Z",
        }),
      ).toMatchObject({ id: "pm-source-facility" });
      expect(
        await invoke("twin entity-create", ["source-machine"], {
          title: "Source machine",
          external_id: "SOURCE-MACHINE",
          kind: "machine",
          facility: "source-facility",
          state: "stopped",
          replica: "edge-source",
          event_id: "source-machine-created",
          observed_at: "2026-07-23T08:01:00Z",
        }),
      ).toMatchObject({
        id: "pm-source-machine",
        details: { type: "TwinAsset", facilityId: "pm-source-facility" },
      });
      expect(
        await client.list({
          type: "TwinFacility",
          status: "all",
          noTruncate: true,
        }),
      ).toMatchObject({
        items: [expect.objectContaining({ id: "pm-source-facility" })],
      });
      await client.create({
        id: "direct-facility",
        title: "Direct facility",
        type: "TwinFacility",
        status: "open",
        field: [
          "twin_external_id=DIRECT-FACILITY",
          "twin_entity_kind=facility",
          "twin_schema_version=2",
        ],
      });
      expect(await invoke("twin query", ["direct-facility"])).toMatchObject({
        details: { state: null },
      });
      expect(
        await invoke("twin observe", ["direct-facility"], {
          state: "running",
          event_id: "direct-facility-observed",
        }),
      ).toMatchObject({
        details: { previous_event_id: undefined },
      });
      expect(
        await invoke("twin observe", ["source-machine"], {
          state: "running",
          source: "sensor-a",
          replica: "edge-source",
          counter: 2,
          schemaVersion: 1,
          supersedes: "source-machine-created",
          eventId: "source-machine-running",
          observedAt: "2026-07-23T08:02:00Z",
        }),
      ).toMatchObject({
        action: "twin-observe",
        details: { previous_event_id: "source-machine-created" },
      });
      expect(
        await invoke("twin observe", ["source-facility"], {
          state: "running",
          event_id: "source-facility-observed",
        }),
      ).toMatchObject({ id: "pm-source-facility" });
      expect(
        await invoke("twin relate", ["source-facility"], {
          target: "source-machine",
          kind: "contains",
          relationshipId: "source-contains-machine",
          eventId: "source-contained",
          observedAt: "2026-07-23T08:03:00Z",
        }),
      ).toMatchObject({ details: { kind: "twin_contains" } });
      expect(
        await invoke("twin relate", ["source-facility"], {
          target: "source-machine",
          kind: "contains",
          relationship_id: "source-contains-machine",
          event_id: "source-contained-again",
          observed_at: "2026-07-23T08:04:00Z",
        }),
      ).toMatchObject({ action: "twin-relate" });
      expect(
        await invoke("twin relate", ["source-machine"], {
          target: "source-facility",
          kind: "feeds",
          event_id: "source-machine-feeds-facility",
        }),
      ).toMatchObject({
        details: { kind: "twin_feeds", target: "pm-source-facility" },
      });
      const relationStore = await sdk.openRelationshipEventStore({
        nodes: [
          "pm-compensated-entity",
          "pm-direct-facility",
          "pm-source-facility",
          "pm-source-machine",
        ],
        definitions: TWIN_RELATIONSHIP_KINDS,
        relativePath: "relationships/digital-twin-events.jsonl",
      });
      expect(
        await invoke("twin relate", ["source-machine"], {
          target: "direct-facility",
          kind: "utility",
          event_id: "source-machine-needs-direct-facility",
          expected_version: relationStore.version,
        }),
      ).toMatchObject({
        details: { kind: "twin_depends_on_utility" },
      });
      expect(
        await invoke("twin observe", ["direct-facility"], {
          state: "stopped",
          event_id: "direct-facility-stopped",
          counter: 2,
        }),
      ).toMatchObject({ action: "twin-observe" });
      expect(
        await invoke("twin observe", ["source-machine"], {
          state: "degraded",
          event_id: "source-machine-collision",
          replica: "edge-source",
          counter: 2,
        }),
      ).toMatchObject({ action: "twin-observe" });
      expect(
        await invoke("twin observe", ["source-machine"], {
          state: "running",
          event_id: "source-machine-missing-correction",
          replica: "edge-source",
          counter: 3,
          supersedes: "missing-source-event",
        }),
      ).toMatchObject({ action: "twin-observe" });
      expect(
        await invoke("twin query", ["source-machine"], {
          limit: 1,
          maxDepth: 2,
        }),
      ).toMatchObject({
        action: "twin-query",
        details: {
          conflicts: expect.any(Array),
          violations: expect.any(Array),
        },
      });
      expect(
        await invoke("twin query", ["source-machine"], {
          at: "2026-07-23T08:04:00Z",
        }),
      ).toMatchObject({ action: "twin-query" });
      expect(await invoke("twin query", ["direct-facility"])).toMatchObject({
        details: {
          violations: [
            expect.objectContaining({ code: "utility_not_running" }),
          ],
        },
      });
      expect(await invoke("twin export")).toMatchObject({
        action: "twin-export",
      });
      const exported = (await invoke("twin export", [], {
        at: "2026-07-23T08:04:00Z",
        limit: 20,
      })) as TwinCommandResult;
      const bundle = exported.details!.bundle;
      expect(
        await invoke("twin import", [], {
          payload: JSON.stringify(bundle),
        }),
      ).toMatchObject({ details: { imported: 0 } });
      const exportedBundle = bundle as ReturnType<typeof exportTwinBundle>;
      const collidingEvents = [
        ...exportedBundle.events,
        { ...exportedBundle.events[0]!, author: "collision-author" },
      ];
      expect(
        await invoke("twin import", [], {
          payload: JSON.stringify({
            ...exportedBundle,
            events: collidingEvents,
            checkpoint: createTwinCheckpoint(collidingEvents),
          }),
        }),
      ).toMatchObject({
        details: {
          imported: 0,
          conflicts: [expect.objectContaining({ code: "event_id_collision" })],
        },
      });
      expect(
        await invoke("twin verify", [], {
          at: "2026-07-23T08:04:00Z",
        }),
      ).toMatchObject({ details: { checkpoint_valid: true } });
      expect(await invoke("twin verify")).toMatchObject({
        details: { checkpoint_valid: true },
      });

      await expect(
        commands.get("twin query")!.run!({
          command: "twin query",
          args: ["source-facility"],
          options: {},
          global: {},
          pm_root: context.pmPath,
        }),
      ).rejects.toThrow(/SDK runtime/);
      await expect(invoke("twin query")).rejects.toThrow(/entity id/);
      await expect(
        invoke("twin entity-create", ["bad-kind"], {
          external_id: "BAD-KIND",
          kind: "robot",
          state: "running",
          event_id: "bad-kind-created",
        }),
      ).rejects.toThrow(/facility, asset, machine, sensor, or utility/);
      await expect(
        invoke("twin entity-create", ["missing-facility"], {
          external_id: "MISSING-FACILITY",
          kind: "machine",
          state: "running",
          event_id: "missing-facility-created",
        }),
      ).rejects.toThrow(/--facility/);
      const commitTransaction = sdk.commitWorkspaceTransaction.bind(sdk);
      const transactionFailure = vi
        .spyOn(sdk, "commitWorkspaceTransaction")
        .mockImplementationOnce((options) =>
          commitTransaction({
            ...options,
            steps: [
              ...options.steps,
              {
                id: "fault-injection-after-state",
                inspect: async () => ({ state: "pending" }),
                apply: async () => {
                  throw new Error("injected post-state failure");
                },
                compensate: async () => {},
              },
            ],
          }),
        );
      onTestFinished(() => transactionFailure.mockRestore());
      await expect(
        invoke("twin entity-create", ["compensated-entity"], {
          external_id: "COMPENSATED",
          kind: "sensor",
          facility: "source-facility",
          state: "running",
          event_id: "compensated-entity-created",
        }),
      ).rejects.toThrow(/injected post-state failure/);
      transactionFailure.mockRestore();
      expect(
        (await client.get("compensated-entity", { depth: "deep" })).item.status,
      ).toBe("closed");
      await expect(
        invoke("twin entity-create", ["invalid-initial-state"], {
          external_id: "INVALID-INITIAL",
          kind: "sensor",
          facility: "source-facility",
          state: "running",
          event_id: "invalid-initial-created",
          observed_at: "not-a-time",
        }),
      ).rejects.toThrow(/timestamp/);
      expect(
        (await client.get("invalid-initial-state", { depth: "deep" })).item
          .status,
      ).toBe("closed");
      await client.create({
        id: "ordinary-task",
        title: "Ordinary task",
        type: "Task",
        status: "open",
      });
      await expect(invoke("twin query", ["ordinary-task"])).rejects.toThrow(
        /expected entity/,
      );
      await expect(
        invoke("twin entity-create", ["ordinary-task"], {
          external_id: "CONFLICT",
          kind: "facility",
          state: "running",
          event_id: "conflict-created",
        }),
      ).rejects.toThrow(/expected entity/);
      await expect(
        invoke("twin observe", ["source-machine"], {
          state: "running",
          event_id: "bad-observed-at",
          observed_at: "invalid",
        }),
      ).rejects.toThrow(/timestamp/);
      await expect(
        invoke("twin observe", ["source-machine"], {
          state: "running",
          event_id: "bad-expected-version",
          expected_version: 1,
        }),
      ).rejects.toThrow(/version conflict/);
      await expect(
        invoke("twin query", ["source-machine"], { limit: 0 }),
      ).rejects.toThrow(/must be positive/);
      await expect(
        invoke("twin relate", ["source-facility"], {
          target: "source-machine",
          kind: "unknown",
          event_id: "bad-kind",
        }),
      ).rejects.toThrow(/contains, feeds, or utility/);
      await expect(
        invoke("twin relate", ["source-facility"], {
          target: "source-machine",
          kind: "feeds",
          event_id: "bad-time",
          observed_at: "invalid",
        }),
      ).rejects.toThrow(/timestamp/);
      await expect(invoke("twin import", [], { payload: "{" })).rejects.toThrow(
        /valid JSON/,
      );
      await expect(
        invoke("twin import", [], {
          payload: JSON.stringify({ format_version: 2 }),
        }),
      ).rejects.toThrow(/format_version/);

      const store = await sdk.openRelationshipEventStore({
        nodes: [
          "pm-compensated-entity",
          "pm-direct-facility",
          "pm-source-facility",
          "pm-source-machine",
        ],
        definitions: TWIN_RELATIONSHIP_KINDS,
        relativePath: "relationships/digital-twin-events.jsonl",
      });
      expect(
        await invoke("twin observe", ["source-facility"], {
          state: "running",
          event_id: "source-facility-versioned",
          expected_version: store.version,
        }),
      ).toMatchObject({ action: "twin-observe" });
      await store.append({
        eventId: "source-machine-retired",
        relationshipId: "state:pm-source-machine",
        action: "remove",
        author: "twin-source-test",
        timestamp: "2026-07-23T08:05:00Z",
      });
      await expect(
        invoke("twin observe", ["source-machine"], {
          state: "running",
          event_id: "after-retirement",
        }),
      ).rejects.toThrow(/state was retired/);
      await client.create({
        id: "missing-facility-field",
        title: "Missing facility field",
        type: "TwinAsset",
        status: "open",
        field: [
          "twin_external_id=MISSING-FIELD",
          "twin_entity_kind=machine",
          "twin_facility=pm-source-facility",
          "twin_schema_version=2",
        ],
      });
      await client.update("missing-facility-field", {
        unset: ["twin_facility"],
      });
      await expect(
        invoke("twin observe", ["missing-facility-field"], {
          state: "running",
          event_id: "missing-field-observed",
        }),
      ).rejects.toThrow(/missing twin_facility/);
    });
  });

  it("runs the complete installed facility flow including temporal query and idempotent import", async () => {
    await withTempPmPath(async (context) => {
      const install = await context.runCliInProcess([
        "install",
        "packages/pm-digital-twin",
        "--project",
        "--json",
      ]);
      expect(install.code, install.stderr).toBe(0);
      expect(
        (await context.runCliInProcess(["profile", "apply", "twin", "--json"]))
          .code,
      ).toBe(0);

      const createEntity = (
        id: string,
        kind: string,
        state: string,
        eventId: string,
        observedAt: string,
        facility?: string,
      ) =>
        context.runCliInProcess(
          [
            "twin",
            "entity-create",
            id,
            "--external-id",
            id.toUpperCase(),
            "--kind",
            kind,
            ...(facility === undefined ? [] : ["--facility", facility]),
            "--state",
            state,
            "--event-id",
            eventId,
            "--observed-at",
            observedAt,
            "--json",
          ],
          { expectJson: true },
        );
      for (const result of [
        await createEntity(
          "pm-facility",
          "facility",
          "running",
          "facility-created",
          "2026-07-23T08:00:00Z",
        ),
        await createEntity(
          "pm-utility",
          "utility",
          "stopped",
          "utility-created",
          "2026-07-23T08:01:00Z",
          "pm-facility",
        ),
        await createEntity(
          "pm-machine",
          "machine",
          "running",
          "machine-created",
          "2026-07-23T08:02:00Z",
          "pm-facility",
        ),
        await createEntity(
          "pm-downstream",
          "machine",
          "running",
          "downstream-created",
          "2026-07-23T08:03:00Z",
          "pm-facility",
        ),
      ])
        expect(result.code, result.stderr).toBe(0);

      const relate = async (
        source: string,
        target: string,
        kind: string,
        eventId: string,
      ) =>
        context.runCliInProcess([
          "twin",
          "relate",
          source,
          "--target",
          target,
          "--kind",
          kind,
          "--event-id",
          eventId,
          "--json",
        ]);
      expect(
        (await relate("pm-facility", "pm-machine", "contains", "contains"))
          .code,
      ).toBe(0);
      expect(
        (await relate("pm-machine", "pm-utility", "utility", "utility")).code,
      ).toBe(0);
      expect(
        (await relate("pm-machine", "pm-downstream", "feeds", "feeds")).code,
      ).toBe(0);

      const query = await context.runCliInProcess(
        ["twin", "query", "pm-machine", "--json"],
        { expectJson: true },
      );
      expect(query.code, query.stderr).toBe(0);
      expect(JSON.stringify(query.json)).toContain("utility_not_running");

      const observed = await context.runCliInProcess([
        "twin",
        "observe",
        "pm-utility",
        "--state",
        "running",
        "--event-id",
        "utility-started",
        "--counter",
        "2",
        "--observed-at",
        "2026-07-23T08:04:00Z",
        "--json",
      ]);
      expect(observed.code, observed.stderr).toBe(0);
      const historical = await context.runCliInProcess(
        [
          "twin",
          "query",
          "pm-utility",
          "--at",
          "2026-07-23T08:03:30Z",
          "--json",
        ],
        { expectJson: true },
      );
      expect(JSON.stringify(historical.json)).toContain('"state":"stopped"');

      const exported = await context.runCliInProcess(
        ["twin", "export", "--json"],
        { expectJson: true },
      );
      expect(exported.code, exported.stderr).toBe(0);
      const bundle = (
        exported.json as {
          details: { bundle: unknown };
        }
      ).details.bundle;
      const imported = await context.runCliInProcess(
        ["twin", "import", "--payload", JSON.stringify(bundle), "--json"],
        { expectJson: true },
      );
      expect(imported.code, imported.stderr).toBe(0);
      expect(imported.json).toMatchObject({
        details: { imported: 0 },
      });
      const verified = await context.runCliInProcess(
        ["twin", "verify", "--json"],
        { expectJson: true },
      );
      expect(verified.code, verified.stderr).toBe(0);
      expect(verified.json).toMatchObject({
        details: { checkpoint_valid: true },
      });
    });
  });
});
