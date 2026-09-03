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
  console.error("अपने .env में GEMINI_API_KEY=YOUR_KEY डालो।");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

app.use(express.json({ limit: "1mb" }));

const PUBLIC_DIR = path.join(__dirname, "public");

/*
========================================
BLOCK DIRECT .HTML ACCESS
========================================
*/

app.use((req, res, next) => {
  // Direct .html URL को block करो
  if (req.path.toLowerCase().endsWith(".html")) {
    return res.status(404).send("Not Found");
  }

  next();
});

/*
========================================
CLEAN PAGE ROUTES
========================================
*/

// Main website
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Login page
app.get("/login", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

// Signup page
app.get("/signup", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "signup.html"));
});

// Chat page
app.get("/chat", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "chat.html"));
});

// Profile page
app.get("/profile", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "profile.html"));
});

// Settings page
app.get("/settings", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "settings.html"));
});

// Study page
app.get("/study", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "study.html"));
});

/*
========================================
STATIC FILES
========================================
*/

app.use(express.static(PUBLIC_DIR));

/*
========================================
CHAT HISTORY
========================================
*/

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

/*
========================================
HEALTH
========================================
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    model: MODEL,
    api: "/api/chat"
  });
});

/*
========================================
HISTORY API
========================================
*/

app.get("/api/history", (req, res) => {
  const history = readHistory();

  res.json({
    ok: true,
    history
  });
});

app.delete("/api/history", (req, res) => {
  saveHistory([]);

  res.json({
    ok: true,
    message: "Chat history deleted"
  });
});

/*
========================================
GEMINI CHAT API
========================================
*/

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({
        error: "Message खाली है।"
      });
    }

    const incomingMessages = Array.isArray(req.body?.messages)
      ? req.body.messages
      : [];

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

    const history = readHistory();

    history.push({
      id: Date.now(),
      user: message,
      assistant: reply,
      timestamp: new Date().toISOString()
    });

    saveHistory(history.slice(-100));

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

/*
========================================
404
========================================
*/

app.use((req, res) => {
  res.status(404).send("Not Found");
});

/*
========================================
START SERVER
========================================
*/

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