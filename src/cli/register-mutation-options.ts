/**
 * @module cli/register-mutation-options
 *
 * Defines bounded mutation-family registration controls.
 */

/** Optional controls used by the selective CLI bootstrap. */
export interface RegisterMutationCommandsOptions {
  /** Register only this mutation command when the family can safely short-circuit. */
  targetCommandName?: string;
}
