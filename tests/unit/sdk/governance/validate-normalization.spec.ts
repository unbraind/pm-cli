import { expect, it } from "vitest";
import { summarizeCommandPreview } from "../../../../src/sdk/governance/validate-normalization.js";

it("bounds long linked-command diagnostics after collapsing multiline whitespace", () => {
  const preview = summarizeCommandPreview(`  pm\n  get\tpm-missing ${"x".repeat(200)}  `);
  expect(preview).toHaveLength(120);
  expect(preview).toMatch(/^pm get pm-missing x+\.\.\.$/u);
});
