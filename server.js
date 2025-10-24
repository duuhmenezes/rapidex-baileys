import express from "express";
import qrcode from "qrcode";
import fs from "fs-extra";
import cors from "cors";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://rapidex.app.br", "https://painel.rapidex.app.br"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

const SESSION_DIR = "./sessions";
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);

const clients = {};

async function startClient(eid) {
  const sessionPath = `${SESSION_DIR}/${eid}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion(); // garante compatibilidade

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

// ===================== ROTAS =====================
app.get("/qr", async (req, res) => {
  const { eid } = req.query;
  if (!eid) return res.status(400).json({ error: "eid obrigatório" });

  const file = `${SESSION_DIR}/${eid}_qr.txt`;
  if (fs.existsSync(file)) {
    return res.json({ qr: await fs.readFile(file, "utf8") });
  }

  await startClient(eid);
  setTimeout(async () => {
    if (fs.existsSync(file)) {
      res.json({ qr: await fs.readFile(file, "utf8") });
    } else {
      res.json({ qr: null });
    }
  }, 3000);
});

app.get("/status", async (req, res) => {
  const { eid } = req.query;
  const file = `${SESSION_DIR}/${eid}_status.txt`;
  let status = "desconhecido";
  if (fs.existsSync(file)) status = await fs.readFile(file, "utf8");
  res.json({
    eid,
    conectado: status === "connected",
    status,
  });
});

app.post("/send", async (req, res) => {
  const { eid, to, message } = req.body;
  if (!eid || !to || !message)
    return res.status(400).json({ error: "Parâmetros faltando." });

  try {
    const sock = clients[eid] || await startClient(eid);

    // normaliza número (remove +, espaços, traços)
    const cleaned = to.toString().replace(/\D/g, "");

    // resolve ID válido (checa se o número existe no WhatsApp)
    const [result] = await sock.onWhatsApp(cleaned);
    if (!result || !result.exists) {
      return res.json({ success: false, error: "Número não encontrado no WhatsApp." });
    }

    const jid = result.jid;
    console.log(`📤 Enviando para ${jid}`);

    await sock.sendMessage(jid, { text: message });

    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao enviar:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 Rapidex WhatsApp Server (Baileys v7)</h1>
    <p>Status: <a href="/status?eid=1">/status?eid=1</a></p>
    <p>QR: <a href="/qr?eid=1">/qr?eid=1</a></p>
  `);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Servidor Baileys rodando na porta ${PORT}`));
