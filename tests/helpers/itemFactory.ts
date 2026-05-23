import { expect } from "vitest";
import type { TempPmContext } from "./withTempPmPath.js";

export type TestItemStatus = "draft" | "open" | "in_progress" | "blocked" | "closed" | "canceled";

export interface TestItemFactoryOverrides {
  title: string;
  description?: string;
  type?: string;
  status?: TestItemStatus;
  priority?: string;
  tags?: string;
  body?: string;
  deadline?: string;
  estimate?: string;
  acceptanceCriteria?: string;
  author?: string;
  message?: string;
  assignee?: string;
  parent?: string;
  dep?: string;
  comment?: string;
  note?: string;
  learning?: string;
  file?: string;
  test?: string;
  doc?: string;
  createMode?: "progressive" | "template";
}

export interface CreatedTestItem {
  id: string;
  item: Record<string, unknown>;
}

export function createTestItem(context: TempPmContext, overrides: TestItemFactoryOverrides): CreatedTestItem {
  const title = overrides.title;
  const args = [
    "create",
    "--json",
    "--title",
    title,
    "--description",
    overrides.description ?? `${title} description`,
    "--type",
    overrides.type ?? "Task",
    "--status",
    overrides.status ?? "open",
    "--priority",
    overrides.priority ?? "1",
    "--tags",
    overrides.tags ?? "unit",
    "--body",
    overrides.body ?? "",
    "--deadline",
    overrides.deadline ?? "none",
    "--estimate",
    overrides.estimate ?? "10",
    "--acceptance-criteria",
    overrides.acceptanceCriteria ?? `${title} acceptance`,
    "--author",
    overrides.author ?? "seed-author",
    "--message",
    overrides.message ?? `Create ${title}`,
    "--assignee",
    overrides.assignee ?? "none",
    "--dep",
    overrides.dep ?? "none",
    "--comment",
    overrides.comment ?? "none",
    "--note",
    overrides.note ?? "none",
    "--learning",
    overrides.learning ?? "none",
    "--file",
    overrides.file ?? "none",
    "--test",
    overrides.test ?? "none",
    "--doc",
    overrides.doc ?? "none",
  ];

  if (overrides.parent !== undefined) {
    args.push("--parent", overrides.parent);
  }
  if (overrides.createMode !== undefined) {
    args.push("--create-mode", overrides.createMode);
  }

  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  const payload = created.json as { item?: Record<string, unknown> };
  expect(typeof payload.item?.id).toBe("string");
  return {
    id: String(payload.item?.id ?? ""),
    item: payload.item ?? {},
  };
}

export function createTestItemId(context: TempPmContext, overrides: TestItemFactoryOverrides): string {
  return createTestItem(context, overrides).id;
}
