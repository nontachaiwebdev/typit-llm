import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export function createChatModel(): BaseChatModel {
  const provider = (process.env.LLM_PROVIDER ?? "openai").toLowerCase();

  if (provider === "anthropic") {
    return new ChatAnthropic({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      apiKey: process.env.ANTHROPIC_API_KEY!,
      temperature: 0,
    });
  }

  return new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY!,
    temperature: 0,
  });
}
