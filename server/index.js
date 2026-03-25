"use strict";

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");
require("dotenv").config();

// ─────────────────────────────────────────────
// ENV CONFIG  (works for both local and prod)
// ─────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 8891;

// Comma-separated list of allowed CORS origins, e.g.:
//   CORS_ORIGINS=https://app.example.com,https://www.example.com
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      `http://localhost:${PORT}`,
    ];

// Gateway
const GATEWAY_URL =
  process.env.GATEWAY_URL ||
  (process.env.GATEWAY_HOST
    ? `http://${process.env.GATEWAY_HOST}:18789`
    : "http://127.0.0.1:18789");

// Auth token (prefer env var; falls back to openclaw.json; then hard-coded sentinel)
const GATEWAY_TOKEN_ENV = process.env.GATEWAY_TOKEN || "";

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// OpenClaw config file (can be overridden for Docker / CI)
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  path.join(os.homedir(), ".openclaw", "openclaw.json");

// Where the imported agent config is persisted on disk
const CONFIG_PATH =
  process.env.AGENT_CONFIG_PATH ||
  path.join(__dirname, "..", "config.json");

// ─────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: IS_PROD
      ? (origin, cb) => {
          // In production reject requests from origins not in the allowlist
          if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
          cb(new Error(`CORS: origin '${origin}' not allowed`));
        }
      : CORS_ORIGINS,
    credentials: true,
  })
);
app.use(express.json({ limit: "4mb" }));

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/** Cross-platform binary resolver — handles .cmd on Windows */
function findBin(name) {
  const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
  return execSync(cmd, { encoding: "utf-8", shell: true })
    .split(/\r?\n/)[0]
    .trim();
}

/** Resolve system Node (not Electron's bundled one) */
function getSystemNode() {
  try {
    const cmd = process.platform === "win32" ? "where node" : "which node";
    const lines = execSync(cmd, { encoding: "utf-8", shell: true })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const systemNode = lines.find(
      (p) =>
        !p.toLowerCase().includes("electron") &&
        !p.toLowerCase().includes("node_modules")
    );
    console.log("[node] system node:", systemNode || lines[0]);
    return systemNode || lines[0];
  } catch (e) {
    console.error("[node] failed to resolve system node:", e.message);
    return process.execPath;
  }
}

const SYSTEM_NODE = getSystemNode();

/** Resolve openclaw CLI JS entry point across common install locations */
function getOpenclawJs() {
  const candidates = [
    // Windows npm global
    path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "openclaw",
      "dist",
      "index.js"
    ),
    // Unix npm global
    "/usr/local/lib/node_modules/openclaw/dist/index.js",
    // nvm
    path.join(
      os.homedir(),
      ".nvm",
      "versions",
      "node",
      `v${process.versions.node}`,
      "lib",
      "node_modules",
      "openclaw",
      "dist",
      "index.js"
    ),
    // OPENCLAW_PATH env override
    ...(process.env.OPENCLAW_PATH ? [process.env.OPENCLAW_PATH] : []),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log("[openclaw] found at:", p);
      return p;
    }
  }

  // Fallback: derive from binary location
  try {
    const bin = findBin("openclaw");
    const nm1 = path.join(
      path.dirname(bin),
      "node_modules",
      "openclaw",
      "dist",
      "index.js"
    );
    if (fs.existsSync(nm1)) return nm1;
    const nm2 = path.resolve(
      path.join(
        path.dirname(bin),
        "..",
        "node_modules",
        "openclaw",
        "dist",
        "index.js"
      )
    );
    if (fs.existsSync(nm2)) return nm2;
  } catch (e) {
    console.error("[openclaw] binary fallback failed:", e.message);
  }

  // Last resort — Windows default
  return path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "npm",
    "node_modules",
    "openclaw",
    "dist",
    "index.js"
  );
}

/** Run openclaw CLI and return stdout (or stderr on exit 0 builds) */
const runOpenclawJs = (args) =>
  new Promise((resolve, reject) => {
    const proc = spawn(SYSTEM_NODE, [getOpenclawJs(), ...args], {
      shell: false,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
    });
    let stdout = "",
      stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      const output = stdout || stderr;
      if (code === 0) resolve(output);
      else reject(new Error(stderr || stdout));
    });
    proc.on("error", reject);
  });

// ─────────────────────────────────────────────
// AGENT CONFIG
// ─────────────────────────────────────────────
let agentConfig = null;

// Try to load a previously persisted config on boot
(function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      agentConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      console.log("[config] loaded from disk:", agentConfig.name);
    } else {
      console.log("[config] no saved config found — waiting for import");
    }
  } catch (e) {
    console.error("[config] failed to load from disk:", e.message);
  }
})();

// ─────────────────────────────────────────────
// GATEWAY AUTH
// ─────────────────────────────────────────────
function getGatewayAuthToken() {
  // 1. Explicit env var (preferred in production / Docker)
  if (GATEWAY_TOKEN_ENV) return GATEWAY_TOKEN_ENV;

  // 2. Injected via imported config
  if (agentConfig?.gateway?.token) return agentConfig.gateway.token;

  // 3. ~/.openclaw/openclaw.json (local dev)
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    const token = JSON.parse(raw)?.gateway?.auth?.token || "";
    if (token) {
      console.log("[auth] token from openclaw.json:", token.slice(0, 8) + "...");
      return token;
    }
  } catch (e) {
    console.log("[auth] openclaw.json read failed:", e.message);
  }

  // 4. Hard-coded sentinel (dev only — warn loudly in prod)
  const fallback = "6405dc414af6f33fd24f7f7ecf5b88d8466767e96546e4e9";
  if (IS_PROD) {
    console.warn(
      "[auth] WARNING: using hard-coded fallback token in production! Set GATEWAY_TOKEN env var."
    );
  }
  return fallback;
}

function getGatewayWsUrl() {
  const base =
    agentConfig?.gateway?.url || GATEWAY_URL;
  const wsUrl = base.replace(/^http/, "ws");
  console.log("[gateway] ws url:", wsUrl);
  return wsUrl;
}

// ─────────────────────────────────────────────
// PERSISTENT GATEWAY CONNECTION
// ─────────────────────────────────────────────
let gwConn = null;

function getGatewayConnection() {
  return new Promise((resolve) => {
    if (
      gwConn &&
      gwConn.connected &&
      gwConn.ws.readyState === WebSocket.OPEN
    ) {
      return resolve(gwConn);
    }

    if (gwConn) {
      try {
        gwConn.ws.close();
      } catch {}
      gwConn = null;
    }

    const wsUrl = getGatewayWsUrl();
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: GATEWAY_URL },
    });

    const connId = crypto.randomUUID();
    const conn = { ws, connected: false, pending: new Map() };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Auth challenge
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const token = getGatewayAuthToken();
        ws.send(
          JSON.stringify({
            type: "req",
            id: connId,
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "openclaw-control-ui",
                version: "2026.3.13",
                platform: process.platform,
                mode: "webchat",
              },
              role: "operator",
              scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
              caps: ["tool-events"],
              device: {
                id: "1d712d3c6a514adbcb7b5cca165c7d3b2db7462199c6470ad19f2eed5f39cf38",
              },
              locale: "en-US",
              userAgent:
                "Mozilla/5.0 (compatible; openclaw-control-ui/1.0)",
              auth: { token },
            },
          })
        );
        return;
      }

      // Auth response
      if (msg.type === "res" && msg.id === connId) {
        if (msg.ok) {
          conn.connected = true;
          console.log("[gateway] connected (persistent)");
          resolve(conn);
        } else {
          console.error("[gateway] auth failed:", JSON.stringify(msg).slice(0, 200));
          resolve(null);
        }
        return;
      }

      // Route responses to pending requests
      if (msg.type === "res") {
        for (const [, handler] of conn.pending) {
          if (handler.reqIds?.includes(msg.id)) {
            handler.onResponse(msg);
            return;
          }
        }
      }

      // Route events by runId
      if (msg.type === "event") {
        const runId = msg.payload?.runId;
        if (runId) {
          for (const [, handler] of conn.pending) {
            if (handler.runId === runId) {
              handler.onEvent(msg);
              return;
            }
          }
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[gateway] ws error:", err.message);
      conn.connected = false;
      gwConn = null;
      resolve(null);
    });

    ws.on("close", () => {
      console.log("[gateway] ws closed");
      conn.connected = false;
      for (const [, handler] of conn.pending) handler.onClose?.();
      conn.pending.clear();
      gwConn = null;
    });

    gwConn = conn;

    setTimeout(() => {
      if (!conn.connected) {
        console.log("[gateway] connection timed out after 10s");
        try { ws.close(); } catch {}
        resolve(null);
      }
    }, 10_000);
  });
}

// ─────────────────────────────────────────────
// CHAT VIA CLI GATEWAY
// ─────────────────────────────────────────────
async function chatViaGatewayCLI(message, sessionId) {
  const sessionKey = `agent:main:${sessionId || crypto.randomUUID()}`;
  const token = getGatewayAuthToken();
  const openclawJs = getOpenclawJs();
  const gatewayWsUrl = getGatewayWsUrl().replace(/^ws/, "ws");

  const runGatewayCall = (method, params) =>
    new Promise((resolve, reject) => {
      const paramsStr = JSON.stringify(params);
      console.log("[cli-gateway] calling:", method, paramsStr.slice(0, 100));

      const proc = spawn(
        SYSTEM_NODE,
        [
          openclawJs,
          "gateway",
          "call",
          method,
          "--params",
          paramsStr,
          "--token",
          token,
          "--url",
          gatewayWsUrl,
          "--json",
          "--timeout",
          "60000",
        ],
        { shell: false, env: { ...process.env, NO_COLOR: "1" } }
      );

      let stdout = "",
        stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || stdout));
      });
      proc.on("error", reject);
    });

  try {
    await runGatewayCall("chat.send", {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
    });

    // Poll up to 60 s (12 × 5 s)
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        const historyResult = await runGatewayCall("chat.history", {
          sessionKey,
        });
        const data = JSON.parse(historyResult);
        const messages = Array.isArray(data) ? data : data.messages || [];
        const assistantMsg = messages
          .filter((m) => m.role === "assistant")
          .pop();

        if (assistantMsg) {
          let content = "";
          if (Array.isArray(assistantMsg.content)) {
            content = assistantMsg.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
          } else if (typeof assistantMsg.content === "string") {
            content = assistantMsg.content;
          }
          content = content
            .replace(/<\/?(?:think|final|thinking)[^>]*>/g, "")
            .trim();
          if (content) {
            console.log(`[cli-gateway] response on poll ${i + 1}`);
            return { ok: true, text: content };
          }
        }
      } catch (pollErr) {
        console.log(
          `[cli-gateway] poll ${i + 1} failed:`,
          pollErr.message?.slice(0, 150)
        );
      }
    }

    return { ok: false, error: "Agent did not respond in time" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// CHAT VIA DIRECT GEMINI API  (fallback)
// ─────────────────────────────────────────────
async function chatViaDirectAPI(message, history, res) {
  // Prefer env var, then config
  const apiKey = GEMINI_API_KEY || agentConfig?.configuration?.apiKey;
  const model =
    GEMINI_MODEL ||
    agentConfig?.configuration?.model ||
    "gemini-2.5-flash";
  const systemPrompt =
    agentConfig?.configuration?.systemPrompt || "You are a helpful assistant.";

  if (!apiKey) {
    res.write(
      `data: ${JSON.stringify({ error: "No Gemini API key configured" })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const contents = [];
  if (history?.length) {
    for (const msg of history) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  try {
    const response = await axios.post(
      url,
      { contents, systemInstruction: { parts: [{ text: systemPrompt }] } },
      { responseType: "stream", timeout: 60_000 }
    );

    let buffer = "";
    response.data.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
            );
          }
        } catch {}
      }
    });

    response.data.on("end", () => {
      res.write("data: [DONE]\n\n");
      res.end();
    });

    response.data.on("error", (err) => {
      console.error("[gemini] stream error:", err.message);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });

    return { close: () => response.data.destroy() };
  } catch (err) {
    const errMsg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error("[gemini] error:", errMsg);
    res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return null;
  }
}

// ─────────────────────────────────────────────
// ROUTES — health / config
// ─────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    env: IS_PROD ? "production" : "development",
    version: process.env.npm_package_version || "unknown",
  });
});

app.get("/api/config", (req, res) => {
  if (!agentConfig) return res.json({ loaded: false });
  res.json({
    loaded: true,
    name: agentConfig.name,
    description: agentConfig.description,
    agentType: agentConfig.agentType,
    model: agentConfig.configuration?.model,
    systemPrompt: agentConfig.configuration?.systemPrompt,
    version: agentConfig.version,
  });
});

app.post("/api/config/import", (req, res) => {
  try {
    const config = req.body;
    if (!config?.name || !config?.configuration) {
      return res.status(400).json({ error: "Invalid config format" });
    }
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    agentConfig = config;
    console.log("[config] imported:", config.name);
    res.json({ success: true });
  } catch (err) {
    console.error("[config] import error:", err.message);
    res.status(500).json({ error: "Failed to import config" });
  }
});

// ─────────────────────────────────────────────
// ROUTES — chat
// ─────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  if (!agentConfig)
    return res.status(400).json({ error: "No agent config loaded" });

  const { message, history, sessionId } = req.body;
  let clientDisconnected = false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  res.on("close", () => (clientDisconnected = true));

  console.log("[chat] sessionId:", sessionId);
  const result = await chatViaGatewayCLI(message, sessionId);

  if (clientDisconnected) return;

  if (result.ok && result.text) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: result.text } }] })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    console.log("[chat] gateway failed, falling back to Gemini:", result.error);
    const directChat = await chatViaDirectAPI(message, history, res);
    res.on("close", () => directChat?.close?.());
  }
});

// ─────────────────────────────────────────────
// ROUTES — OpenClaw gateway management
// ─────────────────────────────────────────────

app.get("/api/openclaw/health", async (_req, res) => {
  try {
    const response = await axios.get(`${GATEWAY_URL}/health`, {
      timeout: 5_000,
    });
    res.json({ status: "ok", gateway: response.data });
  } catch (err) {
    res.json({ status: "unreachable", error: err.message });
  }
});

app.get("/api/openclaw/cli-check", (_req, res) => {
  try {
    const bin = findBin("openclaw");
    const version = execSync(`"${bin}" --version`, {
      encoding: "utf-8",
      shell: true,
    }).trim();
    res.json({ status: "ok", version });
  } catch {
    res.json({ status: "not_found" });
  }
});

app.post("/api/openclaw/start", async (_req, res) => {
  // Already running?
  try {
    const health = await axios.get(`${GATEWAY_URL}/health`, { timeout: 3_000 });
    if (health.data?.ok) return res.json({ status: "already_running" });
  } catch {}

  let openclawBin;
  try {
    openclawBin = findBin("openclaw");
  } catch {
    return res
      .status(404)
      .json({ status: "not_found", error: "OpenClaw CLI not installed" });
  }

  const port = GATEWAY_URL.match(/:(\d+)/)?.[1] || "18789";
  const proc = spawn(
    openclawBin,
    ["gateway", "--port", port, "--force", "--auth", "none"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: { ...process.env },
    }
  );
  proc.unref();

  let startOutput = "";
  proc.stdout.on("data", (d) => (startOutput += d.toString()));
  proc.stderr.on("data", (d) => (startOutput += d.toString()));
  proc.on("error", (err) =>
    console.error("[openclaw] spawn error:", err.message)
  );

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const h = await axios.get(`${GATEWAY_URL}/health`, { timeout: 2_000 });
      if (h.data?.ok) {
        ready = true;
        break;
      }
    } catch {}
  }

  if (ready) {
    await new Promise((r) => setTimeout(r, 3_000));
    console.log("[openclaw] gateway started");
    return res.json({ status: "started" });
  }

  console.error("[openclaw] gateway failed:", startOutput.slice(-500));
  res.status(500).json({
    status: "failed",
    error: "Gateway did not become healthy",
    output: startOutput.slice(-500),
  });
});

// ─────────────────────────────────────────────
// ROUTES — Sessions / history
// ─────────────────────────────────────────────

app.get("/api/openclaw/sessions", (_req, res) => {
  try {
    const bin = findBin("openclaw");
    const raw = execSync(
      `"${bin}" sessions --json --active 10080`,
      {
        encoding: "utf-8",
        timeout: 15_000,
        maxBuffer: 50 * 1024 * 1024,
        shell: true,
        env: { ...process.env, NO_COLOR: "1" },
      }
    );
    const data = JSON.parse(raw);
    const sessions = (data.sessions || [])
      .slice(0, 20)
      .map(({ key, sessionId, updatedAt, model, agentId, inputTokens, outputTokens }) => ({
        key,
        sessionId,
        updatedAt,
        model,
        agentId,
        inputTokens,
        outputTokens,
      }));
    res.json({ ok: true, sessions });
  } catch (err) {
    console.error("[sessions] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: "Failed to list sessions" });
  }
});

app.get("/api/openclaw/sessions/:sessionKey/history", (req, res) => {
  try {
    const bin = findBin("openclaw");
    const { sessionKey } = req.params;
    const paramsJson = JSON.stringify({ sessionKey }).replace(/"/g, '\\"');
    const raw = execSync(
      `"${bin}" gateway call chat.history --params "${paramsJson}" --json --timeout 15000`,
      {
        encoding: "utf-8",
        timeout: 20_000,
        maxBuffer: 50 * 1024 * 1024,
        shell: true,
        env: { ...process.env, NO_COLOR: "1" },
      }
    );
    const data = JSON.parse(raw);
    const messages = (data.messages || [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        let content = "";
        if (Array.isArray(m.content)) {
          content = m.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
        } else if (typeof m.content === "string") {
          content = m.content;
        }
        content = content
          .replace(/<\/?(?:think|final|thinking)[^>]*>/g, "")
          .trim();
        const thinkMatch = content.match(/^think\n[\s\S]*?\n([A-Z][\s\S]*)$/m);
        if (thinkMatch) content = thinkMatch[1].trim();
        return { role: m.role, content, timestamp: m.timestamp };
      });
    res.json({ ok: true, messages });
  } catch (err) {
    console.error("[history] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: "Failed to fetch history" });
  }
});

// ─────────────────────────────────────────────
// ROUTES — Skills
// ─────────────────────────────────────────────

app.get("/api/skills/search", async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.json({ ok: true, results: [] });
  try {
    const raw = await runOpenclawJs(["skills", "search", q.trim(), "--json"]);
    const jsonStart = raw.search(/[\[{]/);
    if (jsonStart === -1) return res.json({ ok: true, results: [] });
    const data = JSON.parse(raw.slice(jsonStart));
    const results =
      data.results || data.skills || (Array.isArray(data) ? data : []);
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[skills/search] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: err.message?.slice(0, 200) });
  }
});

app.post("/api/skills/install", async (req, res) => {
  const { skillName } = req.body;
  if (!skillName)
    return res.status(400).json({ ok: false, error: "skillName required" });
  try {
    await runOpenclawJs(["skills", "install", skillName]);
    res.json({ ok: true, message: `${skillName} installed` });
  } catch (err) {
    console.error("[skills/install] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: err.message?.slice(0, 300) });
  }
});

app.post("/api/skills/update", async (req, res) => {
  const { skillName } = req.body;
  if (!skillName)
    return res.status(400).json({ ok: false, error: "skillName required" });
  try {
    await runOpenclawJs(["skills", "update", skillName]);
    res.json({ ok: true, message: `${skillName} updated` });
  } catch (err) {
    console.error("[skills/update] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: err.message?.slice(0, 300) });
  }
});

app.get("/api/skills", async (_req, res) => {
  try {
    const raw = await runOpenclawJs(["skills", "list", "--json"]);
    const jsonStart = raw.search(/[\[{]/);
    if (jsonStart === -1)
      throw new Error("No JSON in output: " + raw.slice(0, 200));
    const data = JSON.parse(raw.slice(jsonStart));

    let disabledSkills = [];
    try {
      const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
      disabledSkills = config.skills?.disabled || [];
    } catch {}

    const skills = (data.skills || []).map((s) => ({
      name: s.name,
      description: s.description,
      emoji: s.emoji || "🔧",
      eligible: s.eligible,
      disabled: disabledSkills.includes(s.name),
      missing: s.missing,
      homepage: s.homepage || null,
      source: s.source,
    }));

    res.json({ ok: true, skills });
  } catch (err) {
    console.error("[skills] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/skills/enable", (req, res) => {
  const { skillName } = req.body;
  if (!skillName)
    return res.status(400).json({ ok: false, error: "skillName required" });
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    if (!config.skills) config.skills = {};
    if (!config.skills.disabled) config.skills.disabled = [];
    config.skills.disabled = config.skills.disabled.filter(
      (s) => s !== skillName
    );
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/skills/disable", (req, res) => {
  const { skillName } = req.body;
  if (!skillName)
    return res.status(400).json({ ok: false, error: "skillName required" });
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    if (!config.skills) config.skills = {};
    if (!config.skills.disabled) config.skills.disabled = [];
    if (!config.skills.disabled.includes(skillName))
      config.skills.disabled.push(skillName);
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// STATIC CLIENT (production build)
// ─────────────────────────────────────────────
const clientDist = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    if (!req.path.startsWith("/api")) {
      res.sendFile(path.join(clientDist, "index.html"));
    }
  });
  console.log("[static] serving client from", clientDist);
}

// ─────────────────────────────────────────────
// SERVER STARTUP  (with port-conflict recovery)
// ─────────────────────────────────────────────
function startListening() {
  const server = app.listen(PORT, () => {
    console.log(
      `[server] running on port ${PORT} (${IS_PROD ? "production" : "development"})`
    );
  });

  server.on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;

    console.log(`[server] port ${PORT} in use — attempting to free it...`);
    try {
      if (process.platform === "win32") {
        const result = execSync(`netstat -ano | findstr :${PORT}`, {
          encoding: "utf-8",
          shell: true,
        }).trim();
        const pids = [
          ...new Set(
            result
              .split(/\r?\n/)
              .map((l) => l.trim().split(/\s+/).pop())
              .filter(Boolean)
          ),
        ];
        pids.forEach((pid) => {
          try {
            execSync(`taskkill /PID ${pid} /F`, { shell: true });
          } catch {}
        });
      } else {
        execSync(`fuser -k ${PORT}/tcp`, { shell: true });
      }
      console.log("[server] port freed, restarting in 1 s...");
      setTimeout(startListening, 1_000);
    } catch {
      console.error(
        `[server] could not free port ${PORT}. Kill the process manually.`
      );
      process.exit(1);
    }
  });
}

startListening();