import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { downloadDocxFiles, cleanupTmpDir } from "./supabase.js";

interface ReindexOptions {
  directoryId?: string;
  pineconeIndexName: string;
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
  const { directoryId, pineconeIndexName, onComplete } = options;

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
  const { tmpDir, files } = await downloadDocxFiles(directoryId);

  if (files.length === 0) {
    activeJobs.delete(pineconeIndexName);
    await cleanupTmpDir(tmpDir);
    throw new Error("No .docx files found in Supabase");
  }

  console.log(`Downloaded ${files.length} file(s)`);

  try {
    // 2. Load documents
    const allDocuments = [];
    for (const file of files) {
      const loader = new DocxLoader(file.localPath);
      const docs = await loader.load();
      docs.forEach((doc) => {
        doc.metadata.source = file.relativePath;
      });
      allDocuments.push(...docs);
      console.log(`Loaded: ${file.relativePath} (${docs.length} page(s))`);
    }

    // 3. Split into chunks
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const chunks = await splitter.splitDocuments(allDocuments);
    const nonEmptyChunks = chunks.filter(
      (c) => c.pageContent.trim().length > 0
    );
    console.log(
      `Total chunks: ${chunks.length} (non-empty: ${nonEmptyChunks.length})`
    );

    // 4. Clear existing vectors from Pinecone
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    const index = pinecone.Index(pineconeIndexName);

    console.log(
      `Deleting all vectors from Pinecone index "${pineconeIndexName}"...`
    );
    await index.namespace("").deleteAll();

    // 5. Embed and upsert new vectors
    const embeddings = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
      apiKey: process.env.OPENAI_API_KEY!,
    });

    console.log("Upserting chunks into Pinecone...");
    await PineconeStore.fromDocuments(nonEmptyChunks, embeddings, {
      pineconeIndex: index,
    });

    console.log("Reindex complete!");
    onComplete?.();

    return {
      filesProcessed: files.length,
      chunksIndexed: nonEmptyChunks.length,
    };
  } finally {
    activeJobs.delete(pineconeIndexName);
    await cleanupTmpDir(tmpDir);
  }
}
