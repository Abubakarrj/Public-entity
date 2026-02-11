# Concierge — SMS Operations Dashboard

## Architecture

```
Member's Phone
     │
     │ SMS / iMessage
     ▼
┌──────────────┐
│   Linqapp    │
│  (SMS API)   │
└──────┬───────┘
       │ POST webhook
       ▼
┌──────────────────────┐
│   Concierge Server   │  ← server.js (Node/Express)
│   (port 3001)        │
│                      │
│  /api/webhook/linqapp│  ← receives inbound SMS
│  /api/send           │  ← sends outbound SMS
│  /ws                 │  ← WebSocket to dashboard
└──────────┬───────────┘
           │ WebSocket
           ▼
┌──────────────────────┐
│   Concierge PWA      │  ← concierge-dashboard.jsx
│   Dashboard          │
│                      │
│  • Live conversations│
│  • Auto-reply engine │
│  • Order management  │
│  • Member tiers      │
│  • Cubby assignment  │
│  • Preference memory │
└──────────────────────┘
```

## Quick Start

### 1. Server Setup

```bash
# Clone/copy the server files
mkdir concierge-server && cd concierge-server

# Copy server.js, package.json, .env.example
cp .env.example .env    # Edit with your credentials

# Install & run
npm install
npm start
```

You should see:

```
══════════════════════════════════════════
  CONCIERGE WEBHOOK SERVER
══════════════════════════════════════════
  HTTP:      http://localhost:3001
  WebSocket: ws://localhost:3001/ws
  Webhook:   POST /api/webhook/linqapp
  Send API:  POST /api/send
  Health:    GET  /api/health
  Phone:     8607077256
══════════════════════════════════════════
```

### 2. Configure Linqapp Webhook

In your Linqapp dashboard, set the inbound webhook URL to:

```
https://your-domain.com/api/webhook/linqapp
```

For local testing, use [ngrok](https://ngrok.com):

```bash
ngrok http 3001
# Copy the https URL → set as webhook in Linqapp
```

### 3. Dashboard Setup

Add `concierge-dashboard.jsx` and `useWebSocket.js` to your React project.

To connect the dashboard to the WebSocket server, add this inside the `ConciergeDashboard` component:

```jsx
import { useWebSocket } from "./useWebSocket";

// Inside ConciergeDashboard():
const { connected, sendSMS } = useWebSocket({
  url: "ws://localhost:3001/ws",
  onInbound: (payload) => {
    const phone = payload.from.replace(/\D/g, "");

    // Auto-create member if new
    if (!state.members[phone]) {
      dispatch({ type: "ADD_MEMBER", payload: { phone, name: "", tier: "tourist" } });
    }

    // Add inbound message
    dispatch({ type: "ADD_MESSAGE", payload: {
      phone,
      message: { text: payload.body, direction: "inbound", time: Date.now() },
    }});

    // Generate + send auto-reply
    const member = state.members[phone] || { tier: "tourist" };
    const reply = generateReply(payload.body, member, state.orders[phone], state.preferences[phone]);

    setTimeout(() => {
      dispatch({ type: "ADD_MESSAGE", payload: {
        phone,
        message: { text: reply, direction: "outbound", time: Date.now(), auto: true },
      }});
      sendSMS(phone, reply);
    }, 500);
  },
  onSendResult: (result) => {
    dispatch({ type: "LOG_SEND", payload: {
      to: result.to, text: result.body,
      ok: result.ok, status: result.status,
      error: result.error, time: Date.now(),
    }});
  },
});
```

## Files

| File | Purpose |
|------|---------|
| `server.js` | Node/Express webhook server + WebSocket bridge |
| `concierge-dashboard.jsx` | React PWA dashboard (full UI) |
| `useWebSocket.js` | React hook for WebSocket connection |
| `.env.example` | Environment variable template |
| `package.json` | Server dependencies |

## API Reference

### Linqapp Endpoints

**Send Message:**
```
POST https://api.linqapp.com/api/partner/v3/chats
Authorization: Bearer YOUR_SECRET_TOKEN
Content-Type: application/json

{ "phone": "2125550147", "message": "Your order is ready." }
```

**List Phone Numbers:**
```
GET https://api.linqapp.com/api/partner/v3/phonenumbers
Authorization: Bearer YOUR_SECRET_TOKEN
Accept: */*
```

### Webhook (Linqapp → Server)

```
POST /api/webhook/linqapp
Content-Type: application/json

{
  "from": "+12125550147",
  "to": "8607077256",
  "body": "Hey, can I get a latte?"
}
```

### Send SMS (Server → Linqapp)

```
POST https://api.linqapp.com/api/partner/v3/chats
Authorization: Bearer 81f072a8-0c1b-48bf-a2a5-00157caa04bd
Content-Type: application/json

{
  "phone": "2125550147",
  "message": "Your order is ready. Please pick up from cubby #12 just inside the Gallery."
}
```

You can also send via the server's REST proxy:

```
POST /api/send
Content-Type: application/json

{
  "to": "2125550147",
  "body": "Your order is ready."
}
```

### WebSocket Messages

**Server → Dashboard:**
```json
{ "type": "inbound_message", "from": "2125550147", "body": "Hey", "timestamp": 1707580000000 }
{ "type": "send_result", "ok": true, "to": "2125550147", "body": "See you soon.", "status": 200 }
{ "type": "connected", "phone": "8607077256" }
```

**Dashboard → Server:**
```json
{ "type": "send_sms", "to": "2125550147", "body": "Your order is ready." }
{ "type": "ping" }
```

### Health Check

```
GET /api/health

→ { "status": "ok", "uptime": 3600, "connections": 1, "phone": "8607077256" }
```

## Deployment

### Railway / Render / Fly.io

1. Push `server.js`, `package.json`, and `.env` to a git repo
2. Deploy to any Node.js hosting platform
3. Set environment variables in the hosting dashboard
4. Point Linqapp webhook to `https://your-app.com/api/webhook/linqapp`
5. Update `DASHBOARD_ORIGIN` in `.env` to your PWA's URL
6. Update WebSocket URL in the dashboard to `wss://your-app.com/ws`

### Important Notes

- Use `wss://` (not `ws://`) in production for secure WebSocket
- The server handles auto-reconnection on the WebSocket client side
- All SMS sends are logged in the dashboard's Logs tab
- Unknown phone numbers are auto-registered as Tourist members
- Daily complimentary order limits reset via the Settings modal
