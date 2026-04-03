export interface PmCliErrorContext {
  code?: string;
  type?: string;
  required?: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
}

export class PmCliError extends Error {
  public readonly exitCode: number;
  public readonly context: PmCliErrorContext;

  constructor(message: string, exitCode: number, context: PmCliErrorContext = {}) {
    super(message);
    this.name = "PmCliError";
    this.exitCode = exitCode;
    this.context = context;
  }
}
