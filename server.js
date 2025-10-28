import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import Database from "better-sqlite3";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

if (!VERIFY_TOKEN || !WA_TOKEN || !WA_PHONE_NUMBER_ID) {
    console.error("⚠️ Falta configurar VERIFY_TOKEN, WA_TOKEN o WA_PHONE_NUMBER_ID en .env");
    process.exit(1);
}

// ---------- DB (SQLite) ----------
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "inbox.sqlite");
await (await import("fs/promises")).mkdir(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Tablas
db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
                                                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                 phone TEXT UNIQUE NOT NULL,
                                                 name TEXT,
                                                 last_ts INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                            conversation_id INTEGER NOT NULL,
                                            wa_msg_id TEXT,                    -- id devuelto por Cloud API (para status)
                                            direction TEXT NOT NULL CHECK(direction IN ('in','out')),
                                            text TEXT,
                                            status TEXT,                       -- sent/delivered/read/failed para 'out' | 'received' para 'in'
                                            ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                                            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, ts DESC);
`);

// Helpers DB
const upsertConversation = db.prepare(`
    INSERT INTO conversations (phone, name, last_ts)
    VALUES (@phone, @name, @last_ts)
    ON CONFLICT(phone) DO UPDATE SET
    name=COALESCE(excluded.name, conversations.name),
    last_ts=excluded.last_ts
`);
const getConversationByPhone = db.prepare(`SELECT * FROM conversations WHERE phone = ?`);
const getConversationById = db.prepare(`SELECT * FROM conversations WHERE id = ?`);
const insertMessage = db.prepare(`
    INSERT INTO messages (conversation_id, wa_msg_id, direction, text, status, ts)
    VALUES (@conversation_id, @wa_msg_id, @direction, @text, @status, @ts)
`);
const updateMessageStatusByWaId = db.prepare(`
    UPDATE messages SET status = @status, ts = MAX(ts, @ts)
    WHERE wa_msg_id = @wa_msg_id
`);
const listConversations = db.prepare(`
    SELECT id, phone, name, last_ts FROM conversations ORDER BY last_ts DESC
`);
const listMessagesByConversation = db.prepare(`
    SELECT id, wa_msg_id, direction, text, status, ts
    FROM messages
    WHERE conversation_id = ?
    ORDER BY ts ASC
`);

// Crea/actualiza conversación y devuelve su fila
function ensureConversation(phone, name = null, tsSec = Math.floor(Date.now()/1000)) {
    upsertConversation.run({ phone, name, last_ts: tsSec });
    return getConversationByPhone.get(phone);
}

// Guarda mensaje y actualiza last_ts de la conversación
function pushMessage({ phone, name, direction, text, status, wa_msg_id = null, tsSec = Math.floor(Date.now()/1000) }) {
    const conv = ensureConversation(phone, name, tsSec);
    insertMessage.run({
        conversation_id: conv.id,
        wa_msg_id,
        direction,
        text,
        status,
        ts: tsSec
    });
}

// ---------- App ----------
const app = express();
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.url}`);
    next();
});

app.use(bodyParser.json({ limit: "2mb" }));

// 🚩 servir estáticos DESDE /public (corrección clave)
app.use(express.static(path.join(__dirname, "public")));

// ===== Webhook VERIFY (GET) =====
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

// ===== Webhook eventos (POST) =====
app.post("/webhook", (req, res) => {
    const body = req.body;
    try {
        if (body?.object !== "whatsapp_business_account") {
            return res.sendStatus(200); // ignorar otros objetos
        }

        for (const entry of body.entry || []) {
            for (const change of entry.changes || []) {
                const value = change.value || {};

                // 1) Mensajes entrantes
                const msg = value.messages?.[0];
                if (msg) {
                    const from = msg.from; // teléfono del usuario (E.164)
                    const name = value.contacts?.[0]?.profile?.name || null;
                    const text =
                        msg.text?.body ||
                        msg.interactive?.list_reply?.title ||
                        msg.button?.text ||
                        "(mensaje)";
                    const tsSec = Number(msg.timestamp) || Math.floor(Date.now() / 1000);

                    pushMessage({
                        phone: from,
                        name,
                        direction: "in",
                        text,
                        status: "received",
                        tsSec
                    });
                }

                // 2) Estados de mensajes salientes
                const st = value.statuses?.[0];
                if (st) {
                    const wa_msg_id = st.id;
                    const status = st.status;
                    const tsSec = Number(st.timestamp) || Math.floor(Date.now() / 1000);
                    const to = st.recipient_id;

                    // Guardar el estado normal
                    updateMessageStatusByWaId.run({ status, wa_msg_id, ts: tsSec });
                    if (to) ensureConversation(to, null, tsSec);

                    // ⚠️ Verificar errores específicos
                    const error = st.errors?.[0];
                    if (status === "failed" && error) {
                        const code = error.code;
                        const detail = error.detail || error.title || "";

                        // Detectar si el número no tiene WhatsApp
                        if (
                            code === 131026 ||
                            code === 131047 ||
                            detail.includes("not a valid WhatsApp user") ||
                            detail.includes("Recipient phone number not in WhatsApp")
                        ) {
                            console.log(`❌ ${to} no tiene WhatsApp (${detail || code})`);
                            // Puedes registrar esto en una tabla o archivo aparte
                            db.prepare(
                                `INSERT INTO messages (conversation_id, direction, text, status, ts)
                                 VALUES ((SELECT id FROM conversations WHERE phone = ?), 'system',
                                         'El número no tiene WhatsApp', 'failed', ?)`
                            ).run(to, tsSec);
                        } else {
                            console.log(`⚠️ Error al enviar a ${to}: ${detail || code}`);
                        }
                    }

                    if (["sent", "delivered", "read"].includes(status)) {
                        console.log(`✅ Mensaje a ${to} confirmado (${status})`);
                    }
                }

            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Error en /webhook:", e);
        res.sendStatus(500);
    }
});

// Devuelve el último estado conocido de un número
app.get("/api/status/:phone", (req, res) => {
    const phone = req.params.phone;
    const stmt = db.prepare(`
    SELECT m.status, m.ts
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE c.phone = ?
    ORDER BY m.ts DESC LIMIT 1
  `);
    const result = stmt.get(phone);
    if (!result) return res.json({ status: "unknown" });
    res.json({ status: result.status, last_update: result.ts });
});

// ===== API: Listar bandeja con mensajes =====
// GET /api/messages           → todas las conversaciones con sus mensajes
// GET /api/messages?phone=... → solo una conversación específica
app.get("/api/messages", (req, res) => {
    try {
        const { phone } = req.query;

        if (phone) {
            const conv = getConversationByPhone.get(phone);
            if (!conv) return res.json([]);
            const msgs = listMessagesByConversation.all(conv.id);
            return res.json([
                {
                    phone: conv.phone,
                    name: conv.name,
                    last_ts: conv.last_ts,
                    messages: msgs
                }
            ]);
        }

        // Todas las conversaciones
        const convs = listConversations.all();
        const result = convs.map((c) => ({
            phone: c.phone,
            name: c.name,
            last_ts: c.last_ts,
            messages: listMessagesByConversation.all(c.id)
        }));
        res.json(result);
    } catch (e) {
        console.error("Error en GET /api/messages:", e);
        res.status(500).json({ error: "internal_error" });
    }
});

// ===== API: Enviar mensaje =====
app.post("/api/send", async (req, res) => {
    try {
        const { to, text } = req.body || {};
        if (!to || !text) {
            return res.status(400).json({ error: "Faltan campos: to, text" });
        }

        const url = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;
        const payload = {
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body: text }
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
            console.error("Error Cloud API:", data);
            return res
                .status(502)
                .json({ error: "cloud_api_error", details: data });
        }

        const wa_msg_id = data?.messages?.[0]?.id || null;
        const tsSec = Math.floor(Date.now() / 1000);

        // Guardar 'out' con estado inicial 'sent'
        pushMessage({
            phone: to,
            name: null,
            direction: "out",
            text,
            status: "sent",
            wa_msg_id,
            tsSec
        });

        return res.json({ ok: true, id: wa_msg_id });
    } catch (e) {
        console.error("Error en POST /api/send:", e);
        res.status(500).json({ error: "internal_error" });
    }
});

// 🚩 Servir index.html DESDE /public (corrección clave)
app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// (Opcional) healthcheck simple
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
    console.log(`✅ Server escuchando en http://localhost:${PORT}`);
});
