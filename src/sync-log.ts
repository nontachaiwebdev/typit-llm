import { resolveClient, type SupabaseConfig } from "./supabase.js";

// Writes one row per sync run to public.sync_logs (migration lives in
// oc-ai-chat/supabase/migrations/20261112000001_create_sync_logs_table.sql).
// Logging is best-effort: any failure is warned about and swallowed so it
// never breaks the sync itself.

export type SyncTarget = "ledningssystem" | "boende";
export type SyncTrigger = "cli" | "api";

export interface SyncFileDetail {
  file_id: string;
  name: string;
  status: "indexed" | "download_failed";
  chunks?: number;
  error?: string;
}

interface StartParams {
  target: SyncTarget;
  trigger: SyncTrigger;
  directoryId?: string;
  pineconeIndex: string;
}

interface FinishParams {
  status: "success" | "failed";
  filesFound?: number;
  filesDownloaded?: number;
  filesFailed?: number;
  chunksIndexed?: number;
  details: SyncFileDetail[];
  errorMessage?: string;
}

/** Insert a `running` row. Returns its id, or undefined if logging failed. */
export async function startSyncLog(
  config: SupabaseConfig | undefined,
  params: StartParams
): Promise<string | undefined> {
  try {
    const { client } = resolveClient(config);
    const { data, error } = await client
      .from("sync_logs")
      .insert({
        target: params.target,
        trigger: params.trigger,
        directory_id: params.directoryId ?? null,
        pinecone_index: params.pineconeIndex,
        status: "running",
      })
      .select("id")
      .single();

    if (error) throw error;
    return data.id as string;
  } catch (err: any) {
    console.warn("⚠️  Could not write sync log (start):", err?.message ?? err);
    return undefined;
  }
}

/** Mark the run as finished. No-op if the start row was never written. */
export async function finishSyncLog(
  config: SupabaseConfig | undefined,
  logId: string | undefined,
  params: FinishParams
): Promise<void> {
  if (!logId) return;
  try {
    const { client } = resolveClient(config);
    const { error } = await client
      .from("sync_logs")
      .update({
        status: params.status,
        files_found: params.filesFound ?? null,
        files_downloaded: params.filesDownloaded ?? null,
        files_failed: params.filesFailed ?? null,
        chunks_indexed: params.chunksIndexed ?? null,
        details: params.details,
        error_message: params.errorMessage ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", logId);

    if (error) throw error;
  } catch (err: any) {
    console.warn("⚠️  Could not write sync log (finish):", err?.message ?? err);
  }
}
