import "dotenv/config";
import express from "express";
import cors from "cors";
import { query } from "./chain.js";
import {
  query as queryLedningssystem,
  resetVectorStore as resetLedningssystemVectorStore,
  type ChatMessage,
} from "./chain-ledningssystem.js";
import {
  query as queryBoende,
  resetVectorStore as resetBoendeVectorStore,
} from "./chain-boende.js";
import { reindex } from "./reindex.js";
import { createClient } from "@supabase/supabase-js";
import { createRequireUser } from "./auth.js";
import {
  resolveAllowedSources,
  clearPermissionCache,
  type PermissionConfig,
} from "./permissions.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Per-subsystem Supabase project config (auth + file_permissions live together).
const ledningssystemCfg: PermissionConfig = {
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
};
const boendeCfg: PermissionConfig = {
  supabaseUrl: process.env.SUPABASE_URL_BOENDE!,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY_BOENDE!,
};

// Token verifiers — each validates against its own project.
const requireUserLedningssystem = createRequireUser(
  createClient(ledningssystemCfg.supabaseUrl, ledningssystemCfg.supabaseKey)
);
const requireUserBoende = createRequireUser(
  createClient(boendeCfg.supabaseUrl, boendeCfg.supabaseKey)
);

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

app.post(
  "/ledningssystem/chat",
  requireApiKey,
  requireUserLedningssystem,
  async (req: express.Request, res: express.Response) => {
    const { message, history } = req.body as {
      message?: string;
      history?: ChatMessage[];
    };

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    try {
      const allowedSources = await resolveAllowedSources(
        req.userId!,
        ledningssystemCfg
      );
      const { answer, sources } = await queryLedningssystem(
        message,
        history,
        allowedSources
      );
      res.json({ answer, sources });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.post("/ledningssystem/reindex", requireApiKey, async (_req: express.Request, res: express.Response) => {
  try {
    const result = await reindex({
      pineconeIndexName: process.env.PINECONE_INDEX_LEDNINGSSYSTEM!,
      onComplete: () => {
        resetLedningssystemVectorStore();
        clearPermissionCache(ledningssystemCfg.supabaseUrl);
      },
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

app.post(
  "/boende/chat",
  requireApiKey,
  requireUserBoende,
  async (req: express.Request, res: express.Response) => {
    const { message, history } = req.body as {
      message?: string;
      history?: ChatMessage[];
    };

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    try {
      const allowedSources = await resolveAllowedSources(
        req.userId!,
        boendeCfg
      );
      const { answer, sources } = await queryBoende(
        message,
        history,
        allowedSources
      );
      res.json({ answer, sources });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.post("/boende/reindex", requireApiKey, async (_req: express.Request, res: express.Response) => {
  try {
    const result = await reindex({
      pineconeIndexName: process.env.PINECONE_INDEX_BOENDE!,
      supabase: {
        url: process.env.SUPABASE_URL_BOENDE!,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY_BOENDE!,
        bucket: process.env.SUPABASE_BUCKET_BOENDE,
      },
      onComplete: () => {
        resetBoendeVectorStore();
        clearPermissionCache(boendeCfg.supabaseUrl);
      },
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
