import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

async function debug() {
  // 1. Try to query the files table
  console.log("--- Querying public.files ---");
  const { data, error, count } = await supabase
    .from("files")
    .select("*", { count: "exact" })
    .limit(10);

  if (error) {
    console.error("Query error:", error);
    return;
  }

  console.log(`Total rows returned: ${data?.length}, count: ${count}`);

  if (data && data.length > 0) {
    console.log("\nFirst row columns:", Object.keys(data[0]));
    console.log("\nFirst 10 rows:");
    for (const row of data) {
      console.log({
        id: row.id,
        name: row.name,
        is_directory: row.is_directory,
        mime_type: row.mime_type,
        storage_path: row.storage_path,
        parent_id: row.parent_id,
      });
    }
  } else {
    console.log("No rows found in files table.");
  }

  // 2. Check for non-directory files specifically
  console.log("\n--- Querying non-directory files ---");
  const { data: files, error: filesError } = await supabase
    .from("files")
    .select("*")
    .eq("is_directory", false)
    .limit(10);

  if (filesError) {
    console.error("Files query error:", filesError);
    return;
  }

  console.log(`Non-directory files: ${files?.length}`);
  if (files && files.length > 0) {
    for (const f of files) {
      console.log(`  ${f.name} | mime: ${f.mime_type} | path: ${f.storage_path}`);
    }
  }
}

debug().catch(console.error);
