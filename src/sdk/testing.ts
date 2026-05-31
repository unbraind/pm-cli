import type {
  ExtensionRegistrationRegistry,
  FlagDefinition,
  RegisteredExtensionCommandDefinition,
} from "../core/extensions/loader.js";

export interface RegisteredCommandContractExpectation {
  command: string;
  action?: string;
  extensionName?: string;
  arguments?: string[];
  flags?: string[];
}

export interface RegisteredCommandContractAssertion {
  command: RegisteredExtensionCommandDefinition;
  flags: FlagDefinition[];
}

function normalizeSdkCommandName(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function formatAvailable(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function collectFlagLabels(flags: readonly FlagDefinition[]): Set<string> {
  const labels = new Set<string>();
  for (const flag of flags) {
    if (typeof flag.long === "string" && flag.long.trim().length > 0) {
      labels.add(flag.long.trim());
    }
    if (typeof flag.short === "string" && flag.short.trim().length > 0) {
      labels.add(flag.short.trim());
    }
  }
  return labels;
}

/**
 * Assert that an activated extension registration registry contains a command
 * contract with the expected public metadata.
 */
export function assertRegisteredCommandContract(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredCommandContractExpectation,
): RegisteredCommandContractAssertion {
  const expectedCommand = normalizeSdkCommandName(expectation.command);
  if (expectedCommand.length === 0) {
    throw new Error("Expected command name must be a non-empty string");
  }

  const commandCandidates = registrations.commands.filter((entry) => entry.command === expectedCommand);
  const command = expectation.extensionName
    ? commandCandidates.find((entry) => entry.name === expectation.extensionName)
    : commandCandidates[0];
  if (!command) {
    const available = registrations.commands.map((entry) => entry.command).sort((left, right) => left.localeCompare(right));
    const extensionSuffix = expectation.extensionName ? ` from extension "${expectation.extensionName}"` : "";
    throw new Error(
      `Expected extension command "${expectedCommand}"${extensionSuffix} to be registered. Available commands: ${formatAvailable(
        available,
      )}`,
    );
  }

  if (expectation.action !== undefined && command.action !== expectation.action) {
    throw new Error(
      `Expected extension command "${expectedCommand}" action "${expectation.action}", received "${command.action}"`,
    );
  }

  if (expectation.arguments !== undefined) {
    const actualArguments = (command.arguments ?? []).map((argument) => argument.name);
    const missingArguments = expectation.arguments.filter((argument) => !actualArguments.includes(argument));
    if (missingArguments.length > 0) {
      throw new Error(
        `Expected extension command "${expectedCommand}" arguments ${formatAvailable(
          expectation.arguments,
        )}; missing ${formatAvailable(missingArguments)}; available ${formatAvailable(actualArguments)}`,
      );
    }
  }

  const flags = registrations.flags
    .filter(
      (entry) =>
        entry.target_command === expectedCommand &&
        (expectation.extensionName === undefined || entry.name === expectation.extensionName),
    )
    .flatMap((entry) => entry.flags);

  if (expectation.flags !== undefined) {
    const actualFlagLabels = collectFlagLabels(flags);
    const missingFlags = expectation.flags.filter((flag) => !actualFlagLabels.has(flag));
    if (missingFlags.length > 0) {
      throw new Error(
        `Expected extension command "${expectedCommand}" flags ${formatAvailable(expectation.flags)}; missing ${formatAvailable(
          missingFlags,
        )}; available ${formatAvailable([...actualFlagLabels].sort((left, right) => left.localeCompare(right)))}`,
      );
    }
  }

  return { command, flags };
}
