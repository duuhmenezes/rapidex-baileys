import express from "express";
import qrcode from "qrcode";
import fs from "fs-extra";
import cors from "cors";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import mysql from "mysql2/promise";

const app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://rapidex.app.br", "https://painel.rapidex.app.br"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// ===============================
// BANCO DE DADOS
// ===============================
const db = await mysql.createPool({
  host: "zeus.hostsrv.org",
  user: "rapidexapp_api",
  password: "OFgRk?wM1E.J",
  database: "rapidexapp_sistema"
});

// ===============================
// VARIÁVEIS GLOBAIS
// ===============================
const SESSION_DIR = "./sessions";
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);

const clients = {};

// ===============================
// FUNÇÃO DE CONEXÃO BAILEYS
// ===============================
async function startClient(eid) {
  const sessionPath = `${SESSION_DIR}/${eid}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`🟡 Iniciando sessão ${eid}...`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Rapidex", "Windows", "10.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  clients[eid] = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      const qrData = await qrcode.toDataURL(qr);
      await fs.writeFile(`${sessionPath}_qr.txt`, qrData);
      await fs.writeFile(`${sessionPath}_status.txt`, "disconnected");
      console.log(`📸 QR gerado para loja ${eid}`);
    }

    if (connection === "open") {
      console.log(`✅ Loja ${eid} conectada`);
      await fs.writeFile(`${sessionPath}_status.txt`, "connected");
      const qrFile = `${sessionPath}_qr.txt`;
      if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Sessão ${eid} desconectada (${reason || "desconhecido"})`);
      await fs.writeFile(`${sessionPath}_status.txt`, "disconnected");
      delete clients[eid];
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => startClient(eid), 5000);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
}

// ===============================
// PROCESSAMENTO DA FILA
// ===============================
async function processarFila() {
  const [mensagens] = await db.query(
    "SELECT * FROM whatsapp_fila WHERE status = 'pendente' ORDER BY id ASC LIMIT 5"
  );

  for (const msg of mensagens) {
    const { id, rel_estabelecimentos_id, numero, mensagem } = msg;
    try {
      await db.query("UPDATE whatsapp_fila SET status='enviando' WHERE id=?", [id]);

      const sock = clients[rel_estabelecimentos_id] || await startClient(rel_estabelecimentos_id);
      const cleaned = numero.replace(/\D/g, "");
      const [result] = await sock.onWhatsApp(cleaned);

      if (!result || !result.exists) {
        await db.query("UPDATE whatsapp_fila SET status='falhou', retorno='Número não existe' WHERE id=?", [id]);
        continue;
      }

      const jid = result.jid;
      await sock.sendMessage(jid, { text: mensagem });

      await db.query("UPDATE whatsapp_fila SET status='enviado', retorno='OK' WHERE id=?", [id]);
      await db.query(
        "INSERT INTO whatsapp_logs (rel_estabelecimentos_id, numero, mensagem, status, resposta) VALUES (?, ?, ?, 'enviado', 'OK')",
        [rel_estabelecimentos_id, numero, mensagem]
      );
    } catch (err) {
      await db.query("UPDATE whatsapp_fila SET status='falhou', retorno=? WHERE id=?", [err.message, id]);
      await db.query(
        "INSERT INTO whatsapp_logs (rel_estabelecimentos_id, numero, mensagem, status, resposta) VALUES (?, ?, ?, 'falhou', ?)",
        [rel_estabelecimentos_id, numero, mensagem, err.message]
      );
    }
  }
}

// Executa a cada 15 segundos
setInterval(processarFila, 15000);

// ===============================
// ROTAS API
// ===============================

// ➕ Adiciona mensagem à fila
app.post("/queue", async (req, res) => {
  const { eid, to, message } = req.body;
  if (!eid || !to || !message)
    return res.status(400).json({ error: "Parâmetros obrigatórios faltando." });

  try {
    await db.query(
      "INSERT INTO whatsapp_fila (rel_estabelecimentos_id, numero, mensagem) VALUES (?, ?, ?)",
      [eid, to, message]
    );
    res.json({ success: true, message: "Mensagem adicionada à fila." });
  } catch (err) {
    console.error("Erro ao inserir na fila:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Status de conexão
app.get("/status", async (req, res) => {
  const { eid } = req.query;
  const file = `${SESSION_DIR}/${eid}_status.txt`;
  let status = "desconhecido";
  if (fs.existsSync(file)) status = await fs.readFile(file, "utf8");
  res.json({ eid, conectado: status === "connected", status });
});

// QR Code
app.get("/qr", async (req, res) => {
  const { eid } = req.query;
  if (!eid) return res.status(400).json({ error: "eid obrigatório" });

  const file = `${SESSION_DIR}/${eid}_qr.txt`;
  if (fs.existsSync(file)) return res.json({ qr: await fs.readFile(file, "utf8") });

  await startClient(eid);
  setTimeout(async () => {
    if (fs.existsSync(file)) {
      res.json({ qr: await fs.readFile(file, "utf8") });
    } else {
      res.json({ qr: null });
    }
  }, 3000);
});

// Envio direto (fora da fila)
app.post("/send", async (req, res) => {
  const { eid, to, message } = req.body;
  if (!eid || !to || !message)
    return res.status(400).json({ error: "Parâmetros faltando." });

  try {
    const sock = clients[eid] || await startClient(eid);
    const cleaned = to.toString().replace(/\D/g, "");
    const [result] = await sock.onWhatsApp(cleaned);

    if (!result || !result.exists) {
      return res.json({ success: false, error: "Número não encontrado no WhatsApp." });
    }

    const jid = result.jid;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao enviar:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Página inicial
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 Rapidex WhatsApp Server (Baileys v7)</h1>
    <p>✅ /queue → adiciona à fila</p>
    <p>🔍 /status?eid=1 → status</p>
    <p>📸 /qr?eid=1 → QR Code</p>
  `);
});

// Inicia servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Servidor Baileys rodando na porta ${PORT}`));
