import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { readFile } from "fs/promises";
import {
  downloadDocxFiles,
  cleanupTmpDir,
  type SupabaseConfig,
} from "./supabase.js";
import { chunkDocument } from "./chunking.js";
import { extractMetadataFromPath } from "./metadata.js";

interface ReindexOptions {
  directoryId?: string;
  pineconeIndexName: string;
  /** Optional Supabase connection; defaults to the global env-var client when omitted */
  supabase?: SupabaseConfig;
  /** Called after successful reindex so callers can reset cached vector stores */
  onComplete?: () => void;
}

interface ReindexResult {
  filesProcessed: number;
  chunksIndexed: number;
}

// Simple lock to prevent concurrent reindex on the same Pinecone index
const activeJobs = new Set<string>();

export async function reindex(options: ReindexOptions): Promise<ReindexResult> {
  const { directoryId, pineconeIndexName, supabase, onComplete } = options;

  if (activeJobs.has(pineconeIndexName)) {
    throw new Error(
      `Reindex already in progress for index "${pineconeIndexName}"`
    );
  }

  activeJobs.add(pineconeIndexName);

  // 1. Download files from Supabase (DB query + Storage download)
  console.log(
    `Downloading .docx files (directory: ${directoryId ?? "ALL"})...`
  );
  const { tmpDir, files } = await downloadDocxFiles(directoryId, supabase);

  if (files.length === 0) {
    activeJobs.delete(pineconeIndexName);
    await cleanupTmpDir(tmpDir);
    throw new Error("No .docx files found in Supabase");
  }

  console.log(`Downloaded ${files.length} file(s)`);

  try {
    // 2. Load and chunk documents using structure-aware pipeline
    const allChunks = [];
    for (const file of files) {
      const metadata = extractMetadataFromPath(file.folderPath, file.fileName);
      const buffer = await readFile(file.localPath);
      const chunks = await chunkDocument(buffer, metadata);

      allChunks.push(...chunks);
      console.log(
        `Loaded: ${file.relativePath} → ${chunks.length} chunk(s)`
      );
    }

    console.log(`Total chunks: ${allChunks.length}`);

    // 3. Clear existing vectors from Pinecone
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    const index = pinecone.Index(pineconeIndexName);

    console.log(
      `Deleting all vectors from Pinecone index "${pineconeIndexName}"...`
    );
    try {
      await index.namespace("").deleteAll();
    } catch (err: any) {
      // Pinecone serverless returns 404 when the default namespace has no
      // vectors yet (nothing to delete) — treat as a no-op and continue.
      const status = err?.status ?? err?.statusCode;
      const msg = String(err?.message ?? err);
      if (status === 404 || msg.includes("404") || /not found/i.test(msg)) {
        console.log(
          `Index "${pineconeIndexName}" has no existing vectors to delete — continuing.`
        );
      } else {
        throw err;
      }
    }

    // 4. Embed and upsert new vectors
    const embeddings = new OpenAIEmbeddings({
      model: "text-embedding-3-large",
      dimensions: 1536,
      apiKey: process.env.OPENAI_API_KEY!,
    });

    console.log("Upserting chunks into Pinecone...");
    await PineconeStore.fromDocuments(allChunks, embeddings, {
      pineconeIndex: index,
    });

    console.log("Reindex complete!");
    onComplete?.();

    return {
      filesProcessed: files.length,
      chunksIndexed: allChunks.length,
    };
  } finally {
    activeJobs.delete(pineconeIndexName);
    await cleanupTmpDir(tmpDir);
  }
}
