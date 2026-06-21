import mammoth from "mammoth";

export interface Section {
  heading: string;
  level: number; // 1 = document title, 2 = sub-section
  content: string; // plain text with markdown-like formatting preserved
  breadcrumb: string[];
}

/**
 * Convert a .docx buffer to HTML using mammoth (preserves headings, bold, lists).
 */
async function parseDocxToHtml(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer });
  return result.value;
}

/**
 * Detect whether an HTML paragraph is a heading.
 *
 * Documents use bold formatting (not Word heading styles) for headings.
 * A heading is a <p> whose entire content is wrapped in <strong>.
 * Examples:
 *   <p><strong>D – 5. Rutin för kost</strong></p>       → heading
 *   <p><strong>Kosten</strong></p>                        → heading
 *   <p><strong>Syfte:</strong> </p>                       → heading (trailing space/colon)
 *   <p>Some text <strong>bold</strong> more text</p>      → NOT a heading
 */
function isHeadingParagraph(innerHtml: string): string | null {
  const trimmed = innerHtml.trim();
  // Match: optional whitespace, <strong>content</strong>, optional whitespace
  const match = trimmed.match(/^\s*<strong>(.*?)<\/strong>\s*$/s);
  if (!match) return null;

  const headingText = stripHtmlTags(match[1]).trim();
  // Skip empty or very long "headings" (likely a bold paragraph, not a heading)
  if (!headingText || headingText.length > 150) return null;
  return headingText;
}

// Regex: document code prefix like "D – 5.", "J - 1.", "H – ", "A "
const DOC_CODE_RE = /^[A-K]\s*[–\-]\s*\d+/;

/**
 * Determine heading level:
 * - Level 1: matches document code prefix (e.g. "D – 5. Rutin för kost...")
 * - Level 2: other standalone bold paragraphs (e.g. "Kosten", "Syfte:")
 */
function headingLevel(text: string): number {
  return DOC_CODE_RE.test(text) ? 1 : 2;
}

/**
 * Strip HTML tags from a string, converting structural tags to readable text.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<em>(.*?)<\/em>/gi, "_$1_")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Parse HTML into paragraph blocks, handling <p>, <ul>, <ol>, <table> etc.
 */
function splitHtmlBlocks(
  html: string
): Array<{ type: "p" | "list" | "other"; raw: string }> {
  const blocks: Array<{ type: "p" | "list" | "other"; raw: string }> = [];

  // Split on <p> and list blocks
  const tagRe =
    /(<p[^>]*>.*?<\/p>|<ul[^>]*>.*?<\/ul>|<ol[^>]*>.*?<\/ol>|<table[^>]*>.*?<\/table>)/gis;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    const raw = match[1];
    if (raw.startsWith("<p")) {
      blocks.push({ type: "p", raw });
    } else if (raw.startsWith("<ul") || raw.startsWith("<ol")) {
      blocks.push({ type: "list", raw });
    } else {
      blocks.push({ type: "other", raw });
    }
  }

  return blocks;
}

/**
 * Main export: Parse a .docx buffer into structured sections.
 *
 * Each section has a heading, level, content (plain text), and breadcrumb.
 * If the document has no detectable headings, the entire text is returned
 * as a single section.
 */
export async function parseDocxToSections(
  buffer: Buffer
): Promise<Section[]> {
  const html = await parseDocxToHtml(buffer);
  const blocks = splitHtmlBlocks(html);

  const sections: Section[] = [];
  let currentHeading = "";
  let currentLevel = 1;
  let docTitle = "";
  let contentParts: string[] = [];

  function flushSection() {
    const content = contentParts
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (content || currentHeading) {
      const breadcrumb = [docTitle, currentHeading].filter(
        (s) => s && s !== docTitle
      );
      if (docTitle && !breadcrumb.includes(docTitle)) {
        breadcrumb.unshift(docTitle);
      }

      sections.push({
        heading: currentHeading,
        level: currentLevel,
        content,
        breadcrumb,
      });
    }
    contentParts = [];
  }

  for (const block of blocks) {
    if (block.type === "p") {
      // Extract inner HTML of <p>
      const innerMatch = block.raw.match(/<p[^>]*>(.*?)<\/p>/is);
      if (!innerMatch) continue;

      const inner = innerMatch[1];

      // Check if this is a heading
      const headingText = isHeadingParagraph(inner);
      if (headingText) {
        const level = headingLevel(headingText);

        if (!docTitle) {
          // First heading = document title (regardless of detected level)
          docTitle = headingText;
          flushSection();
          currentHeading = headingText;
          currentLevel = 1;
        } else {
          // New section
          flushSection();
          currentHeading = headingText;
          currentLevel = level;
        }
      } else {
        // Regular paragraph — convert to plain text
        const text = stripHtmlTags(inner).trim();
        if (text) {
          contentParts.push(text);
        }
      }
    } else if (block.type === "list") {
      // Convert list to bullet points
      const text = stripHtmlTags(block.raw).trim();
      if (text) {
        contentParts.push(text);
      }
    } else {
      // Tables and other blocks
      const text = stripHtmlTags(block.raw).trim();
      if (text) {
        contentParts.push(text);
      }
    }
  }

  // Flush the last section
  flushSection();

  // If no headings were found, return the whole document as one section
  if (sections.length === 0) {
    const fullText = stripHtmlTags(html)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return [
      {
        heading: "",
        level: 1,
        content: fullText,
        breadcrumb: [],
      },
    ];
  }

  return sections;
}
