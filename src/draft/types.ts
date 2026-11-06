import type { Document } from "@langchain/core/documents";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Per-company document search (each company has its own Pinecone index). */
export interface DraftDocSearch {
  retrieve: (query: string, allowedSources: string[]) => Promise<Document[]>;
  formatContext: (docs: Document[]) => string;
}

export interface EditDecision {
  editId: string;
  status: "accepted" | "rejected";
  /** Optional echo of the edit, so the model knows what it decided on. */
  reason?: string;
  newText?: string;
}

/** "review" = check the document against current law, then suggest fixes. */
export type DraftMode = "draft" | "review";

/** Read-only reference file sent with a turn. Never edited by the model. */
export interface Attachment {
  name: string;
  content: string;
}

export interface DraftTurnInput {
  mode: DraftMode;
  message: string;
  attachments: Attachment[];
  history: ChatMessage[];
  document: string;
  lastSeenDocument?: string;
  editDecisions: EditDecision[];
}

interface EditCommon {
  editId: string;
  newText: string;
  reason: string;
  /** URLs and legal references the edit relies on. */
  sources: string[];
}

export type DraftEdit =
  | (EditCommon & {
      type: "replace";
      oldText: string;
    })
  | (EditCommon & {
      type: "insert_after_heading";
      heading: string;
    })
  | (EditCommon & {
      type: "append";
    });

export interface DraftSource {
  kind: "internal" | "web" | "law";
  title: string;
  url?: string;
  file?: string;
  reference?: string;
}

/** Events streamed to the client over SSE. */
export type DraftEvent =
  | { event: "status"; data: { message: string } }
  | { event: "text"; data: { delta: string } }
  | { event: "edit"; data: DraftEdit }
  | { event: "source"; data: DraftSource }
  | { event: "done"; data: Record<string, never> }
  | { event: "error"; data: { message: string } };

export type Emit = (e: DraftEvent) => void;
