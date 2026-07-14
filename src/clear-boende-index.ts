import "dotenv/config";
import { Pinecone } from "@pinecone-database/pinecone";

// One-time cleanup: wipe all vectors from the boende Pinecone index so it starts
// clean before the first `npm run ingest:boende`. Delete this file after running.
async function main() {
  const indexName = process.env.PINECONE_INDEX_BOENDE!;
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  await pc.Index(indexName).namespace("").deleteAll();
  console.log(`Cleared all vectors from Pinecone index "${indexName}"`);
}

main().catch(console.error);
