import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/**
 * Read-only inspection of the `file_permissions` table.
 *
 * Discovers the table's columns at runtime (no schema assumed), prints a sample
 * of rows, summarizes how many files each user is granted, and best-effort
 * resolves file references to real names via the `files` table.
 *
 * Touches NOTHING — pure SELECTs. Uses the service-role key so RLS is bypassed
 * and we see the raw table contents.
 */

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}

const supabase = createClient(url, key);

// Candidate column names we try to recognize, most-specific first.
const USER_KEYS = ["user_id", "user_email", "email", "user", "username", "role"];
const FILE_KEYS = ["file_id", "file", "source", "file_name", "filename", "path", "storage_path"];
const PERM_KEYS = ["access_level", "permission", "access", "can_read", "allowed", "level", "role"];

function pick(cols: string[], candidates: string[]): string | undefined {
  return candidates.find((c) => cols.includes(c));
}

function looksLikeUuid(v: unknown): boolean {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

async function main() {
  console.log(`Supabase project : ${url}`);
  console.log(`Table            : public.file_permissions\n`);

  // 1. Does the table exist / can we read it? Grab count + a sample.
  const { data: rows, error, count } = await supabase
    .from("file_permissions")
    .select("*", { count: "exact" })
    .limit(1000);

  if (error) {
    console.error(`❌ Could not read file_permissions: ${error.message}`);
    console.error(
      "\nIf this is a 'relation does not exist' error, the table may live in a\n" +
        "different Supabase project (e.g. boende: SUPABASE_URL_BOENDE)."
    );
    process.exit(1);
  }

  console.log(`✅ Table readable. Total rows: ${count ?? rows?.length ?? 0}\n`);

  if (!rows || rows.length === 0) {
    console.warn("⚠️  Table is empty — no permission rows to inspect.");
    return;
  }

  // 2. Discover the schema from the first row.
  const cols = Object.keys(rows[0]);
  console.log(`Columns (${cols.length}): ${cols.join(", ")}\n`);

  const userKey = pick(cols, USER_KEYS);
  const fileKey = pick(cols, FILE_KEYS);
  const permKey = pick(cols, PERM_KEYS.filter((k) => k !== userKey));

  console.log("Detected mapping:");
  console.log(`  user column       → ${userKey ?? "(none recognized)"}`);
  console.log(`  file column       → ${fileKey ?? "(none recognized)"}`);
  console.log(`  permission column → ${permKey ?? "(none recognized)"}\n`);

  // 3. Best-effort resolve file references to human-readable names + type.
  const fileInfoById = new Map<string, { name: string; isDir: boolean }>();
  if (fileKey && rows.some((r) => looksLikeUuid(r[fileKey]))) {
    const ids = [...new Set(rows.map((r) => r[fileKey]).filter(looksLikeUuid))];
    const { data: files, error: fErr } = await supabase
      .from("files")
      .select("id, name, storage_path, is_directory")
      .in("id", ids);
    if (fErr) {
      console.warn(`(could not resolve file names: ${fErr.message})\n`);
    } else {
      for (const f of files ?? []) {
        fileInfoById.set(f.id, {
          name: f.name ?? f.storage_path ?? f.id,
          isDir: !!f.is_directory,
        });
      }
    }
  }

  const resolveFile = (v: unknown): string => {
    if (typeof v === "string" && fileInfoById.has(v)) {
      const info = fileInfoById.get(v)!;
      return `${info.isDir ? "[DIR] " : ""}${info.name}`;
    }
    return `${String(v)} (unresolved)`;
  };

  // 4. Sample rows (raw).
  console.log("── Sample rows (up to 15) ──");
  for (const r of rows.slice(0, 15)) {
    const u = userKey ? r[userKey] : "?";
    const f = fileKey ? resolveFile(r[fileKey]) : "?";
    const p = permKey ? ` [${r[permKey]}]` : "";
    console.log(`  ${u}  →  ${f}${p}`);
  }
  console.log("");

  // 5. Per-user summary.
  if (userKey && fileKey) {
    const byUser = new Map<string, Set<string>>();
    for (const r of rows) {
      const u = String(r[userKey]);
      if (!byUser.has(u)) byUser.set(u, new Set());
      byUser.get(u)!.add(resolveFile(r[fileKey]));
    }

    console.log(`── Per-user file counts (${byUser.size} user(s)) ──`);
    for (const [u, files] of [...byUser.entries()].sort((a, b) => b[1].size - a[1].size)) {
      console.log(`  ${u} → ${files.size} file(s)`);
      for (const f of [...files].slice(0, 10)) console.log(`       • ${f}`);
      if (files.size > 10) console.log(`       … and ${files.size - 10} more`);
    }
    console.log("");
  }

  // 6. access_level distribution.
  if (permKey) {
    const levels = new Map<string, number>();
    for (const r of rows) {
      const v = String(r[permKey]);
      levels.set(v, (levels.get(v) ?? 0) + 1);
    }
    console.log("── access_level distribution ──");
    for (const [v, n] of levels) console.log(`  ${v}: ${n} row(s)`);
    console.log("");
  }

  // 7. Folder-vs-file breakdown of the references (explains any count mismatch).
  if (fileKey && fileInfoById.size > 0) {
    const refIds = [...new Set(rows.map((r) => String(r[fileKey])))];
    let dirs = 0,
      files = 0,
      unresolved = 0;
    for (const id of refIds) {
      const info = fileInfoById.get(id);
      if (!info) unresolved++;
      else if (info.isDir) dirs++;
      else files++;
    }
    console.log("── Reference types ──");
    console.log(`  folders : ${dirs}`);
    console.log(`  files   : ${files}`);
    console.log(`  unresolved (id not in files table): ${unresolved}\n`);
  }

  // 8. Coverage cross-check against the files table.
  const { count: totalFiles } = await supabase
    .from("files")
    .select("*", { count: "exact", head: true })
    .eq("is_directory", false);
  const { count: totalDirs } = await supabase
    .from("files")
    .select("*", { count: "exact", head: true })
    .eq("is_directory", true);
  if (typeof totalFiles === "number") {
    const granted = fileKey
      ? new Set(rows.map((r) => String(r[fileKey]))).size
      : 0;
    console.log(
      `Library: ${totalFiles} file(s) + ${totalDirs ?? "?"} folder(s) | ` +
        `distinct entries referenced in permissions: ${granted}`
    );
  }
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err.message ?? err);
  process.exit(1);
});
