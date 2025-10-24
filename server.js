import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

/* =======================
   Almacenamiento en memoria
   Estructura:
   conversations: Map(waId => {
     waId, name,
     msgs: [{ id, direction: 'in'|'out', type, text, timestamp, status }]
   })
   msgIndex: Map(messageId => waId)  // para actualizar estados por webhook
======================= */
const conversations = new Map();
const msgIndex = new Map();

function ensureConv(waId, name = null) {
    if (!conversations.has(waId)) {
        conversations.set(waId, { waId, name: name || waId, msgs: [] });
    } else if (name) {
        const c = conversations.get(waId);
        if (!c.name || c.name === waId) c.name = name; // mejorar nombre si llega
    }
    return conversations.get(waId);
}

function pushMsg({ waId, name, id, direction, type, text, timestamp, status }) {
    const conv = ensureConv(waId, name);
    conv.msgs.push({
        id,
        direction, // 'in' o 'out'
        type,      // text, image, etc.
        text,
        timestamp: Number(timestamp) || Date.now(),
        status     // received | sent | delivered | read | failed
    });
    if (id) msgIndex.set(id, waId);
}

function updateStatus(messageId, newStatus, ts) {
    const waId = msgIndex.get(messageId);
    if (!waId) return;
    const conv = conversations.get(waId);
    if (!conv) return;
    const msg = conv.msgs.find(m => m.id === messageId);
    if (msg) {
        msg.status = newStatus;
        if (ts) msg.timestamp = Number(ts) * 1000;
    }
}

/* =======================
   LOG mínimo (útil debug)
======================= */
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

/* =======================
   VERIFY WEBHOOK (GET)
======================= */
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

/* =======================
   RECEPCIÓN WEBHOOK (POST)
   - Mensajes entrantes
   - Estados (statuses) de mensajes salientes
======================= */
app.post("/webhook", (req, res) => {
    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const value  = change?.value;

        // 1) MENSAJES ENTRANTES
        const messages = value?.messages;
        if (Array.isArray(messages)) {
            const contactName = value?.contacts?.[0]?.profile?.name || null;
            const waId        = value?.contacts?.[0]?.wa_id || messages[0]?.from;

            for (const msg of messages) {
                const mType = msg.type;
                let text = "";
                if (mType === "text") text = msg.text?.body || "";
                else if (mType === "interactive") {
                    text =
                        msg.interactive?.button_reply?.title ||
                        msg.interactive?.list_reply?.title ||
                        "(interacción)";
                } else {
                    text = `[${mType}] (no-text)`;
                }

                pushMsg({
                    waId,
                    name: contactName,
                    id: msg.id,
                    direction: "in",
                    type: mType,
                    text,
                    timestamp: (Number(msg.timestamp) || Date.now()/1000) * 1000,
                    status: "received"
                });
            }
        }

        // 2) ESTADOS DE MENSAJES (DELIVERED/READ/FAILED/etc.)
        const statuses = value?.statuses;
        if (Array.isArray(statuses)) {
            for (const st of statuses) {
                const mid = st.id;            // id del mensaje
                const s   = st.status;        // delivered, read, failed, sent, etc.
                const ts  = st.timestamp;     // epoch (s)
                let mapped = s;
                if (s === "sent") mapped = "sent";
                if (s === "delivered") mapped = "delivered";
                if (s === "read") mapped = "read";
                if (s === "failed") mapped = "failed";

                updateStatus(mid, mapped, ts);
            }
        }
    } catch (e) {
        console.error("Error webhook:", e);
    }
    res.sendStatus(200);
});

/* =======================
   API: listar conversaciones
======================= */
app.get("/api/messages", (_req, res) => {
    // Devolver ordenado por última actividad desc
    const arr = Array.from(conversations.values())
        .map(c => ({ ...c, msgs: [...c.msgs].sort((a,b)=>a.timestamp-b.timestamp) }))
        .sort((a,b) => {
            const at = a.msgs[a.msgs.length-1]?.timestamp || 0;
            const bt = b.msgs[b.msgs.length-1]?.timestamp || 0;
            return bt - at;
        });
    res.json(arr);
});

/* =======================
   API: enviar mensaje (saliente)
======================= */
app.post("/api/send", async (req, res) => {
    try {
        const { to, body } = req.body;
        if (!to || !body) {
            return res.status(400).json({ error: "to y body son requeridos" });
        }

        const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

        const payload = {
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body }
        };

        const r = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${WA_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await r.json();
        if (!r.ok) {
            console.error("WA send error:", data);
            return res.status(500).json({ error: "WhatsApp API error", detail: data });
        }

        // id del mensaje saliente
        const outId = data?.messages?.[0]?.id || null;

        // Guardar en conversación como 'out'
        pushMsg({
            waId: to,
            name: "Contacto",
            id: outId,
            direction: "out",
            type: "text",
            text: body,
            timestamp: Date.now(),
            status: "sent"
        });

        return res.json({ ok: true, data });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "server_error" });
    }
});

/* ======================= */
app.get("/", (_req, res) => {
    res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
    console.log(`Servidor listo en http://localhost:${PORT}`);
});
