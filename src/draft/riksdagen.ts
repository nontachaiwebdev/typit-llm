// Fetch current Swedish statute text (SFS) from Riksdagen's open data API.
// Docs: https://data.riksdagen.se — document ids look like "sfs-1993-387".

const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_TEXT_CHARS = 15_000;

export interface LawResult {
  title: string;
  url: string;
  /** e.g. "t.o.m. SFS 2026:676" — the latest amendment included. */
  amendedThrough?: string;
  text: string;
}

const cache = new Map<string, { at: number; title: string; amendedThrough?: string; text: string }>();

/** Normalise "SFS 1993:387" / "1993:387" → "1993:387", or null if invalid. */
export function parseSfsNumber(input: string): string | null {
  const m = input.match(/(\d{4})\s*:\s*(\d+)/);
  return m ? `${m[1]}:${m[2]}` : null;
}

async function fetchStatute(sfs: string) {
  const hit = cache.get(sfs);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  const [year, num] = sfs.split(":");
  const url = `https://data.riksdagen.se/dokument/sfs-${year}-${num}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Riksdagen svarade ${res.status}`);

  const body = (await res.json()) as {
    dokumentstatus?: { dokument?: { titel?: string; subtitel?: string; text?: string } };
  };
  const dok = body.dokumentstatus?.dokument;
  if (!dok?.text) throw new Error("Ingen lagtext hittades");

  const entry = {
    at: Date.now(),
    title: dok.titel ?? `SFS ${sfs}`,
    amendedThrough: dok.subtitel || undefined,
    text: dok.text.replace(/\r\n/g, "\n"),
  };
  cache.set(sfs, entry);
  return entry;
}

/**
 * Pull one paragraph out of the statute, e.g. "9 a §" or "3 kap. 2 §".
 * Returns null if it can't be located.
 */
export function extractSection(text: string, section: string): string | null {
  const m = section.match(/(?:(\d+\s*[a-z]?)\s*kap\.?\s*)?(\d+\s*[a-z]?)\s*§/i);
  if (!m) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const chapter = m[1] ? norm(m[1]) : null;
  const para = norm(m[2]);

  // Statute text is hard-wrapped, so a cross-reference like "17 §, svara för"
  // can start a line mid-paragraph. Real paragraph and chapter starts follow
  // a blank line, so anchor on "\n\n" (the text is prefixed with one).
  let scope = "\n\n" + text;
  const pat = (s: string) => s.replace(" ", "\\s*");

  if (chapter) {
    const start = scope.search(new RegExp(`\\n\\n${pat(chapter)}\\s*kap\\.`));
    if (start === -1) return null;
    scope = scope.slice(start);
    const next = scope.slice(2).search(/\n\n\d+\s*[a-z]?\s*kap\./);
    if (next !== -1) scope = scope.slice(0, next + 2);
  }

  const start = scope.search(new RegExp(`\\n\\n${pat(para)}\\s*§`));
  if (start === -1) return null;
  const rest = scope.slice(start + 2);
  // Paragraph ends where the next "N §", "N a §" or "N kap." block begins.
  const end = rest.search(/\n\n\d+\s*[a-z]?\s*(§|kap\.)/);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

export async function fetchLaw(sfsInput: string, section?: string): Promise<LawResult> {
  const sfs = parseSfsNumber(sfsInput);
  if (!sfs) throw new Error(`Ogiltigt SFS-nummer: "${sfsInput}". Använd formatet ÅÅÅÅ:NNN.`);

  const law = await fetchStatute(sfs);
  const [year, num] = sfs.split(":");
  const url = `https://data.riksdagen.se/dokument/sfs-${year}-${num}.text`;

  let text: string;
  if (section) {
    const extracted = extractSection(law.text, section);
    text = extracted ?? `Kunde inte hitta "${section}". Början av lagen:\n\n${law.text.slice(0, 4000)}`;
  } else {
    text = law.text.length > MAX_TEXT_CHARS
      ? law.text.slice(0, MAX_TEXT_CHARS) + "\n\n[… texten är avkortad — ange section för en specifik paragraf]"
      : law.text;
  }

  return { title: law.title, url, amendedThrough: law.amendedThrough, text };
}
