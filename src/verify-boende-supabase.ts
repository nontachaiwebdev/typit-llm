import "dotenv/config";
import { downloadDocxFiles, cleanupTmpDir } from "./supabase.js";

// Read-only check of boende's Supabase: queries the files table, reconstructs
// folder paths, and downloads every .docx to a temp dir to confirm Storage
// access — then cleans up. Touches NEITHER Pinecone NOR the source data.
async function main() {
  const config = {
    url: process.env.SUPABASE_URL_BOENDE!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY_BOENDE!,
    bucket: process.env.SUPABASE_BUCKET_BOENDE,
  };

  if (!config.url || !config.serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_URL_BOENDE or SUPABASE_SERVICE_ROLE_KEY_BOENDE in .env"
    );
  }

  console.log(`Boende Supabase : ${config.url}`);
  console.log(`Storage bucket  : ${config.bucket ?? "knowledge-base (default)"}`);
  console.log("Querying files table + downloading from Storage...\n");

  const { tmpDir, files } = await downloadDocxFiles(undefined, config);

  console.log(`\n✅ Found and downloaded ${files.length} .docx file(s):\n`);
  for (const f of files) {
    const path = [...f.folderPath, f.fileName].join("/");
    console.log(`  • ${path}`);
  }

  await cleanupTmpDir(tmpDir);
  console.log("\nTemp files cleaned up. Verification complete.");

  if (files.length === 0) {
    console.warn(
      "\n⚠️  No .docx files found — /boende/reindex would fail with 'No .docx files found in Supabase'."
    );
  }
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err.message ?? err);
  process.exit(1);
});
