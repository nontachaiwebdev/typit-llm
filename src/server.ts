import "dotenv/config";
import express from "express";
import cors from "cors";
import { query } from "./chain.js";
import {
  query as queryLedningssystem,
  resetVectorStore as resetLedningssystemVectorStore,
  type ChatMessage,
} from "./chain-ledningssystem.js";
import { reindex } from "./reindex.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.LLM_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.post("/chat", requireApiKey, async (req: express.Request, res: express.Response) => {
  const { message } = req.body as { message?: string };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const { answer, sources } = await query(message);
    res.json({ answer, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/ledningssystem/chat", requireApiKey, async (req: express.Request, res: express.Response) => {
  const { message, history } = req.body as {
    message?: string;
    history?: ChatMessage[];
  };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const { answer, sources } = await queryLedningssystem(message, history);
    res.json({ answer, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/ledningssystem/reindex", requireApiKey, async (_req: express.Request, res: express.Response) => {
  try {
    const result = await reindex({
      pineconeIndexName: process.env.PINECONE_INDEX_LEDNINGSSYSTEM!,
      onComplete: resetLedningssystemVectorStore,
    });
    res.json({
      message: "Reindex complete",
      filesProcessed: result.filesProcessed,
      chunksIndexed: result.chunksIndexed,
    });
  } catch (err: any) {
    console.error(err);
    const status = err.message?.includes("already in progress") ? 409 : 500;
    res.status(status).json({ error: err.message || "Internal server error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
