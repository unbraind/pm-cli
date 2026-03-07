export class PmCliError extends Error {
  public readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "PmCliError";
    this.exitCode = exitCode;
  }
}
