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

// ================================
// CONFIG
// ================================

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

if (!API_KEY) {
  console.error("❌ GEMINI_API_KEY नहीं मिला!");
  console.error("अपने .env में GEMINI_API_KEY=YOUR_KEY डालो।");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: API_KEY
});

// ================================
// MIDDLEWARE
// ================================

app.use(express.json({ limit: "1mb" }));

// public folder serve करना
app.use(express.static(path.join(__dirname, "public")));

// ================================
// CHAT HISTORY
// ================================

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

// ================================
// HEALTH CHECK
// ================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    model: MODEL,
    api: "/api/chat"
  });
});

// ================================
// GET CHAT HISTORY
// ================================

app.get("/api/history", (req, res) => {
  const history = readHistory();

  res.json({
    ok: true,
    history
  });
});

// ================================
// DELETE CHAT HISTORY
// ================================

app.delete("/api/history", (req, res) => {
  saveHistory([]);

  res.json({
    ok: true,
    message: "Chat history deleted"
  });
});

// ================================
// CHAT API
// ================================

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({
        error: "Message खाली है।"
      });
    }

    // Browser से आई conversation
    const incomingMessages = Array.isArray(req.body?.messages)
      ? req.body.messages
      : [];

    // Gemini format में convert
    const contents = incomingMessages
      .filter(
        item =>
          item &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" &&
          item.content.trim()
      )
      .map(item => ({
        role: item.role === "assistant" ? "model" : "user",
        parts: [
          {
            text: item.content.trim()
          }
        ]
      }));

    // अगर conversation में current message नहीं है
    if (
      contents.length === 0 ||
      contents[contents.length - 1]?.parts?.[0]?.text !== message
    ) {
      contents.push({
        role: "user",
        parts: [
          {
            text: message
          }
        ]
      });
    }

    // ================================
    // GEMINI REQUEST
    // ================================

    const response = await ai.models.generateContent({
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
      throw new Error("Gemini ने खाली response दिया।");
    }

    // ================================
    // SAVE HISTORY
    // ================================

    const history = readHistory();

    history.push({
      id: Date.now(),
      user: message,
      assistant: reply,
      timestamp: new Date().toISOString()
    });

    // बहुत बड़ी file बनने से रोकने के लिए
    const limitedHistory = history.slice(-100);

    saveHistory(limitedHistory);

    // ================================
    // RESPONSE
    // ================================

    res.json({
      ok: true,
      reply: reply.trim(),
      model: MODEL
    });

  } catch (error) {
    console.error("NOVA AI ERROR:", error);

    const status =
      error?.status ||
      error?.statusCode ||
      500;

    res.status(status >= 400 && status < 600 ? status : 500).json({
      error:
        error?.message ||
        "NOVA AI से response नहीं मिला।"
    });
  }
});

// ================================
// START SERVER
// ================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("================================");
  console.log("        NOVA AI SERVER");
  console.log("================================");
  console.log(`Running: http://localhost:${PORT}`);
  console.log("AI API: /api/chat");
  console.log("History: /api/history");
  console.log(`Model: ${MODEL}`);
  console.log("Status: /api/health");
  console.log("================================");
  console.log("");
});