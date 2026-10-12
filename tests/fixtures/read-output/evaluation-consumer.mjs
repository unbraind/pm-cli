/** Exercise public evaluator composition and omission refusal through a real installed Node/Bun artifact. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installed = createRequire(path.join(process.argv[2], "package.json"));
const { PmClient, runContextEvaluationScenario } = await import(pathToFileURL(installed.resolve("@unbrained/pm-cli/sdk")).href);
const client = new PmClient({ pmRoot: process.env.PM_PATH, noExtensions: true });
await client.schemaAddField("sdk_numeric", { type: "number" });
await client.schemaAddField("sdk_boolean", { type: "boolean" });
await client.schemaAddField("sdk_default");
const registered = await client.schemaListFields();
for (const [key, type] of [["sdk_numeric", "number"], ["sdk_boolean", "boolean"], ["sdk_default", "string"]]) {
  assert(registered.fields.some((field) => field.key === key && field.type === type));
}
const created = await client.create({ title: "Packed evaluation anchor", type: "Task", createMode: "progressive",
  sdkNumeric: "7", sdkBoolean: "true", sdkDefault: "Ready",
});
assert.equal(created.item.sdk_numeric, 7);
assert.equal(created.item.sdk_boolean, true);
assert.equal(created.item.sdk_default, "Ready");
for (const surface of ["context", "next"]) {
  const scenario = {
    id: `packed-${surface}`, surface, judgments: { [created.item.id]: 3 }, token_budget: 10_000,
    options: { limit: "100" }, rationale: "Grade the installed SDK packet directly.",
  };
  const report = await runContextEvaluationScenario(scenario, client);
  assert(report.ranked_ids.includes(created.item.id));
  assert(report.attribution.some((row) => row.id === created.item.id));
  await assert.rejects(runContextEvaluationScenario({ ...scenario, options: { outputBudget: 1 } }, client), (error) => error.context?.code === "context_evaluation_read_incomplete");
}
console.log("Packed SDK context evaluator composition and refusals passed.");
