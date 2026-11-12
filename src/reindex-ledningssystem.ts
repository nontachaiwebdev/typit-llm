import "dotenv/config";
import { reindex } from "./reindex.js";

// CLI reindex for ledningssystem: downloads .docx from the default Supabase
// project (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET), clears
// the ledningssystem Pinecone index, and re-embeds everything. Same operation
// as the POST /ledningssystem/reindex endpoint, runnable without the server.
async function main() {
  const result = await reindex({
    target: "ledningssystem",
    trigger: "cli",
    pineconeIndexName: process.env.PINECONE_INDEX_LEDNINGSSYSTEM!,
  });

  console.log("\n✅ Reindex complete:", result);
}

main().catch((err) => {
  console.error("\n❌ Reindex failed:", err.message ?? err);
  process.exit(1);
});
