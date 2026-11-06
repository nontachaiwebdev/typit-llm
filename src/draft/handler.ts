import type { Request, Response } from "express";
import { resolveAllowedSources, type PermissionConfig } from "../permissions.js";
import { runDraftTurn } from "./agent.js";
import type {
  Attachment,
  ChatMessage,
  DraftDocSearch,
  DraftEvent,
  DraftTurnInput,
  EditDecision,
} from "./types.js";

const MAX_DOC_CHARS = Number(process.env.DRAFT_MAX_DOC_CHARS) || 100_000;
const MAX_ATTACHMENT_CHARS = Number(process.env.DRAFT_MAX_ATTACHMENT_CHARS) || 100_000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_NAME = 200;

/** Validate and normalise the request body, or return an error. */
function parseBody(body: any): DraftTurnInput | { error: string; status: number } {
  const { mode, message, attachments, history, document, lastSeenDocument, editDecisions } =
    body ?? {};
  if (mode !== undefined && mode !== null && mode !== "draft" && mode !== "review") {
    return { error: 'mode must be "draft" or "review"', status: 400 };
  }
  if (typeof message !== "string" || !message.trim()) {
    return { error: "message is required", status: 400 };
  }

  const files: Attachment[] = [];
  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments)) {
      return { error: "attachments must be an array", status: 400 };
    }
    if (attachments.length > MAX_ATTACHMENTS) {
      return { error: `at most ${MAX_ATTACHMENTS} attachments are allowed`, status: 400 };
    }
    for (const a of attachments) {
      if (typeof a?.name !== "string" || typeof a?.content !== "string") {
        return { error: "each attachment needs a string name and content", status: 400 };
      }
      // The name goes into a tag attribute in the prompt, so keep it tame.
      const name = a.name.replace(/["<>]/g, "").trim().slice(0, MAX_ATTACHMENT_NAME) || "bilaga";
      files.push({ name, content: a.content });
    }
    const total = files.reduce((n, f) => n + f.content.length, 0);
    if (total > MAX_ATTACHMENT_CHARS) {
      return { error: `attachments exceed ${MAX_ATTACHMENT_CHARS} characters in total`, status: 413 };
    }
  }
  if (typeof document !== "string") {
    return { error: "document is required (may be an empty string)", status: 400 };
  }
  if (lastSeenDocument !== undefined && lastSeenDocument !== null && typeof lastSeenDocument !== "string") {
    return { error: "lastSeenDocument must be a string", status: 400 };
  }
  if (document.length > MAX_DOC_CHARS || (lastSeenDocument?.length ?? 0) > MAX_DOC_CHARS) {
    return { error: `document exceeds ${MAX_DOC_CHARS} characters`, status: 413 };
  }
  const hist: ChatMessage[] = Array.isArray(history)
    ? history.filter(
        (m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string"
      )
    : [];
  const decisions: EditDecision[] = Array.isArray(editDecisions)
    ? editDecisions
        .filter(
          (d: any) =>
            typeof d?.editId === "string" && (d.status === "accepted" || d.status === "rejected")
        )
        .map((d: any) => ({
          editId: d.editId,
          status: d.status,
          reason: typeof d.reason === "string" ? d.reason : undefined,
          newText: typeof d.newText === "string" ? d.newText : undefined,
        }))
    : [];
  return {
    mode: mode === "review" ? "review" : "draft",
    message,
    attachments: files,
    history: hist,
    document,
    lastSeenDocument: lastSeenDocument ?? undefined,
    editDecisions: decisions,
  };
}

/**
 * Stateless drafting chat turn, streamed as Server-Sent Events. Saving the
 * turn is the caller's job (oc-ai-chat's manage-drafts function). Mount behind
 * requireApiKey + the company's requireUser (sets req.userId).
 */
export function createDraftChatHandler(cfg: PermissionConfig, docSearch: DraftDocSearch) {
  return async (req: Request, res: Response) => {
    const input = parseBody(req.body);
    if ("error" in input) {
      res.status(input.status).json({ error: input.error });
      return;
    }

    let allowedSources: string[];
    try {
      allowedSources = await resolveAllowedSources(req.userId!, cfg);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx)
    res.flushHeaders();

    // Stop the model (and stop paying for tokens) if the client disconnects.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const emit = (e: DraftEvent) => {
      if (res.writableEnded || abort.signal.aborted) return;
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };

    try {
      await runDraftTurn(input, allowedSources, emit, abort.signal, docSearch);
      emit({ event: "done", data: {} });
    } catch (err) {
      if (abort.signal.aborted) {
        console.log("draft chat: client disconnected, aborted");
      } else {
        console.error(err);
        emit({ event: "error", data: { message: "Något gick fel. Försök igen." } });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  };
}
