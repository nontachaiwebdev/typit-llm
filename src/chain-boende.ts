import "dotenv/config";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { Document } from "@langchain/core/documents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createChatModel } from "./llm.js";

let vectorStore: PineconeStore | null = null;
let llm: BaseChatModel | null = null;

const SYSTEM_PROMPT = `Du är en expert på boende för omsorgsverksamhet (personlig assistans).
Du svarar på frågor baserat ENBART på de dokument som ges som kontext nedan.

Instruktioner:
- Svara alltid på svenska om inte frågan ställs på ett annat språk.
- Referera till specifika dokument och avsnitt i ditt svar (t.ex. "Enligt D - 5. Rutin för kost...").
- Om kontexten innehåller delvis information, ge det du kan och notera vad som saknas.
- Om informationen inte finns i kontexten alls, säg tydligt att du inte har den informationen.
- Var konkret och hänvisa till rutinnamn och dokumentnummer när möjligt.

Kontext:
{context}`;

async function init() {
  if (vectorStore) return;

  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  const index = pinecone.Index(process.env.PINECONE_INDEX_BOENDE!);

  const embeddings = new OpenAIEmbeddings({
    model: "text-embedding-3-large",
    dimensions: 1536,
    apiKey: process.env.OPENAI_API_KEY!,
  });

  vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex: index,
  });

  llm = createChatModel();
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface QueryResult {
  answer: string;
  sources: string[];
}

export function resetVectorStore() {
  vectorStore = null;
}

/**
 * Rewrite a user question into a formal Swedish search query
 * that matches the language used in policy documents.
 * Includes conversation history for resolving follow-up references.
 */
async function rewriteQuery(
  question: string,
  history: ChatMessage[]
): Promise<string> {
  const historyContext =
    history.length > 0
      ? `\nTidigare konversation:\n${history
          .slice(-4)
          .map((m) => `${m.role === "user" ? "Användare" : "Assistent"}: ${m.content}`)
          .join("\n")}\n`
      : "";

  const rewritePrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `Du är en sökassistent för dokument om boende inom omsorgsverksamhet.
Skriv om användarens fråga till en optimal sökfråga som matchar formellt svenskt fackspråk i policydokument.
${historyContext}
Regler:
- Behåll svenska termer och fackspråk
- Om frågan refererar till tidigare konversation (t.ex. "berätta mer", "det där"), lös referensen
- Expandera förkortningar
- Svara BARA med den omskrivna sökfrågan, inget annat`,
    ],
    ["human", "{question}"],
  ]);

  const chain = rewritePrompt.pipe(llm!);
  const result = await chain.invoke({ question });
  return (result.content as string).trim();
}

/**
 * Format retrieved documents into structured context with source labels.
 */
function formatContext(docs: Document[]): string {
  return docs
    .map((doc, i) => {
      const m = doc.metadata;
      const header = [m.docTitle, m.section].filter(Boolean).join(" > ");
      return `--- Dokument ${i + 1}: ${header || m.source || "okänd"} ---\n${doc.pageContent}`;
    })
    .join("\n\n");
}

export async function query(
  question: string,
  history: ChatMessage[] = []
): Promise<QueryResult> {
  await init();

  // Step 1: Rewrite query for better retrieval
  const rewrittenQuery = await rewriteQuery(question, history);

  // Step 2: Retrieve more candidates with dynamic threshold
  const resultsWithScore = await vectorStore!.similaritySearchWithScore(
    rewrittenQuery,
    15
  );

  // Dynamic threshold: keep results within a reasonable range of the best score
  const topScore = resultsWithScore[0]?.[1] ?? 0;
  const dynamicThreshold = Math.max(0.35, topScore - 0.15);

  const relevantDocs = resultsWithScore
    .filter(([, score]) => score >= dynamicThreshold)
    .slice(0, 8) // cap context size
    .map(([doc]) => doc as Document);

  if (relevantDocs.length === 0) {
    return {
      answer:
        "Jag har tyvärr inte den informationen i de tillgängliga dokumenten.",
      sources: [],
    };
  }

  // Step 3: Build prompt with conversation history
  const messages: Array<["system" | "human" | "ai", string]> = [
    ["system", SYSTEM_PROMPT],
  ];

  // Include last 5 turns of conversation history
  if (history.length > 0) {
    for (const msg of history.slice(-5)) {
      messages.push([msg.role === "user" ? "human" : "ai", msg.content]);
    }
  }

  messages.push(["human", "{input}"]);

  const prompt = ChatPromptTemplate.fromMessages(messages);
  const context = formatContext(relevantDocs);
  const chain = prompt.pipe(llm!);
  const response = await chain.invoke({ context, input: question });

  // Step 4: Extract rich source info
  const sources: string[] = [
    ...new Set(
      relevantDocs
        .map((doc) => doc.metadata?.source)
        .filter(Boolean) as string[]
    ),
  ];

  return { answer: response.content as string, sources };
}
