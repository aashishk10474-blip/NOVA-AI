import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

if (!API_KEY) {
  console.error("❌ GEMINI_API_KEY नहीं मिला!");
  console.error("Render में Environment Variables में GEMINI_API_KEY डालो।");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: API_KEY
});

app.use(express.json({ limit: "2mb" }));

// Website files
app.use(express.static(path.join(__dirname, "public")));

// -------------------------
// Chat History
// -------------------------

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "chat-history.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, "[]", "utf8");
}

function readHistory() {
  try {
    const data = fs.readFileSync(HISTORY_FILE, "utf8");
    return JSON.parse(data || "[]");
  } catch (error) {
    console.error("History read error:", error);
    return [];
  }
}

function saveHistory(history) {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(history, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("History save error:", error);
  }
}

// -------------------------
// Health Check
// -------------------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    model: MODEL,
    api: "/api/chat"
  });
});

// -------------------------
// Get History
// -------------------------

app.get("/api/history", (req, res) => {
  res.json({
    ok: true,
    history: readHistory()
  });
});

// -------------------------
// Delete History
// -------------------------

app.delete("/api/history", (req, res) => {
  saveHistory([]);

  res.json({
    ok: true,
    message: "Chat history deleted"
  });
});

// -------------------------
// AI CHAT
// -------------------------

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(
      req.body?.message || ""
    ).trim();

    if (!message) {
      return res.status(400).json({
        error: "Message खाली है।"
      });
    }

    const incomingMessages =
      Array.isArray(req.body?.messages)
        ? req.body.messages
        : [];

    const contents = incomingMessages
      .filter(
        item =>
          item &&
          (item.role === "user" ||
            item.role === "assistant") &&
          typeof item.content === "string" &&
          item.content.trim()
      )
      .map(item => ({
        role:
          item.role === "assistant"
            ? "model"
            : "user",
        parts: [
          {
            text: item.content.trim()
          }
        ]
      }));

    // Current user message मौजूद नहीं है तो add करो
    const lastMessage =
      contents[contents.length - 1];

    const lastText =
      lastMessage?.parts?.[0]?.text || "";

    if (lastText !== message) {
      contents.push({
        role: "user",
        parts: [
          {
            text: message
          }
        ]
      });
    }

    console.log("🤖 NOVA AI:", message);

    const response =
      await ai.models.generateContent({
        model: MODEL,
        contents
      });

    const reply =
      response?.text ||
      response?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") ||
      "";

    if (!reply.trim()) {
      throw new Error(
        "Gemini ने खाली response दिया।"
      );
    }

    // History save
    const history = readHistory();

    history.push({
      id: Date.now(),
      user: message,
      assistant: reply.trim(),
      timestamp: new Date().toISOString()
    });

    // Last 100 messages रखो
    saveHistory(history.slice(-100));

    res.json({
      ok: true,
      reply: reply.trim(),
      model: MODEL
    });

  } catch (error) {
    console.error("❌ NOVA AI ERROR:", error);

    const status =
      error?.status ||
      error?.statusCode ||
      500;

    res.status(
      status >= 400 && status < 600
        ? status
        : 500
    ).json({
      error:
        error?.message ||
        "NOVA AI से response नहीं मिला।"
    });
  }
});

// -------------------------
// Start Server
// -------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("================================");
  console.log("          NOVA AI");
  console.log("================================");
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log("API: /api/chat");
  console.log("Health: /api/health");
  console.log("================================");
  console.log("");
});