const express = require("express");
const cors = require("cors");
const axios = require("axios");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 8891;

app.use(cors());
app.use(express.json());

// --- Windows-safe binary finder ---
// Uses "where" on Windows, "which" on Unix. Handles \r\n line endings.
function findBin(name) {
  const { execSync } = require("child_process");
  const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
  const result = execSync(cmd, { encoding: "utf-8", shell: true }).split(/\r?\n/)[0].trim();
  // On Windows, if it's a .cmd file, we need to invoke via cmd.exe
  return result;
}

// --- Config loading ---
let agentConfig = null;
const configPath = path.join(__dirname, "..", "config.json");

function loadConfig() {
  // Config is only loaded via import — always prompt on launch
  console.log("Waiting for config import...");
}

loadConfig();

function getGatewayWsUrl() {
  let httpUrl = agentConfig?.gateway?.url || "http://127.0.0.1:18789";
  if (process.env.GATEWAY_HOST) {
    httpUrl = httpUrl.replace(/127\.0\.0\.1|localhost/g, process.env.GATEWAY_HOST);
  }
  const wsUrl = httpUrl.replace(/^http/, "ws");
  console.log("[gateway] connecting to:", wsUrl);
  return wsUrl;
}

function getGatewayAuthToken() {
  if (agentConfig?.gateway?.token) return agentConfig.gateway.token;
  try {
    const ocPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = fs.readFileSync(ocPath, "utf-8");
    const parsed = JSON.parse(raw);
    const token = parsed.gateway?.auth?.token || "";
    console.log("[auth] token found:", token ? token.slice(0, 8) + "..." : "NONE");
    return token;
  } catch (e) {
    console.log("[auth] failed to read openclaw.json:", e.message);
    // Fallback: hardcoded token from openclaw.json
    return "6405dc414af6f33fd24f7f7ecf5b88d8466767e96546e4e9";
  }
}

// --- Persistent Gateway Connection ---
let gwConn = null; // { ws, connected, pending }

function getGatewayConnection() {
  return new Promise((resolve) => {
    if (gwConn && gwConn.connected && gwConn.ws.readyState === WebSocket.OPEN) {
      return resolve(gwConn);
    }

    // Clean up old connection
    if (gwConn) {
      try { gwConn.ws.close(); } catch { }
      gwConn = null;
    }

    const wsUrl = getGatewayWsUrl();
    const ws = new WebSocket(wsUrl, {
      headers: {
        "Origin": "http://localhost:18789",
      }
    });
    console.log("[gateway] ws created, readyState:", ws.readyState);
    const connId = crypto.randomUUID();
    const conn = { ws, connected: false, pending: new Map() };

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      console.log("[gateway] msg:", JSON.stringify(msg).slice(0, 150));

      // Auth handshake
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const token = getGatewayAuthToken();
        const authPayload = {
          type: "req", id: connId, method: "connect",
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: "openclaw-control-ui", version: "2026.3.13", platform: "Win32", mode: "webchat" },
            role: "operator",
            scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
            caps: ["tool-events"],
            device: { id: "1d712d3c6a514adbcb7b5cca165c7d3b2db7462199c6470ad19f2eed5f39cf38" },
            locale: "en-US",
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            auth: { token },
          },
        };
        console.log("[gateway] sending auth with token:", token.slice(0, 8) + "...");
        console.log("[gateway] full auth payload:", JSON.stringify(authPayload));
        ws.send(JSON.stringify(authPayload));
        return;
      }

      if (msg.type === "res" && msg.id === connId) {
        if (msg.ok) {
          conn.connected = true;
          console.log("[gateway] connected (persistent)");
          resolve(conn);
        } else {
          console.error("[gateway] auth failed");
          resolve(null);
        }
        return;
      }

      // Route responses to pending requests
      if (msg.type === "res") {
        for (const [id, handler] of conn.pending) {
          if (handler.reqIds && handler.reqIds.includes(msg.id)) {
            handler.onResponse(msg);
            return;
          }
        }
      }

      // Route events by runId
      if (msg.type === "event") {
        const runId = msg.payload?.runId;
        if (runId) {
          for (const [id, handler] of conn.pending) {
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
      // Reject all pending
      for (const [id, handler] of conn.pending) {
        handler.onClose?.();
      }
      conn.pending.clear();
      gwConn = null;
    });

    gwConn = conn;

    setTimeout(() => {
      if (!conn.connected) {
        console.log("[gateway] connection timed out after 10s — no auth response received");
        try { ws.close(); } catch { }
        resolve(null);
      }
    }, 10000);
  });
}



async function chatViaGatewayCLI(message, sessionId) {
  const sessionKey = sessionId ? `agent:main:${sessionId}` : `agent:main:${crypto.randomUUID()}`;
  const token = getGatewayAuthToken();
  const openclawJs = path.join(
    os.homedir(), "AppData", "Roaming", "npm", "node_modules", "openclaw", "dist", "index.js"
  );

  const runGatewayCall = (method, params) => {
    return new Promise((resolve, reject) => {
      const { spawn } = require("child_process");
      const paramsStr = JSON.stringify(params);
      console.log("[cli-gateway] calling:", method, paramsStr.slice(0, 100));

      const proc = spawn(process.execPath, [
        openclawJs,
        "gateway", "call", method,
        "--params", paramsStr,
        "--token", token,
        "--url", "ws://127.0.0.1:18789",
        "--json",
        "--timeout", "60000"
      ], {
        shell: false,
        env: { ...process.env, NO_COLOR: "1" }
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", d => { stdout += d.toString(); });
      proc.stderr.on("data", d => { stderr += d.toString(); });
      proc.on("close", (code) => {
        console.log("[cli-gateway] exited:", code, "| stderr:", stderr.slice(0, 150));
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || stdout));
      });
      proc.on("error", reject);
    });
  };

  try {
    // Send message
    console.log("[cli-gateway] sending to session:", sessionKey);
    const sendResult = await runGatewayCall("chat.send", {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID()
    });
    console.log("[cli-gateway] send result:", sendResult.slice(0, 200));

    // Poll for response every 5s up to 60s
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const historyResult = await runGatewayCall("chat.history", { sessionKey });
        const data = JSON.parse(historyResult);
        const messages = Array.isArray(data) ? data : data.messages || [];
        const assistantMsg = messages.filter(m => m.role === "assistant").pop();

        if (assistantMsg) {
          let content = "";
          if (Array.isArray(assistantMsg.content)) {
            content = assistantMsg.content.filter(p => p.type === "text").map(p => p.text).join("");
          } else if (typeof assistantMsg.content === "string") {
            content = assistantMsg.content;
          }
          content = content.replace(/<\/?(?:think|final|thinking)[^>]*>/g, "").trim();
          if (content) {
            console.log(`[cli-gateway] got response on poll ${i + 1}`);
            return { ok: true, text: content };
          }
        }
      } catch (pollErr) {
        console.log(`[cli-gateway] poll ${i + 1} failed:`, pollErr.message?.slice(0, 150));
      }
    }

    return { ok: false, error: "Agent did not respond in time" };

  } catch (err) {
    console.log("[cli-gateway] error:", err.message?.slice(0, 300));
    return { ok: false, error: err.message };
  }
}


// --- Direct Gemini API streaming (fallback) ---
async function chatViaDirectAPI(message, history, res) {
  const apiKey = agentConfig.configuration?.apiKey;
  const model = agentConfig.configuration?.model || "gemini-2.5-flash";
  const systemPrompt = agentConfig.configuration?.systemPrompt || "You are a helpful assistant.";

  if (!apiKey) {
    res.write(`data: ${JSON.stringify({ error: "No API key configured" })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const contents = [];
  if (history && history.length > 0) {
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
    const response = await axios.post(url, {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
    }, {
      responseType: "stream",
      timeout: 60000,
    });

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
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          }
        } catch {
          // skip unparseable
        }
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
    const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error("[gemini] error:", errMsg);
    res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return null;
  }
}

// --- Routes ---

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/config", (req, res) => {
  if (!agentConfig) {
    return res.json({ loaded: false });
  }
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
    if (!config || !config.name || !config.configuration) {
      return res.status(400).json({ error: "Invalid config format" });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    agentConfig = config;
    console.log(`Config imported: ${config.name}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Config import error:", err.message);
    res.status(500).json({ error: "Failed to import config" });
  }
});

app.post("/api/chat", async (req, res) => {
  if (!agentConfig) return res.status(400).json({ error: "No agent config loaded" });

  const { message, history, sessionId } = req.body;
  let clientDisconnected = false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  res.on("close", () => { clientDisconnected = true; });

  console.log("[chat] using CLI gateway, sessionId:", sessionId);
  const result = await chatViaGatewayCLI(message, sessionId);

  if (clientDisconnected) return;

  if (result.ok && result.text) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: result.text } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    console.log("[chat] CLI gateway failed, falling back to Gemini:", result.error);
    const directChat = await chatViaDirectAPI(message, history, res);
    res.on("close", () => { if (directChat?.close) directChat.close(); });
  }
});

app.get("/api/openclaw/health", async (req, res) => {
  try {
    const gatewayUrl = agentConfig?.gateway?.url || "http://127.0.0.1:18789";
    const response = await axios.get(`${gatewayUrl}/health`, { timeout: 5000 });
    res.json({ status: "ok", gateway: response.data });
  } catch (err) {
    res.json({ status: "unreachable", error: err.message });
  }
});

// --- OpenClaw Session History Endpoints ---

app.get("/api/openclaw/sessions", (req, res) => {
  try {
    const { execSync } = require("child_process");
    // FIX 4: findBin() handles where/which + \r\n; shell: true lets .cmd files execute
    const bin = findBin("openclaw");
    const raw = execSync(`"${bin}" sessions --json --active 10080`, {
      encoding: "utf-8",
      timeout: 15000,
      maxBuffer: 50 * 1024 * 1024,
      shell: true,              // FIX 5: required — was causing ETIMEDOUT
      env: { ...process.env, NO_COLOR: "1" },
    });
    const data = JSON.parse(raw);
    const sessions = (data.sessions || []).slice(0, 20).map((s) => ({
      key: s.key,
      sessionId: s.sessionId,
      updatedAt: s.updatedAt,
      model: s.model,
      agentId: s.agentId,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
    }));
    res.json({ ok: true, sessions });
  } catch (err) {
    console.error("[openclaw/sessions] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: "Failed to list sessions" });
  }
});

app.get("/api/openclaw/sessions/:sessionKey/history", (req, res) => {
  try {
    const { execSync } = require("child_process");
    // FIX 6: findBin() for cross-platform binary resolution
    const bin = findBin("openclaw");
    const sessionKey = req.params.sessionKey;
    // FIX 7: Windows cmd.exe doesn't support single quotes — use escaped double quotes instead
    const paramsJson = JSON.stringify({ sessionKey }).replace(/"/g, '\\"');
    const raw = execSync(
      `"${bin}" gateway call chat.history --params "${paramsJson}" --json --timeout 15000`,
      {
        encoding: "utf-8",
        timeout: 20000,
        maxBuffer: 50 * 1024 * 1024,
        shell: true,            // FIX 8: required for .cmd + escaped args
        env: { ...process.env, NO_COLOR: "1" },
      }
    );
    const data = JSON.parse(raw);
    // Normalize messages: extract text from content arrays
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
        // Strip thinking/control tags
        content = content.replace(/<\/?(?:think|final|thinking)[^>]*>/g, "").trim();
        // Strip "think\nThinking Process:..." blocks
        const thinkMatch = content.match(/^think\n[\s\S]*?\n([A-Z][\s\S]*)$/m);
        if (thinkMatch) content = thinkMatch[1].trim();
        return { role: m.role, content, timestamp: m.timestamp };
      });
    res.json({ ok: true, messages });
  } catch (err) {
    console.error("[openclaw/sessions/history] error:", err.message?.slice(0, 300));
    res.status(500).json({ ok: false, error: "Failed to fetch session history" });
  }
});

app.get("/api/openclaw/cli-check", (req, res) => {
  try {
    const { execSync } = require("child_process");
    // FIX 9: findBin() + shell: true for .cmd compatibility
    const bin = findBin("openclaw");
    const version = execSync(`"${bin}" --version`, { encoding: "utf-8", shell: true }).trim();
    res.json({ status: "ok", version });
  } catch {
    res.json({ status: "not_found" });
  }
});

// --- Start OpenClaw gateway if not running ---
const { spawn: spawnProcess } = require("child_process");
let openclawProcess = null;

app.post("/api/openclaw/start", async (req, res) => {
  // Check if already running
  try {
    const gatewayUrl = agentConfig?.gateway?.url || "http://127.0.0.1:18789";
    const health = await axios.get(`${gatewayUrl}/health`, { timeout: 3000 });
    if (health.data?.ok) {
      return res.json({ status: "already_running" });
    }
  } catch { }

  // Find openclaw binary
  let openclawBin;
  try {
    // FIX 10: findBin() replaces bare "where openclaw" call
    openclawBin = findBin("openclaw");
  } catch {
    return res.status(404).json({ status: "not_found", error: "OpenClaw CLI not found. Install it first." });
  }

  // Start the gateway
  try {
    const port = agentConfig?.gateway?.url?.match(/:(\d+)/)?.[1] || "18789";
    openclawProcess = spawnProcess(openclawBin, ["gateway", "--port", port, "--force", "--auth", "none"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // FIX 11: shell: true ensures .cmd wrapper is invoked correctly on Windows
      shell: true,
      env: { ...process.env },
    });

    openclawProcess.unref();

    let startOutput = "";
    openclawProcess.stdout.on("data", (d) => { startOutput += d.toString(); });
    openclawProcess.stderr.on("data", (d) => { startOutput += d.toString(); });

    openclawProcess.on("error", (err) => {
      console.error("[openclaw] spawn error:", err.message);
    });

    // Wait for gateway to become healthy (up to 15s)
    const gatewayUrl = agentConfig?.gateway?.url || "http://127.0.0.1:18789";
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const h = await axios.get(`${gatewayUrl}/health`, { timeout: 2000 });
        if (h.data?.ok) {
          ready = true;
          break;
        }
      } catch { }
    }

    if (ready) {
      // Give the agent a few extra seconds to fully initialize
      await new Promise((r) => setTimeout(r, 3000));
      console.log("[openclaw] gateway started successfully");
      res.json({ status: "started" });
    } else {
      console.error("[openclaw] gateway failed to start:", startOutput.slice(-500));
      res.status(500).json({ status: "failed", error: "Gateway did not become healthy", output: startOutput.slice(-500) });
    }
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// Serve built client in production
const clientDist = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    if (!req.path.startsWith("/api")) {
      res.sendFile(path.join(clientDist, "index.html"));
    }
  });
  console.log("Serving client from", clientDist);
}

function startListening() {
  const server = app.listen(PORT, () => {
    console.log(`Bolofy Agent server running on port ${PORT}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Port ${PORT} in use, killing old process...`);
      try {
        const { execSync } = require("child_process");
        // FIX 12: shell: true required for pipe operator (|) to work on Windows
        const result = execSync(`netstat -ano | findstr :${PORT}`, {
          encoding: "utf-8",
          shell: true,
        }).trim();
        // FIX 13: extract PIDs from netstat output and kill each with taskkill
        const pids = [...new Set(result.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()))].filter(Boolean);
        if (pids.length) {
          pids.forEach(pid => { try { execSync(`taskkill /PID ${pid} /F`, { shell: true }); } catch { } });
          console.log("Killed old process, restarting...");
          setTimeout(() => startListening(), 1000);
        }
      } catch {
        console.error(`Port ${PORT} is already in use. Kill the process manually.`);
        process.exit(1);
      }
    } else {
      throw err;
    }
  });
}


// Skills adding Part

// --- Skills Management ---

const getOpenclawJs = () => path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules", "openclaw", "dist", "index.js"
);

const runOpenclawJs = (args) => new Promise((resolve, reject) => {
  const { spawn } = require("child_process");
  const proc = spawn(process.execPath, [getOpenclawJs(), ...args], {
    shell: false,
    env: { ...process.env, NO_COLOR: "1" }
  });
  let stdout = "", stderr = "";
  proc.stdout.on("data", d => { stdout += d.toString(); });
  proc.stderr.on("data", d => { stderr += d.toString(); });
  proc.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
  proc.on("error", reject);
});

// Get all skills with status
app.get("/api/skills", async (req, res) => {
  try {
    const raw = await runOpenclawJs(["skills", "list", "--json"]);
    const data = JSON.parse(raw);

    // Read disabled list from openclaw.json
    let disabledSkills = [];
    try {
      const ocPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
      const config = JSON.parse(fs.readFileSync(ocPath, "utf-8"));
      disabledSkills = config.skills?.disabled || [];
    } catch {}

    const skills = (data.skills || []).map(s => ({
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

// Enable a skill (remove from disabled list)
app.post("/api/skills/enable", (req, res) => {
  const { skillName } = req.body;
  if (!skillName) return res.status(400).json({ ok: false, error: "skillName required" });
  try {
    const ocPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(ocPath, "utf-8"));
    if (!config.skills) config.skills = {};
    if (!config.skills.disabled) config.skills.disabled = [];
    config.skills.disabled = config.skills.disabled.filter(s => s !== skillName);
    fs.writeFileSync(ocPath, JSON.stringify(config, null, 2));
    console.log("[skills] enabled:", skillName);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Disable a skill (add to disabled list)
app.post("/api/skills/disable", (req, res) => {
  const { skillName } = req.body;
  if (!skillName) return res.status(400).json({ ok: false, error: "skillName required" });
  try {
    const ocPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(ocPath, "utf-8"));
    if (!config.skills) config.skills = {};
    if (!config.skills.disabled) config.skills.disabled = [];
    if (!config.skills.disabled.includes(skillName)) {
      config.skills.disabled.push(skillName);
    }
    fs.writeFileSync(ocPath, JSON.stringify(config, null, 2));
    console.log("[skills] disabled:", skillName);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

startListening();