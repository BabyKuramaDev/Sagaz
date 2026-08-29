/** Minimal `--flag value` / `--flag=value` / `--flag` parser; no dependency. */
export interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export function parseFlags(argv: readonly string[], valueFlags: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    if (valueFlags.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} requires a value`);
      flags[name] = value;
    } else if (inline !== undefined) {
      throw new UsageError(`--${name} does not take a value`);
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}
