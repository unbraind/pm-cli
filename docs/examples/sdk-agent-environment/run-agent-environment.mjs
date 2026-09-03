import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PM_EPISODE_SCHEMA,
  PM_OBSERVATION_SCHEMA,
  PM_VERDICT_SCHEMA,
  PM_WORKSPACE_RECIPE_SCHEMA,
  PmClient,
  defineEpisodeSpecification,
  openPmEpisode,
  runWithWorkspaceRecipe,
} from "@unbrained/pm-cli/sdk";

class PublicSdkAdapter {
  constructor(workspace) {
    this.client = new PmClient({ cwd: workspace, noExtensions: true });
    this.itemId = "";
    this.revision = 0;
  }

  async reset(recipe) {
    const created = await runWithWorkspaceRecipe(recipe, async () => {
      await this.client.init("environment");
      return this.client.create({
        title: "Complete the SDK environment task",
        type: "Task",
        status: "open",
        description: "Created inside a deterministic public-SDK episode.",
      });
    });
    this.itemId = created.item.id;
    this.revision = 0;
    return { workspace_id: "temporary-pm-workspace", state_id: "revision:0" };
  }

  async execute(_action) {
    const result = await this.client.close(
      this.itemId,
      "Public SDK episode completed",
      {
        resolution: "The ordinary PmClient close action recorded completion.",
        expected: "The task is closed through the public SDK.",
        actual: "The task is closed through the public SDK.",
        validateClose: "warn",
      },
    );
    this.revision += 1;
    return { state_id: `revision:${this.revision}`, output: result };
  }

  async readRecordedState() {
    const result = await this.client.get(this.itemId);
    return {
      snapshot_id: `revision:${this.revision}`,
      state: {
        item: {
          id: result.item.id,
          title: result.item.title,
          status: result.item.status,
          resolution: result.item.resolution,
        },
      },
    };
  }
}

const observation = {
  schema: PM_OBSERVATION_SCHEMA,
  id: "sdk-task-state",
  version: 1,
  reads: [{ command: "get", budget_tokens: 256 }],
  calibration: {
    basis: "emitted_bytes",
    samples: [96, 128, 160],
    expected_emitted_bytes: 128,
    tolerance_bytes: 32,
  },
  corpus_dependence: { kind: "independent" },
  tiers: [
    {
      id: "standard",
      max_tokens: 256,
      fields: ["item.id", "item.title", "item.status", "item.resolution"],
    },
    { id: "identity", max_tokens: 48, fields: ["item.id", "item.status"] },
  ],
};

const verdict = {
  schema: PM_VERDICT_SCHEMA,
  id: "sdk-task-closed",
  version: 1,
  predicates: [
    {
      id: "closed",
      kind: "field_equals",
      path: "item.status",
      expected: "closed",
    },
    { id: "explained", kind: "field_present", path: "item.resolution" },
  ],
  composition: { operator: "all", predicate_ids: ["closed", "explained"] },
};

const workspace = await mkdtemp(join(tmpdir(), "pm-sdk-environment-"));
try {
  const session = await openPmEpisode(
    defineEpisodeSpecification({
      schema: PM_EPISODE_SCHEMA,
      id: "public-sdk-environment",
      version: 1,
      mode: "evaluation",
      recipe: {
        schema: PM_WORKSPACE_RECIPE_SCHEMA,
        seed: "public-sdk-environment",
        clock: "2026-09-03T00:00:00.000Z",
        tickMs: 1,
        operations: [],
      },
      task_item_ids: ["created-by-adapter"],
      observable_fields: [
        "item.id",
        "item.title",
        "item.status",
        "item.resolution",
      ],
      withheld_fields: ["grading.expected_status"],
      observation,
      verdict,
      limits: {
        max_actions: 1,
        max_observations: 2,
        max_tokens_per_observation: 256,
      },
    }),
    new PublicSdkAdapter(workspace),
  );
  const initial = await session.observe();
  await session.step({ kind: "close" });
  const completed = await session.close();
  process.stdout.write(
    `${JSON.stringify({
      initial_status: initial.status,
      initial_tier: initial.receipt.served_tier,
      verdict: completed.verdict.outcome,
      policy: completed.verdict.policy,
      trajectory: completed.trajectory.map((entry) => entry.kind),
    })}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
