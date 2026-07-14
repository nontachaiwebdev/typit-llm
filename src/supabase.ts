import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  bucket?: string;
}

// Default client built from global env vars — used when no config is passed
// (preserves the original behavior for existing callers).
const defaultClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Client = typeof defaultClient;

const DEFAULT_BUCKET = process.env.SUPABASE_BUCKET ?? "knowledge-base";

/** Resolve which Supabase client + bucket to use for a given (optional) config. */
function resolveClient(config?: SupabaseConfig): { client: Client; bucket: string } {
  if (!config) return { client: defaultClient, bucket: DEFAULT_BUCKET };
  return {
    client: createClient(config.url, config.serviceRoleKey),
    bucket: config.bucket ?? "knowledge-base",
  };
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DownloadedFile {
  localPath: string;
  relativePath: string;
  /** Folder hierarchy from root, e.g. ["J Personal", "J - 4. Arbetsmiljö"] */
  folderPath: string[];
  /** Original file name, e.g. "J - 4. Arbetsmiljöpolicy.docx" */
  fileName: string;
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
async function listDocxFiles(
  client: Client,
  directoryId?: string
): Promise<FileRow[]> {
  if (!directoryId) {
    const { data, error } = await client
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

    const { data, error } = await client
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
 * Fetch all directory rows and build a map of id → FileRow.
 * Used to reconstruct folder paths by walking parent_id chains.
 */
async function fetchDirectoryMap(
  client: Client
): Promise<Map<string, FileRow>> {
  const dirMap = new Map<string, FileRow>();
  const { data, error } = await client
    .from("files")
    .select("*")
    .eq("is_directory", true);

  if (error) {
    console.error("Failed to fetch directories:", error.message);
    return dirMap;
  }

  for (const row of (data ?? []) as FileRow[]) {
    dirMap.set(row.id, row);
  }
  return dirMap;
}

/**
 * Build folder path segments for a file by walking its parent_id chain.
 * Returns e.g. ["J Personal", "J - 4. Arbetsmiljö"]
 */
function buildFolderPath(
  row: FileRow,
  dirMap: Map<string, FileRow>
): string[] {
  const parts: string[] = [];
  let parentId = row.parent_id;
  while (parentId) {
    const dir = dirMap.get(parentId);
    if (!dir) break;
    parts.unshift(dir.name);
    parentId = dir.parent_id;
  }
  return parts;
}

/**
 * Download all .docx files from Supabase (DB + Storage)
 * to a temporary directory. Returns the temp dir path and list of files.
 */
export async function downloadDocxFiles(
  directoryId?: string,
  config?: SupabaseConfig
): Promise<{ tmpDir: string; files: DownloadedFile[] }> {
  const { client, bucket } = resolveClient(config);
  const tmpDir = join(tmpdir(), `typit-llm-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const [fileRows, dirMap] = await Promise.all([
    listDocxFiles(client, directoryId),
    fetchDirectoryMap(client),
  ]);
  const downloadedFiles: DownloadedFile[] = [];

  for (const row of fileRows) {
    const { data, error } = await client.storage
      .from(bucket)
      .download(row.storage_path);

    if (error || !data) {
      console.error(`Failed to download ${row.name}:`, error?.message);
      continue;
    }

    const localPath = join(tmpDir, `${row.id}-${row.name}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    await writeFile(localPath, buffer);

    const folderPath = buildFolderPath(row, dirMap);

    downloadedFiles.push({
      localPath,
      relativePath: row.name,
      folderPath,
      fileName: row.name,
    });
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
