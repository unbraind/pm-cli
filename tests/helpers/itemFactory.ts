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

interface TestItemCreateField {
  flag: string;
  key: keyof TestItemFactoryOverrides;
  fallback: (title: string) => string;
}

const TEST_ITEM_CREATE_FIELDS: readonly TestItemCreateField[] = [
  { flag: "--description", key: "description", fallback: (title) => `${title} description` },
  { flag: "--type", key: "type", fallback: () => "Task" },
  { flag: "--status", key: "status", fallback: () => "open" },
  { flag: "--priority", key: "priority", fallback: () => "1" },
  { flag: "--tags", key: "tags", fallback: () => "unit" },
  { flag: "--body", key: "body", fallback: () => "" },
  { flag: "--deadline", key: "deadline", fallback: () => "none" },
  { flag: "--estimate", key: "estimate", fallback: () => "10" },
  { flag: "--acceptance-criteria", key: "acceptanceCriteria", fallback: (title) => `${title} acceptance` },
  { flag: "--author", key: "author", fallback: () => "seed-author" },
  { flag: "--message", key: "message", fallback: (title) => `Create ${title}` },
  { flag: "--assignee", key: "assignee", fallback: () => "none" },
  { flag: "--dep", key: "dep", fallback: () => "none" },
  { flag: "--comment", key: "comment", fallback: () => "none" },
  { flag: "--note", key: "note", fallback: () => "none" },
  { flag: "--learning", key: "learning", fallback: () => "none" },
  { flag: "--file", key: "file", fallback: () => "none" },
  { flag: "--test", key: "test", fallback: () => "none" },
  { flag: "--doc", key: "doc", fallback: () => "none" },
];

function resolveCreateFieldValue(field: TestItemCreateField, overrides: TestItemFactoryOverrides): string {
  const value = overrides[field.key];
  return typeof value === "string" ? value : field.fallback(overrides.title);
}

function appendOptionalCreateArg(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) {
    args.push(flag, value);
  }
}

function buildCreateTestItemArgs(overrides: TestItemFactoryOverrides): string[] {
  const args = ["create", "--json", "--title", overrides.title];
  for (const field of TEST_ITEM_CREATE_FIELDS) {
    args.push(field.flag, resolveCreateFieldValue(field, overrides));
  }
  appendOptionalCreateArg(args, "--parent", overrides.parent);
  appendOptionalCreateArg(args, "--create-mode", overrides.createMode);
  return args;
}

export function createTestItem(context: TempPmContext, overrides: TestItemFactoryOverrides): CreatedTestItem {
  const args = buildCreateTestItemArgs(overrides);
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
