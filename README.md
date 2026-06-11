# Rapidex Baileys

Microservico Node.js que mantem a sessao WhatsApp Web de cada loja (`eid`) e expoe API para o Rapidex.

## Endpoints

| Metodo | Rota | Uso |
|--------|------|-----|
| GET | `/health` | Health check (Railway) |
| GET | `/status?eid=` | Status da conexao |
| GET | `/qr?eid=` | QR Code (data URL) |
| POST | `/send` | Enviar mensagem (`eid`, `to`, `message`, `jid?`) |
| POST | `/sync-history?eid=` | Importar historico de conversas para o painel |
| POST | `/disconnect?eid=` | Desconectar WhatsApp da loja |
| POST | `/queue` | **Deprecated** — fila legada (usar cron PHP) |

### Status possiveis

| Status | Significado |
|--------|-------------|
| `connected` | WhatsApp conectado |
| `connecting` | Iniciando sessao |
| `qr_pending` | QR gerado, aguardando scan |
| `disconnected` | Desconectado |

Resposta de `/status`:

```json
{ "eid": "1", "status": "connected", "conectado": true, "qr_pending": false }
```

Resposta de `/sync-history`:

```json
{ "ok": true, "success": true, "imported": 142, "skipped": 8, "msg": "Historico sincronizado." }
```

## Fluxo de mensagens

```
WhatsApp (ao vivo)  → messages.upsert (type=notify) → POST inbound.php  → bot + inbox
WhatsApp (historico)→ messaging-history.set        → POST history.php  → inbox (sem bot)
Sync manual (painel)→ POST /sync-history           → fetchMessageHistory → history.php
```

## Variaveis de ambiente

Copie `.env.example` para `.env` (local) ou configure no Railway.

| Variavel | Obrigatoria | Descricao |
|----------|-------------|-----------|
| `DB_*` | Sim | Banco do Rapidex (mesmo do painel) |
| `WHATS_WEBHOOK_TOKEN` | Sim* | Token do webhook (`WHATS_WEBHOOK_TOKEN` ou `CRON_TOKEN` no Rapidex) |
| `WHATS_WEBHOOK_URL` | Nao | Default: `https://rapidex.app.br/api/whatsapp/inbound.php` |
| `WHATS_HISTORY_WEBHOOK_URL` | Nao | Default: `.../api/whatsapp/history.php` |
| `WHATS_SYNC_FULL_HISTORY` | Nao | Default `true` — importa historico ao conectar |
| `WHATS_HISTORY_BATCH_SIZE` | Nao | Default `80` mensagens por POST |
| `WHATS_HISTORY_SYNC_TIMEOUT_MS` | Nao | Default `90000` (90s) |
| `BAILEYS_API_TOKEN` | Nao | Se definido, exige `Authorization: Bearer` em todos endpoints exceto `/health` |
| `CORS_ORIGINS` | Nao | Origens do painel |
| `SESSION_DIR` | Nao | Pasta das sessoes (default `./sessions`) |
| `WHATS_FORWARD_GROUP` | Nao | Grupo opcional para copia de mensagens |

\* Se vazio, mensagens recebidas nao disparam bot/inbox no painel.

## Deploy no Railway (Hobby)

1. Novo projeto → Deploy from GitHub (este repo).
2. **Volume** montado em `/app/sessions` (ou `SESSION_DIR=/app/sessions`).
3. Variaveis `DB_*`, `WHATS_WEBHOOK_TOKEN` e `WHATS_SYNC_FULL_HISTORY=true`.
4. No Rapidex (`.env`): `WHATS_API=https://seu-app.up.railway.app`
5. Painel → WhatsApp → Gerar QR → Ativar envio automatico.
6. Conversas → **Sincronizar historico** (ou aguarde import automatico ao conectar).
7. Cron do Rapidex: `cron.php?acao=whatsapp_fila` e `whatsapp_bot`.

## Local

```bash
cp .env.example .env
npm install
npm start
```

## Fila de envio

A fila `whatsapp_fila` e processada pelo **cron PHP** do Rapidex (`WhatsAppRepository::processQueue`), que chama `POST /send` neste servico.

## Seguranca

Configure `BAILEYS_API_TOKEN` no Railway e no Rapidex (`.env`) para proteger `/send`, `/sync-history` e demais rotas. O proxy do painel envia `Authorization: Bearer` automaticamente quando a variavel existe.
