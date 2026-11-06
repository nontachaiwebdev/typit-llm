import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { tools as anthropicTools } from "@langchain/anthropic";
import { z } from "zod";
import { fetchLaw } from "./riksdagen.js";
import { validateEdit, type Range } from "./edits.js";
import type { DraftDocSearch, DraftEdit, DraftSource, Emit } from "./types.js";

const DEFAULT_ALLOWED_DOMAINS = [
  "riksdagen.se",
  "av.se",
  "socialstyrelsen.se",
  "ivo.se",
  "imy.se",
  "forsakringskassan.se",
  "regeringen.se",
  "folkhalsomyndigheten.se",
];

export function allowedDomains(): string[] {
  const env = process.env.DRAFT_ALLOWED_DOMAINS?.trim();
  if (!env) return DEFAULT_ALLOWED_DOMAINS;
  return env.split(",").map((d) => d.trim()).filter(Boolean);
}

interface ToolContext {
  document: string;
  allowedSources: string[];
  /** Already de-duplicates source events. */
  emit: Emit;
  /** url → title of web search results seen so far this turn. */
  webResults: Map<string, string>;
  /** The company's knowledge-base search. */
  docSearch: DraftDocSearch;
}

function isAllowedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return allowedDomains().some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

/**
 * Build the tool set for one turn. Tools close over the request's document,
 * the user's permitted files and the SSE emitter.
 */
export function buildDraftTools(ctx: ToolContext) {
  const usedRanges: Range[] = [];
  const emitSource = (s: DraftSource) => ctx.emit({ event: "source", data: s });

  const searchInternalDocs = tool(
    async ({ query }) => {
      ctx.emit({ event: "status", data: { message: "Söker i interna dokument…" } });
      if (ctx.allowedSources.length === 0) {
        return "Användaren har inte behörighet till några interna dokument.";
      }
      const docs = await ctx.docSearch.retrieve(query, ctx.allowedSources);
      if (docs.length === 0) return "Inga relevanta interna dokument hittades.";
      for (const d of docs) {
        const m = d.metadata ?? {};
        emitSource({
          kind: "internal",
          title: m.docTitle || m.source || "Internt dokument",
          file: m.source,
          reference: m.section || undefined,
        });
      }
      return ctx.docSearch.formatContext(docs);
    },
    {
      name: "search_internal_docs",
      description:
        "Sök i organisationens befintliga dokument (rutiner, riktlinjer, policyer) som användaren har behörighet till. Skriv sökfrågan på formell svenska.",
      schema: z.object({
        query: z.string().describe("Sökfråga på svenska, utan personuppgifter."),
      }),
    }
  );

  const fetchLawTool = tool(
    async ({ sfs, section }) => {
      ctx.emit({
        event: "status",
        data: { message: `Hämtar lagtext SFS ${sfs}${section ? ` ${section}` : ""} från Riksdagen…` },
      });
      try {
        const law = await fetchLaw(sfs, section);
        emitSource({
          kind: "law",
          title: law.title,
          url: law.url,
          reference: [section, law.amendedThrough].filter(Boolean).join(", ") || undefined,
        });
        return `${law.title}${law.amendedThrough ? ` (${law.amendedThrough})` : ""}\nKälla: ${law.url}\n\n${law.text}`;
      } catch (err: any) {
        return `Kunde inte hämta lagtexten: ${err.message}`;
      }
    },
    {
      name: "fetch_law",
      description:
        "Hämta gällande lagtext ur Svensk författningssamling (SFS) från Riksdagens öppna data. Ange SFS-nummer och gärna en specifik paragraf. Fungerar inte för myndighetsföreskrifter (AFS, HSLF-FS) — använd web_search för dem.",
      schema: z.object({
        sfs: z.string().describe('SFS-nummer, t.ex. "1993:387" för LSS.'),
        section: z
          .string()
          .optional()
          .describe('Paragraf, t.ex. "9 a §" eller "3 kap. 2 §". Utelämna för hela lagen (avkortad).'),
      }),
    }
  );

  const editDocument = tool(
    async ({ type, oldText, heading, newText, reason, sources }) => {
      const req =
        type === "replace"
          ? { type, oldText: oldText ?? "" } as const
          : type === "insert_after_heading"
            ? { type, heading: heading ?? "" } as const
            : { type } as const;

      const result = validateEdit(ctx.document, req, usedRanges);
      if (typeof result === "string") return result;

      // Keep only web sources the model actually saw in search results or that
      // point at an allowed domain; plain references ("AFS 2023:1") pass as-is.
      const cleanSources = (sources ?? []).filter(
        (s) => !/^https?:\/\//.test(s) || ctx.webResults.has(s) || isAllowedUrl(s)
      );

      const editId = randomUUID();
      const common = { editId, newText, reason, sources: cleanSources };
      let edit: DraftEdit;
      if (req.type === "replace") edit = { ...common, type: "replace", oldText: req.oldText };
      else if (req.type === "insert_after_heading") edit = { ...common, type: "insert_after_heading", heading: req.heading.trim() };
      else edit = { ...common, type: "append" };

      usedRanges.push(result);

      ctx.emit({ event: "edit", data: edit });
      for (const s of cleanSources) {
        if (/^https?:\/\//.test(s)) {
          emitSource({ kind: "web", title: ctx.webResults.get(s) ?? s, url: s });
        }
      }
      return `ok: förslag ${editId} skickat till användaren.`;
    },
    {
      name: "edit_document",
      description: `Föreslå en ändring i dokumentet i editorn. Användaren godkänner eller avvisar varje förslag.
- "replace": ersätt oldText (exakt, unik text ur dokumentet) med newText. För att ta bort text, låt newText vara "".
- "insert_after_heading": infoga newText direkt efter rubrikraden heading (exakt rad, t.ex. "## Ansvar"). Börja newText med en radbrytning.
- "append": lägg till newText sist i dokumentet. Använd för ett första utkast i ett tomt dokument eller för nya avsnitt i slutet.
Alla ändringar avser dokumentet som det ser ut i denna tur och får inte överlappa varandra.`,
      schema: z.object({
        type: z.enum(["replace", "insert_after_heading", "append"]),
        oldText: z.string().optional().describe('Krävs för "replace".'),
        heading: z.string().optional().describe('Krävs för "insert_after_heading".'),
        newText: z.string().describe("Ny markdowntext."),
        reason: z.string().describe("Kort motivering som visas för användaren, gärna med lagrum."),
        sources: z
          .array(z.string())
          .optional()
          .describe("URL:er (från web_search eller fetch_law) och lagrum som ändringen bygger på."),
      }),
    }
  );

  const webSearch = anthropicTools.webSearch_20250305({
    allowedDomains: allowedDomains(),
    maxUses: 5,
    userLocation: {
      type: "approximate",
      country: "SE",
      timezone: "Europe/Stockholm",
    },
  });

  return {
    customTools: [searchInternalDocs, fetchLawTool, editDocument],
    serverTools: [webSearch],
  };
}
