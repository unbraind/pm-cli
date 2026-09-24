/** Write a bounded, secret-free attempt receipt from structured workflow outputs. */
import { writeFileSync } from "node:fs";
import { readFailureRecord, RECORD_SCHEMA } from "./release-failure-record.mjs";

/** Preserve only explicit outcome and gate identity, never captured gate stdout. */
export function createReleaseObservation(env, failure) {
  const id = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Expected positive GitHub run and attempt identities.");
  }
  const outcome = env.RELEASE_PUBLISHED_TAG
    ? env.RELEASE_EXISTING_TAG ? "same_day_verified" : "published"
    : env.RELEASE_PIPELINE_REASON || "unknown_success";
  return {
    schema: "release-observation/1", run_id: id, run_attempt: attempt,
    event: env.GITHUB_EVENT_NAME, outcome,
    failure_stage: failure?.schema === RECORD_SCHEMA ? failure.stage : null,
  };
}

/** Write the attempt receipt to the workflow-owned artifact path. */
export function writeReleaseObservation(env = process.env) {
  const observation = createReleaseObservation(env, readFailureRecord(env.RELEASE_FAILURE_RECORD));
  writeFileSync(env.RELEASE_OBSERVATION_PATH, `${JSON.stringify(observation)}\n`);
  return observation;
}
