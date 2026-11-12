import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { readFile } from "fs/promises";
import {
  downloadDocxFiles,
  cleanupTmpDir,
  type SupabaseConfig,
} from "./supabase.js";
import {
  startSyncLog,
  finishSyncLog,
  type SyncFileDetail,
  type SyncTarget,
  type SyncTrigger,
} from "./sync-log.js";
import { chunkDocument } from "./chunking.js";
import { extractMetadataFromPath } from "./metadata.js";

interface ReindexOptions {
  /** Knowledge base being synced (recorded in public.sync_logs) */
  target: SyncTarget;
  /** What started the sync (recorded in public.sync_logs) */
  trigger: SyncTrigger;
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
  const { target, trigger, directoryId, pineconeIndexName, supabase, onComplete } =
    options;

  if (activeJobs.has(pineconeIndexName)) {
    throw new Error(
      `Reindex already in progress for index "${pineconeIndexName}"`
    );
  }

  activeJobs.add(pineconeIndexName);

  const logId = await startSyncLog(supabase, {
    target,
    trigger,
    directoryId,
    pineconeIndex: pineconeIndexName,
  });

  let tmpDir: string | undefined;
  const details: SyncFileDetail[] = [];
  let filesFound: number | undefined;
  let filesDownloaded: number | undefined;
  let filesFailed: number | undefined;
  let chunksIndexed: number | undefined;

  try {
    // 1. Download files from Supabase (DB query + Storage download)
    console.log(
      `Downloading .docx files (directory: ${directoryId ?? "ALL"})...`
    );
    const download = await downloadDocxFiles(directoryId, supabase);
    tmpDir = download.tmpDir;
    const { files, failed } = download;

    filesDownloaded = files.length;
    filesFailed = failed.length;
    filesFound = files.length + failed.length;
    for (const f of failed) {
      details.push({ file_id: f.fileId, name: f.name, status: "download_failed", error: f.error });
    }

    if (files.length === 0) {
      throw new Error("No .docx files found in Supabase");
    }

    console.log(`Downloaded ${files.length} file(s)`);

    // 2. Load and chunk documents using structure-aware pipeline
    const allChunks = [];
    for (const file of files) {
      const metadata = extractMetadataFromPath(file.folderPath, file.fileName);
      const buffer = await readFile(file.localPath);
      const chunks = await chunkDocument(buffer, metadata);

      allChunks.push(...chunks);
      details.push({
        file_id: file.fileId,
        name: file.fileName,
        status: "indexed",
        chunks: chunks.length,
      });
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
    chunksIndexed = allChunks.length;
    onComplete?.();
    await finishSyncLog(supabase, logId, {
      status: "success",
      filesFound,
      filesDownloaded,
      filesFailed,
      chunksIndexed,
      details,
    });

    return {
      filesProcessed: files.length,
      chunksIndexed: allChunks.length,
    };
  } catch (err: any) {
    await finishSyncLog(supabase, logId, {
      status: "failed",
      filesFound,
      filesDownloaded,
      filesFailed,
      chunksIndexed,
      details,
      errorMessage: String(err?.message ?? err),
    });
    throw err;
  } finally {
    activeJobs.delete(pineconeIndexName);
    if (tmpDir) await cleanupTmpDir(tmpDir);
  }
}
