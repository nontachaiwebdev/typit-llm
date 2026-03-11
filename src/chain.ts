import "dotenv/config";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { Document } from "@langchain/core/documents";

const SCORE_THRESHOLD = 0.50;

let vectorStore: PineconeStore | null = null;
let llm: ChatOpenAI | null = null;

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a helpful assistant. Answer the user's question based only on the provided context.
If the answer is not in the context, say you don't know.
Respond in the same language as the question.

Context:
{context}`,
  ],
  ["human", "{input}"],
]);

async function init() {
  if (vectorStore) return;

  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  const index = pinecone.Index(process.env.PINECONE_INDEX!);

  const embeddings = new OpenAIEmbeddings({
    model: "text-embedding-3-small",
    apiKey: process.env.OPENAI_API_KEY!,
  });

  vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex: index,
  });

  llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY!,
    temperature: 0,
  });
}

export interface QueryResult {
  answer: string;
  sources: string[];
}

export async function query(question: string): Promise<QueryResult> {
  await init();

  // Search with scores and filter by threshold
  const resultsWithScore = await vectorStore!.similaritySearchWithScore(question, 5);
  const relevantDocs = resultsWithScore
    .filter(([, score]) => score >= SCORE_THRESHOLD)
    .map(([doc]) => doc as Document);

  // No relevant documents — don't fabricate sources
  if (relevantDocs.length === 0) {
    return {
      answer: "I don't have information about that in the documents.",
      sources: [],
    };
  }

  const context = relevantDocs.map((d) => d.pageContent).join("\n\n");
  const chain = prompt.pipe(llm!);
  const response = await chain.invoke({ context, input: question });

  const sources: string[] = [
    ...new Set(
      relevantDocs
        .map((doc) => doc.metadata?.source)
        .filter(Boolean) as string[]
    ),
  ];

  return { answer: response.content as string, sources };
}
