/** A preview's configuration-only settings scope ends with the preview, including for work captured during its activation (pm-fyg1hl). */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../../src/sdk/index.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

interface CaptureGlobals {
  pmPreviewScopeRead?: () => Promise<string[]>;
  pmPreviewScopeRelease?: () => void;
  pmPreviewScopeDuring?: Promise<string[]>;
  pmPreviewScopeDeferred?: Promise<string[]>;
}
const captured = globalThis as typeof globalThis & CaptureGlobals;

describe("preview settings scope expiry", () => {
  it("lets a read captured during a preview's activation see file-backed schema fields once the preview settled", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "deferred-reader"),
        name: "deferred-reader",
        manifestOverrides: { capabilities: ["hooks"] },
        // Both reads are created inside activation, so both carry the preview's async context.
        entrySource: `export default { activate() {
          globalThis.pmPreviewScopeDuring = globalThis.pmPreviewScopeRead();
          globalThis.pmPreviewScopeDeferred = new Promise((resolve) => { globalThis.pmPreviewScopeRelease = resolve; }).then(() => globalThis.pmPreviewScopeRead());
        } };`,
      });
      const client = new PmClient({ pmRoot: pmPath });
      await new PmClient({ pmRoot: pmPath, noExtensions: true }).schemaAddField("review_owner", { type: "string" });
      captured.pmPreviewScopeRead = async () => (await new PmClient({ pmRoot: pmPath, noExtensions: true }).schemaListFields()).fields.map((field) => field.key);
      try {
        const preview = await client.previewItemMutations({ transactionId: "scope-expiry", mutations: [{ op: "create", id: "staged", options: { title: "Staged", type: "Task" } }] });
        expect(preview).toMatchObject({ validated: true });
        expect(await captured.pmPreviewScopeDuring).not.toContain("review_owner");
        captured.pmPreviewScopeRelease?.();
        expect(await captured.pmPreviewScopeDeferred).toContain("review_owner");
      } finally {
        for (const key of ["pmPreviewScopeRead", "pmPreviewScopeRelease", "pmPreviewScopeDuring", "pmPreviewScopeDeferred"] as const) delete captured[key];
      }
    });
  });
});
