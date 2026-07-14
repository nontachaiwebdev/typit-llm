import "dotenv/config";
import { reindex } from "./reindex.js";
import { resetVectorStore } from "./chain-boende.js";

// CLI reindex for boende: downloads .docx from boende's Supabase, clears the
// boende Pinecone index, and re-embeds everything. Same operation as the
// POST /boende/reindex endpoint, runnable without the server.
async function main() {
  const result = await reindex({
    pineconeIndexName: process.env.PINECONE_INDEX_BOENDE!,
    supabase: {
      url: process.env.SUPABASE_URL_BOENDE!,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY_BOENDE!,
      bucket: process.env.SUPABASE_BUCKET_BOENDE,
    },
    onComplete: resetVectorStore,
  });

  console.log("\n✅ Reindex complete:", result);
}

main().catch((err) => {
  console.error("\n❌ Reindex failed:", err.message ?? err);
  process.exit(1);
});
