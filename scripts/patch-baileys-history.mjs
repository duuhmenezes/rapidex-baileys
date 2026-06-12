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

const SNIPPET_BLOCK_RE =
  /\r?\n\s*\/\/ rapidex-phoneNumberToLidMappings\r?\n\s*for \(const map of item\.phoneNumberToLidMappings \|\| \[\]\) \{[\s\S]*?\r?\n\s*\}\r?\n/;

const INSERT_RE =
  /(chats\.push\(\{ \.\.\.chat \}\);\r?\n\s*\})\r?\n(\s*break;\r?\n\s*case proto\.HistorySync\.HistorySyncType\.PUSH_NAME:)/;

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
  const pushPos = src.indexOf("chats.push({ ...chat });");

  if (src.includes(MARKER)) {
    const markerPos = src.indexOf(MARKER);
    if (markerPos !== -1 && pushPos !== -1 && markerPos < pushPos) {
      src = src.replace(SNIPPET_BLOCK_RE, "\n");
    } else {
      return "already";
    }
  }

  if (!INSERT_RE.test(src)) {
    return "no-anchor";
  }

  src = src.replace(INSERT_RE, `$1${SNIPPET}$2`);
  writeFileSync(historyPath, src);
  return "patched";
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
    if (result === "patched") {
      console.log(`patch-baileys-history: aplicado em ${historyPath}`);
      ok++;
    } else if (result === "already") {
      console.log(`patch-baileys-history: ok em ${historyPath}`);
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
