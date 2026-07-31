import {
  applyTerminalOrderingPolicy,
  requireTerminalReason,
  type ItemMetadata,
  type TerminalTransitionPolicy,
} from "@unbrained/pm-cli/sdk";

export const policy: TerminalTransitionPolicy = {
  requireCloseReason: true,
  orderingEdges: "preserve",
};

export const reason = requireTerminalReason(
  { message: "Verified through the SDK acceptance workflow." },
  policy.requireCloseReason,
);

export const metadata: ItemMetadata = {
  id: "pm-example",
  title: "Example lifecycle",
  description: "Demonstrate durable SDK-owned terminal lifecycle policy.",
  type: "Task",
  status: "blocked",
  priority: 1,
  tags: ["example", "sdk"],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  blocked_by: "pm-prerequisite",
  dependencies: [
    {
      id: "pm-prerequisite",
      kind: "blocked_by",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ],
};

export const ordering = applyTerminalOrderingPolicy(metadata, policy);
