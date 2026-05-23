import { expect } from "vitest";

export interface JsonErrorEnvelope {
  type?: string;
  code: string;
  title?: string;
  detail?: string;
  required?: string;
  exit_code: number;
  why?: string;
  examples?: string[];
  next_steps?: string[];
  recovery?: Record<string, unknown>;
}

export function parseJsonErrorEnvelope(stderr: string): JsonErrorEnvelope {
  return JSON.parse(stderr) as JsonErrorEnvelope;
}

export function expectJsonErrorEnvelope(
  stderr: string,
  expected?: Partial<JsonErrorEnvelope>,
): JsonErrorEnvelope {
  const envelope = parseJsonErrorEnvelope(stderr);
  if (expected) {
    expect(envelope).toMatchObject(expected);
  }
  return envelope;
}
