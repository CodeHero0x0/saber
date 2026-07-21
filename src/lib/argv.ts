import { SaberError } from "./errors.js";

export type ParsedBooleanArguments = {
  positionals: string[];
  flags: ReadonlySet<string>;
};

/**
 * Parse positional arguments plus presence-only flags. Keeping this small and
 * typed lets subsequent commands share exact, non-shell argument handling.
 */
export function parseBooleanArguments(
  argv: readonly string[],
  allowedFlags: readonly string[],
): ParsedBooleanArguments {
  const allowed = new Set(allowedFlags);
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (const argument of argv) {
    if (argument === "--") {
      throw new SaberError("unexpected argument separator", 2);
    }

    if (argument.startsWith("-")) {
      if (!allowed.has(argument)) {
        throw new SaberError("unknown flag", 2);
      }
      if (flags.has(argument)) {
        throw new SaberError("duplicate flag", 2);
      }
      flags.add(argument);
      continue;
    }

    positionals.push(argument);
  }

  return { positionals, flags };
}
