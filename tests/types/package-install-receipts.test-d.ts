/** Compile the installation preservation contract through both public package entrypoints. */
import type { ExtensionCommandResult } from "@unbrained/pm-cli/sdk";
import type { PackageCommandResult } from "@unbrained/pm-cli/sdk/runtime";

declare const result: ExtensionCommandResult;
const preserved: boolean | undefined = result.details.previous_state_preserved;
const packageResult: PackageCommandResult = result;
if (packageResult.details.rollback?.status === "failed") {
  const args: string[] = packageResult.details.rollback.recovery_args;
  const source: string = packageResult.details.rollback.backup_directory;
  void args;
  void source;
}
type Rollback = NonNullable<PackageCommandResult["details"]["rollback"]>;
const restored: Rollback = { status: "restored" };
// @ts-expect-error a failed compensation must retain its executable recovery evidence
const incomplete: Rollback = { status: "failed", error: "copy refused" };
// @ts-expect-error preservation is a boolean receipt, not a textual success label
const mislabeled: PackageCommandResult["details"]["previous_state_preserved"] = "true";
void preserved;
void restored;
void incomplete;
void mislabeled;
