import "./preload.mjs";
import express from "express";
import qrcode from "qrcode";
import fs from "fs-extra";
import cors from "cors";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  USyncQuery,
  USyncUser,
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
const lidMaps = Object.create(null);
const activeHistorySync = Object.create(null);
const historyReceived = Object.create(null);
const historyBootstrapTimers = Object.create(null);

function getLidMap(eid) {
  if (!lidMaps[eid]) {
    lidMaps[eid] = new Map();
  }
  return lidMaps[eid];
}

async function loadLidMap(eid) {
  const file = `${sessionPath(eid)}/lid-map.json`;
  try {
    const data = await fs.readJson(file);
    const map = getLidMap(eid);
    for (const [lid, phone] of Object.entries(data || {})) {
      if (lid && phone) {
        map.set(lid, String(phone));
      }
    }
  } catch {
    /* first run */
  }
}

async function saveLidMap(eid) {
  const map = getLidMap(eid);
  const data = Object.fromEntries(map.entries());
  await fs.writeJson(`${sessionPath(eid)}/lid-map.json`, data).catch(() => {});
}

function rememberLidPhone(eid, lid, phone) {
  const lidJid = String(lid || "");
  const normalized = normalizePhone(phone);
  if (!lidJid || !normalized) return;
  getLidMap(eid).set(lidJid, normalized);
  saveLidMap(eid).catch(() => {});
}

/** Preenche lid-map a partir de contatos/chats do historico (antes de importar msgs). */
function ingestLidMappings(eid, contacts = [], chats = []) {
  const rememberPair = (lidRaw, phoneRaw) => {
    const phone = normalizePhone(phoneRaw);
    if (!phone) return;
    let lid = String(lidRaw || "").trim();
    if (!lid) return;
    if (!lid.includes("@")) {
      lid = `${lid}@lid`;
    }
    if (!lid.endsWith("@lid")) return;
    rememberLidPhone(eid, lid, phone);
  };

  for (const contact of contacts) {
    const pn = String(contact?.phoneNumber || contact?.pnJid || "");
    let phone = phoneFromJid(pn);
    if (!phone && pn) {
      phone = normalizePhone(pn);
    }
    if (!phone) continue;

    rememberPair(contact?.lid || contact?.lidJid, phone);
    rememberPair(
      String(contact?.id || "").endsWith("@lid") ? contact.id : "",
      phone
    );
  }

  for (const chat of chats) {
    const pnJid = String(chat?.pnJid || "");
    const phone = phoneFromJid(pnJid);
    if (!phone) continue;
    rememberPair(chat?.lidJid || chat?.id, phone);
    if (String(chat?.id || "").endsWith("@lid")) {
      rememberPair(chat.id, phone);
    }
  }
}

/** Cruza msgs do historico com chats/contatos para montar lid-map. */
function ingestLidFromMessages(eid, chats = [], messages = []) {
  const chatById = new Map();
  for (const chat of chats) {
    if (chat?.id) chatById.set(String(chat.id), chat);
  }

  for (const msg of messages) {
    const remoteJid = String(msg?.key?.remoteJid || "");
    const altJid = String(
      msg?.key?.remoteJidAlt || msg?.key?.participantAlt || ""
    );

    if (remoteJid.endsWith("@lid") && isPnJid(altJid)) {
      rememberLidPhone(eid, remoteJid, phoneFromJid(altJid));
    }

    if (remoteJid.endsWith("@lid")) {
      const chat = chatById.get(remoteJid);
      const pn = String(chat?.pnJid || "");
      if (pn) {
        rememberLidPhone(eid, remoteJid, phoneFromJid(pn));
      }
    }
  }
}

async function syncLidMappingsToSignalStore(sock, contacts = [], chats = []) {
  const store = sock?.signalRepository?.lidMapping?.storeLIDPNMappings;
  if (!store) return 0;

  const pairs = [];
  const seen = new Set();
  const addPair = (lidRaw, pnRaw) => {
    const lid = String(lidRaw || "").trim();
    const pn = String(pnRaw || "").trim();
    if (!lid.endsWith("@lid") || !isPnJid(pn)) return;
    const key = `${lid}|${pn}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ lid, pn });
  };

  for (const contact of contacts) {
    addPair(
      contact?.lid ||
        contact?.lidJid ||
        (String(contact?.id || "").endsWith("@lid") ? contact.id : ""),
      contact?.phoneNumber || contact?.pnJid
    );
  }

  for (const chat of chats) {
    addPair(chat?.lidJid, chat?.pnJid);
    if (String(chat?.id || "").endsWith("@lid")) {
      addPair(chat.id, chat?.pnJid);
    }
  }

  if (!pairs.length) return 0;
  await store(pairs);
  return pairs.length;
}

function collectLidJids(...sources) {
  const lids = new Set();
  const remember = (raw) => {
    const jid = String(raw || "").trim();
    if (jid.endsWith("@lid") || jid.endsWith("@hosted.lid")) {
      lids.add(jid);
    }
  };

  for (const list of sources) {
    for (const item of list || []) {
      remember(item?.key?.remoteJid);
      remember(item?.key?.remoteJidAlt);
      remember(item?.key?.participantAlt);
      remember(item?.id);
      remember(item?.lid);
      remember(item?.lidJid);
    }
  }

  return [...lids];
}

function unresolvedLidJids(eid, lidJids) {
  const map = getLidMap(eid);
  return lidJids.filter((lid) => !map.get(lid));
}

function normalizeLidJid(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.includes("@")) return value;
  return `${value}@lid`;
}

function isLidJid(jid) {
  const j = String(jid || "");
  return j.endsWith("@lid") || j.endsWith("@hosted.lid");
}

/** Extrai pares LID↔PN do retorno USync (id pode ser LID ou PN). */
function extractLidPnPairsFromUsync(rows) {
  const pairs = [];
  const seen = new Set();

  for (const row of rows || []) {
    const id = String(row?.id || "").trim();
    const lidField = String(row?.lid || "").trim();
    let lid = "";
    let pn = "";

    if (isLidJid(id)) {
      lid = id;
      if (isPnJid(lidField)) {
        pn = lidField;
      } else if (/^\d+$/.test(lidField)) {
        pn = `${lidField}@s.whatsapp.net`;
      }
    } else if (isPnJid(id) && lidField) {
      pn = id;
      lid = normalizeLidJid(lidField);
    }

    if (!lid || !pn || !isPnJid(pn)) continue;
    const key = `${lid}|${pn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ lid, pn });
  }

  return pairs;
}

async function storeLidPnPairs(sock, eid, pairs) {
  if (!pairs.length) return 0;

  if (sock?.signalRepository?.lidMapping?.storeLIDPNMappings) {
    await sock.signalRepository.lidMapping.storeLIDPNMappings(pairs);
  }

  let stored = 0;
  for (const { lid, pn } of pairs) {
    const phone = phoneFromJid(pn);
    if (phone) {
      rememberLidPhone(eid, lid, phone);
      stored += 1;
    }
  }
  return stored;
}

async function usyncQueryLidPairs(sock, lids, mode = "message") {
  if (!sock?.executeUSyncQuery || !lids.length) return [];

  const strategies = [
    () => {
      const query = new USyncQuery()
        .withContext(mode)
        .withDeviceProtocol()
        .withLIDProtocol();
      for (const lid of lids) {
        query.withUser(new USyncUser().withId(lid).withLid(lid));
      }
      return query;
    },
    () => {
      const query = new USyncQuery().withContext("interactive").withLIDProtocol();
      for (const lid of lids) {
        query.withUser(new USyncUser().withId(lid).withLid(lid));
      }
      return query;
    },
  ];

  const allPairs = [];
  const seen = new Set();

  for (const build of strategies) {
    try {
      const result = await sock.executeUSyncQuery(build());
      for (const pair of extractLidPnPairsFromUsync(result?.list || [])) {
        const key = `${pair.lid}|${pair.pn}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allPairs.push(pair);
      }
      if (allPairs.length) break;
    } catch {
      /* tenta proxima estrategia */
    }
  }

  return allPairs;
}

/** Resolve LID→PN via USync (mesmo fluxo do Baileys ao enviar mensagem). */
async function resolveLidsViaUsync(sock, eid, lidJids) {
  const pending = unresolvedLidJids(eid, lidJids);
  if (!pending.length || !sock?.executeUSyncQuery) {
    return 0;
  }

  let resolved = 0;
  const batchSize = 10;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const pairs = await usyncQueryLidPairs(sock, batch, "message");
    if (!pairs.length) {
      console.warn(
        `resolveLidsViaUsync ${eid}: 0 pares para LIDs ${batch.slice(0, 2).join(", ")}`
      );
      continue;
    }

    resolved += await storeLidPnPairs(sock, eid, pairs);
  }

  if (resolved > 0) {
    await saveLidMap(eid);
  }

  return resolved;
}

async function preflightHistoryLids(eid, sock, messages, chats, contacts) {
  if (!sock) return 0;

  const lids = collectLidJids(messages, chats, contacts);
  const pending = unresolvedLidJids(eid, lids);
  if (!pending.length) return 0;

  let resolved = await resolveLidsViaUsync(sock, eid, pending);

  for (const lid of pending) {
    if (getLidMap(eid).get(lid)) continue;
    try {
      const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
      const phone = phoneFromJid(pnJid);
      if (phone) {
        rememberLidPhone(eid, lid, phone);
        resolved += 1;
      }
    } catch {
      /* ignore */
    }
  }

  if (resolved > 0) {
    await saveLidMap(eid);
  }

  return resolved;
}

async function resolveLidsFromChatsCache(eid, sock) {
  const chats = await loadChatsCache(eid);
  const lids = collectLidJids(chats, [], []);
  if (!lids.length) return 0;
  return resolveLidsViaUsync(sock, eid, lids);
}

async function finalizeHistorySync(eid, sock) {
  const cacheResolved = await resolveLidsFromChatsCache(eid, sock);
  if (cacheResolved > 0) {
    console.log(`history ${eid}: ${cacheResolved} LIDs resolvidos via chats-cache`);
  }
  finishHistorySync(eid, "Historico sincronizado.");
}

function logHistoryDebug(eid, chats, contacts, messages) {
  const sampleMsgs = (messages || []).slice(0, 2).map((m) => ({
    remoteJid: m?.key?.remoteJid,
    remoteJidAlt: m?.key?.remoteJidAlt,
    participantAlt: m?.key?.participantAlt,
    fromMe: m?.key?.fromMe,
  }));
  const sampleChats = (chats || []).slice(0, 2).map((c) => ({
    id: c?.id,
    pnJid: c?.pnJid,
    lidJid: c?.lidJid,
  }));
  const sampleContacts = (contacts || []).slice(0, 2).map((c) => ({
    id: c?.id,
    phoneNumber: c?.phoneNumber,
    lid: c?.lid,
  }));
  console.warn(
    `history ${eid}: debug samples msgs=${JSON.stringify(sampleMsgs)} chats=${JSON.stringify(sampleChats)} contacts=${JSON.stringify(sampleContacts)}`
  );
}

function chatsCacheFile(eid) {
  return `${sessionPath(eid)}/chats-cache.json`;
}

async function loadChatsCache(eid) {
  try {
    const data = await fs.readJson(chatsCacheFile(eid));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function mergeChatsCache(eid, incoming) {
  if (!incoming?.length) return;
  const current = await loadChatsCache(eid);
  const byId = new Map(current.map((c) => [String(c.id || ""), c]));
  for (const chat of incoming) {
    const id = String(chat?.id || "");
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...chat, id });
  }
  await fs
    .writeJson(chatsCacheFile(eid), Array.from(byId.values()).slice(0, 500))
    .catch(() => {});
}

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

function isValidPhoneDigits(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length < 10 || d.length > 13) {
    return false;
  }
  return true;
}

function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!isValidPhoneDigits(digits)) {
    return "";
  }
  if (digits.length >= 10 && digits.length <= 11 && !digits.startsWith("55")) {
    digits = `55${digits}`;
  }
  if (!isValidPhoneDigits(digits)) {
    return "";
  }
  return digits;
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

function isPnJid(jid) {
  const j = String(jid || "");
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@hosted");
}

/** Extrai telefone do user part do JID (ignora sufixo :device). */
function phoneFromJid(jid) {
  const raw = String(jid || "").trim();
  if (!raw) return "";
  const user = raw.split("@")[0].split(":")[0];
  return normalizePhone(user);
}

/** User part bruto de @lid (nao valida como telefone BR). */
function lidUserFromJid(jid) {
  const raw = String(jid || "").trim();
  if (!isLidJid(raw)) return "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function resolveContact(msg, eid = "") {
  const remoteJid = String(msg.key?.remoteJid || "");
  const altJid = String(
    msg.key?.remoteJidAlt ||
      msg.key?.participantAlt ||
      msg.key?.participant ||
      ""
  );
  const map = eid ? getLidMap(eid) : new Map();

  for (const jid of [altJid, remoteJid]) {
    if (!isPnJid(jid)) continue;
    const phone = phoneFromJid(jid);
    if (phone) {
      return { jid: remoteJid || jid, phone };
    }
  }

  for (const jid of [remoteJid, altJid]) {
    if (!jid.endsWith("@lid")) continue;
    const mapped = map.get(jid);
    if (mapped) {
      const phone = normalizePhone(mapped);
      if (phone) {
        return { jid: remoteJid || jid, phone };
      }
    }
  }

  return { jid: remoteJid, phone: "" };
}

async function resolveContactAsync(msg, eid = "", sock = null) {
  const base = resolveContact(msg, eid);
  if (base.phone) return base;

  const remoteJid = String(msg.key?.remoteJid || "");
  const altJid = String(
    msg.key?.remoteJidAlt ||
      msg.key?.participantAlt ||
      msg.key?.participant ||
      ""
  );
  const lidMapping = sock?.signalRepository?.lidMapping;

  if (lidMapping?.getPNForLID) {
    for (const jid of [remoteJid, altJid]) {
      if (!jid.endsWith("@lid")) continue;
      try {
        const pnJid = await lidMapping.getPNForLID(jid);
        const phone = phoneFromJid(pnJid);
        if (phone) {
          rememberLidPhone(eid, jid, phone);
          return { jid: remoteJid || jid, phone };
        }
      } catch {
        /* ignore */
      }
    }
  }

  return base;
}

async function resolveMessageContact(msg, eid = "", sock = null) {
  const remoteJid = String(msg?.key?.remoteJid || "");
  const altJid = String(
    msg?.key?.remoteJidAlt ||
      msg?.key?.participantAlt ||
      msg?.key?.participant ||
      ""
  );

  const contact = await resolveContactAsync(msg, eid, sock);
  let phone = contact.phone;
  let jid = String(contact.jid || remoteJid);

  if (isPnJid(altJid)) {
    const pn = phoneFromJid(altJid);
    if (pn) {
      phone = pn;
      if (isLidJid(remoteJid)) {
        rememberLidPhone(eid, remoteJid, pn);
        jid = remoteJid;
      }
    }
  }

  if (!phone && isLidJid(remoteJid)) {
    phone = lidUserFromJid(remoteJid);
    jid = remoteJid;
    console.warn(
      `[${eid || "?"}] resolveMessageContact: somente LID disponível (${remoteJid}), PN não resolvido`
    );
  }

  return { phone, jid, remoteJid };
}

async function messageToPayloadAsync(msg, eid = "", sock = null) {
  if (!msg?.message || !msg.key?.remoteJid || shouldSkipJid(msg.key.remoteJid)) {
    return null;
  }

  const texto = messagePlaceholder(msg);
  if (!texto) return null;

  const { phone, jid } = await resolveMessageContact(msg, eid, sock);
  if (!phone || !jid) return null;

  return {
    from: phone,
    jid,
    message: texto,
    fromMe: !!msg.key.fromMe,
    pushName: msg.pushName || msg.verifiedBizName || "",
    msgId: String(msg.key.id || ""),
    timestamp: parseMessageTimestamp(msg),
  };
}

function contactDisplayName(contact) {
  return String(
    contact?.name || contact?.notify || contact?.verifiedName || ""
  ).trim();
}

function contactPhoneFromBaileys(contact, eid = "") {
  const map = eid ? getLidMap(eid) : new Map();
  const pn = String(contact?.phoneNumber || contact?.pnJid || "");
  if (isPnJid(pn)) {
    return phoneFromJid(pn);
  }
  if (pn) {
    return normalizePhone(pn);
  }

  const id = String(contact?.id || "");
  if (isPnJid(id)) {
    return phoneFromJid(id);
  }

  const lid = String(contact?.lid || contact?.lidJid || "");
  if (lid.endsWith("@lid")) {
    const mapped = map.get(lid);
    if (mapped) {
      return normalizePhone(mapped);
    }
  }
  if (id.endsWith("@lid")) {
    const mapped = map.get(id);
    if (mapped) {
      return normalizePhone(mapped);
    }
  }

  return "";
}

function contactPhotoFromBaileys(contact) {
  const img = String(contact?.imgUrl || "");
  if (img.startsWith("http://") || img.startsWith("https://")) {
    return img;
  }
  return "";
}

function contactsToPayload(contacts, eid = "") {
  const out = [];
  const seen = new Set();

  for (const contact of contacts || []) {
    const phone = contactPhoneFromBaileys(contact, eid);
    const name = contactDisplayName(contact);
    const jid = String(contact?.id || "");
    const photo = contactPhotoFromBaileys(contact);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push({
      phone,
      name,
      jid,
      photo,
    });
  }

  return out;
}

async function forwardContactsToRapidex(eid, contacts, sock = null) {
  let payload = contactsToPayload(contacts, eid);

  if (sock && payload.length) {
    const enriched = [];
    for (const row of payload) {
      let photo = row.photo || "";
      if (!photo && row.jid) {
        try {
          photo = (await sock.profilePictureUrl(row.jid, "image")) || "";
        } catch {
          photo = "";
        }
      }
      enriched.push({ ...row, photo });
    }
    payload = enriched;
  }

  if (!WEBHOOK_TOKEN || !payload.length) {
    return { updated: 0 };
  }

  try {
    const res = await fetch(HISTORY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: WEBHOOK_TOKEN,
        eid: Number(eid),
        contacts: payload,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`contacts webhook ${eid}: HTTP ${res.status}`);
      return { updated: 0 };
    }
    return { updated: Number(data.names_updated || data.updated || 0) };
  } catch (err) {
    console.error(`contacts webhook ${eid}:`, err.message);
    return { updated: 0 };
  }
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

async function scheduleHistoryBootstrap(eid, sock) {
  clearTimeout(historyBootstrapTimers[eid]);
  historyBootstrapTimers[eid] = setTimeout(async () => {
    delete historyBootstrapTimers[eid];
    if (historyReceived[eid] || !clients[eid]) return;

    console.log(
      `history ${eid}: sync inicial nao veio (reconexao?) — tentando chats-cache...`
    );
    const cached = await requestHistoryFromCachedChats(eid, sock);
    console.log(
      `history ${eid}: bootstrap cache requested=${cached.requested} (${cached.note})`
    );
  }, 25000);
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

async function forwardHistoryBatch(eid, messages, sock = null) {
  if (!WEBHOOK_TOKEN || !messages?.length) {
    return { imported: 0, skipped: 0 };
  }

  await preflightHistoryLids(eid, sock, messages, [], []);

  const payloads = [];
  for (const msg of messages) {
    const row = await messageToPayloadAsync(msg, eid, sock);
    if (row) payloads.push(row);
  }

  if (!payloads.length) {
    const sample = messages.slice(0, 1)[0];
    const remoteJid = String(sample?.key?.remoteJid || "");
    const texto = sample ? messagePlaceholder(sample) : "";
    console.warn(
      `history ${eid}: ${messages.length} msgs mas 0 payloads (jid=${remoteJid}, texto=${texto ? "ok" : "vazio"}, lidUser=${lidUserFromJid(remoteJid) || "?"})`
    );
    logHistoryDebug(eid, [], [], messages);
    return { imported: 0, skipped: messages.length };
  }

  console.log(
    `history ${eid}: ${payloads.length}/${messages.length} msgs -> webhook (${payloads.filter((p) => String(p.jid || "").includes("@lid")).length} via @lid)`
  );

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
          console.log(
            `history ${eid}: webhook ok imported=${data.imported ?? "?"} skipped=${data.skipped ?? "?"}`
          );
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

  const texto = messagePlaceholder(msg);
  if (!texto) return;

  const { phone, jid } = await resolveMessageContact(msg, eid, sock);
  if (!phone || !jid) return;

  const fromMe = !!msg.key.fromMe;
  const pushName = msg.pushName || msg.verifiedBizName || "";
  const msgId = String(msg.key.id || "");

  forwardToRapidex(eid, phone, texto, fromMe, pushName, jid, msgId).catch(
    () => {}
  );
  maybeForwardToGroup(sock, eid, msg.key.remoteJid, msg, phone, texto).catch(
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

async function requestHistoryFromCachedChats(eid, sock) {
  const chats = await loadChatsCache(eid);
  if (!chats.length) {
    return { requested: 0, note: "sem_cache" };
  }

  let requested = 0;

  for (const chat of chats.slice(0, 40)) {
    const jid = String(chat.id || "");
    if (!jid || shouldSkipJid(jid)) continue;

    const wrapped = chat.messages?.[0];
    const msg = wrapped?.message || wrapped;
    if (!msg?.key?.id || !msg?.messageTimestamp) continue;

    let tsMs = parseMessageTimestamp(msg);
    if (tsMs <= 0) continue;
    if (tsMs < 9999999999) tsMs *= 1000;

    try {
      await sock.fetchMessageHistory(50, msg.key, tsMs);
      requested += 1;
    } catch (err) {
      console.error(`fetchHistory cache ${eid}/${jid}:`, err.message);
    }
  }

  return {
    requested,
    note: requested > 0 ? "cache_ok" : "sem_ancora_cache",
  };
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

  if (requested === 0 || note === "sem_conversas" || note === "sem_ancora") {
    const cached = await requestHistoryFromCachedChats(eid, clients[eid]);
    if (cached.requested > 0) {
      return waiter;
    }
  }

  if (note === "sem_conversas") {
    finishHistorySync(
      eid,
      "Historico inicial so vem na primeira conexao (QR novo). Se apagou conversas no Rapidex, desconecte e escaneie o QR de novo, ou aguarde mensagens novas.",
      true
    );
  } else if (note === "sem_ancora") {
    finishHistorySync(
      eid,
      "Nao foi possivel ancorar o historico. Desconecte, escaneie o QR novamente e aguarde 1–2 minutos.",
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
    await loadLidMap(eid);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Iniciando sessao ${eid}...`);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS("Desktop"),
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
        historyReceived[eid] = false;
        await fs.writeFile(statusFile(eid), "connected");
        if (await fs.pathExists(qrFile(eid))) await fs.remove(qrFile(eid));
        await upsertSession(eid, { status: "connected", last_qr: null });
        scheduleHistoryBootstrap(eid, sock);
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
      rememberLidPhone(eid, lid, pn);
    });

    sock.ev.on("messaging-history.set", async ({ chats, messages, contacts, isLatest, progress }) => {
      try {
        historyReceived[eid] = true;
        clearTimeout(historyBootstrapTimers[eid]);
        delete historyBootstrapTimers[eid];

        const nMsg = (messages || []).length;
        const nChat = (chats || []).length;
        const nContact = (contacts || []).length;

        if (nMsg === 0 && nChat === 0 && nContact === 0) {
          console.log(
            `history ${eid}: chunk metadata vazio (progress=${progress ?? "?"}, latest=${!!isLatest})`
          );
          if (isLatest) {
            await finalizeHistorySync(eid, sock);
          }
          return;
        }

        if (chats?.length) {
          await mergeChatsCache(eid, chats);
        }

        ingestLidMappings(eid, contacts, chats);
        ingestLidFromMessages(eid, chats, messages);
        const signalPairs = await syncLidMappingsToSignalStore(sock, contacts, chats);
        const usyncResolved = await preflightHistoryLids(
          eid,
          sock,
          messages,
          chats,
          contacts
        );
        await saveLidMap(eid);
        const mapSize = getLidMap(eid).size;
        console.log(
          `history ${eid}: chunk chats=${nChat} msgs=${nMsg} contacts=${nContact} | lid-map ${mapSize}, usync ${usyncResolved} (progress=${progress ?? "?"})`
        );
        if (mapSize === 0 && usyncResolved === 0 && (nMsg > 0 || nChat > 0)) {
          logHistoryDebug(eid, chats, contacts, messages);
        }

        if (contacts?.length) {
          await forwardContactsToRapidex(eid, contacts, sock);
        }

        const batch = (messages || []).filter(
          (msg) => msg?.message && msg.key?.remoteJid && !shouldSkipJid(msg.key.remoteJid)
        );
        if (!batch.length) {
          if (isLatest) {
            await finalizeHistorySync(eid, sock);
          }
          return;
        }

        console.log(
          `history ${eid}: importando ${batch.length} msgs (latest=${!!isLatest})`
        );
        await forwardHistoryBatch(eid, batch, sock);

        if (isLatest) {
          await finalizeHistorySync(eid, sock);
        }
      } catch (err) {
        console.error(`messaging-history.set ${eid}:`, err.message);
      }
    });

    sock.ev.on("chats.upsert", async (chats) => {
      try {
        if (chats?.length) {
          await mergeChatsCache(eid, chats);
          ingestLidMappings(eid, [], chats);
          await saveLidMap(eid);
        }
      } catch (err) {
        console.error(`chats.upsert ${eid}:`, err.message);
      }
    });

    sock.ev.on("contacts.upsert", async (contacts) => {
      try {
        if (!contacts?.length) return;
        ingestLidMappings(eid, contacts, []);
        await saveLidMap(eid);
        await forwardContactsToRapidex(eid, contacts, sock);
      } catch (err) {
        console.error(`contacts.upsert ${eid}:`, err.message);
      }
    });

    sock.ev.on("contacts.update", async (contacts) => {
      try {
        if (!contacts?.length) return;
        ingestLidMappings(eid, contacts, []);
        await saveLidMap(eid);
      } catch (err) {
        console.error(`contacts.update ${eid}:`, err.message);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      try {
        if (type === "notify") {
          for (const msg of messages || []) {
            await processLiveMessage(sock, eid, msg);
          }
          return;
        }

        if (type === "append") {
          const batch = (messages || []).filter(
            (msg) => msg?.message && msg.key?.remoteJid && !shouldSkipJid(msg.key.remoteJid)
          );
          if (batch.length) {
            await forwardHistoryBatch(eid, batch, sock);
          }
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
  res.json({ ok: true, service: "rapidex-baileys", version: "2.3.2" });
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

app.get("/avatar", async (req, res) => {
  const eid = String(req.query.eid || "").trim();
  const jid = String(req.query.jid || "").trim();
  if (!eid || !jid || !clients[eid]) {
    return res.status(404).end();
  }

  try {
    const url = await clients[eid].profilePictureUrl(jid, "image");
    if (!url) {
      return res.status(404).end();
    }
    return res.redirect(302, url);
  } catch {
    return res.status(404).end();
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

if (process.env.RAILWAY_ENVIRONMENT && SESSION_DIR === "./sessions") {
  console.warn(
    "AVISO: monte um Volume no Railway em /app/sessions e defina SESSION_DIR=/app/sessions — senao cada deploy desconecta o WhatsApp."
  );
}

process.on("SIGTERM", () => {
  console.log("SIGTERM recebido — encerrando sem logout (sessao preservada no disco).");
  process.exit(0);
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`Rapidex Baileys v2.3.2 na porta ${PORT}`);
  console.log(`syncFullHistory=${SYNC_FULL_HISTORY}`);
  console.log(`historyWebhook=${HISTORY_WEBHOOK_URL}`);
  if (!WEBHOOK_TOKEN) {
    console.warn(
      "WHATS_WEBHOOK_TOKEN ausente: historico e mensagens NAO serao enviados ao Rapidex."
    );
  }
  if (API_TOKEN) {
    console.log("BAILEYS_API_TOKEN ativo — endpoints protegidos.");
  }
});
