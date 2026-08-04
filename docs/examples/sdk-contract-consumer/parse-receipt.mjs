import { spawnSync } from "node:child_process";
import { parseMutationReceipt } from "@unbrained/pm-cli/sdk";

const completed = spawnSync(
  "pm",
  ["create", "SDK receipt example", "--type", "Task", "--json"],
  { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
);

if (completed.error) {
  throw new Error(`Failed to run pm create: ${completed.error.message}`, {
    cause: completed.error,
  });
}
if (completed.status !== 0) {
  throw new Error(
    completed.stderr.trim() || `pm create failed with ${completed.status}`,
  );
}

const receipt = parseMutationReceipt(completed.stdout);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
