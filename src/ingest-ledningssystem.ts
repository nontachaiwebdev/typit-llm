import "dotenv/config";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { readdir, stat } from "fs/promises";
import { join } from "path";

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

  const allDocuments = [];
  for (const filePath of docxFiles) {
    const loader = new DocxLoader(filePath);
    const docs = await loader.load();
    const fileName = filePath.replace(DATA_DIR + "/", "");
    docs.forEach((doc) => {
      doc.metadata.source = fileName;
    });
    allDocuments.push(...docs);
    console.log(`Loaded: ${fileName} (${docs.length} page(s))`);
  }

  console.log(`Total documents loaded: ${allDocuments.length}`);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const chunks = await splitter.splitDocuments(allDocuments);
  const nonEmptyChunks = chunks.filter((c) => c.pageContent.trim().length > 0);
  console.log(`Total chunks after splitting: ${chunks.length} (non-empty: ${nonEmptyChunks.length})`);

  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
  });
  const index = pinecone.Index(process.env.PINECONE_INDEX_LEDNINGSSYSTEM!);

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
