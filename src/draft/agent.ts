import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { buildSystemPrompt, buildTurnContext } from "./prompt.js";
import { buildDraftTools } from "./tools.js";
import type { DraftDocSearch, DraftTurnInput, Emit } from "./types.js";

const MAX_ITERATIONS = 8;
const HISTORY_TURNS = 10;

let model: ChatAnthropic | null = null;

function getModel(): ChatAnthropic {
  if (!model) {
    model = new ChatAnthropic({
      model: process.env.DRAFT_MODEL || "claude-sonnet-5-5",
      apiKey: process.env.ANTHROPIC_API_KEY!,
      maxTokens: 8192,
      // Newer Claude models reject {type: "disabled"} (LangChain's default) and
      // expect "between_tools": no upfront thinking, only short notes between
      // tool calls. Not yet in the installed SDK's types, hence the cast.
      thinking: { type: "between_tools" } as any,
    });
  }
  return model;
}

type Block = Record<string, any>;

/**
 * Run one chat turn: stream the model's reply, execute its tool calls, and
 * loop until it stops asking for tools. Everything the UI needs is sent
 * through `emit`; the caller sends `done`/`error`.
 */
export async function runDraftTurn(
  input: DraftTurnInput,
  allowedSources: string[],
  emit: Emit,
  signal: AbortSignal,
  docSearch: DraftDocSearch
): Promise<void> {
  // De-duplicate source events across the whole turn.
  const seenSources = new Set<string>();
  const turnEmit: Emit = (e) => {
    if (e.event === "source") {
      const key = `${e.data.kind}|${e.data.url ?? e.data.file ?? e.data.title}`;
      if (seenSources.has(key)) return;
      seenSources.add(key);
    }
    emit(e);
  };

  const state: StreamState = { webResults: new Map(), hasText: false, breakPending: false };

  const { customTools, serverTools } = buildDraftTools({
    document: input.document,
    allowedSources,
    emit: turnEmit,
    webResults: state.webResults,
    docSearch,
  });
  const toolsByName = new Map<string, (typeof customTools)[number]>(
    customTools.map((t) => [t.name, t])
  );
  const llm = getModel().bindTools([...customTools, ...serverTools]);

  const today = new Date().toISOString().slice(0, 10);
  const messages: BaseMessage[] = [
    new SystemMessage(buildSystemPrompt(today)),
    ...input.history
      .slice(-HISTORY_TURNS)
      .map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content))),
    new HumanMessage(buildTurnContext(input)),
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) return;

    let full: AIMessageChunk | undefined;
    state.breakPending = true;
    const stream = await llm.stream(messages, { signal });

    for await (const chunk of stream) {
      full = full ? full.concat(chunk) : chunk;
      if (!Array.isArray(chunk.content)) {
        if (chunk.content) turnEmit({ event: "text", data: { delta: chunk.content } });
        continue;
      }
      for (const block of chunk.content as Block[]) {
        handleStreamBlock(block, state, turnEmit);
      }
    }

    if (!full) break;
    messages.push(full);

    const stopReason =
      (full.additional_kwargs as Block)?.stop_reason ??
      (full.response_metadata as Block)?.stop_reason;

    // A long server-side web search can pause the turn; send the partial
    // assistant message back unchanged and the model continues where it was.
    if (stopReason === "pause_turn") continue;

    const toolCalls = full.tool_calls ?? [];
    if (toolCalls.length === 0) return;

    for (const call of toolCalls) {
      const t = toolsByName.get(call.name);
      let content: string;
      if (!t) {
        content = `Okänt verktyg: ${call.name}`;
      } else {
        try {
          const out = await (t as any).invoke(call.args);
          content = typeof out === "string" ? out : JSON.stringify(out);
        } catch (err: any) {
          console.error(`draft tool ${call.name} failed:`, err);
          content = `Verktyget misslyckades: ${err?.message ?? "okänt fel"}`;
        }
      }
      messages.push(new ToolMessage({ tool_call_id: call.id!, content }));
    }
  }

  turnEmit({
    event: "text",
    data: { delta: "\n\n(Avbröt efter för många steg. Försök gärna dela upp frågan.)" },
  });
}

interface StreamState {
  /** url → title for every web search result seen this turn. */
  webResults: Map<string, string>;
  hasText: boolean;
  /** A tool call (or new model step) happened since the last text. */
  breakPending: boolean;
}

/** Translate one streamed Anthropic content block into UI events. */
function handleStreamBlock(block: Block, state: StreamState, emit: Emit) {
  // Cited sentences arrive as several adjacent text blocks and must be joined
  // as-is, but text before and after a tool call should be separate paragraphs.
  if (block.type !== "text") state.breakPending = true;

  switch (block.type) {
    case "text": {
      if (block.text) {
        const sep = state.hasText && state.breakPending ? "\n\n" : "";
        state.breakPending = false;
        state.hasText = true;
        emit({ event: "text", data: { delta: sep + block.text } });
      }
      for (const c of (block.citations ?? []) as Block[]) {
        if (c.type === "web_search_result_location" && c.url) {
          emit({ event: "source", data: { kind: "web", title: c.title || c.url, url: c.url } });
        }
      }
      break;
    }
    case "server_tool_use": {
      if (block.name === "web_search") {
        emit({ event: "status", data: { message: "Söker på webben…" } });
      }
      break;
    }
    case "web_search_tool_result": {
      const content = block.content;
      if (!Array.isArray(content)) {
        console.warn("web search error:", content?.error_code);
        emit({ event: "status", data: { message: "Webbsökningen misslyckades." } });
        break;
      }
      for (const r of content as Block[]) {
        if (r.url) state.webResults.set(r.url, r.title || r.url);
      }
      const hosts = [...new Set(content.map((r: Block) => safeHost(r.url)).filter(Boolean))];
      emit({
        event: "status",
        data: { message: `Hittade ${content.length} träffar${hosts.length ? ` (${hosts.join(", ")})` : ""}` },
      });
      break;
    }
  }
}

export function safeHost(url?: string): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}
