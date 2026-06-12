/**
 * Baileys ignora phoneNumberToLidMappings no historico — Rapidex precisa disso para LID.
 * Roda no postinstall e no boot do server.js.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const historyPath = join(
  __dirname,
  "../node_modules/baileys/lib/Utils/history.js"
);
const MARKER = "rapidex-phoneNumberToLidMappings";

const SNIPPET = `
            // ${MARKER}
            for (const map of item.phoneNumberToLidMappings || []) {
                if (!map?.lidJid || !map?.pnJid) continue;
                contacts.push({
                    id: map.lidJid,
                    lid: map.lidJid,
                    phoneNumber: map.pnJid
                });
            }
`;

export function patchBaileysHistory() {
  if (!existsSync(historyPath)) {
    console.warn("patch-baileys-history: history.js nao encontrado, skip");
    return false;
  }

  let src = readFileSync(historyPath, "utf8");
  if (src.includes(MARKER)) {
    return true;
  }

  const anchor = "                chats.push({ ...chat });";
  if (!src.includes(anchor)) {
    console.warn("patch-baileys-history: anchor nao encontrado, skip");
    return false;
  }

  src = src.replace(
    anchor,
    `${SNIPPET}
                chats.push({ ...chat });`
  );
  writeFileSync(historyPath, src);
  console.log("patch-baileys-history: phoneNumberToLidMappings aplicado");
  return true;
}

patchBaileysHistory();
