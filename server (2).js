// ════════════════════════════════════════════════════════════
// CONCIERGE WEBHOOK SERVER
// Bridges Linqapp SMS ↔ PWA Dashboard via WebSocket
// ════════════════════════════════════════════════════════════
//
// SETUP:
//   npm init -y
//   npm install express ws cors dotenv node-fetch@2
//   node server.js
//
// ENV (.env file):
//   PORT=3001
//   LINQAPP_API_TOKEN=81f072a8-0c1b-48bf-a2a5-00157caa04bd
//   LINQAPP_PHONE=8607077256
//   LINQAPP_SEND_URL=https://api.linqapp.com/v1/messages
//   LINQAPP_WEBHOOK_SECRET=your_webhook_signing_secret
//   DASHBOARD_ORIGIN=http://localhost:3000
//
// ARCHITECTURE:
//   Linqapp Webhook POST → this server → WebSocket → PWA Dashboard
//   PWA Dashboard → WebSocket → this server → Linqapp Send API → Member's phone
//
// ════════════════════════════════════════════════════════════

require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

// ── Config ──
const CONFIG = {
  PORT: process.env.PORT || 3001,
  LINQAPP_API_TOKEN: process.env.LINQAPP_API_TOKEN || "",
  LINQAPP_PHONE: process.env.LINQAPP_PHONE || "",
  LINQAPP_SEND_URL: "https://api.linqapp.com/api/partner/v3/chats",
  LINQAPP_NUMBERS_URL: "https://api.linqapp.com/api/partner/v3/phonenumbers",
  LINQAPP_WEBHOOK_SECRET: process.env.LINQAPP_WEBHOOK_SECRET || "",
  DASHBOARD_ORIGIN: process.env.DASHBOARD_ORIGIN || "http://localhost:3000",
};

// ── Middleware ──
app.use(cors({ origin: CONFIG.DASHBOARD_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ── WebSocket Server ──
const wss = new WebSocket.Server({ server, path: "/ws" });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[WS] Dashboard connected (${clients.size} total)`);

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      await handleDashboardMessage(ws, msg);
    } catch (e) {
      console.error("[WS] Bad message:", e.message);
      ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Dashboard disconnected (${clients.size} remaining)`);
  });

  // Send connection confirmation
  ws.send(JSON.stringify({
    type: "connected",
    phone: CONFIG.LINQAPP_PHONE,
    timestamp: Date.now(),
  }));
});

// Broadcast to all connected dashboards
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// ── Handle Dashboard → Server Messages ──
async function handleDashboardMessage(ws, msg) {
  switch (msg.type) {
    case "send_sms": {
      const { to, body } = msg;
      if (!to || !body) {
        ws.send(JSON.stringify({ type: "send_result", ok: false, error: "Missing to/body" }));
        return;
      }
      const result = await sendSMS(to, body);
      ws.send(JSON.stringify({
        type: "send_result",
        ...result,
        to,
        body,
        timestamp: Date.now(),
      }));
      break;
    }

    case "get_phonenumbers": {
      try {
        const res = await fetch(CONFIG.LINQAPP_NUMBERS_URL, {
          method: "GET",
          headers: {
            Accept: "*/*",
            Authorization: `Bearer ${CONFIG.LINQAPP_API_TOKEN}`,
          },
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        ws.send(JSON.stringify({
          type: "phonenumbers",
          ok: res.ok,
          data,
          timestamp: Date.now(),
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "phonenumbers", ok: false, error: err.message }));
      }
      break;
    }

    case "ping":
      ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      break;

    default:
      ws.send(JSON.stringify({ type: "error", error: `Unknown type: ${msg.type}` }));
  }
}

// ════════════════════════════════════════════════════════════
// CONCIERGE BRAIN — Server-side auto-reply
// Works even when no dashboard is connected
// ════════════════════════════════════════════════════════════
const memberStore = {}; // phone → { tier, dailyOrderUsed, lastDrink, name }

function conciergeReply(text, phone) {
  const msg = text.toLowerCase().trim();
  const member = memberStore[phone] || { tier: "tourist", dailyOrderUsed: false };

  if (/^(hi|hey|hello|yo|sup|what'?s up|good (morning|afternoon|evening))/.test(msg)) {
    return member.name ? `Hey ${member.name.split(" ")[0]}. What can I get you?` : "Hey. What can I get you?";
  }
  if (/lounge|envoy access|upgrade|vip/.test(msg) && member.tier === "tourist") {
    return "The Lounge is reserved for Envoy members. I'll guide your Gallery pickup.";
  }
  if (/usual|same as (last|before)|again|same thing|repeat/.test(msg)) {
    if (member.lastDrink) return `Placing your usual — ${member.lastDrink}. One moment.`;
    return "I don't have a previous order saved for you yet. What would you like?";
  }
  if (/coffee|latte|espresso|cappuccino|mocha|americano|matcha|tea|chai|drip|pour over|cold brew|cortado|flat white/.test(msg)) {
    if (member.tier === "tourist" && member.dailyOrderUsed) {
      return "Today's complimentary order has already been used. I can place another for you if you'd like to proceed with payment.";
    }
    if (member.lastDrink) return `Would you like your usual? (${member.lastDrink})`;
    return "Hot or cold? Milk preference? Sugar level?";
  }
  if (/^(hot|cold|iced)$/.test(msg)) return "Milk preference?";
  if (/^(oat|almond|whole|skim|soy|coconut|no milk|black|none)/.test(msg)) return "Sugar level?";
  if (/^(no sugar|none|one|two|three|sweet|unsweetened|light sugar|half|regular)/.test(msg)) return "Placing your order now.";
  if (/^(yes|yeah|yep|yup|sure|please|go ahead|do it)$/.test(msg)) return "Placing your order now.";
  if (/status|where('?s| is)|ready|how long|eta|order/.test(msg)) return "I'll check on that for you. One moment.";
  if (/arriving|coming|on my way|heading|omw|be there|walking/.test(msg)) return "See you soon.";
  if (/how (does|do i|it works)|explain|what do i|pickup|pick up/.test(msg)) return "When your order is ready, I'll text your cubby number. Just pick it up there.";
  if (/menu|what('?s| do you) (have|offer|serve)|options/.test(msg)) return "We have espresso drinks, drip coffee, matcha, chai, and tea. What sounds good?";
  if (/pay|charge|card|cost|price/.test(msg)) {
    if (member.tier === "envoy") return "Complimentary for Envoy members. No charge.";
    if (!member.dailyOrderUsed) return "Your first order today is complimentary.";
    return "I'll send you a payment link for this order.";
  }
  if (/thanks|thank you|thx|appreciate|cheers/.test(msg)) return "Anytime.";
  if (/bye|later|see you|gotta go|leaving/.test(msg)) return "See you next time.";
  return "I'm here if you need anything.";
}

// ════════════════════════════════════════════════════════════
// LINQAPP WEBHOOK ENDPOINT
// Linqapp POSTs inbound messages here
// ════════════════════════════════════════════════════════════

app.post("/api/webhook/linqapp", async (req, res) => {
  console.log("[Webhook] Inbound:", JSON.stringify(req.body));

  // Respond 200 immediately — Linqapp expects fast ack
  res.status(200).json({ received: true });

  // Optional: verify webhook signature
  if (CONFIG.LINQAPP_WEBHOOK_SECRET) {
    const signature = req.headers["x-linq-signature"] || req.headers["x-webhook-signature"] || "";
    const expected = crypto
      .createHmac("sha256", CONFIG.LINQAPP_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (signature && signature !== expected) {
      console.warn("[Webhook] Signature mismatch — ignoring");
      return;
    }
  }

  // Normalize the inbound payload
  const payload = normalizeInbound(req.body);

  if (!payload.from || !payload.body) {
    console.warn("[Webhook] Missing from/body. Event type:", payload.eventType);
    // Still store chatId even if no message body (e.g. chat.created)
    if (payload.from && payload.chatId) {
      chatStore[payload.from] = payload.chatId;
      console.log(`[Chat] Stored chatId for ${payload.from}: ${payload.chatId}`);
    }
    return;
  }

  // Store chatId → phone mapping
  if (payload.from && payload.chatId) {
    chatStore[payload.from] = payload.chatId;
    console.log(`[Chat] Mapped ${payload.from} → ${payload.chatId}`);
  }

  // Forward to all connected dashboards
  broadcast({
    type: "inbound_message",
    from: payload.from,
    to: payload.to,
    body: payload.body,
    timestamp: payload.timestamp || Date.now(),
    raw: req.body,
  });

  console.log(`[Webhook] Forwarded to ${clients.size} dashboard(s)`);

  // Auto-reply via concierge brain
  const reply = conciergeReply(payload.body, payload.from);
  console.log(`[Concierge] "${payload.body}" → "${reply}"`);

  // Small delay for natural feel
  await new Promise(r => setTimeout(r, 400 + Math.random() * 600));

  const result = await sendSMS(payload.from, reply);
  console.log(`[Concierge] Reply sent:`, result.ok ? "OK" : result.error);

  // Notify dashboards of the auto-reply
  broadcast({
    type: "outbound_message",
    to: payload.from,
    body: reply,
    auto: true,
    sendResult: result,
    timestamp: Date.now(),
  });
});

// Normalize Linqapp v3 webhook payload
function normalizeInbound(body) {
  // Linqapp v3 format:
  // body.data.sender_handle.handle = "+19789964279"
  // body.data.chat.id = "3cf56637-..."
  // body.data.parts[0].value = "Hey"
  // body.data.chat.owner_handle.handle = "+18607077256"

  const data = body.data || {};
  const senderHandle = data.sender_handle || {};
  const chatOwner = (data.chat || {}).owner_handle || {};
  const parts = data.parts || [];

  // Extract message text from parts array
  const messageText = parts
    .filter(p => p.type === "text")
    .map(p => p.value)
    .join(" ")
    .trim();

  return {
    from: cleanPhone(senderHandle.handle || ""),
    to: cleanPhone(chatOwner.handle || CONFIG.LINQAPP_PHONE),
    body: messageText,
    chatId: (data.chat || {}).id || "",
    messageId: data.id || "",
    service: data.service || "",
    timestamp: data.sent_at || body.created_at || Date.now(),
    eventType: body.event_type || "",
  };
}

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

// ════════════════════════════════════════════════════════════
// LINQAPP SEND API
// Server → Linqapp → Member's phone
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// CHAT ID STORE — maps phone numbers to Linqapp chat IDs
// ════════════════════════════════════════════════════════════
const chatStore = {}; // phone → chatId

async function sendSMS(toPhone, messageBody) {
  const phone = cleanPhone(toPhone);
  const chatId = chatStore[phone];

  if (!chatId) {
    console.error(`[SMS] No chatId found for ${phone}. Cannot send.`);
    return { ok: false, error: "No chatId for this phone number" };
  }

  const url = `${CONFIG.LINQAPP_SEND_URL}/${chatId}/messages`;

  console.log(`[SMS] Sending to ${phone} (chat: ${chatId}): "${messageBody}"`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.LINQAPP_API_TOKEN}`,
      },
      body: JSON.stringify({
        parts: [{ type: "text", value: messageBody }],
      }),
    });

    const responseText = await res.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    if (res.ok) {
      console.log(`[SMS] Sent OK (${res.status}) to ${phone}`);
      return { ok: true, status: res.status, data: responseData };
    }

    console.warn(`[SMS] Failed (${res.status}):`, responseText);

    // Try simpler body format
    if (res.status >= 400) {
      console.log("[SMS] Retrying with simple message body...");
      const retryRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.LINQAPP_API_TOKEN}`,
        },
        body: JSON.stringify({ message: messageBody }),
      });

      const retryText = await retryRes.text();
      if (retryRes.ok) {
        console.log(`[SMS] Sent OK with simple body (${retryRes.status})`);
        return { ok: true, status: retryRes.status };
      }

      // Try POST to /chats directly with phone
      console.log("[SMS] Retrying with POST to /chats...");
      const fallbackRes = await fetch(CONFIG.LINQAPP_SEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.LINQAPP_API_TOKEN}`,
        },
        body: JSON.stringify({ phone, message: messageBody }),
      });

      if (fallbackRes.ok) {
        console.log(`[SMS] Sent OK via /chats fallback (${fallbackRes.status})`);
        return { ok: true, status: fallbackRes.status, via: "chats-fallback" };
      }

      console.error("[SMS] All attempts failed");
      return { ok: false, status: res.status, error: responseText };
    }

    return { ok: false, status: res.status, error: responseText };
  } catch (err) {
    console.error("[SMS] Network error:", err.message);
    return { ok: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════
// REST API ENDPOINTS (for dashboard HTTP calls)
// ════════════════════════════════════════════════════════════

// Send SMS via REST (dashboard calls this — no token needed from client)
app.post("/api/send", async (req, res) => {
  const { to, body } = req.body;

  if (!to || !body) {
    return res.status(400).json({ error: "Missing to/body" });
  }

  if (!CONFIG.LINQAPP_API_TOKEN) {
    return res.status(500).json({ error: "Server missing LINQAPP_API_TOKEN" });
  }

  const result = await sendSMS(to, body);
  res.json(result);
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    connections: clients.size,
    phone: CONFIG.LINQAPP_PHONE,
    timestamp: Date.now(),
  });
});

// Fetch Linqapp phone numbers
app.get("/api/phonenumbers", async (req, res) => {
  console.log("[API] Fetching Linqapp phone numbers...");

  try {
    const response = await fetch(CONFIG.LINQAPP_NUMBERS_URL, {
      method: "GET",
      headers: {
        Accept: "*/*",
        Authorization: `Bearer ${CONFIG.LINQAPP_API_TOKEN}`,
      },
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (response.ok) {
      console.log("[API] Phone numbers fetched:", JSON.stringify(data));
      // Broadcast to dashboards so they can auto-detect
      broadcast({ type: "phonenumbers", data, timestamp: Date.now() });
      return res.json({ ok: true, data });
    }

    // Try X-API-Key if Bearer fails
    if (response.status === 401 || response.status === 403) {
      const retryRes = await fetch(CONFIG.LINQAPP_NUMBERS_URL, {
        method: "GET",
        headers: {
          Accept: "*/*",
          "X-API-Key": CONFIG.LINQAPP_API_TOKEN,
        },
      });

      const retryText = await retryRes.text();
      let retryData;
      try {
        retryData = JSON.parse(retryText);
      } catch {
        retryData = { raw: retryText };
      }

      if (retryRes.ok) {
        broadcast({ type: "phonenumbers", data: retryData, timestamp: Date.now() });
        return res.json({ ok: true, data: retryData });
      }

      return res.status(retryRes.status).json({ ok: false, status: retryRes.status, error: retryText });
    }

    res.status(response.status).json({ ok: false, status: response.status, error: text });
  } catch (err) {
    console.error("[API] Phone numbers fetch error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Webhook test endpoint
app.get("/api/webhook/test", (req, res) => {
  res.json({
    message: "Webhook endpoint is live",
    post_to: "/api/webhook/linqapp",
    expected_payload: {
      from: "+12125550147",
      to: CONFIG.LINQAPP_PHONE,
      body: "Hey, can I get a latte?",
    },
  });
});

// ════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════

server.listen(CONFIG.PORT, () => {
  console.log("");
  console.log("══════════════════════════════════════════");
  console.log("  CONCIERGE WEBHOOK SERVER");
  console.log("══════════════════════════════════════════");
  console.log(`  HTTP:      http://localhost:${CONFIG.PORT}`);
  console.log(`  WebSocket: ws://localhost:${CONFIG.PORT}/ws`);
  console.log(`  Webhook:   POST /api/webhook/linqapp`);
  console.log(`  Send API:  POST /api/send`);
  console.log(`  Health:    GET  /api/health`);
  console.log(`  Numbers:   GET  /api/phonenumbers`);
  console.log(`  Phone:     ${CONFIG.LINQAPP_PHONE || "(set in .env)"}`);
  console.log(`  Token:     ${CONFIG.LINQAPP_API_TOKEN ? "••••" + CONFIG.LINQAPP_API_TOKEN.slice(-8) : "⚠ MISSING — set LINQAPP_API_TOKEN in .env"}`);
  console.log("══════════════════════════════════════════");
  console.log("");

  if (!CONFIG.LINQAPP_API_TOKEN) {
    console.warn("⚠  WARNING: No LINQAPP_API_TOKEN set. SMS sending will fail.");
    console.warn("   Copy .env.example to .env and add your token.");
    console.warn("");
  }
});
