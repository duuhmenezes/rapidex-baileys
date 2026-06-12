/**
 * Deve ser o primeiro import do server.js — patch em disco antes do Baileys carregar.
 */
import { patchBaileysHistory } from "./scripts/patch-baileys-history.mjs";

patchBaileysHistory();
