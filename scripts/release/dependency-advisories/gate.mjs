#!/usr/bin/env node
/** Repository advisory collector and read-only SDK provider adapter (pm-eqxjzl). */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../utils.mjs";
import { queryOsv, queryRegistry } from "./feeds.mjs";
import { readInputs } from "./inventory.mjs";
import { RECEIPT_VERSION, verifyReceipt } from "./receipt.mjs";

/** Replace previous clean evidence before collection, including on interrupted runs. */
async function writeReceipt(receiptPath, receipt) {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, receiptPath);
}

/** Collect bounded feeds or verify existing evidence without network access. */
export async function main(argv, root) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--verify-receipt")) throw new Error("Usage: dependency-advisories/gate.mjs [--verify-receipt]");
  const receiptPath = path.join(root, ".cache/dependency-security/receipt.json");
  if (argv[0] === "--verify-receipt") return verifyReceipt(root, receiptPath);
  const receipt = { version: RECEIPT_VERSION, status: "collecting", started_at: new Date().toISOString() };
  await writeReceipt(receiptPath, receipt);
  try {
    const inputs = await readInputs(root);
    receipt.inputs = inputs.inputs;
    receipt.scope = "all-pnpm-lock-packages-including-dev-optional";
    const results = await Promise.allSettled([
      Promise.resolve().then(() => queryRegistry(root)),
      queryOsv(inputs.packages),
    ]);
    receipt.feeds = Object.fromEntries(["registry", "osv"].map((name, index) => [name,
      results[index].status === "fulfilled" ? results[index].value : { status: "unavailable", observed_at: new Date().toISOString(), database_updated_at: null },
    ]));
    receipt.status = "complete";
    receipt.completed_at = new Date().toISOString();
    await writeReceipt(receiptPath, receipt);
    return await verifyReceipt(root, receiptPath);
  } catch {
    if (receipt.status === "collecting") receipt.status = "unavailable";
    await writeReceipt(receiptPath, receipt);
    throw new Error("Dependency advisory gate blocked; inspect .cache/dependency-security/receipt.json (no feed success is inferred from unavailable evidence)");
  }
}

/** Keep CLI diagnostics and exit status at the executable boundary. */
export async function runIfMain(candidate, argv, root) {
  if (candidate === undefined || import.meta.url !== pathToFileURL(path.resolve(candidate)).href) return;
  try {
    const result = await main(argv, root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

await runIfMain(process.argv[1], process.argv.slice(2), repoRoot);
