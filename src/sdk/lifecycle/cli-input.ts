/** @module sdk/lifecycle/cli-input Explicit transport policies for SDK-backed command adapters. */
import { markCliMutationInput, preserveLiteralMutationInput } from "../../core/item/literal-mutation-input.js";
import { preserveMutationStdinTokenLiterals, transferMutationStdinTokenPolicy } from "../../core/item/parse.js";

/** Clone lifecycle options and opt a command adapter into CLI stdin and clear-token syntax. */
export function withCliMutationInput<T extends object>(options: T): T {
  return markCliMutationInput(transferMutationStdinTokenPolicy(options, { ...options }));
}

/** Clone decoded data and keep every sentinel spelling literal, even inside a CLI adapter. */
export function withLiteralMutationInput<T extends object>(options: T): T {
  return preserveLiteralMutationInput(preserveMutationStdinTokenLiterals(transferMutationStdinTokenPolicy(options, { ...options })));
}
