import "dotenv/config";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import { chunkDocument } from "./chunking.js";
import { extractMetadataFromPath } from "./metadata.js";

const DATA_DIR = "./data/Ledningssystem";

async function findDocxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      const nested = await findDocxFiles(fullPath);
      results.push(...nested);
    } else if (entry.endsWith(".docx")) {
      results.push(fullPath);
    }
  }

  return results;
}

async function ingest() {
  const docxFiles = await findDocxFiles(DATA_DIR);
  console.log(`Found ${docxFiles.length} .docx files`);

  const allChunks = [];
  for (const filePath of docxFiles) {
    // Extract path segments relative to DATA_DIR
    const relativePath = filePath.replace(DATA_DIR + "/", "");
    const parts = relativePath.split("/");
    const fileName = parts.pop()!;
    const pathSegments = parts; // folder hierarchy

    const metadata = extractMetadataFromPath(pathSegments, fileName);
    const buffer = await readFile(filePath);
    const chunks = await chunkDocument(buffer, metadata);

    allChunks.push(...chunks);
    console.log(
      `Loaded: ${relativePath} → ${chunks.length} chunk(s)`
    );
  }

  console.log(`Total chunks after splitting: ${allChunks.length}`);

  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
  });
  const index = pinecone.Index(process.env.PINECONE_INDEX_LEDNINGSSYSTEM!);

  const embeddings = new OpenAIEmbeddings({
    model: "text-embedding-3-large",
    dimensions: 1536,
    apiKey: process.env.OPENAI_API_KEY!,
  });

  console.log("Upserting chunks into Pinecone...");
  await PineconeStore.fromDocuments(allChunks, embeddings, {
    pineconeIndex: index,
  });

  console.log("Ingestion complete!");
}

ingest().catch(console.error);
