import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectAgentIdentity,
  resolveAuthor,
  resolveClaimPrincipal,
  runWithHarnessDetectionSignals,
} from "../../../src/core/shared/author.js";
import {
  getSessionStatePath,
  readAgentSemanticAttributionSync,
  readSessionState,
  recordClaimedWorkAttribution,
  recordFocusedWorkAttribution,
  releaseClaimedWorkAttribution,
  semanticAttributionKey,
} from "../../../src/core/session/session-state.js";
import { readSettings } from "../../../src/core/store/settings.js";
import {
  resolveSemanticLineageIds,
  semanticAttributionAffinity,
} from "../../../src/sdk/context/semantic-session-attribution.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const temporaryRoots: string[] = [];

async function semanticWorkspace(): Promise<{
  workspace: string;
  pmRoot: string;
  principal: string;
}> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "pm-semantic-session-"),
  );
  temporaryRoots.push(workspace);
  const pmRoot = path.join(workspace, ".agents", "pm");
  await mkdir(pmRoot, { recursive: true });
  await writeFile(path.join(pmRoot, "settings.json"), "{}", "utf8");
  const signals = {
    cwd: workspace,
    env: { CODEX_THREAD_ID: "semantic-thread" },
  };
  const principal = runWithHarnessDetectionSignals(signals, () =>
    resolveClaimPrincipal(resolveAuthor(undefined, "")),
  );
  return { workspace, pmRoot, principal };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("semantic session attribution", () => {
  it("infers one stable workset with bounded evidence and releases it incrementally", async () => {
    const { workspace, pmRoot, principal } = await semanticWorkspace();
    await recordClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-alpha",
      lineageIds: ["pm-alpha", "pm-feature", "pm-roadmap"],
    });
    await recordClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-beta",
      lineageIds: ["pm-beta", "pm-feature", "pm-roadmap"],
    });

    const detected = detectAgentIdentity({
      cwd: workspace,
      env: { CODEX_THREAD_ID: "semantic-thread" },
      argv: ["node", "pm", "update", "pm-beta"],
    });
    expect(detected.provenance).toMatchObject({
      role: {
        value: "implementer",
        source: "inferred",
        confidence: "medium",
        rule_version: "v2",
      },
      topic: {
        value: "workset:pm-alpha+pm-beta",
        source: "inferred",
        confidence: "medium",
        rule_version: "v2",
        evidence: expect.arrayContaining([
          "claim:pm-alpha",
          "claim:pm-beta",
          "lineage:pm-feature",
        ]),
      },
    });

    await releaseClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-alpha",
    });
    expect(
      detectAgentIdentity({
        cwd: workspace,
        env: { CODEX_THREAD_ID: "semantic-thread" },
      }).provenance,
    ).toMatchObject({
      role: { value: "release-operator", source: "inferred" },
      topic: { value: "pm-beta", source: "inferred" },
    });

    for (const suffix of ["a", "b", "c", "d"]) {
      await recordClaimedWorkAttribution({
        pmRoot,
        principal,
        itemId: `pm-${suffix.repeat(120)}`,
      });
    }
    expect(
      readAgentSemanticAttributionSync({
        cwd: workspace,
        env: {},
        key: semanticAttributionKey(principal),
      })?.topic,
    ).toMatch(/^workset:.+\+[a-f0-9]{12}$/u);
  });

  it("gives explicit focus and declarations precedence over inferred claims", async () => {
    const { workspace, pmRoot, principal } = await semanticWorkspace();
    await recordClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-child",
    });
    await recordFocusedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-outcome",
      lineageIds: ["pm-outcome", "pm-roadmap"],
    });
    expect(
      detectAgentIdentity({
        cwd: workspace,
        env: { CODEX_THREAD_ID: "semantic-thread" },
      }).provenance,
    ).toMatchObject({
      role: { value: "planner", source: "inferred", confidence: "high" },
      topic: { value: "pm-outcome", source: "inferred", confidence: "high" },
    });
    expect(
      detectAgentIdentity({
        cwd: workspace,
        env: {
          CODEX_THREAD_ID: "semantic-thread",
          PM_AGENT_SESSION_ROLE: "reviewer",
          PM_AGENT_SESSION_TOPIC: "declared review",
        },
      }).provenance,
    ).toMatchObject({
      role: { value: "reviewer", source: "session" },
      topic: { value: "declared review", source: "session" },
    });

    await recordClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-peer",
    });
    await releaseClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-child",
    });
    await recordFocusedWorkAttribution({ pmRoot, principal });
    const state = await readSessionState(pmRoot);
    expect(
      state.semantic_attribution?.[semanticAttributionKey(principal)],
    ).toMatchObject({
      topic: "pm-peer",
      active_item_ids: ["pm-peer"],
    });
    expect(
      semanticAttributionAffinity({
        role: "planner",
        topic: "pm-outcome",
        confidence: "high",
        rule_version: "v2",
        evidence: ["lineage:pm-roadmap"],
        active_item_ids: [],
        focused_item_id: "pm-outcome",
      }),
    ).toEqual({ "pm-outcome": 1, "pm-roadmap": 0.75 });
    await releaseClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-peer",
    });
    await releaseClaimedWorkAttribution({
      pmRoot,
      principal,
      itemId: "pm-peer",
    });
    expect(
      semanticAttributionAffinity({
        role: "implementer",
        topic: "empty",
        confidence: "medium",
        rule_version: "v2",
        evidence: [],
        active_item_ids: [],
      }),
    ).toBeUndefined();
  });

  it("fails open for missing, malformed, and unrelated session state", async () => {
    const { workspace, pmRoot, principal } = await semanticWorkspace();
    expect(
      readAgentSemanticAttributionSync({
        cwd: workspace,
        env: {},
        key: semanticAttributionKey(principal),
      }),
    ).toBeUndefined();
    await mkdir(path.dirname(getSessionStatePath(pmRoot)), { recursive: true });
    await writeFile(getSessionStatePath(pmRoot), "not-json", "utf8");
    expect(
      detectAgentIdentity({
        cwd: workspace,
        env: { CODEX_THREAD_ID: "semantic-thread" },
      }).provenance?.topic,
    ).toBeNull();
    await writeFile(
      getSessionStatePath(pmRoot),
      JSON.stringify({
        semantic_attribution: {
          [semanticAttributionKey(principal)]: {
            role: "implementer",
            topic: 42,
            confidence: "high",
            rule_version: "v2",
            evidence: ["claim:pm-invalid"],
            active_item_ids: ["pm-invalid"],
          },
        },
      }),
      "utf8",
    );
    expect(
      detectAgentIdentity({
        cwd: workspace,
        env: { CODEX_THREAD_ID: "semantic-thread" },
      }).provenance?.topic,
    ).toBeNull();
    expect(await readSessionState(pmRoot)).toEqual({});
    expect(semanticAttributionKey("explicit-user")).toMatch(
      /^author-[a-f0-9]{24}$/u,
    );

    await writeFile(
      getSessionStatePath(pmRoot),
      JSON.stringify({
        semantic_attribution: {
          ["x".repeat(129)]: {
            role: "implementer",
            topic: "pm-too-long-key",
            confidence: "medium",
            rule_version: "v2",
            evidence: [],
            active_item_ids: [],
          },
          valid: {
            role: "implementer",
            topic: "pm-valid",
            confidence: "medium",
            rule_version: "v2",
            evidence: [],
            active_item_ids: [],
          },
        },
      }),
      "utf8",
    );
    expect(await readSessionState(pmRoot)).toEqual({
      semantic_attribution: {
        valid: expect.objectContaining({ topic: "pm-valid" }),
      },
    });

    const nestedWorkspace = path.join(workspace, "configured");
    const nestedRoot = path.join(nestedWorkspace, ".agents", "pm");
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(path.join(nestedRoot, "settings.json"), "{}", "utf8");
    await recordClaimedWorkAttribution({
      pmRoot: nestedRoot,
      principal,
      itemId: "pm-nested",
    });
    expect(
      readAgentSemanticAttributionSync({
        cwd: workspace,
        env: { PM_PATH: nestedWorkspace },
        key: semanticAttributionKey(principal),
      })?.topic,
    ).toBe("pm-nested");
  });

  it("resolves canonical lineage under missing, cycle, and depth boundaries", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      expect(
        await resolveSemanticLineageIds(context.pmPath, settings, ""),
      ).toEqual([]);
      expect(
        await resolveSemanticLineageIds(context.pmPath, settings, "pm-missing"),
      ).toEqual([]);

      const ids: string[] = [];
      for (let index = 0; index < 18; index += 1) {
        const created = context.runCli(
          [
            "create",
            "--json",
            "--create-mode",
            "progressive",
            "--title",
            `Lineage ${index}`,
            "--description",
            `Lineage ${index} description`,
            "--type",
            "Task",
            "--status",
            "open",
            ...(ids.length > 0 ? ["--parent", ids.at(-1)!] : []),
          ],
          { expectJson: true },
        );
        expect(created.code).toBe(0);
        ids.push((created.json as { item: { id: string } }).item.id);
      }
      expect(
        await resolveSemanticLineageIds(context.pmPath, settings, ids.at(-1)!),
      ).toHaveLength(16);

      const rootPath = path.join(context.pmPath, "tasks", `${ids[0]}.toon`);
      const root = await readFile(rootPath, "utf8");
      await writeFile(
        rootPath,
        /^parent:.*$/mu.test(root)
          ? root.replace(/^parent:.*$/mu, `parent: ${ids[1]}`)
          : `${root.trimEnd()}\nparent: ${ids[1]}\n`,
        "utf8",
      );
      expect(
        await resolveSemanticLineageIds(context.pmPath, settings, ids[1]!),
      ).toEqual([ids[1], ids[0]]);
    });
  });
});
