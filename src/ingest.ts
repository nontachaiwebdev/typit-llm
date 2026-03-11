import "dotenv/config";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { readdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = "./data";

async function ingest() {
  // 1. Load all .docx files from /data
  const files = await readdir(DATA_DIR);
  const docxFiles = files.filter((f) => f.endsWith(".docx"));

  console.log(`Found ${docxFiles.length} .docx files`);

  const allDocuments = [];
  for (const file of docxFiles) {
    const filePath = join(DATA_DIR, file);
    const loader = new DocxLoader(filePath);
    const docs = await loader.load();
    // Tag each doc with its source filename
    docs.forEach((doc) => {
      doc.metadata.source = file;
    });
    allDocuments.push(...docs);
    console.log(`Loaded: ${file} (${docs.length} page(s))`);
  }

  console.log(`Total documents loaded: ${allDocuments.length}`);

  // 2. Split into chunks
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const chunks = await splitter.splitDocuments(allDocuments);
  const nonEmptyChunks = chunks.filter((c) => c.pageContent.trim().length > 0);
  console.log(`Total chunks after splitting: ${chunks.length} (non-empty: ${nonEmptyChunks.length})`);

  // 3. Connect to Pinecone
  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
  });
  const index = pinecone.Index(process.env.PINECONE_INDEX!);

  // 4. Embed and upsert into Pinecone
  const embeddings = new OpenAIEmbeddings({
    model: "text-embedding-3-small",
    apiKey: process.env.OPENAI_API_KEY!,
  });

  console.log("Upserting chunks into Pinecone...");
  await PineconeStore.fromDocuments(nonEmptyChunks, embeddings, {
    pineconeIndex: index,
  });

  console.log("Ingestion complete!");
}

ingest().catch(console.error);
