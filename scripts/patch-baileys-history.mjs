/**
 * Baileys ignora phoneNumberToLidMappings no historico — Rapidex precisa disso para LID.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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

const WRONG_SNIPPET_RE =
  /\n            \/\/ rapidex-phoneNumberToLidMappings\n            for \(const map of item\.phoneNumberToLidMappings \|\| \[\]\) \{[\s\S]*?\n            \}\n/g;

const END_ANCHOR = `                chats.push({ ...chat });
            }
            break;
        case proto.HistorySync.HistorySyncType.PUSH_NAME:`;

const END_REPLACEMENT = `                chats.push({ ...chat });
            }${SNIPPET}
            break;
        case proto.HistorySync.HistorySyncType.PUSH_NAME:`;

function resolveHistoryPaths() {
  const paths = [];
  const candidates = [
    "@whiskeysockets/baileys/lib/Utils/history.js",
    "baileys/lib/Utils/history.js",
    join(__dirname, "../node_modules/@whiskeysockets/baileys/lib/Utils/history.js"),
    join(__dirname, "../node_modules/baileys/lib/Utils/history.js"),
  ];

  for (const candidate of candidates) {
    try {
      const resolved = candidate.includes("node_modules")
        ? candidate
        : require.resolve(candidate);
      if (resolved && !paths.includes(resolved)) {
        paths.push(resolved);
      }
    } catch {
      /* try next */
    }
  }

  return paths.filter((p) => existsSync(p));
}

function patchFile(historyPath) {
  let src = readFileSync(historyPath, "utf8");
  const wrongPlacement = WRONG_SNIPPET_RE.test(src);

  if (src.includes(MARKER) && !wrongPlacement) {
    return "already";
  }

  if (wrongPlacement) {
    src = src.replace(WRONG_SNIPPET_RE, "\n");
  }

  if (!src.includes(END_ANCHOR)) {
    return "no-anchor";
  }

  src = src.replace(END_ANCHOR, END_REPLACEMENT);
  writeFileSync(historyPath, src);
  return wrongPlacement ? "relocated" : "patched";
}

export function patchBaileysHistory() {
  const paths = resolveHistoryPaths();
  if (!paths.length) {
    console.warn(
      "patch-baileys-history: history.js nao encontrado (@whiskeysockets/baileys ou baileys)"
    );
    return false;
  }

  let ok = 0;
  for (const historyPath of paths) {
    const result = patchFile(historyPath);
    if (result === "patched" || result === "relocated") {
      console.log(`patch-baileys-history: ${result} em ${historyPath}`);
      ok++;
    } else if (result === "already") {
      console.log(`patch-baileys-history: ja aplicado em ${historyPath}`);
      ok++;
    } else {
      console.warn(`patch-baileys-history: anchor ausente em ${historyPath}`);
    }
  }

  return ok > 0;
}

const isDirectRun =
  (process.argv[1] &&
    fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, "/")) ||
  process.argv[1]?.endsWith("patch-baileys-history.mjs");

if (isDirectRun) {
  patchBaileysHistory();
}
