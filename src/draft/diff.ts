import { diffLines } from "diff";

const MAX_SUMMARY_CHARS = 4000;

/**
 * Describe what changed in the editor between the document the model saw last
 * turn and the one sent now. Returns "" when there is nothing to report.
 */
export function summarizeUserChanges(
  lastSeen: string | undefined,
  current: string
): string {
  if (lastSeen === undefined || lastSeen === current) return "";

  const lines: string[] = [];
  for (const part of diffLines(lastSeen, current)) {
    if (!part.added && !part.removed) continue;
    const prefix = part.added ? "+ " : "- ";
    for (const line of part.value.replace(/\n$/, "").split("\n")) {
      lines.push(prefix + line);
    }
  }
  if (lines.length === 0) return "";

  const summary = lines.join("\n");
  if (summary.length > MAX_SUMMARY_CHARS) {
    return "Användaren har gjort omfattande ändringar i dokumentet. Läs det aktuella dokumentet noggrant.";
  }
  return summary;
}
