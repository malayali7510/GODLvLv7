"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
const DATA_DIRECTORY = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIRECTORY, "licenses.json");
const SITE_FILE = path.join(__dirname, "public", "index.html");

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Add it as a private environment variable before starting.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIRECTORY, { recursive: true });

function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { licenses: parsed.licenses || {}, updateOffset: Number(parsed.updateOffset || 0) };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read licence store:", error.message);
    return { licenses: {}, updateOffset: 0 };
  }
}

let data = loadData();

function saveData() {
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, DATA_FILE);
}

function isAdmin(userId) {
  return ADMIN_IDS.has(String(userId));
}

function makeKey() {
  return `MH-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function createLicense(durationLabel, durationMs, createdBy) {
  let key;
  do key = makeKey(); while (data.licenses[key]);
  const now = Date.now();
  data.licenses[key] = {
    key,
    durationLabel,
    createdAt: now,
    expiresAt: now + durationMs,
    createdBy: String(createdBy),
    deviceId: null,
    activatedAt: null,
    revokedAt: null
  };
  saveData();
  return data.licenses[key];
}

function remainingText(expiresAt) {
  const milliseconds = Math.max(0, expiresAt - Date.now());
  const days = Math.floor(milliseconds / 86400000);
  const hours = Math.floor((milliseconds % 86400000) / 3600000);
  const minutes = Math.ceil((milliseconds % 3600000) / 60000);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.description || `Telegram ${method} failed`);
  return payload.result;
}

function keyKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔑 Generate 1-day key", callback_data: "key:1d" }],
      [{ text: "🔑 Generate 1-week key", callback_data: "key:7d" }],
      [{ text: "🔑 Generate 1-month key", callback_data: "key:30d" }]
    ]
  };
}

async function sendStart(chatId, userId) {
  const message = isAdmin(userId)
    ? "MALAYALI HERE key manager\n\nChoose a key duration below. Each key works on one device."
    : "MALAYALI HERE access bot\n\nUse /id to show your Telegram ID.";
  const options = isAdmin(userId) ? { inline_keyboard: keyKeyboard().inline_keyboard } : undefined;
  await telegram("sendMessage", { chat_id: chatId, text: message, reply_markup: options });
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = (message.text || "").trim();
  if (!chatId || !userId) return;

  if (text === "/id") {
    await telegram("sendMessage", { chat_id: chatId, text: `Your Telegram ID: ${userId}` });
    return;
  }
  if (text === "/start" || text === "/keys") {
    await sendStart(chatId, userId);
    return;
  }
  if (text.startsWith("/revoke")) {
    if (!isAdmin(userId)) return;
    const key = text.split(/\s+/, 2)[1]?.toUpperCase();
    const license = data.licenses[key];
    if (!license) {
      await telegram("sendMessage", { chat_id: chatId, text: "Key not found." });
      return;
    }
    license.revokedAt = Date.now();
    saveData();
    await telegram("sendMessage", { chat_id: chatId, text: `Revoked ${key}.` });
    return;
  }
  if (text === "/stats" && isAdmin(userId)) {
    const all = Object.values(data.licenses);
    const active = all.filter((license) => !license.revokedAt && license.expiresAt > Date.now()).length;
    await telegram("sendMessage", { chat_id: chatId, text: `Keys created: ${all.length}\nActive: ${active}` });
  }
}

async function handleCallback(callback) {
  const userId = callback.from?.id;
  const chatId = callback.message?.chat?.id;
  if (!userId || !chatId) return;
  if (!isAdmin(userId)) {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Only the bot owner can generate keys.", show_alert: true });
    return;
  }
  const options = {
    "key:1d": ["1 day", 86400000],
    "key:7d": ["1 week", 7 * 86400000],
    "key:30d": ["1 month", 30 * 86400000]
  };
  const selected = options[callback.data];
  if (!selected) return;
  const license = createLicense(selected[0], selected[1], userId);
  await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Key generated." });
  await telegram("sendMessage", {
    chat_id: chatId,
    text: `New ${license.durationLabel} key\n\n${license.key}\n\nExpires ${new Date(license.expiresAt).toUTCString()}\n\nIt activates on the first device where it is used.`,
    reply_markup: keyKeyboard()
  });
}

async function pollTelegram() {
  try {
    const updates = await telegram("getUpdates", { offset: data.updateOffset, timeout: 25, allowed_updates: ["message", "callback_query"] });
    for (const update of updates) {
      data.updateOffset = update.update_id + 1;
      if (update.message) await handleMessage(update.message);
      if (update.callback_query) await handleCallback(update.callback_query);
      saveData();
    }
  } catch (error) {
    console.error("Telegram polling error:", error.message);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  setImmediate(pollTelegram);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": process.env.SITE_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function collectJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) request.destroy();
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
    request.on("error", reject);
  });
}

async function verifyLicense(request, response) {
  let input;
  try { input = await collectJson(request); } catch { sendJson(response, 400, { ok: false, message: "Invalid request." }); return; }
  const key = String(input.key || "").trim().toUpperCase();
  const deviceId = String(input.deviceId || "").trim();
  if (!key || deviceId.length < 16 || deviceId.length > 200) {
    sendJson(response, 400, { ok: false, message: "Enter a valid access key." });
    return;
  }
  const license = data.licenses[key];
  if (!license || license.revokedAt || license.expiresAt <= Date.now()) {
    sendJson(response, 403, { ok: false, message: "This key is invalid or has expired." });
    return;
  }
  if (license.deviceId && license.deviceId !== deviceId) {
    sendJson(response, 403, { ok: false, message: "This key is already activated on another device." });
    return;
  }
  if (!license.deviceId) {
    license.deviceId = deviceId;
    license.activatedAt = Date.now();
    saveData();
  }
  sendJson(response, 200, { ok: true, expiresAt: license.expiresAt, remaining: remainingText(license.expiresAt) });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") { sendJson(response, 204, {}); return; }
  if (request.method === "GET" && url.pathname === "/health") { sendJson(response, 200, { ok: true }); return; }
  if (request.method === "POST" && url.pathname === "/api/verify") { await verifyLicense(request, response); return; }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    fs.createReadStream(SITE_FILE).pipe(response);
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

async function start() {
  server.listen(PORT, () => console.log(`MALAYALI HERE key server listening on port ${PORT}`));
  try {
    await telegram("setMyCommands", {
      commands: [
        { command: "start", description: "Open the key menu" },
        { command: "keys", description: "Open key-generation buttons (owner)" },
        { command: "id", description: "Show your Telegram ID" },
        { command: "revoke", description: "Revoke a key: /revoke KEY" },
        { command: "stats", description: "Show key totals (owner)" }
      ]
    });
    console.log("Telegram commands configured.");
  } catch (error) {
    console.error("Could not configure Telegram commands:", error.message);
  }
  pollTelegram();
}

start();
