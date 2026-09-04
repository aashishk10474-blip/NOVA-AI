import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------
// ENV
// -------------------------

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!API_KEY) {
  console.error("❌ GEMINI_API_KEY नहीं मिला!");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL नहीं मिला!");
  console.error("Render में PostgreSQL database connect करो।");
  process.exit(1);
}

if (!SESSION_SECRET) {
  console.error("❌ SESSION_SECRET नहीं मिला!");
  console.error("Render Environment Variables में SESSION_SECRET डालो।");
  process.exit(1);
}

// -------------------------
// Gemini
// -------------------------

const ai = new GoogleGenAI({
  apiKey: API_KEY
});

// -------------------------
// PostgreSQL
// -------------------------

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

// -------------------------
// Express
// -------------------------

app.use(express.json({ limit: "2mb" }));

// Website files
app.use(
  express.static(path.join(__dirname, "public"))
);

// -------------------------
// DATABASE SETUP
// -------------------------

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("✅ Database ready");
}

// -------------------------
// PASSWORD HASHING
// -------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  try {
    const [salt, originalHash] = storedHash.split(":");

    if (!salt || !originalHash) {
      return false;
    }

    const hash = crypto
      .scryptSync(password, salt, 64)
      .toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(originalHash, "hex")
    );
  } catch {
    return false;
  }
}

// -------------------------
// SESSION TOKEN
// -------------------------

function createSessionToken(userId) {
  const payload = {
    userId: String(userId),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30
  };

  const payloadBase64 = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${signature}`;
}

function verifySessionToken(token) {
  try {
    if (!token) {
      return null;
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
      return null;
    }

    const [payloadBase64, signature] = parts;

    const expectedSignature = crypto
      .createHmac("sha256", SESSION_SECRET)
      .update(payloadBase64)
      .digest("base64url");

    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSignature);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(payloadBase64, "base64url").toString("utf8")
    );

    if (!payload.userId || !payload.exp) {
      return null;
    }

    if (Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// -------------------------
// COOKIE HELPERS
// -------------------------

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader
    .split(";")
    .map(item => item.trim());

  const target = cookies.find(item =>
    item.startsWith(`${name}=`)
  );

  if (!target) {
    return null;
  }

  return decodeURIComponent(
    target.substring(name.length + 1)
  );
}

function setSessionCookie(res, token) {
  const secure =
    process.env.NODE_ENV === "production"
      ? "; Secure"
      : "";

  res.setHeader(
    "Set-Cookie",
    `nova_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "nova_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
  );
}

// -------------------------
// AUTH MIDDLEWARE
// -------------------------

async function requireAuth(req, res, next) {
  try {
    const token = getCookie(req, "nova_session");

    const session = verifySessionToken(token);

    if (!session) {
      return res.status(401).json({
        ok: false,
        error: "Login required"
      });
    }

    const result = await pool.query(
      `
      SELECT id, name, email, created_at
      FROM users
      WHERE id = $1
      `,
      [session.userId]
    );

    if (result.rows.length === 0) {
      clearSessionCookie(res);

      return res.status(401).json({
        ok: false,
        error: "User account not found"
      });
    }

    req.user = result.rows[0];

    next();
  } catch (error) {
    console.error("Auth error:", error);

    return res.status(500).json({
      ok: false,
      error: "Authentication error"
    });
  }
}

// -------------------------
// HEALTH CHECK
// -------------------------

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      status: "online",
      database: "connected",
      model: MODEL,
      api: "/api/chat"
    });
  } catch (error) {
    console.error("Health error:", error);

    res.status(500).json({
      ok: false,
      status: "online",
      database: "disconnected"
    });
  }
});

// -------------------------
// SIGNUP
// -------------------------

app.post("/api/signup", async (req, res) => {
  try {
    const name = String(
      req.body?.name || ""
    ).trim();

    const email = String(
      req.body?.email || ""
    )
      .trim()
      .toLowerCase();

    const password = String(
      req.body?.password || ""
    );

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Name is required"
      });
    }

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "Valid email is required"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Password must be at least 6 characters"
      });
    }

    const existing = await pool.query(
      `
      SELECT id
      FROM users
      WHERE email = $1
      `,
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        ok: false,
        error: "Account already exists"
      });
    }

    const passwordHash = hashPassword(password);

    const result = await pool.query(
      `
      INSERT INTO users
        (name, email, password_hash)
      VALUES
        ($1, $2, $3)
      RETURNING id, name, email, created_at
      `,
      [name, email, passwordHash]
    );

    const user = result.rows[0];

    const token = createSessionToken(user.id);

    setSessionCookie(res, token);

    res.status(201).json({
      ok: true,
      message: "Account created successfully",
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error("Signup error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "Account already exists"
      });
    }

    res.status(500).json({
      ok: false,
      error: "Signup failed"
    });
  }
});

// -------------------------
// LOGIN
// -------------------------

app.post("/api/login", async (req, res) => {
  try {
    const email = String(
      req.body?.email || ""
    )
      .trim()
      .toLowerCase();

    const password = String(
      req.body?.password || ""
    );

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email and password are required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        email,
        password_hash,
        created_at
      FROM users
      WHERE email = $1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: "Invalid email or password"
      });
    }

    const user = result.rows[0];

    const passwordCorrect = verifyPassword(
      password,
      user.password_hash
    );

    if (!passwordCorrect) {
      return res.status(401).json({
        ok: false,
        error: "Invalid email or password"
      });
    }

    const token = createSessionToken(user.id);

    setSessionCookie(res, token);

    res.json({
      ok: true,
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      ok: false,
      error: "Login failed"
    });
  }
});

// -------------------------
// CURRENT USER
// -------------------------

app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      createdAt: req.user.created_at
    }
  });
});

// -------------------------
// LOGOUT
// -------------------------

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);

  res.json({
    ok: true,
    message: "Logged out"
  });
});

// -------------------------
// GET USER CHAT HISTORY
// -------------------------

app.get(
  "/api/history",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          id,
          user_message AS user,
          assistant_message AS assistant,
          created_at AS timestamp
        FROM chat_history
        WHERE user_id = $1
        ORDER BY id ASC
        LIMIT 100
        `,
        [req.user.id]
      );

      res.json({
        ok: true,
        history: result.rows
      });
    } catch (error) {
      console.error("History read error:", error);

      res.status(500).json({
        ok: false,
        error: "Could not load history"
      });
    }
  }
);

// -------------------------
// DELETE USER CHAT HISTORY
// -------------------------

app.delete(
  "/api/history",
  requireAuth,
  async (req, res) => {
    try {
      await pool.query(
        `
        DELETE FROM chat_history
        WHERE user_id = $1
        `,
        [req.user.id]
      );

      res.json({
        ok: true,
        message: "Chat history deleted"
      });
    } catch (error) {
      console.error(
        "History delete error:",
        error
      );

      res.status(500).json({
        ok: false,
        error: "Could not delete history"
      });
    }
  }
);

// -------------------------
// AI CHAT
// -------------------------

app.post(
  "/api/chat",
  requireAuth,
  async (req, res) => {
    try {
      const message = String(
        req.body?.message || ""
      ).trim();

      if (!message) {
        return res.status(400).json({
          ok: false,
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

      console.log(
        `🤖 NOVA AI [${req.user.email}]:`,
        message
      );

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

      // Save history for THIS user
      await pool.query(
        `
        INSERT INTO chat_history
          (user_id, user_message, assistant_message)
        VALUES
          ($1, $2, $3)
        `,
        [
          req.user.id,
          message,
          reply.trim()
        ]
      );

      // Keep latest 100 messages per user
      await pool.query(
        `
        DELETE FROM chat_history
        WHERE user_id = $1
        AND id NOT IN (
          SELECT id
          FROM chat_history
          WHERE user_id = $1
          ORDER BY id DESC
          LIMIT 100
        )
        `,
        [req.user.id]
      );

      res.json({
        ok: true,
        reply: reply.trim(),
        model: MODEL
      });
    } catch (error) {
      console.error(
        "❌ NOVA AI ERROR:",
        error
      );

      const status =
        error?.status ||
        error?.statusCode ||
        500;

      res.status(
        status >= 400 && status < 600
          ? status
          : 500
      ).json({
        ok: false,
        error:
          error?.message ||
          "NOVA AI से response नहीं मिला।"
      });
    }
  }
);

// -------------------------
// START SERVER
// -------------------------

async function startServer() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log("");
        console.log(
          "================================"
        );
        console.log(
          "          NOVA AI"
        );
        console.log(
          "================================"
        );
        console.log(
          `Server: http://localhost:${PORT}`
        );
        console.log(
          `Model: ${MODEL}`
        );
        console.log(
          "API: /api/chat"
        );
        console.log(
          "Auth: /api/signup"
        );
        console.log(
          "Auth: /api/login"
        );
        console.log(
          "Auth: /api/me"
        );
        console.log(
          "================================"
        );
        console.log("");
      }
    );
  } catch (error) {
    console.error(
      "❌ Server startup failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
