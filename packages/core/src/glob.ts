/**
 * The one wildcard syntax of Sagaz, shared by classification rules, policy tool rules and
 * compensation pack entries: `*` matches any run of characters (including none), anchored.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`);
}
