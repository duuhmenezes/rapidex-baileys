import express from "express";
import qrcode from "qrcode";
import fs from "fs-extra";
import cors from "cors";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import mysql from "mysql2/promise";

const SESSION_DIR = process.env.SESSION_DIR || "./sessions";
const WEBHOOK_URL =
  process.env.WHATS_WEBHOOK_URL ||
  "https://rapidex.app.br/api/whatsapp/inbound.php";
const WEBHOOK_TOKEN = (process.env.WHATS_WEBHOOK_TOKEN || "").trim();
const FORWARD_GROUP = (process.env.WHATS_FORWARD_GROUP || "").trim();

const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: corsOrigins.length
      ? corsOrigins
      : ["https://rapidex.app.br", "https://painel.rapidex.app.br"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

function requireEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

const db = await mysql.createPool({
  host: requireEnv("DB_HOST"),
  user: requireEnv("DB_USER"),
  password: requireEnv("DB_PASS"),
  database: requireEnv("DB_NAME"),
  waitForConnections: true,
  connectionLimit: 10,
});

await fs.ensureDir(SESSION_DIR);

const clients = Object.create(null);
const sessionStatus = Object.create(null);
const starting = new Set();

async function ensureSessionTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      rel_estabelecimentos_id INT UNSIGNED NOT NULL,
      session_name VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
      last_qr MEDIUMTEXT NULL,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_eid (rel_estabelecimentos_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function upsertSession(eid, { status, last_qr = null }) {
  try {
    const [rows] = await db.query(
      "SELECT id FROM whatsapp_sessions WHERE rel_estabelecimentos_id=? LIMIT 1",
      [eid]
    );

    if (rows.length) {
      await db.query(
        "UPDATE whatsapp_sessions SET status=?, last_qr=?, session_name=? WHERE rel_estabelecimentos_id=?",
        [status, last_qr, String(eid), eid]
      );
    } else {
      await db.query(
        "INSERT INTO whatsapp_sessions (rel_estabelecimentos_id, session_name, status, last_qr) VALUES (?, ?, ?, ?)",
        [eid, String(eid), status, last_qr]
      );
    }
  } catch (err) {
    console.error("upsertSession:", err.message);
  }
}

function statusFile(eid) {
  return `${SESSION_DIR}/${eid}_status.txt`;
}

function qrFile(eid) {
  return `${SESSION_DIR}/${eid}_qr.txt`;
}

function sessionPath(eid) {
  return `${SESSION_DIR}/${eid}`;
}

async function readStatus(eid) {
  if (sessionStatus[eid]) {
    return sessionStatus[eid];
  }
  if (clients[eid]) {
    return "connecting";
  }
  const file = statusFile(eid);
  if (await fs.pathExists(file)) {
    return String(await fs.readFile(file, "utf8")).trim();
  }
  return "disconnected";
}

async function hasSavedSession(eid) {
  return fs.pathExists(`${sessionPath(eid)}/creds.json`);
}

async function clearSession(eid) {
  delete clients[eid];
  delete sessionStatus[eid];
  starting.delete(eid);
  await fs.remove(sessionPath(eid)).catch(() => {});
  await fs.remove(statusFile(eid)).catch(() => {});
  await fs.remove(qrFile(eid)).catch(() => {});
  await upsertSession(eid, { status: "disconnected", last_qr: null });
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}

function extractMessageText(msg) {
  if (!msg?.message) return "";
  return (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    msg.message.documentMessage?.caption ||
    ""
  ).trim();
}

function messagePlaceholder(msg) {
  const text = extractMessageText(msg);
  if (text) return text;
  if (msg.message?.imageMessage) return "[imagem]";
  if (msg.message?.videoMessage) return "[video]";
  if (msg.message?.audioMessage) return "[audio]";
  if (msg.message?.documentMessage) return "[documento]";
  if (msg.message?.stickerMessage) return "[sticker]";
  return "";
}

function resolveContact(msg) {
  const remoteJid = String(msg.key?.remoteJid || "");
  const altJid = String(msg.key?.remoteJidAlt || msg.key?.participant || "");

  if (remoteJid.endsWith("@s.whatsapp.net")) {
    return {
      jid: remoteJid,
      phone: remoteJid.split("@")[0].replace(/\D/g, ""),
    };
  }

  if (altJid.endsWith("@s.whatsapp.net")) {
    return {
      jid: remoteJid,
      phone: altJid.split("@")[0].replace(/\D/g, ""),
    };
  }

  return {
    jid: remoteJid,
    phone: remoteJid.split("@")[0].replace(/\D/g, ""),
  };
}

async function forwardToRapidex(eid, numero, message, fromMe, pushName, jid = "") {
  if (!WEBHOOK_TOKEN || !message) return;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: WEBHOOK_TOKEN,
        eid: Number(eid),
        from: numero,
        jid: jid || "",
        message,
        fromMe: !!fromMe,
        pushName: pushName || "",
      }),
    });
    if (!res.ok) {
      console.error(`webhook ${eid}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`webhook ${eid}:`, err.message);
  }
}

async function maybeForwardToGroup(sock, eid, remoteJid, msg, numero, texto) {
  if (!FORWARD_GROUP || remoteJid.endsWith("@g.us")) return;

  const agora = new Date();
  const horario = agora.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dataBR = agora.toLocaleDateString("pt-BR");

  let lojaNome = `Loja ${eid}`;
  try {
    const [rows] = await db.query(
      "SELECT nome FROM estabelecimentos WHERE id=? LIMIT 1",
      [eid]
    );
    if (rows.length && rows[0].nome) lojaNome = rows[0].nome;
  } catch {
    /* ignore */
  }

  const header =
    `📩 *Mensagem*\n\n` +
    `👤 *Cliente:* ${numero}\n` +
    `💬 *Texto:* ${texto || messagePlaceholder(msg)}\n` +
    `🕒 ${horario} — ${dataBR}\n` +
    `🏪 *Loja:* ${lojaNome}`;

  try {
    await sock.sendMessage(FORWARD_GROUP, { text: header });
  } catch (err) {
    console.error(`forwardGroup ${eid}:`, err.message);
  }
}

async function sendTextMessage(eid, to, message, jid = "") {
  const key = String(eid);
  const status = await readStatus(key);

  if (status !== "connected" || !clients[key]) {
    return { success: false, error: "not_connected" };
  }

  const text = String(message || "").trim();
  if (!text) {
    return { success: false, error: "empty_message" };
  }

  try {
    const sock = clients[key];
    const targetJid = String(jid || "").trim();

    if (targetJid.includes("@")) {
      await sock.sendMessage(targetJid, { text });
      return { success: true };
    }

    const phone = normalizePhone(to);
    if (!phone) {
      return { success: false, error: "invalid_number" };
    }

    const [result] = await sock.onWhatsApp(phone);
    if (!result?.exists) {
      return { success: false, error: "number_not_found" };
    }
    await sock.sendMessage(result.jid, { text });
    return { success: true };
  } catch (err) {
    console.error(`send ${key}:`, err.message);
    return { success: false, error: err.message || "send_failed" };
  }
}

async function startClient(rawEid) {
  const eid = String(rawEid);
  if (clients[eid]) return clients[eid];
  if (starting.has(eid)) return clients[eid] || null;

  starting.add(eid);
  sessionStatus[eid] = "connecting";
  await upsertSession(eid, { status: "connecting" });

  try {
    const authPath = sessionPath(eid);
    await fs.ensureDir(authPath);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Iniciando sessao ${eid}...`);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Rapidex", "Chrome", "120.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    clients[eid] = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        const qrData = await qrcode.toDataURL(qr);
        await fs.writeFile(qrFile(eid), qrData);
        await fs.writeFile(statusFile(eid), "disconnected");
        sessionStatus[eid] = "disconnected";
        await upsertSession(eid, { status: "disconnected", last_qr: qrData });
        console.log(`QR gerado para loja ${eid}`);
      }

      if (connection === "open") {
        console.log(`Loja ${eid} conectada`);
        sessionStatus[eid] = "connected";
        await fs.writeFile(statusFile(eid), "connected");
        if (await fs.pathExists(qrFile(eid))) await fs.remove(qrFile(eid));
        await upsertSession(eid, { status: "connected", last_qr: null });
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(`Sessao ${eid} desconectada (${reason || "?"})`);
        sessionStatus[eid] = "disconnected";
        await fs.writeFile(statusFile(eid), "disconnected");
        await upsertSession(eid, { status: "disconnected" });
        delete clients[eid];

        if (reason === DisconnectReason.loggedOut) {
          await clearSession(eid);
          return;
        }

        setTimeout(() => {
          if (!clients[eid]) startClient(eid).catch(() => {});
        }, 5000);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (!msg?.message || !msg.key?.remoteJid) return;

        const remoteJid = msg.key.remoteJid;
        if (remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast")) return;

        const contact = resolveContact(msg);
        const numero = contact.phone;
        const waJid = contact.jid;
        if (!numero || !waJid) return;

        const texto = messagePlaceholder(msg);
        const fromMe = !!msg.key.fromMe;
        const pushName = msg.pushName || "";

        forwardToRapidex(eid, numero, texto, fromMe, pushName, waJid).catch(() => {});
        maybeForwardToGroup(sock, eid, remoteJid, msg, numero, texto).catch(() => {});
      } catch (err) {
        console.error(`messages.upsert ${eid}:`, err.message);
      }
    });

    return sock;
  } finally {
    starting.delete(eid);
  }
}

async function restoreSessions() {
  let entries = [];
  try {
    entries = await fs.readdir(SESSION_DIR);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const creds = `${SESSION_DIR}/${name}/creds.json`;
    if (await fs.pathExists(creds)) {
      startClient(name).catch((err) =>
        console.error(`restore ${name}:`, err.message)
      );
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "rapidex-baileys" });
});

app.get("/status", async (req, res) => {
  const eid = String(req.query.eid || "").trim();
  if (!eid) {
    return res.status(400).json({ success: false, error: "eid_required" });
  }

  let status = await readStatus(eid);

  if (status !== "connected" && !clients[eid] && !starting.has(eid)) {
    startClient(eid).catch(() => {});
    status = sessionStatus[eid] || "connecting";
  } else if (clients[eid] && status === "disconnected") {
    status = sessionStatus[eid] || "connecting";
  }

  res.json({ eid, status, conectado: status === "connected" });
});

app.get("/qr", async (req, res) => {
  const eid = String(req.query.eid || "").trim();
  if (!eid) {
    return res.status(400).json({ success: false, error: "eid_required" });
  }

  const file = qrFile(eid);
  if (await fs.pathExists(file)) {
    return res.json({ qr: await fs.readFile(file, "utf8") });
  }

  await startClient(eid);

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await fs.pathExists(file)) {
      return res.json({ qr: await fs.readFile(file, "utf8") });
    }
    if ((await readStatus(eid)) === "connected") {
      return res.json({ qr: null, status: "connected" });
    }
  }

  // Credenciais antigas podem impedir novo QR — força sessão limpa
  if (await hasSavedSession(eid)) {
    await clearSession(eid);
    await startClient(eid);
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await fs.pathExists(file)) {
        return res.json({ qr: await fs.readFile(file, "utf8"), reset: true });
      }
    }
  }

  res.json({ qr: null, status: await readStatus(eid) });
});

app.post("/send", async (req, res) => {
  const eid = String(req.body?.eid || "").trim();
  const to = req.body?.to;
  const message = req.body?.message;
  const jid = String(req.body?.jid || "").trim();

  if (!eid || !message || (!to && !jid)) {
    return res.status(400).json({ success: false, error: "missing_params" });
  }

  const result = await sendTextMessage(eid, to, message, jid);
  if (!result.success) {
    return res.status(result.error === "not_connected" ? 503 : 400).json(result);
  }

  res.json(result);
});

app.post("/queue", async (req, res) => {
  const eid = Number(req.body?.eid || 0);
  const to = String(req.body?.to || "").replace(/\D/g, "");
  const message = String(req.body?.message || "").trim();

  if (eid <= 0 || !to || !message) {
    return res.status(400).json({ success: false, error: "missing_params" });
  }

  await db.query(
    `INSERT INTO whatsapp_fila
      (rel_estabelecimentos_id, numero, mensagem, status, agendado_para, criado_em)
     VALUES (?, ?, ?, 'pendente', NOW(), NOW())`,
    [eid, to, message]
  );

  res.json({ success: true });
});

await ensureSessionTable();
await restoreSessions();

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`Rapidex Baileys na porta ${PORT}`);
  if (!WEBHOOK_TOKEN) {
    console.warn("WHATS_WEBHOOK_TOKEN ausente: bot/inbox do painel nao recebera mensagens.");
  }
});
