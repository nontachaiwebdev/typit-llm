import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";

/**
 * PROVE the permissions → Pinecone-filter pipeline end-to-end.
 *
 *   file_permissions.file_id  ──join──▶  files (tree)  ──reconstruct──▶  source path
 *                                                                          │
 *                                    Pinecone metadata.source  ◀──compare──┘
 *
 * Steps:
 *  1. Join file_permissions → files, per user.
 *  2. Reconstruct the exact `source` path the ingest used (walk parent_id chain),
 *     expanding folder grants to all descendant files.
 *  3. Pull the real `source` values living in Pinecone and measure overlap, so we
 *     know a { source: { $in: [...] } } filter would actually match.
 *
 * Read-only. No writes to Supabase or Pinecone.
 */

interface FileRow {
  id: string;
  name: string;
  storage_path: string | null;
  parent_id: string | null;
  is_directory: boolean;
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function fetchAllFiles(): Promise<FileRow[]> {
  // Paginate to be safe if the table grows beyond the default 1000-row cap.
  const all: FileRow[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase
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

async function fetchPermissions() {
  const { data, error } = await supabase
    .from("file_permissions")
    .select("user_id, file_id, access_level");
  if (error) throw new Error(`file_permissions query failed: ${error.message}`);
  return data as { user_id: string; file_id: string; access_level: string }[];
}

/** Pull distinct `source` values actually present in the Pinecone index. */
async function fetchPineconeSources(): Promise<Set<string>> {
  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  const index = pinecone.Index(process.env.PINECONE_INDEX_LEDNINGSSYSTEM!);
  // A constant vector is fine — we only want a broad sample of metadata, not
  // relevance. topK is capped at 1000 when includeMetadata is true.
  const vector = new Array(1536).fill(0.01);
  const res = await index.query({
    vector,
    topK: 1000,
    includeMetadata: true,
  });
  const sources = new Set<string>();
  for (const m of res.matches ?? []) {
    const s = (m.metadata as any)?.source;
    if (typeof s === "string") sources.add(s);
  }
  return sources;
}

async function main() {
  const [fileRows, perms] = await Promise.all([
    fetchAllFiles(),
    fetchPermissions(),
  ]);

  const byId = new Map<string, FileRow>();
  const childrenByParent = new Map<string | null, FileRow[]>();
  for (const r of fileRows) {
    byId.set(r.id, r);
    const arr = childrenByParent.get(r.parent_id) ?? [];
    arr.push(r);
    childrenByParent.set(r.parent_id, arr);
  }

  // Reconstruct source EXACTLY as ingest did: walk parent_id up to build the
  // folder path, then append the file name.  (see supabase.ts buildFolderPath +
  // metadata.ts source = [...folderPath, fileName].join("/"))
  function buildFolderPath(row: FileRow): string[] {
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
  const reconstructSource = (row: FileRow): string =>
    [...buildFolderPath(row), row.name].join("/");

  function descendantFiles(dirId: string): FileRow[] {
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

  // Group grants per user, expanding folder grants → descendant files.
  const byUser = new Map<string, Set<string>>();
  let unresolved = 0;
  for (const p of perms) {
    const row = byId.get(p.file_id);
    if (!row) {
      unresolved++;
      continue;
    }
    const set = byUser.get(p.user_id) ?? new Set<string>();
    if (row.is_directory) {
      for (const f of descendantFiles(row.id)) set.add(reconstructSource(f));
    } else {
      set.add(reconstructSource(row));
    }
    byUser.set(p.user_id, set);
  }

  console.log(`Users with permissions: ${byUser.size}`);
  if (unresolved) console.log(`⚠️  ${unresolved} permission row(s) had a file_id not found in files\n`);

  // Pull what Pinecone actually has, then measure overlap.
  console.log("Sampling Pinecone metadata.source values...");
  let pineconeSources: Set<string>;
  try {
    pineconeSources = await fetchPineconeSources();
  } catch (err: any) {
    console.error(`❌ Pinecone sample failed: ${err.message ?? err}`);
    console.error("(Reconstruction below is still valid; only the cross-check was skipped.)");
    pineconeSources = new Set();
  }
  console.log(`Distinct sources sampled from Pinecone: ${pineconeSources.size}\n`);

  for (const [userId, allowed] of byUser) {
    console.log(`── User ${userId} ──`);
    console.log(`  Allowed files (after folder expansion): ${allowed.size}`);

    if (pineconeSources.size > 0) {
      const matched = [...allowed].filter((s) => pineconeSources.has(s));
      const missing = [...allowed].filter((s) => !pineconeSources.has(s));
      console.log(`  Reconstructed source MATCHES Pinecone: ${matched.length}/${allowed.size}`);
      if (missing.length) {
        console.log(`  ⚠️  ${missing.length} reconstructed path(s) NOT found in Pinecone sample, e.g.:`);
        for (const s of missing.slice(0, 5)) console.log(`        ${s}`);
      }
    }
    console.log("  Example reconstructed source paths:");
    for (const s of [...allowed].slice(0, 5)) console.log(`        ${s}`);
    console.log("");
  }

  // Live filter test: take one allowed source and prove a Pinecone metadata
  // filter returns only that file.
  const firstUser = [...byUser.values()][0];
  const sample = firstUser && [...firstUser].find((s) => pineconeSources.has(s));
  if (sample) {
    console.log(`── Live filter test on: ${sample} ──`);
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    const index = pinecone.Index(process.env.PINECONE_INDEX_LEDNINGSSYSTEM!);
    const embeddings = new OpenAIEmbeddings({
      model: "text-embedding-3-large",
      dimensions: 1536,
      apiKey: process.env.OPENAI_API_KEY!,
    });
    const store = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex: index });
    const hits = await store.similaritySearch("rutin", 5, { source: sample });
    console.log(`  Query with filter {source} returned ${hits.length} chunk(s).`);
    const allMatch = hits.every((h) => h.metadata?.source === sample);
    console.log(`  All returned chunks belong to that file: ${allMatch ? "✅ yes" : "❌ no"}`);
  }
}

main().catch((err) => {
  console.error("\n❌ Failed:", err.message ?? err);
  process.exit(1);
});
