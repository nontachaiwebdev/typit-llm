import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = process.env.SUPABASE_BUCKET ?? "knowledge-base";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DownloadedFile {
  localPath: string;
  relativePath: string;
}

interface FileRow {
  id: string;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  parent_id: string | null;
  is_directory: boolean;
}

function isDocx(row: FileRow): boolean {
  return row.mime_type === DOCX_MIME || row.name.endsWith(".docx");
}

/**
 * Query the public.files table to find all .docx files.
 * If directoryId is provided, BFS-traverse all descendants of that directory.
 * Otherwise, return all .docx files in the table.
 */
async function listDocxFiles(directoryId?: string): Promise<FileRow[]> {
  if (!directoryId) {
    const { data, error } = await supabase
      .from("files")
      .select("*")
      .eq("is_directory", false);

    if (error) throw new Error(`Failed to query files: ${error.message}`);
    return (data as FileRow[]).filter(isDocx);
  }

  // BFS: collect all descendant .docx files under directoryId
  const docxFiles: FileRow[] = [];
  let queue: string[] = [directoryId];

  while (queue.length > 0) {
    const parentIds = queue;
    queue = [];

    const { data, error } = await supabase
      .from("files")
      .select("*")
      .in("parent_id", parentIds);

    if (error) throw new Error(`Failed to query files: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data as FileRow[]) {
      if (row.is_directory) {
        queue.push(row.id);
      } else if (isDocx(row)) {
        docxFiles.push(row);
      }
    }
  }

  return docxFiles;
}

/**
 * Download all .docx files from Supabase (DB + Storage)
 * to a temporary directory. Returns the temp dir path and list of files.
 */
export async function downloadDocxFiles(
  directoryId?: string
): Promise<{ tmpDir: string; files: DownloadedFile[] }> {
  const tmpDir = join(tmpdir(), `typit-llm-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const fileRows = await listDocxFiles(directoryId);
  const downloadedFiles: DownloadedFile[] = [];

  for (const row of fileRows) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(row.storage_path);

    if (error || !data) {
      console.error(`Failed to download ${row.name}:`, error?.message);
      continue;
    }

    const localPath = join(tmpDir, `${row.id}-${row.name}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    await writeFile(localPath, buffer);

    downloadedFiles.push({ localPath, relativePath: row.name });
    console.log(`Downloaded: ${row.name}`);
  }

  return { tmpDir, files: downloadedFiles };
}

/**
 * Remove a temporary directory and all its contents.
 */
export async function cleanupTmpDir(tmpDir: string) {
  await rm(tmpDir, { recursive: true, force: true });
}
