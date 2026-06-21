import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { parseDocxToSections } from "./docx-parser.js";
import type { DocumentMetadata } from "./metadata.js";

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 300;

/**
 * Build the title prefix that gets prepended to every chunk.
 * e.g. "[D – 5. Rutin för kost > Måltiden]"
 */
function buildTitlePrefix(breadcrumb: string[]): string {
  if (breadcrumb.length === 0) return "";
  return `[${breadcrumb.join(" > ")}]`;
}

/**
 * Process a .docx file into LangChain Documents with section-aware chunking
 * and rich metadata.
 *
 * Each chunk:
 *  - Is prepended with a title prefix so the embedding captures the topic
 *  - Never crosses section boundaries
 *  - Carries full metadata (source, category, subArea, docTitle, section)
 */
export async function chunkDocument(
  buffer: Buffer,
  metadata: DocumentMetadata
): Promise<Document[]> {
  const sections = await parseDocxToSections(buffer);
  const allChunks: Document[] = [];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  for (const section of sections) {
    // Skip title-only sections with no content
    if (!section.content) continue;

    // Use breadcrumb if available, otherwise fall back to docTitle from metadata
    const breadcrumb =
      section.breadcrumb.length > 0
        ? section.breadcrumb
        : metadata.docTitle
          ? [metadata.docTitle]
          : [];
    const prefix = buildTitlePrefix(breadcrumb);
    const prefixLine = prefix ? `${prefix}\n\n` : "";

    // Available space for content after prefix
    const contentBudget = CHUNK_SIZE - prefixLine.length;

    if (section.content.length <= contentBudget) {
      // Section fits in one chunk
      allChunks.push(
        new Document({
          pageContent: `${prefixLine}${section.content}`,
          metadata: {
            ...metadata,
            section: section.heading,
            breadcrumb: section.breadcrumb.join(" > "),
          },
        })
      );
    } else {
      // Section is too large — split it, then re-prepend the prefix to each sub-chunk
      const subChunks = await splitter.splitText(section.content);
      for (const text of subChunks) {
        if (!text.trim()) continue;
        allChunks.push(
          new Document({
            pageContent: `${prefixLine}${text}`,
            metadata: {
              ...metadata,
              section: section.heading,
              breadcrumb: section.breadcrumb.join(" > "),
            },
          })
        );
      }
    }
  }

  return allChunks;
}
