export interface DocumentMetadata {
  /** Full relative path for provenance (e.g. "D Genomförande/D-5/D-5. Rutin.docx") */
  source: string;
  /** Top-level category (e.g. "D Genomförande") */
  category: string;
  /** Category letter code (e.g. "D") */
  categoryCode: string;
  /** Sub-area folder (e.g. "D - 5. Kost och måltider") */
  subArea: string;
  /** Document title without extension (e.g. "D - 5. Rutin för kost, matlagning och måltiden") */
  docTitle: string;
  /** Per-chunk fields — filled during chunking, not here */
  section?: string;
  breadcrumb?: string;
}

/**
 * Extract rich metadata from folder path segments and filename.
 *
 * @param pathSegments - Folder hierarchy, e.g. ["D  Genomförande", "D - 5. Kost och måltider"]
 * @param fileName - File name with extension, e.g. "D - 5. Rutin för kost.docx"
 */
export function extractMetadataFromPath(
  pathSegments: string[],
  fileName: string
): DocumentMetadata {
  const source = [...pathSegments, fileName].join("/");
  const docTitle = fileName.replace(/\.docx$/i, "");

  // First segment is typically the top-level category
  const category = pathSegments[0] ?? "";

  // Extract category letter code (A-K)
  const codeMatch = category.match(/^([A-K])\b/i);
  const categoryCode = codeMatch ? codeMatch[1].toUpperCase() : "";

  // Second segment (if exists) is the sub-area
  const subArea = pathSegments[1] ?? "";

  return {
    source,
    category: category.trim(),
    categoryCode,
    subArea: subArea.trim(),
    docTitle: docTitle.trim(),
  };
}
