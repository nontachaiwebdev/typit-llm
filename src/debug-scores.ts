import "dotenv/config";
import { PineconeStore } from "@langchain/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Pinecone } from "@pinecone-database/pinecone";

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const index = pinecone.Index(process.env.PINECONE_INDEX!);
const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small", apiKey: process.env.OPENAI_API_KEY! });
const vectorStore = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex: index });

const questions = [
  "Hur ska man agera vid en akut psykiatrisk situation?",
  "Vad gör man om en kollega verkar påverkad av alkohol eller droger?",
  "Vad är arbetsmiljöpolicyn?",
  "Hej!",
  "What is the weather today?",
  "Tell me a joke",
];

for (const q of questions) {
  const results = await vectorStore.similaritySearchWithScore(q, 3);
  console.log("Q:", q);
  results.forEach(([doc, score]) =>
    console.log("  score:", score.toFixed(4), "| source:", doc.metadata?.source)
  );
  console.log("");
}
