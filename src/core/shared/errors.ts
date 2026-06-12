export interface PmCliErrorRecoveryPayload {
  recovery_mode?: "compact";
  attempted_command?: string;
  normalized_args?: string[];
  provided_fields?: string[];
  missing?: string[];
  missing_required_fields?: string[];
  suggested_flags?: string[];
  suggested_retry?: string;
  fallback_candidates?: Array<{
    source: string;
    command: string;
    reason: string;
  }>;
  next_best_command?: string;
}

export interface PmCliErrorContext {
  code?: string;
  type?: string;
  required?: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
  recovery?: PmCliErrorRecoveryPayload;
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
