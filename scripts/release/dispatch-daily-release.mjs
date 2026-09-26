/** Independent morning clock; publication remains owned by the hosted release gates. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "unbraind/pm-cli";

/** Keep transport bounded and never expose authentication or captured command output. */
function github(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("GitHub request failed; inspect authentication/network and hosted runs before retrying.");
  }
}

/** Refuse incomplete API evidence instead of mistaking a truncated census for idle. */
function workflowRuns(workflow, since) {
  const query = new URLSearchParams({ created: `>=${since}`, per_page: "100" });
  const pages = JSON.parse(github(["api", `repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`, "--paginate", "--slurp"]));
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("Missing workflow census.");
  const rows = pages.flatMap((page) => {
    if (!Number.isSafeInteger(page.total_count) || !Array.isArray(page.workflow_runs)) throw new Error("Invalid workflow census.");
    return page.workflow_runs;
  });
  if (rows.length !== pages[0].total_count || new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Incomplete workflow census.");
  return rows;
}

/** Dispatch once per UTC day, within the Vienna morning window, with durable intent. */
export function dispatchDailyRelease({ stateDirectory, check = false, now = new Date() }) {
  if (!stateDirectory || !path.isAbsolute(stateDirectory)) throw new Error("An absolute state directory is required.");
  const instant = now.toISOString();
  const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const day = instant.slice(0, 10);
  const result = { repository: REPOSITORY, day, observed_at: instant, local_time: localTime, check };
  if (!check && (localTime < "04:45" || localTime > "05:15")) return { ...result, outcome: "outside_morning_window" };
  const marker = path.join(stateDirectory, `${day}.json`);
  if (existsSync(marker)) return { ...result, outcome: "dispatch_already_attempted" };
  const tag = `v${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
  const refs = JSON.parse(github(["api", `repos/${REPOSITORY}/git/matching-refs/tags/${tag}`]));
  if (!Array.isArray(refs)) throw new Error("Invalid tag census.");
  if (refs.some((ref) => ref.ref === `refs/tags/${tag}`)) return { ...result, outcome: "existing_tag_requires_publication_verification", tag };
  // Two days cover jobs begun before midnight; hosted job timeouts are under two hours.
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const runs = ["auto-release.yml", "release.yml"].flatMap((workflow) => workflowRuns(workflow, since));
  if (runs.some((run) => run.status !== "completed")) return { ...result, outcome: "active_release_workflow" };
  if (check) return { ...result, outcome: "would_dispatch" };
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  // Exclusive intent creation serializes competing invocations. Keep it even if
  // the POST times out: GitHub may have accepted the request despite that error.
  writeFileSync(marker, `${JSON.stringify({ ...result, outcome: "dispatch_attempted" })}\n`, { flag: "wx", mode: 0o600 });
  github(["workflow", "run", "auto-release.yml", "--repo", REPOSITORY, "--ref", "main", "-f", "push=true", "-f", "dry_run=false", "-f", "telemetry_mode=off"]);
  const accepted = { ...result, outcome: "dispatch_accepted" };
  writeFileSync(marker, `${JSON.stringify(accepted)}\n`, { mode: 0o600 });
  return accepted;
}

/** Parse the narrow operator interface; checks never dispatch or write intent. */
export function main(args = process.argv.slice(2)) {
  if (args.length < 2 || args[0] !== "--state-dir" || args.length > 3 || (args.length === 3 && args[2] !== "--check")) {
    throw new Error("Usage: dispatch-daily-release.mjs --state-dir <absolute-directory> [--check]");
  }
  return dispatchDailyRelease({ stateDirectory: args[1], check: args[2] === "--check" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(main()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
