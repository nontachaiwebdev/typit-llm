import "dotenv/config";
import express from "express";
import cors from "cors";
import { query } from "./chain.js";

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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
