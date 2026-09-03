# Public SDK Agent Environment

Tracker: [pm-t8a0x1](../../../.agents/pm/features/pm-t8a0x1.toon)

This executable example imports only Node.js built-ins and `@unbrained/pm-cli/sdk`. It creates an isolated temporary tracker, uses ordinary `PmClient` actions, serves a budgeted observation, evaluates recorded state, and closes the episode. It has no machine-learning dependencies.

From an installed package checkout:

```bash
npm install @unbrained/pm-cli
npm start
```

The JSON result is intentionally small and stable enough for a CI assertion. The temporary workspace is removed after the run.
