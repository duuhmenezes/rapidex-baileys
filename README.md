# Rapidex Baileys

Microservico Node.js que mantem a sessao WhatsApp Web de cada loja (`eid`) e expoe API para o Rapidex.

## Endpoints

| Metodo | Rota | Uso |
|--------|------|-----|
| GET | `/health` | Health check (Railway) |
| GET | `/status?eid=` | Status da conexao |
| GET | `/qr?eid=` | QR Code (data URL) |
| POST | `/send` | Enviar mensagem (`eid`, `to`, `message`) |
| POST | `/queue` | Enfileirar no banco (legado; preferir fila PHP + cron) |

Resposta de `/status`:

```json
{ "eid": "1", "status": "connected", "conectado": true }
```

## Variaveis de ambiente

Copie `.env.example` para `.env` (local) ou configure no Railway.

| Variavel | Obrigatoria | Descricao |
|----------|-------------|-----------|
| `DB_*` | Sim | Banco do Rapidex (mesmo do painel) |
| `WHATS_WEBHOOK_TOKEN` | Sim* | Token do webhook (`WHATS_WEBHOOK_TOKEN` ou `CRON_TOKEN` no Rapidex) |
| `WHATS_WEBHOOK_URL` | Nao | Default: `https://rapidex.app.br/api/whatsapp/inbound.php` |
| `CORS_ORIGINS` | Nao | Origens do painel |
| `SESSION_DIR` | Nao | Pasta das sessoes (default `./sessions`) |
| `WHATS_FORWARD_GROUP` | Nao | Grupo opcional para copia de mensagens |

\* Se vazio, mensagens recebidas nao disparam bot/inbox no painel.

## Deploy no Railway (Hobby)

1. Novo projeto → Deploy from GitHub (este repo).
2. **Volume** montado em `/app/sessions` (ou `SESSION_DIR=/app/sessions`).
3. Variaveis `DB_*` e `WHATS_WEBHOOK_TOKEN`.
4. No Rapidex (`.env` ou `config.php`): `WHATS_API=https://seu-app.up.railway.app`
5. Painel → WhatsApp → Gerar QR → Ativar envio automatico.
6. Cron do Rapidex: `cron.php?acao=whatsapp_fila` e `whatsapp_bot`.

## Local

```bash
cp .env.example .env
npm install
npm start
```

## Fila de envio

A fila `whatsapp_fila` e processada pelo **cron PHP** do Rapidex (`WhatsAppRepository::processQueue`), que chama `POST /send` neste servico. Este projeto **nao** processa a fila diretamente (evita duplicidade).
