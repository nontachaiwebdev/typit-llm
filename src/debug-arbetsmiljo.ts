import "dotenv/config";
import { PineconeStore } from "@langchain/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Pinecone } from "@pinecone-database/pinecone";

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const index = pinecone.Index(process.env.PINECONE_INDEX_LEDNINGSSYSTEM!);
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
  apiKey: process.env.OPENAI_API_KEY!,
});
const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
  pineconeIndex: index,
});

const question = "Vad innehåller i arbetsmiljö policy";
const results = await vectorStore.similaritySearchWithScore(question, 5);

console.log("=== FULL CONTEXT SENT TO LLM ===\n");
const context = results
  .filter(([, s]) => s >= 0.5)
  .map(([d]) => d.pageContent)
  .join("\n\n");
console.log(context);
console.log("\n=== END CONTEXT ===");
console.log(`\nContext length: ${context.length} chars`);
