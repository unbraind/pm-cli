import { fitOutputEnvelope, type OutputEnvelopeFitReceipt } from "@unbrained/pm-cli/sdk/query";
import type { ExtensionCommandSdk } from "@unbrained/pm-cli/sdk/authoring";

const fit = fitOutputEnvelope([{ id: "one", score: 1 }], {
  tokenBudget: 200,
  buildEnvelope: (items, receipt) => ({ items, tokens: receipt.estimated_tokens, source: "typed" as const }),
  renderers: { json: (value) => JSON.stringify(value) + "\n" },
});
const source: "typed" = fit.envelope.source;
const score: number | undefined = fit.rows[0]?.score;
const receipt: OutputEnvelopeFitReceipt = fit.envelope.output_fit;
const hostFunction: ExtensionCommandSdk["fitOutputEnvelope"] = fitOutputEnvelope;
void [source, score, receipt, hostFunction];

const reserved = fitOutputEnvelope([], {
  tokenBudget: 200,
  buildEnvelope: () => ({ output_fit: { replaced: true } }),
  renderers: { json: JSON.stringify },
});
// @ts-expect-error The SDK replaces the reserved receipt; builder fields do not survive.
void reserved.envelope.output_fit.replaced;
// @ts-expect-error The receipt is frozen and owned by the SDK.
fit.envelope.output_fit.estimated_tokens = 0;
// @ts-expect-error Replacing the receipt would invalidate the cached renderings.
fit.envelope.output_fit = receipt;
