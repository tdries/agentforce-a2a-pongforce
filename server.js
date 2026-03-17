require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const SF_DOMAIN = process.env.SF_DOMAIN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const AGENT_API = process.env.AGENT_API;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(`${SF_DOMAIN}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Auth failed: ${err.error_description || err.error}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 25 * 60 * 1000;
  console.log("✅ Authenticated with Salesforce");
  return cachedToken;
}

// Create agent session
app.post("/api/session", async (req, res) => {
  try {
    const token = await getToken();
    const { agentId } = req.body;

    const sfRes = await fetch(`${AGENT_API}/agents/${agentId}/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        externalSessionKey: crypto.randomUUID(),
        instanceConfig: {
          endpoint: SF_DOMAIN,
        },
        streamingCapabilities: {
          chunkTypes: ["Text"],
        },
        bypassUser: true,
      }),
    });

    const text = await sfRes.text();
    console.log(`Session response (${sfRes.status}):`, text);

    if (!sfRes.ok) throw new Error(text);
    const data = JSON.parse(text);
    res.json(data);
  } catch (err) {
    console.error("Session error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send message to agent (synchronous)
app.post("/api/message", async (req, res) => {
  try {
    const token = await getToken();
    const { sessionId, text, sequenceId } = req.body;

    const sfRes = await fetch(`${AGENT_API}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          sequenceId,
          type: "Text",
          text,
        },
      }),
    });

    const raw = await sfRes.text();
    console.log(`Message response (${sfRes.status}):`, raw);

    if (!sfRes.ok) throw new Error(raw);
    const data = JSON.parse(raw);

    // Extract response text from messages
    let responseText = "";
    if (data.messages) {
      for (const msg of data.messages) {
        if (msg.message) {
          responseText += msg.message + " ";
        }
      }
    }

    res.json({ response: responseText.trim(), raw: data });
  } catch (err) {
    console.error("Message error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// End session
app.delete("/api/session/:sessionId", async (req, res) => {
  try {
    const token = await getToken();
    await fetch(`${AGENT_API}/sessions/${req.params.sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Expose non-secret config to the client
app.get("/api/config", (req, res) => {
  res.json({
    player1Id: process.env.PLAYER1_ID,
    player2Id: process.env.PLAYER2_ID,
    apiBase: process.env.DEMO_URL + "/api",
  });
});

app.use(express.static("public"));

// HTTPS with mkcert certs
const sslOptions = {
  key: fs.readFileSync(process.env.SSL_KEY_PATH),
  cert: fs.readFileSync(process.env.SSL_CERT_PATH),
};

https.createServer(sslOptions, app).listen(process.env.PORT || 443, () => {
  console.log(`\n🏓 PONGFORCE running at ${process.env.DEMO_URL}\n`);
});