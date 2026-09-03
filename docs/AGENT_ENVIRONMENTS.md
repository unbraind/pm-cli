# SDK Agent Environments

Tracker: [pm-e1vkee](../.agents/pm/features/pm-e1vkee.toon), [pm-gd6vnn](../.agents/pm/features/pm-gd6vnn.toon), [pm-li2fj5](../.agents/pm/features/pm-li2fj5.toon), [pm-t8a0x1](../.agents/pm/features/pm-t8a0x1.toon)

## Agent Quick Context

`@unbrained/pm-cli/sdk` provides three composable contracts for building reproducible project-management environments without a machine-learning runtime dependency:

- an observation contract declares every read ceiling, emitted-byte calibration, corpus-size dependence, and an ordered degradation ladder;
- a verdict contract evaluates named, versioned predicates over recorded state and returns `satisfied`, `violated`, or `not_applicable` without producing a reward signal;
- an episode specification combines a deterministic workspace recipe, canonical task items, observable and withheld fields, hard limits, and an adapter for ordinary `PmClient` actions.

The executable [public-SDK example](examples/sdk-agent-environment/README.md) runs the complete reset → observe → act → verdict → close loop in a temporary pm workspace.

## Contract Boundaries

Observation cost is knowable before a read. `describeObservationCost()` returns the sum of the declared read ceilings plus the calibrated expected emitted bytes. `serveDeclaredObservation()` measures stable serialized bytes, attempts tiers in declaration order, names the served tier, and returns a payload-free refusal if no tier fits.

Verdicts only inspect the adapter's `WorkspaceRecordedState`. Evidence identifies the exact snapshot and JSON pointer while a digest avoids copying field values into the result. The interpreter is deterministic and read-only; `policy: "verdict_only_no_reward"` makes the non-reward boundary machine-readable.

Episodes never grant a second mutation vocabulary. The adapter's `execute()` method should call ordinary public `PmClient` methods, so lifecycle validation, history, extensions, and policy remain authoritative. Each session owns its counters and trajectory, allowing concurrent runs without shared episode state.

Withheld grading fields cannot also be observable. Every tier field must be declared observable, and projection copies only the selected tier fields. Hard action and observation limits fail closed.

## Minimal Shape

```ts
import {
  defineEpisodeSpecification,
  openPmEpisode,
  type EpisodeRuntimeAdapter,
} from "@unbrained/pm-cli/sdk";

const specification = defineEpisodeSpecification({
  // Versioned recipe, task set, observation, verdict, and limits.
});
const session = await openPmEpisode(
  specification,
  adapter satisfies EpisodeRuntimeAdapter<MyAction>,
);

await session.observe();
await session.step({ kind: "close" });
const evidence = await session.close();
```

Use the same specification and adapter boundary for benchmarks, evaluations, training data collection, or scale-transfer experiments. Consumer intent changes through `mode`; the pm action and evidence contracts do not.
