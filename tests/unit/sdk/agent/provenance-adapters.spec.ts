import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHistoryEntry } from "../../../../src/core/history/history.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../../src/core/shared/constants.js";
import {
  BUILTIN_AGENT_PROVENANCE_ADAPTERS,
  diagnoseAgentIdentity,
  listAgentProvenanceAdapters,
  normalizeAgentProvenanceAdapterValue,
  registerAgentProvenanceAdapters,
  resolveAuthor,
  runWithHarnessDetectionSignals,
} from "../../../../src/core/shared/author.js";
import type { AgentProvenanceAdapter } from "../../../../src/core/shared/author.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent provenance adapters", () => {
  const codexAdapter = (): AgentProvenanceAdapter =>
    BUILTIN_AGENT_PROVENANCE_ADAPTERS.find(
      (entry) => entry.harness === "codex",
    )!;

  it("publishes one versioned privacy-bounded adapter for every supported agent harness", () => {
    expect(BUILTIN_AGENT_PROVENANCE_ADAPTERS.map((entry) => entry.harness)).toEqual([
      "aider",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
      "opencode",
      "pi",
    ]);
    for (const adapter of BUILTIN_AGENT_PROVENANCE_ADAPTERS) {
      expect(adapter).toMatchObject({
        contract_version: 1,
        adapter_version: "v1",
        priority: 0,
        probe_policy: {
          network_access: false,
          subprocess_access: false,
          max_lines: 4_096,
        },
      });
      expect(adapter.probe_policy.max_bytes).toBeLessThanOrEqual(4_194_304);
    }
  });

  it("normalizes stable model families and effort vocabulary without discarding raw values", () => {
    expect(
      normalizeAgentProvenanceAdapterValue("model", "gpt-5.6-sol"),
    ).toEqual({ raw: "gpt-5.6-sol", normalized: "gpt-5.6", vocabulary: "v1" });
    expect(
      normalizeAgentProvenanceAdapterValue("effort", "XHIGH"),
    ).toEqual({ raw: "XHIGH", normalized: "xhigh", vocabulary: "v1" });
    expect(
      normalizeAgentProvenanceAdapterValue("effort", "experimental"),
    ).toEqual({
      raw: "experimental",
      normalized: "experimental",
      vocabulary: "v1",
    });
    expect(normalizeAgentProvenanceAdapterValue("model", "claude-sonnet")).toEqual({
      raw: "claude-sonnet",
      normalized: "claude-sonnet",
      vocabulary: "v1",
    });
  });

  it("reuses one Codex tail snapshot across model and effort dimensions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pm-codex-version-probe-"));
    roots.push(home);
    const sessions = path.join(home, ".codex", "sessions", "2026", "08", "22");
    await mkdir(sessions, { recursive: true });
    const thread = "version-probe";
    await writeFile(
      path.join(sessions, `rollout-test-${thread}.jsonl`),
      [
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5.6-sol", effort: "high" },
        }),
      ].join("\n"),
    );
    const identity = diagnoseAgentIdentity({
      env: { CODEX_THREAD_ID: thread },
      home_dir: home,
      argv: [],
    });
    expect(identity.provenance).toMatchObject({
      model: { value: "gpt-5.6-sol", source: "probe" },
      effort: { value: "high", source: "probe" },
    });
  });

  it("falls back to the bounded session head when recent records fill the tail", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pm-codex-head-probe-"));
    roots.push(home);
    const sessions = path.join(home, ".codex", "sessions");
    await mkdir(sessions, { recursive: true });
    const thread = "head-probe";
    await writeFile(
      path.join(sessions, `rollout-${thread}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } })}\n${JSON.stringify({ type: "response_item", payload: { content: "x".repeat(4_194_304) } })}\n`,
    );
    expect(
      diagnoseAgentIdentity({
        env: { CODEX_THREAD_ID: thread },
        home_dir: home,
        argv: [],
      }).provenance,
    ).toMatchObject({
      model: { value: "gpt-5.6-sol", source: "probe" },
      effort: { value: "high", source: "probe" },
    });
  });

  it("fails closed for missing, malformed, unrelated, and unreadable Codex sessions", async () => {
    const missingHome = await mkdtemp(path.join(os.tmpdir(), "pm-codex-missing-"));
    roots.push(missingHome);
    expect(
      diagnoseAgentIdentity({
        env: { CODEX_THREAD_ID: "missing-probe" },
        home_dir: missingHome,
        argv: [],
      }).provenance_outcomes.model,
    ).toMatchObject({ status: "failed", reason: "resolver_failed" });

    for (const [thread, content] of [
      [
        "malformed-probe",
        'not-json\nnull\n[]\n{"type":"turn_context","payload":null}',
      ],
      [
        "unrelated-probe",
        '{"type":"other","nested":{"type":"turn_context"}}',
      ],
      ["empty-payload-probe", '{"type":"turn_context","payload":{}}'],
      [
        "oversized-probe",
        `${"x".repeat(262_145)}{"type":"turn_context"}`,
      ],
    ] as const) {
      const home = await mkdtemp(path.join(os.tmpdir(), "pm-codex-invalid-"));
      roots.push(home);
      const sessions = path.join(home, ".codex", "sessions");
      await mkdir(sessions, { recursive: true });
      await writeFile(path.join(sessions, `rollout-${thread}.jsonl`), content);
      expect(
        diagnoseAgentIdentity({
          env: { CODEX_THREAD_ID: thread },
          home_dir: home,
          argv: [],
        }).provenance?.model,
      ).toBeNull();
    }

    const unreadableHome = await mkdtemp(
      path.join(os.tmpdir(), "pm-codex-unreadable-"),
    );
    roots.push(unreadableHome);
    const sessions = path.join(unreadableHome, ".codex", "sessions");
    await mkdir(sessions, { recursive: true });
    const unreadable = path.join(sessions, "rollout-unreadable-probe.jsonl");
    await writeFile(
      unreadable,
      JSON.stringify({ type: "turn_context", payload: { model: "private" } }),
    );
    await chmod(unreadable, 0o000);
    expect(
      diagnoseAgentIdentity({
        env: { CODEX_THREAD_ID: "unreadable-probe" },
        home_dir: unreadableHome,
        argv: [],
      }).provenance?.model,
    ).toBeNull();
  });

  it("honors Codex discovery depth and entry-count bounds", async () => {
    const deepHome = await mkdtemp(path.join(os.tmpdir(), "pm-codex-deep-"));
    roots.push(deepHome);
    const deepRoot = path.join(deepHome, ".codex", "sessions");
    const deepDirectory = path.join(deepRoot, "a", "b", "c", "d", "e", "f");
    await mkdir(deepDirectory, { recursive: true });
    await writeFile(
      path.join(deepDirectory, "rollout-deep-probe.jsonl"),
      JSON.stringify({ type: "turn_context", payload: { model: "private" } }),
    );
    expect(
      diagnoseAgentIdentity({
        env: { CODEX_THREAD_ID: "deep-probe" },
        home_dir: deepHome,
        argv: [],
      }).provenance?.model,
    ).toBeNull();

    const wideHome = await mkdtemp(path.join(os.tmpdir(), "pm-codex-wide-"));
    roots.push(wideHome);
    const wideRoot = path.join(wideHome, ".codex", "sessions");
    await mkdir(wideRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 512 }, (_, index) =>
        writeFile(path.join(wideRoot, `z-unrelated-${index}.jsonl`), "{}"),
      ),
    );
    await mkdir(path.join(wideRoot, "a-directory"));
    expect(
      diagnoseAgentIdentity({
        env: { CODEX_THREAD_ID: "wide-probe" },
        home_dir: wideHome,
        argv: [],
      }).provenance?.model,
    ).toBeNull();
  });

  it("recovers Codex model and effort from the bounded harness-owned session tail", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pm-codex-probe-"));
    roots.push(home);
    const sessions = path.join(home, ".codex", "sessions", "2026", "08", "22");
    await mkdir(sessions, { recursive: true });
    const thread = "01a0287b-27ab-7850-af2f-fbdbdf5821e2";
    await writeFile(
      path.join(sessions, `rollout-test-${thread}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high", cwd: "/private/work" } })}\n`,
    );

    const identity = diagnoseAgentIdentity({
      env: { CODEX_THREAD_ID: thread },
      home_dir: home,
      argv: [],
    });
    expect(identity).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-sol",
      model_source: "probe",
      provenance: {
        model: { value: "gpt-5.6-sol", source: "probe" },
        effort: { value: "high", source: "probe" },
      },
      provenance_outcomes: {
        model: { status: "resolved", resolver: "codex_session_file" },
        effort: { status: "resolved", resolver: "codex_session_file" },
      },
    });
    expect(JSON.stringify(identity)).not.toContain("private/work");
  });

  it("reports probes-disabled explicitly without touching a session file", () => {
    const identity = diagnoseAgentIdentity({
      env: { CODEX_THREAD_ID: "thread-safe" },
      probes_enabled: false,
      argv: [],
    });
    expect(identity.provenance?.model).toBeNull();
    expect(identity.provenance_outcomes.model).toMatchObject({
      status: "unavailable",
      reason: "probes_disabled",
      resolver: "codex_session_file",
    });
  });

  it("persists configured resolver unavailability without recording paths or session content", () => {
    const entry = runWithHarnessDetectionSignals(
      {
        env: { CODEX_THREAD_ID: "thread-safe" },
        probes_enabled: false,
        argv: [],
      },
      () => {
        const author = resolveAuthor(undefined, "");
        return createHistoryEntry({
          nowIso: "2026-08-22T00:00:00.000Z",
          author,
          op: "comment",
          before: structuredClone(EMPTY_CANONICAL_DOCUMENT),
          after: structuredClone(EMPTY_CANONICAL_DOCUMENT),
        });
      },
    );
    expect(entry.context).toMatchObject({
      agent_provenance_outcomes: {
        model: {
          status: "unavailable",
          reason: "probes_disabled",
          resolver: "codex_session_file",
        },
        effort: {
          status: "unavailable",
          reason: "probes_disabled",
          resolver: "codex_session_file",
        },
      },
    });
    expect(JSON.stringify(entry)).not.toContain("thread-safe");
  });

  it("allows a higher-priority package adapter override and restores the builtin on dispose", () => {
    const dispose = registerAgentProvenanceAdapters([
      {
        ...BUILTIN_AGENT_PROVENANCE_ADAPTERS.find(
          (entry) => entry.harness === "codex",
        )!,
        adapter_version: "package-v2",
        priority: 10,
        descriptor: {
          harness: "codex",
          environment_keys: ["PACKAGE_CODEX"],
          model_environment_keys: ["PACKAGE_CODEX_MODEL"],
        },
      },
    ]);
    expect(
      listAgentProvenanceAdapters().find((entry) => entry.harness === "codex"),
    ).toMatchObject({ adapter_version: "package-v2", priority: 10 });
    dispose();
    expect(
      listAgentProvenanceAdapters().find((entry) => entry.harness === "codex"),
    ).toMatchObject({ adapter_version: "v1", priority: 0 });
  });

  it("validates adapter boundaries, collisions, and reference-counted disposal", () => {
    const base = codexAdapter();
    const invalid = [
      { ...base, contract_version: 2 },
      { ...base, harness: "other" },
      { ...base, adapter_version: " " },
      { ...base, priority: 1.5 },
      {
        ...base,
        probe_policy: { ...base.probe_policy, network_access: true },
      },
    ];
    for (const adapter of invalid) {
      expect(() =>
        registerAgentProvenanceAdapters([
          adapter as unknown as AgentProvenanceAdapter,
        ]),
      ).toThrow();
    }
    expect(() => registerAgentProvenanceAdapters([{ ...base, priority: 0 }])).toThrow(
      /priority greater/u,
    );

    const override = {
      ...base,
      adapter_version: "package-v2",
      priority: 10,
    };
    expect(() => registerAgentProvenanceAdapters([override, override])).toThrow(
      /collision/u,
    );
    const disposeFirst = registerAgentProvenanceAdapters([override]);
    expect(() =>
      registerAgentProvenanceAdapters([
        { ...override, adapter_version: "package-v3", priority: 11 },
      ]),
    ).toThrow(/collision/u);
    const disposeSecond = registerAgentProvenanceAdapters([override]);
    disposeFirst();
    disposeFirst();
    expect(
      listAgentProvenanceAdapters().find((entry) => entry.harness === "codex"),
    ).toMatchObject({ adapter_version: "package-v2" });
    disposeSecond();
    expect(
      listAgentProvenanceAdapters().find((entry) => entry.harness === "codex"),
    ).toMatchObject({ adapter_version: "v1" });
  });

  it("activates a package adapter without waivers through the shared detector", () => {
    const { waivers: _waivers, ...base } = codexAdapter();
    const dispose = registerAgentProvenanceAdapters([
      {
        ...base,
        harness: "package-agent",
        descriptor: {
          harness: "package-agent",
          environment_keys: ["PACKAGE_AGENT"],
          model_environment_keys: ["PACKAGE_AGENT_MODEL"],
        },
      },
    ]);
    expect(
      diagnoseAgentIdentity({
        env: { PACKAGE_AGENT: "1", PACKAGE_AGENT_MODEL: "package-model" },
        argv: [],
      }),
    ).toMatchObject({ harness: "package-agent", model: "package-model" });
    dispose();
  });
});
