import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve which document `source` paths a user is allowed to see, so the chat
 * retrieval can be pre-filtered with a Pinecone metadata filter
 * `{ source: { $in: allowedSources } }`.
 *
 * The logic mirrors the (proven) offline script src/verify-permission-join.ts:
 *   file_permissions.file_id ──▶ files (tree) ──▶ reconstruct `source` path
 * Folder grants are expanded to every descendant file. An empty result means
 * "no access" — callers must fail closed.
 *
 * Each subsystem (ledningssystem, boende) lives in its own Supabase project, so
 * every call is parameterized by a PermissionConfig pointing at that project.
 */

export interface PermissionConfig {
  supabaseUrl: string;
  supabaseKey: string;
}

interface FileRow {
  id: string;
  name: string;
  storage_path: string | null;
  parent_id: string | null;
  is_directory: boolean;
}

interface FileTree {
  byId: Map<string, FileRow>;
  childrenByParent: Map<string | null, FileRow[]>;
}

// The `files` tree changes only on reindex, so cache it per project (keyed by
// URL). file_permissions is fetched per request so grant changes apply instantly.
const treeCache = new Map<string, FileTree>();
const clientCache = new Map<string, SupabaseClient>();

function getClient(cfg: PermissionConfig): SupabaseClient {
  let client = clientCache.get(cfg.supabaseUrl);
  if (!client) {
    client = createClient(cfg.supabaseUrl, cfg.supabaseKey);
    clientCache.set(cfg.supabaseUrl, client);
  }
  return client;
}

/** Drop the cached files tree for a project (call after a reindex). */
export function clearPermissionCache(supabaseUrl?: string): void {
  if (supabaseUrl) treeCache.delete(supabaseUrl);
  else treeCache.clear();
}

async function fetchAllFiles(client: SupabaseClient): Promise<FileRow[]> {
  // Paginate so this keeps working if the table grows past the 1000-row cap.
  const all: FileRow[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await client
      .from("files")
      .select("id, name, storage_path, parent_id, is_directory")
      .range(from, from + page - 1);
    if (error) throw new Error(`files query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as FileRow[]));
    if (data.length < page) break;
    from += page;
  }
  return all;
}

async function getFileTree(cfg: PermissionConfig): Promise<FileTree> {
  const cached = treeCache.get(cfg.supabaseUrl);
  if (cached) return cached;

  const rows = await fetchAllFiles(getClient(cfg));
  const byId = new Map<string, FileRow>();
  const childrenByParent = new Map<string | null, FileRow[]>();
  for (const r of rows) {
    byId.set(r.id, r);
    const siblings = childrenByParent.get(r.parent_id) ?? [];
    siblings.push(r);
    childrenByParent.set(r.parent_id, siblings);
  }

  const tree: FileTree = { byId, childrenByParent };
  treeCache.set(cfg.supabaseUrl, tree);
  return tree;
}

/** Walk parent_id up to the root, collecting folder names (root → leaf). */
function buildFolderPath(row: FileRow, byId: Map<string, FileRow>): string[] {
  const parts: string[] = [];
  let parentId = row.parent_id;
  while (parentId) {
    const dir = byId.get(parentId);
    if (!dir) break;
    parts.unshift(dir.name);
    parentId = dir.parent_id;
  }
  return parts;
}

/** Rebuild the exact `source` string ingest stored (see metadata.ts:27). */
function reconstructSource(row: FileRow, byId: Map<string, FileRow>): string {
  return [...buildFolderPath(row, byId), row.name].join("/");
}

/** BFS all non-directory descendants of a folder. */
function descendantFiles(
  dirId: string,
  childrenByParent: Map<string | null, FileRow[]>
): FileRow[] {
  const out: FileRow[] = [];
  let queue = [dirId];
  while (queue.length) {
    const next: string[] = [];
    for (const id of queue) {
      for (const child of childrenByParent.get(id) ?? []) {
        if (child.is_directory) next.push(child.id);
        else out.push(child);
      }
    }
    queue = next;
  }
  return out;
}

/** Direct per-user grants (file_permissions rows with user_id = userId). */
async function fetchUserPermissions(
  client: SupabaseClient,
  userId: string
): Promise<{ file_id: string }[]> {
  const { data, error } = await client
    .from("file_permissions")
    .select("file_id")
    .eq("user_id", userId);
  if (error) throw new Error(`file_permissions query failed: ${error.message}`);
  return (data ?? []) as { file_id: string }[];
}

/**
 * Groups this user belongs to. Group membership can grant files via group-level
 * file_permissions rows (user_id = null, group_id set). If the group_members
 * table doesn't exist yet in this project, degrade to user-only grants instead
 * of failing the whole request.
 */
async function fetchUserGroupIds(
  client: SupabaseClient,
  userId: string
): Promise<string[]> {
  const { data, error } = await client
    .from("group_members")
    .select("group_id")
    .eq("user_id", userId);
  if (error) {
    // Postgres 42P01 = undefined_table. Treat a missing table as "no groups".
    if (error.code === "42P01" || /does not exist/i.test(error.message)) {
      console.warn(
        `group_members unavailable — resolving user-only grants: ${error.message}`
      );
      return [];
    }
    throw new Error(`group_members query failed: ${error.message}`);
  }
  return (data ?? []).map((r) => (r as { group_id: string }).group_id);
}

/** Group-level grants (file_permissions rows whose group_id is one the user is in). */
async function fetchGroupPermissions(
  client: SupabaseClient,
  groupIds: string[]
): Promise<{ file_id: string }[]> {
  const { data, error } = await client
    .from("file_permissions")
    .select("file_id")
    .in("group_id", groupIds);
  if (error) {
    throw new Error(`file_permissions (group) query failed: ${error.message}`);
  }
  return (data ?? []) as { file_id: string }[];
}

/**
 * All `source` paths this user may retrieve, folder grants expanded to files.
 *
 * A user's grants are the union of their direct per-user grants and the grants
 * of every group they belong to (via group_members). Any access_level grants
 * read for chat. Empty array = no access (fail closed).
 */
export async function resolveAllowedSources(
  userId: string,
  cfg: PermissionConfig
): Promise<string[]> {
  const client = getClient(cfg);
  const [tree, userPerms, groupIds] = await Promise.all([
    getFileTree(cfg),
    fetchUserPermissions(client, userId),
    fetchUserGroupIds(client, userId),
  ]);
  const groupPerms = groupIds.length
    ? await fetchGroupPermissions(client, groupIds)
    : [];
  const { byId, childrenByParent } = tree;

  // Dedupe grants by file_id — collapses the user's overlapping manage/view rows
  // and any file granted both directly and via a group.
  const fileIds = new Set(
    [...userPerms, ...groupPerms].map((p) => p.file_id)
  );

  const allowed = new Set<string>();
  for (const fileId of fileIds) {
    const row = byId.get(fileId);
    if (!row) continue; // grant points at a file no longer in the tree
    if (row.is_directory) {
      for (const f of descendantFiles(row.id, childrenByParent)) {
        allowed.add(reconstructSource(f, byId));
      }
    } else {
      allowed.add(reconstructSource(row, byId));
    }
  }
  return [...allowed];
}
