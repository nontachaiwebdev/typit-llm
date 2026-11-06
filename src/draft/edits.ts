export interface Range {
  start: number;
  end: number;
}

export type EditRequest =
  | { type: "replace"; oldText: string }
  | { type: "insert_after_heading"; heading: string }
  | { type: "append" };

/** All start offsets of `needle` in `haystack`. */
function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    hits.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return hits;
}

/**
 * Check that an edit can be applied to the document as sent this turn:
 * the target must match exactly once and must not overlap an earlier edit
 * from the same turn. Returns the target range, or an error message (Swedish,
 * returned to the model so it can retry).
 */
export function validateEdit(
  doc: string,
  edit: EditRequest,
  usedRanges: Range[]
): Range | string {
  let range: Range;

  if (edit.type === "replace") {
    if (!edit.oldText) return "Fel: oldText får inte vara tom. Använd insert_after_heading för att lägga till text.";
    const hits = findAll(doc, edit.oldText);
    if (hits.length === 0) return "Fel: oldText finns inte i dokumentet. Kopiera texten exakt från det aktuella dokumentet.";
    if (hits.length > 1) return `Fel: oldText förekommer ${hits.length} gånger. Ta med mer omgivande text så att den blir unik.`;
    range = { start: hits[0], end: hits[0] + edit.oldText.length };
  } else if (edit.type === "append") {
    range = { start: doc.length, end: doc.length };
  } else {
    const heading = edit.heading.trim();
    if (!/^#{1,6}\s/.test(heading)) return "Fel: heading måste vara en hel markdown-rubrikrad, t.ex. \"## Ansvar\".";
    const lines = doc.split("\n");
    const matches: number[] = [];
    let offset = 0;
    for (const line of lines) {
      if (line.trim() === heading) matches.push(offset + line.length);
      offset += line.length + 1;
    }
    if (matches.length === 0) return "Fel: rubriken finns inte i dokumentet. Kopiera rubrikraden exakt.";
    if (matches.length > 1) return "Fel: rubriken förekommer flera gånger. Använd replace med unik omgivande text i stället.";
    range = { start: matches[0], end: matches[0] };
  }

  // Inclusive bounds: touching edits also count as overlapping, so an insert
  // right after a heading can't collide with a replace of that heading, and
  // two inserts at the same point can't be applied in an ambiguous order.
  const overlaps = usedRanges.some(
    (r) => range.start <= r.end && r.start <= range.end
  );
  if (overlaps) return "Fel: ändringen överlappar en tidigare ändring i samma svar. Slå ihop dem till en ändring.";

  return range;
}
