/** Host-bound transaction identity and typed receipt contracts (pm-gh1597, pm-gh1598). */
import type { PmClient, ItemMutationPreviewValidation, CommitItemMutationsResult, ItemTransactionStatus, BulkItemMutation } from "../../src/sdk/index.js";
declare const client: PmClient;
declare const mutations: BulkItemMutation[];
const preview: Promise<ItemMutationPreviewValidation> = client.previewItemMutations({ transactionId: "id", mutations });
const commit: Promise<CommitItemMutationsResult> = client.commitItemMutations({ transactionId: "id", mutations });
const status: Promise<ItemTransactionStatus | undefined> = client.itemTransactions.status("id");
const recovery: Promise<ItemTransactionStatus> = client.itemTransactions.supersede("id", "new-id", { reason: "Replan" });
void [preview, commit, status, recovery];
// @ts-expect-error Bound clients do not accept per-batch tracker overrides.
void client.commitItemMutations({ transactionId: "id", mutations, pmRoot: "/another" });
// @ts-expect-error Bound clients retain the host author policy.
void client.previewItemMutations({ transactionId: "id", mutations, author: "another" });
// @ts-expect-error Retirement requires an explicit reason.
void client.itemTransactions.abandon("id", {});
