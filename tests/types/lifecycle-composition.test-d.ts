/** Compile-time lifecycle result contracts for pm-eq4x; never executed. */
import { claim, close, release } from "../../src/sdk/index.js";
import type { PmClient, ClaimResult, StartTaskResult, ReleaseResult, PauseTaskResult, CloseResult, CloseTaskResult } from "../../src/sdk/index.js";
declare const client: PmClient;
declare const compose: boolean;
const methodClaimBase: Promise<ClaimResult> = client.claim("pm-example");
void methodClaimBase;
const methodClaimFalse: Promise<ClaimResult> = client.claim("pm-example", { start: false });
void methodClaimFalse;
const methodClaimComposed: Promise<StartTaskResult> = client.claim("pm-example", { start: true });
void methodClaimComposed;
const methodClaimDynamic: Promise<ClaimResult | StartTaskResult> = client.claim("pm-example", { start: compose });
void methodClaimDynamic;
// @ts-expect-error A result cannot be selected independently of its runtime flag.
void client.claim<true>("pm-example");
const helperClaimBase: Promise<ClaimResult> = claim("pm-example");
void helperClaimBase;
const helperClaimFalse: Promise<ClaimResult> = claim("pm-example", { start: false });
void helperClaimFalse;
const helperClaimComposed: Promise<StartTaskResult> = claim("pm-example", { start: true });
void helperClaimComposed;
const helperClaimDynamic: Promise<ClaimResult | StartTaskResult> = claim("pm-example", { start: compose });
void helperClaimDynamic;
// @ts-expect-error A result cannot be selected independently of its runtime flag.
void claim<true>("pm-example");
void claim("pm-example", undefined, {});
const methodReleaseBase: Promise<ReleaseResult> = client.release("pm-example");
void methodReleaseBase;
const methodReleaseFalse: Promise<ReleaseResult> = client.release("pm-example", { pause: false });
void methodReleaseFalse;
const methodReleaseComposed: Promise<PauseTaskResult> = client.release("pm-example", { pause: true });
void methodReleaseComposed;
const methodReleaseDynamic: Promise<ReleaseResult | PauseTaskResult> = client.release("pm-example", { pause: compose });
void methodReleaseDynamic;
// @ts-expect-error A result cannot be selected independently of its runtime flag.
void client.release<true>("pm-example");
const helperReleaseBase: Promise<ReleaseResult> = release("pm-example");
void helperReleaseBase;
const helperReleaseFalse: Promise<ReleaseResult> = release("pm-example", { pause: false });
void helperReleaseFalse;
const helperReleaseComposed: Promise<PauseTaskResult> = release("pm-example", { pause: true });
void helperReleaseComposed;
const helperReleaseDynamic: Promise<ReleaseResult | PauseTaskResult> = release("pm-example", { pause: compose });
void helperReleaseDynamic;
// @ts-expect-error A result cannot be selected independently of its runtime flag.
void release<true>("pm-example");
void release("pm-example", undefined, {});
const methodCloseBase: Promise<CloseResult> = client.close("pm-example", "Done");
void methodCloseBase;
const methodCloseFalse: Promise<CloseResult> = client.close("pm-example", "Done", { releaseAssignment: false });
void methodCloseFalse;
const methodCloseComposed: Promise<CloseTaskResult> = client.close("pm-example", "Done", { releaseAssignment: true });
void methodCloseComposed;
const methodCloseDynamic: Promise<CloseResult | CloseTaskResult> = client.close("pm-example", "Done", { releaseAssignment: compose });
void methodCloseDynamic;
// @ts-expect-error A result cannot be selected independently of its runtime flag.
void client.close<true>("pm-example", "Done");
const helperCloseBase: Promise<CloseResult> = close("pm-example", "Done");
void helperCloseBase;
const helperCloseFalse: Promise<CloseResult> = close("pm-example", "Done", { releaseAssignment: false });
void helperCloseFalse;
const helperCloseComposed: Promise<CloseTaskResult> = close("pm-example", "Done", { releaseAssignment: true });
void helperCloseComposed;
const helperCloseDynamic: Promise<CloseResult | CloseTaskResult> = close("pm-example", "Done", { releaseAssignment: compose });
void helperCloseDynamic;
// @ts-expect-error A result cannot be selected independently of its runtime flag.
void close<true>("pm-example", "Done");
void close("pm-example", "Done", undefined, {});
