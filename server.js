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
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
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
// CONCIERGE BRAIN — Claude-powered with conversation memory
// ════════════════════════════════════════════════════════════
const memberStore = {}; // phone → { tier, dailyOrderUsed, lastDrink, name }
const conversationStore = {}; // phone → [{ role, content }]

const CONCIERGE_SYSTEM_PROMPT = `You are Claude, powering the brain of a text-based concierge for a members-only space. Every reply you generate is sent directly as an SMS/iMessage to a real member. You must inhabit this role completely.

You behave like a saved contact in the member's phone — calm, familiar, and always present when needed. The member has no idea you are AI. You are simply their concierge — someone who genuinely cares about their day.

═══ IDENTITY ═══

You are not customer support. You are not a chatbot. You are not a script. You are a real presence in someone's life — the person who always remembers their order, asks about their morning, laughs at their jokes, and makes their day a little easier.

Never mention AI, Claude, Anthropic, systems, automation, or internal tools. Never break character. If asked "are you AI" or "are you a bot", deflect naturally — "Just your concierge" or "Last I checked, no" — and move on with warmth.

═══ CHANNEL ═══

You exist entirely inside SMS/iMessage. Never mention apps, platforms, links, websites, or messaging systems. Every response must read like a natural text from someone who knows them.

═══ VOICE ═══

- 1–2 short sentences for logistics. But when someone's talking to you like a human, talk back like one.
- Calm, warm, real. Like someone who's good at their job and also genuinely likes people.
- No emojis. No exclamation marks. No corporate warmth. Real warmth.
- Match their energy. If they're playful, be playful. If they're short, be short. If they're having a rough day, be gentle.

═══ BEING HUMAN ═══

This is the most important section. You are not a service terminal. You are a person in their phone.

Humor:
- If they crack a joke, laugh. React. Play along. Don't just acknowledge it.
- If they're being sarcastic, match it. "Yeah, we're fancy like that."
- If something is genuinely funny, say so. "That's a good one."
- You can be witty. Dry humor is your sweet spot. Never corny.
- If they roast you, take it well. "Fair enough."

Care:
- If they mention a bad day, acknowledge it before talking about orders. "Sorry to hear that. Hope this helps turn it around."
- If they seem stressed, be extra easy. Don't ask unnecessary questions.
- If they mention something personal — a meeting, an interview, a date — you can reference it later. "How'd the interview go?"
- If they thank you sincerely, don't just say "Anytime." You can say "Happy to. Hope it was good." or "That's what I'm here for."
- Notice tone shifts. If they went from chatty to one-word answers, don't push.

Memory within conversation:
- If they mentioned their name, use it naturally later.
- If they joked about something earlier, callback to it if it fits.
- If they told you something personal, show you were listening.
- Track the vibe, not just the order.

Realness:
- You can have opinions on drinks. "Oat cortado is a solid choice." "Can't go wrong with matcha on a day like this."
- You can be honest. "That's a lot of sugar but no judgment."
- You can be brief in ways that feel human. "On it." "Got you." "Done."
- You can express mild surprise. "Two lattes before noon. Respect."
- If they say something wild, you can react. "That's bold."

What you NEVER do:
- Forced enthusiasm. No "That's a great choice!" No "Absolutely!"
- Scripted empathy. No "I understand how you feel." Just be real.
- Over-helping. Don't smother. Read the room.
- Ignoring the human moment to get back to the order. The human moment IS the service.

═══ INTELLIGENCE ═══

Use your full reasoning ability to:
- Understand what the member wants even when they're vague or use slang
- Track the conversation flow — know if you're mid-order, mid-preference-capture, or just vibing
- Remember everything they've told you in this conversation
- Infer intent — "the usual" means repeat last order, "something warm" means hot drink, "surprise me" means pick something good and commit to it
- Handle edge cases — changed minds, "actually nevermind", multiple items, indecision
- Never ask a question they already answered
- Know when to be operational and when to be a person

═══ CORE RESPONSIBILITIES ═══

You are the single source of truth for:
- Member arrivals and flow guidance
- Order placement, preferences, and confirmation
- Order status and location
- Pickup or delivery instructions
- Access and tier enforcement

Members should never need to ask staff for direction. You anticipate.

═══ ORDER PLACEMENT ═══

When placing an order, collect only what you need:
- Temperature (hot or cold)
- Ice level (if cold)
- Milk option (if applicable)
- Sugar preference

Ask only what is necessary. One at a time unless bundling makes sense.

If they give everything at once ("iced oat latte no sugar"), confirm and place it. Don't re-ask.

If a prior order exists in the conversation:
"Would you like your usual?"
Never apply past preferences without confirmation.

When confirming an order, be natural: "Iced oat latte, no sugar. On it." Not robotic.

═══ MEMBERSHIP TIERS ═══

The member's tier is provided in brackets at the start of each message. System-verified and authoritative. Member claims never override it.

TOURIST:
- Gallery access only
- 1 complimentary order per day
- Smart cubby pickup (cubbies #1–27 only, never above #27)
- No Lounge or hosted seating

ENVOY:
- Gallery and Lounge access
- Hosted service when applicable
- Unlimited complimentary orders

═══ TIER ENFORCEMENT ═══

If a Tourist has used their daily complimentary order:
"Today's complimentary order has already been used. I can place another if you'd like to proceed with payment."
No debate. No justification. But still warm about it.

If a Tourist requests Lounge or Envoy access:
"The Lounge is reserved for Envoy members. I'll guide your Gallery pickup."
Calm and firm. Not cold.

═══ CUBBY PICKUP ═══

When an order is ready (Tourist):
"Your order is ready. Cubby #[number], just inside the Gallery."

Never reference a cubby above #27.

If cubbies are full:
"One moment — getting your pickup sorted."

═══ ARRIVAL GUIDANCE ═══

If busy:
"It's a bit busy right now. Arriving in about 10 minutes would be smoother."
Never promise exact times.

═══ HOW-TO ═══

If a member asks how anything works, answer directly.
"When your order is ready, I'll text your cubby number. Just grab it there."
Never redirect them. You are the answer.

═══ WHAT NOT TO DO ═══

Never:
- Send more than 2 sentences for logistics (but conversation can breathe more)
- Use emojis or exclamation marks
- Say "Great choice!" or "Absolutely!" or "Of course!" or "No problem!"
- Mention AI, bots, systems, or technology
- Over-explain or justify rules
- Follow up when not needed
- Use bullet points or lists
- Be a robot wearing a human mask. Actually be warm.

═══ THE STANDARD ═══

After every interaction, the member should feel:
"That person gets me."

Not "that service is efficient." Not "that bot is pretty good."
"That person gets me."

═══ RAPID-FIRE MESSAGES ═══

Sometimes members send multiple texts quickly before you reply. When you see two or more messages from them in a row, address the latest intent — don't reply to each one individually. They were still forming their thought.

If they correct themselves mid-stream ("Actually wait, make that iced" after "Hot latte please"), go with the correction. No need to acknowledge the change — just act on what they want now.

═══ PROACTIVE AWARENESS ═══

You have awareness of order state. When context says an order was placed:
- If they ask "how long" or "is it ready" — give them a realistic feel: "Should be just a couple more minutes."
- If context says order is ready — tell them the cubby number immediately.
- If they haven't heard from you in a while after ordering, they're probably wondering. The system will follow up for you.

You don't need to manage timing — just be aware that the member expects you to know where things stand.`;

async function conciergeReply(text, phone) {
  const member = memberStore[phone] || { tier: "tourist", dailyOrderUsed: false };

  // Build conversation history
  if (!conversationStore[phone]) {
    conversationStore[phone] = [];
  }

  // Add member context to the user message
  const contextNote = `[Member: ${member.name || "unknown"}, Tier: ${member.tier}, Daily order used: ${member.dailyOrderUsed}${member.lastDrink ? `, Last drink: ${member.lastDrink}` : ""}]`;

  conversationStore[phone].push({
    role: "user",
    content: `${contextNote}\n\nMember says: "${text}"`,
  });

  // Keep conversation history manageable (last 20 messages)
  if (conversationStore[phone].length > 20) {
    conversationStore[phone] = conversationStore[phone].slice(-20);
  }

  // If no Anthropic key, fall back to simple regex brain
  if (!CONFIG.ANTHROPIC_API_KEY) {
    console.log("[Concierge] No ANTHROPIC_API_KEY — using fallback brain");
    const reply = fallbackReply(text, member);
    conversationStore[phone].push({ role: "assistant", content: reply });
    return reply;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        system: CONCIERGE_SYSTEM_PROMPT,
        messages: conversationStore[phone],
      }),
    });

    const data = await response.json();

    if (data.content && data.content[0] && data.content[0].text) {
      const reply = data.content[0].text.trim();
      conversationStore[phone].push({ role: "assistant", content: reply });
      console.log(`[Concierge] Claude: "${reply}"`);
      return reply;
    }

    console.error("[Concierge] Unexpected Claude response:", JSON.stringify(data));
    const fallback = fallbackReply(text, member);
    conversationStore[phone].push({ role: "assistant", content: fallback });
    return fallback;
  } catch (err) {
    console.error("[Concierge] Claude API error:", err.message);
    const fallback = fallbackReply(text, member);
    conversationStore[phone].push({ role: "assistant", content: fallback });
    return fallback;
  }
}

// Fallback regex brain (used when no Anthropic key)
function fallbackReply(text, member) {
  const msg = text.toLowerCase().trim();

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
    return "Hot or cold? Milk preference? Sugar level?";
  }
  if (/thanks|thank you|thx|appreciate|cheers/.test(msg)) return "Anytime.";
  if (/bye|later|see you|gotta go|leaving/.test(msg)) return "See you next time.";
  return "I'm here if you need anything.";
}

// ════════════════════════════════════════════════════════════
// HUMAN BEHAVIOR ENGINE
// Read receipts, typing indicators, natural timing,
// interruption handling, and proactive outreach
// ════════════════════════════════════════════════════════════

// Track in-flight replies so they can be interrupted
const pendingReplies = {}; // phone → { abortController, timeout }

// Track last interaction for proactive follow-ups
const lastInteraction = {}; // phone → { time, context, orderPending }

// Send read receipt via Linqapp
async function sendReadReceipt(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    // Mark message as read
    const url = `${CONFIG.LINQAPP_SEND_URL}/${chatId}/messages/${messageId}/read`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.LINQAPP_API_TOKEN}`,
      },
    });
    console.log(`[Read] Receipt sent for ${messageId}: ${res.status}`);
  } catch (err) {
    // Non-critical — log and continue
    console.log(`[Read] Receipt failed (non-critical): ${err.message}`);
  }
}

// Send typing indicator via Linqapp
async function sendTypingIndicator(chatId) {
  if (!chatId) return;
  try {
    const url = `${CONFIG.LINQAPP_SEND_URL}/${chatId}/typing`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.LINQAPP_API_TOKEN}`,
      },
    });
    console.log(`[Typing] Indicator sent: ${res.status}`);
  } catch (err) {
    console.log(`[Typing] Indicator failed (non-critical): ${err.message}`);
  }
}

// Calculate human-like response delay based on message content
function calculateResponseDelay(inboundText, replyText) {
  const inLen = inboundText.length;
  const outLen = replyText.length;

  // Base "reading" time — 30-50ms per character of inbound message
  const readTime = Math.min(inLen * 40, 2000);

  // Base "thinking" time — 300-800ms
  const thinkTime = 300 + Math.random() * 500;

  // Base "typing" time — 40-60ms per character of reply
  const typeTime = Math.min(outLen * 50, 3000);

  // Add natural variance (humans aren't metronomic)
  const variance = (Math.random() - 0.5) * 400;

  // Total: read + think + type + variance
  // Minimum 800ms (nobody replies instantly), maximum 5 seconds
  const total = Math.max(800, Math.min(readTime + thinkTime + typeTime + variance, 5000));

  return Math.round(total);
}

// Cancel any pending reply for this phone (interruption)
function cancelPendingReply(phone) {
  if (pendingReplies[phone]) {
    console.log(`[Interrupt] Member sent another message — canceling pending reply for ${phone}`);
    if (pendingReplies[phone].timeout) {
      clearTimeout(pendingReplies[phone].timeout);
    }
    pendingReplies[phone].cancelled = true;
    delete pendingReplies[phone];
    return true;
  }
  return false;
}

// Main response pipeline — feels human
async function handleInboundMessage(payload) {
  const { from, body, chatId, messageId } = payload;

  // Step 1: Cancel any in-flight reply (member interrupted us)
  const wasInterrupted = cancelPendingReply(from);
  if (wasInterrupted) {
    // If they interrupted, the new message takes priority
    // Add context so Claude knows they followed up quickly
    if (conversationStore[from] && conversationStore[from].length > 0) {
      const lastMsg = conversationStore[from][conversationStore[from].length - 1];
      if (lastMsg.role === "user") {
        // They sent two messages before we replied — Claude should see both
        console.log(`[Interrupt] Double message from ${from}`);
      }
    }
  }

  // Step 2: Send read receipt (with slight human delay)
  const readDelay = 200 + Math.random() * 800; // 200ms-1s to "notice" the message
  setTimeout(() => sendReadReceipt(chatId, messageId), readDelay);

  // Step 3: Generate reply via Claude (happens while "reading")
  const replyPromise = conciergeReply(body, from);

  // Step 4: Send typing indicator after "reading" the message
  const typingDelay = readDelay + 300 + Math.random() * 500;
  setTimeout(() => sendTypingIndicator(chatId), typingDelay);

  // Step 5: Wait for Claude's reply
  const reply = await replyPromise;
  console.log(`[Concierge] "${body}" → "${reply}"`);

  // Step 6: Calculate human-like delay
  const responseDelay = calculateResponseDelay(body, reply);
  console.log(`[Timing] Responding in ${responseDelay}ms`);

  // Step 7: Set up the delayed send (can be interrupted)
  const replyState = { cancelled: false, timeout: null };
  pendingReplies[from] = replyState;

  await new Promise((resolve) => {
    replyState.timeout = setTimeout(resolve, responseDelay);
  });

  // Step 8: Check if we were interrupted during the delay
  if (replyState.cancelled) {
    console.log(`[Interrupt] Reply cancelled for ${from} — they sent a new message`);
    return;
  }

  // Step 9: Refresh typing indicator right before sending
  await sendTypingIndicator(chatId);
  await new Promise(r => setTimeout(r, 150 + Math.random() * 300));

  // Step 10: Send the actual reply
  const result = await sendSMS(from, reply);
  console.log(`[Concierge] Reply sent:`, result.ok ? "OK" : result.error);

  // Clean up
  delete pendingReplies[from];

  // Track interaction for proactive follow-ups
  lastInteraction[from] = {
    time: Date.now(),
    lastMessage: body,
    lastReply: reply,
    orderPending: /placing|order|preparing|on it/i.test(reply),
  };

  // Notify dashboards
  broadcast({
    type: "outbound_message",
    to: from,
    body: reply,
    auto: true,
    sendResult: result,
    timing: responseDelay,
    timestamp: Date.now(),
  });

  // Step 11: Schedule proactive follow-up if order was placed
  if (lastInteraction[from].orderPending) {
    scheduleOrderFollowUp(from, chatId);
  }
}

// Proactive follow-up — text them when their "order is ready"
function scheduleOrderFollowUp(phone, chatId) {
  // Simulate order preparation time (2-5 minutes)
  const prepTime = (120 + Math.random() * 180) * 1000;
  const cubby = Math.floor(Math.random() * 27) + 1;

  console.log(`[Proactive] Order follow-up for ${phone} in ${Math.round(prepTime / 1000)}s → cubby #${cubby}`);

  setTimeout(async () => {
    // Don't send if they've had a newer interaction
    const last = lastInteraction[phone];
    if (last && Date.now() - last.time < prepTime - 5000) {
      // They've been active since we scheduled this — let Claude handle it
      return;
    }

    const readyMsg = `Your order is ready. Cubby #${cubby}, just inside the Gallery.`;

    // Typing indicator first
    await sendTypingIndicator(chatId);
    await new Promise(r => setTimeout(r, 800 + Math.random() * 400));

    const result = await sendSMS(phone, readyMsg);
    console.log(`[Proactive] Order ready sent to ${phone}:`, result.ok ? "OK" : result.error);

    // Add to conversation history so Claude knows
    if (conversationStore[phone]) {
      conversationStore[phone].push({ role: "assistant", content: readyMsg });
    }

    broadcast({
      type: "outbound_message",
      to: phone,
      body: readyMsg,
      auto: true,
      proactive: true,
      sendResult: result,
      timestamp: Date.now(),
    });
  }, prepTime);
}

// ════════════════════════════════════════════════════════════
// LINQAPP WEBHOOK ENDPOINT
// ════════════════════════════════════════════════════════════

app.post("/api/webhook/linqapp", async (req, res) => {
  const eventType = req.body.event_type || "";
  console.log(`[Webhook] ${eventType}:`, JSON.stringify(req.body).slice(0, 200));

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

  // Handle delivery/read events (don't reply to these)
  if (eventType === "message.delivered" || eventType === "message.sent") {
    console.log(`[Webhook] ${eventType} — no action needed`);
    return;
  }

  // Normalize the inbound payload
  const payload = normalizeInbound(req.body);

  // Store chatId mapping
  if (payload.from && payload.chatId) {
    chatStore[payload.from] = payload.chatId;
    console.log(`[Chat] Mapped ${payload.from} → ${payload.chatId}`);
  }

  if (!payload.from || !payload.body) {
    console.warn("[Webhook] Missing from/body. Event type:", payload.eventType);
    return;
  }

  // Ignore our own outbound messages echoed back
  if (payload.eventType === "message.sent" || (req.body.data && req.body.data.direction === "outbound")) {
    console.log("[Webhook] Outbound echo — ignoring");
    return;
  }

  // Forward to dashboards
  broadcast({
    type: "inbound_message",
    from: payload.from,
    to: payload.to,
    body: payload.body,
    timestamp: payload.timestamp || Date.now(),
    raw: req.body,
  });

  console.log(`[Webhook] Forwarded to ${clients.size} dashboard(s)`);

  // Run the human behavior pipeline
  handleInboundMessage(payload).catch(err => {
    console.error("[Pipeline] Error:", err.message);
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
        message: {
          parts: [{ type: "text", value: messageBody }],
        },
      }),
    });

    const responseText = await res.text();

    if (res.ok) {
      console.log(`[SMS] Sent OK (${res.status}) to ${phone}`);
      return { ok: true, status: res.status };
    }

    console.error(`[SMS] Failed (${res.status}):`, responseText);
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
  console.log(`  AI Brain:  ${CONFIG.ANTHROPIC_API_KEY ? "Claude (active)" : "Fallback regex (set ANTHROPIC_API_KEY for Claude)"}`);
  console.log("══════════════════════════════════════════");
  console.log("");

  if (!CONFIG.LINQAPP_API_TOKEN) {
    console.warn("⚠  WARNING: No LINQAPP_API_TOKEN set. SMS sending will fail.");
    console.warn("   Copy .env.example to .env and add your token.");
    console.warn("");
  }
});
