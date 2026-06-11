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
const HISTORY_WEBHOOK_URL =
  process.env.WHATS_HISTORY_WEBHOOK_URL ||
  WEBHOOK_URL.replace(/inbound\.php$/i, "history.php");
const WEBHOOK_TOKEN = (process.env.WHATS_WEBHOOK_TOKEN || "").trim();
const API_TOKEN = (process.env.BAILEYS_API_TOKEN || "").trim();
const FORWARD_GROUP = (process.env.WHATS_FORWARD_GROUP || "").trim();
const SYNC_FULL_HISTORY =
  (process.env.WHATS_SYNC_FULL_HISTORY || "true").toLowerCase() !== "false";
const HISTORY_BATCH_SIZE = Math.max(
  10,
  Math.min(100, Number(process.env.WHATS_HISTORY_BATCH_SIZE || 80))
);
const HISTORY_SYNC_TIMEOUT_MS = Math.max(
  15000,
  Math.min(180000, Number(process.env.WHATS_HISTORY_SYNC_TIMEOUT_MS || 90000))
);

const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: corsOrigins.length
      ? corsOrigins
      : ["https://rapidex.app.br", "https://painel.rapidex.app.br"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
const lidToPhone = new Map();
const activeHistorySync = Object.create(null);

function requireApiAuth(req, res, next) {
  if (!API_TOKEN || req.path === "/health") {
    return next();
  }

  const header = String(req.headers.authorization || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const queryToken = String(req.query.token || "").trim();
  const token = bearer || queryToken;

  if (token !== API_TOKEN) {
    return res.status(401).json({ ok: false, success: false, error: "unauthorized" });
  }

  return next();
}

app.use(requireApiAuth);

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
  if (await fs.pathExists(qrFile(eid))) {
    return "qr_pending";
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
  finishHistorySync(eid, "Sessao encerrada.", true);
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

function shouldSkipJid(jid) {
  const id = String(jid || "");
  return (
    !id ||
    id.endsWith("@g.us") ||
    id.endsWith("@broadcast") ||
    id === "status@broadcast"
  );
}

function parseMessageTimestamp(msg) {
  const raw = msg?.messageTimestamp;
  if (raw == null) return 0;
  if (typeof raw === "number") {
    return raw > 9999999999 ? Math.floor(raw / 1000) : raw;
  }
  if (typeof raw === "object" && typeof raw.toNumber === "function") {
    const n = raw.toNumber();
    return n > 9999999999 ? Math.floor(n / 1000) : n;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 9999999999 ? Math.floor(n / 1000) : n;
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
  if (msg.message?.locationMessage) return "[localizacao]";
  if (msg.message?.contactMessage) return "[contato]";
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

  if (remoteJid.endsWith("@lid")) {
    const mapped = lidToPhone.get(remoteJid);
    if (mapped) {
      return { jid: remoteJid, phone: mapped.replace(/\D/g, "") };
    }
  }

  if (altJid.endsWith("@lid")) {
    const mapped = lidToPhone.get(altJid);
    if (mapped) {
      return { jid: remoteJid, phone: mapped.replace(/\D/g, "") };
    }
  }

  const fallback = remoteJid.split("@")[0].replace(/\D/g, "");
  return {
    jid: remoteJid,
    phone: fallback.length >= 10 ? fallback : "",
  };
}

function messageToPayload(msg) {
  if (!msg?.message || !msg.key?.remoteJid || shouldSkipJid(msg.key.remoteJid)) {
    return null;
  }

  const contact = resolveContact(msg);
  const texto = messagePlaceholder(msg);
  if (!contact.phone || !texto) return null;

  return {
    from: contact.phone,
    jid: contact.jid,
    message: texto,
    fromMe: !!msg.key.fromMe,
    pushName: msg.pushName || msg.verifiedBizName || "",
    msgId: String(msg.key.id || ""),
    timestamp: parseMessageTimestamp(msg),
  };
}

async function forwardToRapidex(
  eid,
  numero,
  message,
  fromMe,
  pushName,
  jid = "",
  msgId = ""
) {
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
        msgId: msgId || "",
      }),
    });
    if (!res.ok) {
      console.error(`webhook ${eid}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`webhook ${eid}:`, err.message);
  }
}

function finishHistorySync(eid, msg = "Historico sincronizado.", force = false) {
  const sync = activeHistorySync[eid];
  if (!sync) return null;

  if (!force && sync.pendingBatches > 0) {
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => finishHistorySync(eid, msg), 6000);
    return null;
  }

  if (sync.done) return null;
  sync.done = true;
  clearTimeout(sync.timer);

  const result = {
    ok: true,
    success: true,
    imported: sync.imported,
    skipped: sync.skipped,
    msg: msg || "Historico sincronizado.",
  };

  sync.resolve(result);
  delete activeHistorySync[eid];
  return result;
}

function beginHistorySync(eid) {
  if (activeHistorySync[eid]) {
    return activeHistorySync[eid].promise;
  }

  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  activeHistorySync[eid] = {
    imported: 0,
    skipped: 0,
    pendingBatches: 0,
    done: false,
    resolve: resolvePromise,
    promise,
    timer: setTimeout(
      () =>
        finishHistorySync(
          eid,
          "Tempo esgotado — historico parcial importado."
        ),
      HISTORY_SYNC_TIMEOUT_MS
    ),
  };

  return promise;
}

async function forwardHistoryBatch(eid, messages) {
  if (!WEBHOOK_TOKEN || !messages?.length) {
    return { imported: 0, skipped: 0 };
  }

  const payloads = messages
    .map((msg) => messageToPayload(msg))
    .filter(Boolean);

  if (!payloads.length) {
    return { imported: 0, skipped: messages.length };
  }

  const sync = activeHistorySync[eid];
  if (sync) sync.pendingBatches += 1;

  let imported = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < payloads.length; i += HISTORY_BATCH_SIZE) {
      const chunk = payloads.slice(i, i + HISTORY_BATCH_SIZE);
      try {
        const res = await fetch(HISTORY_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: WEBHOOK_TOKEN,
            eid: Number(eid),
            messages: chunk,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          imported += Number(data.imported ?? chunk.length);
          skipped += Number(data.skipped ?? 0);
        } else {
          skipped += chunk.length;
          console.error(`history webhook ${eid}: HTTP ${res.status}`);
        }
      } catch (err) {
        skipped += chunk.length;
        console.error(`history webhook ${eid}:`, err.message);
      }
    }
  } finally {
    if (sync) {
      sync.imported += imported;
      sync.skipped += skipped;
      sync.pendingBatches = Math.max(0, sync.pendingBatches - 1);
      if (sync.pendingBatches === 0) {
        clearTimeout(sync.timer);
        sync.timer = setTimeout(
          () => finishHistorySync(eid, "Historico sincronizado."),
          5000
        );
      }
    }
  }

  return { imported, skipped };
}

async function processLiveMessage(sock, eid, msg) {
  if (!msg?.message || !msg.key?.remoteJid || shouldSkipJid(msg.key.remoteJid)) {
    return;
  }

  const contact = resolveContact(msg);
  const numero = contact.phone;
  const waJid = contact.jid;
  if (!numero || !waJid) return;

  const texto = messagePlaceholder(msg);
  if (!texto) return;

  const fromMe = !!msg.key.fromMe;
  const pushName = msg.pushName || "";
  const msgId = String(msg.key.id || "");

  forwardToRapidex(eid, numero, texto, fromMe, pushName, waJid, msgId).catch(
    () => {}
  );
  maybeForwardToGroup(sock, eid, msg.key.remoteJid, msg, numero, texto).catch(
    () => {}
  );
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

async function requestHistoryForConversas(eid, sock) {
  const [rows] = await db.query(
    `SELECT c.numero, c.wa_jid
     FROM whatsapp_conversas c
     WHERE c.rel_estabelecimentos_id=?
     ORDER BY c.atualizado_em DESC
     LIMIT 40`,
    [eid]
  );

  if (!rows.length) {
    return { requested: 0, note: "sem_conversas" };
  }

  let requested = 0;

  for (const row of rows) {
    const phone = normalizePhone(row.numero);
    const jid =
      String(row.wa_jid || "").trim() ||
      (phone ? `${phone}@s.whatsapp.net` : "");
    if (!jid || shouldSkipJid(jid)) continue;

    const [msgs] = await db.query(
      `SELECT m.wa_msg_id, m.criado_em, m.direcao
       FROM whatsapp_chat_mensagens m
       INNER JOIN whatsapp_conversas c ON c.id = m.rel_conversa_id
       WHERE c.rel_estabelecimentos_id=? AND c.numero=?
         AND m.wa_msg_id IS NOT NULL AND m.wa_msg_id != ''
       ORDER BY m.id ASC
       LIMIT 1`,
      [eid, row.numero]
    );

    if (!msgs.length) continue;

    const oldest = msgs[0];
    const tsMs = new Date(oldest.criado_em).getTime();
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;

    try {
      await sock.fetchMessageHistory(
        50,
        {
          remoteJid: jid,
          id: String(oldest.wa_msg_id),
          fromMe: oldest.direcao === "out",
        },
        tsMs
      );
      requested += 1;
    } catch (err) {
      console.error(`fetchHistory ${eid}/${jid}:`, err.message);
    }
  }

  return { requested, note: requested > 0 ? "ok" : "sem_ancora" };
}

async function syncHistoryForEid(rawEid) {
  const eid = String(rawEid);
  const status = await readStatus(eid);

  if (status !== "connected" || !clients[eid]) {
    return {
      ok: false,
      success: false,
      error: "not_connected",
      msg: "WhatsApp nao esta conectado. Escaneie o QR em Conexao QR.",
    };
  }

  const waiter = beginHistorySync(eid);
  const { requested, note } = await requestHistoryForConversas(
    eid,
    clients[eid]
  );

  if (note === "sem_conversas") {
    finishHistorySync(
      eid,
      "Nenhuma conversa salva ainda. O historico e importado automaticamente ao conectar — aguarde alguns minutos.",
      true
    );
  } else if (note === "sem_ancora") {
    finishHistorySync(
      eid,
      "Aguardando importacao automatica do historico. Se acabou de conectar, aguarde 1–2 minutos e tente novamente.",
      true
    );
  } else if (requested === 0) {
    finishHistorySync(eid, "Nenhuma conversa elegivel para sync manual.", true);
  }

  return waiter;
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
      syncFullHistory: SYNC_FULL_HISTORY,
      markOnlineOnConnect: false,
    });

    clients[eid] = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        const qrData = await qrcode.toDataURL(qr);
        await fs.writeFile(qrFile(eid), qrData);
        await fs.writeFile(statusFile(eid), "qr_pending");
        sessionStatus[eid] = "qr_pending";
        await upsertSession(eid, { status: "qr_pending", last_qr: qrData });
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

    sock.ev.on("lid-mapping.update", ({ lid, pn }) => {
      const lidJid = String(lid || "");
      const phone = normalizePhone(pn);
      if (lidJid && phone) {
        lidToPhone.set(lidJid, phone);
      }
    });

    sock.ev.on("messaging-history.set", async ({ messages, isLatest, progress }) => {
      try {
        const batch = (messages || []).filter(
          (msg) => msg?.message && msg.key?.remoteJid && !shouldSkipJid(msg.key.remoteJid)
        );
        if (!batch.length) {
          if (isLatest) finishHistorySync(eid, "Historico sincronizado.");
          return;
        }

        console.log(
          `history ${eid}: ${batch.length} msgs (latest=${!!isLatest}, progress=${progress ?? "?"})`
        );
        await forwardHistoryBatch(eid, batch);

        if (isLatest) {
          finishHistorySync(eid, "Historico sincronizado.");
        }
      } catch (err) {
        console.error(`messaging-history.set ${eid}:`, err.message);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      try {
        for (const msg of messages || []) {
          await processLiveMessage(sock, eid, msg);
        }
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
  res.json({ ok: true, service: "rapidex-baileys", version: "2.2.0" });
});

app.get("/status", async (req, res) => {
  const eid = String(req.query.eid || "").trim();
  if (!eid) {
    return res.status(400).json({ success: false, error: "eid_required" });
  }

  let status = await readStatus(eid);

  if (
    status !== "connected" &&
    status !== "qr_pending" &&
    !clients[eid] &&
    !starting.has(eid)
  ) {
    startClient(eid).catch(() => {});
    status = sessionStatus[eid] || "connecting";
  } else if (clients[eid] && status === "disconnected") {
    status = sessionStatus[eid] || "connecting";
  }

  res.json({
    eid,
    status,
    conectado: status === "connected",
    qr_pending: status === "qr_pending",
  });
});

app.get("/qr", async (req, res) => {
  const eid = String(req.query.eid || "").trim();
  if (!eid) {
    return res.status(400).json({ success: false, error: "eid_required" });
  }

  const file = qrFile(eid);
  if (await fs.pathExists(file)) {
    return res.json({ qr: await fs.readFile(file, "utf8"), status: "qr_pending" });
  }

  await startClient(eid);

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await fs.pathExists(file)) {
      return res.json({ qr: await fs.readFile(file, "utf8"), status: "qr_pending" });
    }
    if ((await readStatus(eid)) === "connected") {
      return res.json({ qr: null, status: "connected" });
    }
  }

  if (await hasSavedSession(eid)) {
    await clearSession(eid);
    await startClient(eid);
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await fs.pathExists(file)) {
        return res.json({
          qr: await fs.readFile(file, "utf8"),
          status: "qr_pending",
          reset: true,
        });
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

app.post("/sync-history", async (req, res) => {
  const eid = String(req.query.eid || req.body?.eid || "").trim();
  if (!eid) {
    return res.status(400).json({ ok: false, success: false, error: "eid_required" });
  }

  if (activeHistorySync[eid] && !activeHistorySync[eid].done) {
    return res.status(409).json({
      ok: false,
      success: false,
      msg: "Sync de historico ja em andamento para esta loja.",
    });
  }

  try {
    const result = await syncHistoryForEid(eid);
    res.json(result);
  } catch (err) {
    console.error(`sync-history ${eid}:`, err.message);
    res.status(500).json({
      ok: false,
      success: false,
      msg: "Erro ao sincronizar historico.",
    });
  }
});

app.post("/disconnect", async (req, res) => {
  const eid = String(req.query.eid || req.body?.eid || "").trim();
  if (!eid) {
    return res.status(400).json({ success: false, error: "eid_required" });
  }

  try {
    const sock = clients[eid];
    if (sock) {
      try {
        await sock.logout();
      } catch {
        /* ignore */
      }
    }
    await clearSession(eid);
    res.json({ success: true, ok: true, status: "disconnected" });
  } catch (err) {
    console.error(`disconnect ${eid}:`, err.message);
    res.status(500).json({ success: false, error: "disconnect_failed" });
  }
});

/** @deprecated Preferir fila PHP + cron Rapidex */
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

  res.json({ success: true, deprecated: true });
});

await ensureSessionTable();
await restoreSessions();

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`Rapidex Baileys v2.2.0 na porta ${PORT}`);
  console.log(`syncFullHistory=${SYNC_FULL_HISTORY}`);
  if (!WEBHOOK_TOKEN) {
    console.warn(
      "WHATS_WEBHOOK_TOKEN ausente: bot/inbox do painel nao recebera mensagens."
    );
  }
  if (API_TOKEN) {
    console.log("BAILEYS_API_TOKEN ativo — endpoints protegidos.");
  }
});
