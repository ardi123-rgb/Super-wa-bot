// language: JavaScript, file: index.js
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

const app = express();
app.use(express.json());

let sock = null;
let status = 'disconnected';
let logs = [];
let currentQrBase64 = null;
let pairingCode = null;

// ── DATABASE LOKAL (JSON) ──────────────────────────────────────
const DB_FILE = path.join(__dirname, 'database.json');
let db = { users: {} };

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
  }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
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

// ── ANTI-BAN SYSTEM (HUMAN SIMULATION) ─────────────────────────
// Fungsi buat nge-pause layaknya manusia ngetik
const humanDelay = (min = 1000, max = 3000) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1)) + min));

// Fungsi pengiriman aman
async function safeSend(from, content, isMedia = false, quoted = null) {
  try {
    // 1. Kasih jeda mikir (1-3 detik)
    await humanDelay(1000, 3000);
    
    // 2. Tampilin status "Sedang mengetik..."
    if (!isMedia) {
      await sock.sendPresenceUpdate('composing', from);
      await humanDelay(2000, 5000); // Jeda ngetik 2-5 detik
      await sock.sendPresenceUpdate('paused', from);
    }

    // 3. Tambahin Zero-Width Space di akhir teks (bikin tiap pesan unik, anti-duplicate)
    if (content.text) {
      content.text = content.text + '\u200b'.repeat(Math.floor(Math.random() * 20) + 1);
    }

    // 4. Kirim pesan
    const opts = quoted ? { quoted } : {};
    return await sock.sendMessage(from, content, opts);
  } catch (err) {
    log(`Anti-Ban Error: ${err.message}`);
  }
}

// ── FUNGSI AI & MAKER ──────────────────────────────────────────
async function askAI(prompt) {
  const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`);
  return res.data;
}

async function generateBrat(text) {
  const svg = `<svg width="512" height="512"><rect width="100%" height="100%" fill="white"/><text x="50%" y="50%" font-family="Arial" font-weight="bold" font-size="45" fill="black" text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function applyFilter(buffer, type) {
  let img = sharp(buffer);
  if (type === 'blur') img = img.blur(15);
  if (type === 'grayscale') img = img.grayscale();
  return await img.jpeg({ quality: 80 }).toBuffer();
}

// ── BOT ENGINE ─────────────────────────────────────────────────
async function startBot() {
  loadDB();
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  // Spoof device biar mirip Chrome di Ubuntu
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
      log('✅ Bot V1 (Anti-Ban) berhasil terhubung.');
    }
    if (connection === 'close') {
      status = 'disconnected';
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) { setTimeout(startBot, 3000); }
      else { log('❌ Logged out. Hapus auth/ lalu scan ulang.'); }
    }
  });

  // Fitur baca pesan (read receipt) biar bot keliatan aktif
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : from;
    const pushname = msg.pushName || 'User';
    
    // Tandai udah dibaca (Centang Biru)
    await sock.readMessages([msg.key]);

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text.startsWith('.')) return;

    const args = text.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const q = args.join(' ');
    const user = getUser(sender);

    log(`CMD [${pushname}]: ${cmd}`);

    try {
      if (cmd === 'menu') {
        await safeSend(from, { text: MENU_TEXT }, false, msg);
      }
      else if (cmd === 'ping') {
        const t1 = Date.now();
        await safeSend(from, { text: '🏓 Pong! ' + (Date.now() - t1) + 'ms' }, false, msg);
      }
      else if (cmd === 'limit') {
        await safeSend(from, { text: `👤 *${pushname}*\n💳 Limit: ${user.limit}\n💰 Uang: ${user.money}\n⚠️ Warn: ${user.warning}` }, false, msg);
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
        if (!msg.message.imageMessage && !msg.message.videoMessage) return;
        const media = await sock.downloadMediaMessage(msg);
        const sticker = new Sticker(media, { pack: 'Bot', author: pushname, type: StickerTypes.FULL });
        await safeSend(from, { sticker: await sticker.toBuffer() }, true, msg);
      }
      else if (cmd === 'brat') {
        if (!q) return;
        const img = await generateBrat(q);
        const sticker = new Sticker(img, { pack: 'Bot', author: 'Brat', type: StickerTypes.FULL });
        await safeSend(from, { sticker: await sticker.toBuffer() }, true, msg);
      }
      else if (['waifu', 'neko', 'shinobu'].includes(cmd)) {
        const res = await axios.get(`https://api.waifu.pics/sfw/${cmd}`);
        await safeSend(from, { image: { url: res.data.url }, caption: `Ini ${cmd} nya~` }, true, msg);
      }
      else if (['blur', 'grayscale'].includes(cmd)) {
        if (!msg.message.imageMessage) return;
        const media = await sock.downloadMediaMessage(msg);
        const filtered = await applyFilter(media, cmd);
        await safeSend(from, { image: filtered, caption: `Efek ${cmd}` }, true, msg);
      }
      else if (['kick', 'promote', 'demote'].includes(cmd) && isGroup) {
        const meta = await sock.groupMetadata(from);
        const isAdmin = meta.participants.find(p => p.id === sender)?.admin;
        if (!isAdmin) return safeSend(from, { text: '❌ Khusus Admin!' }, false, msg);
        const target = msg.message.extendedTextMessage?.contextInfo?.participant;
        if (!target) return safeSend(from, { text: 'Reply targetnya!' }, false, msg);
        
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

// ── WEB DASHBOARD (Sama aja) ───────────────────────────────────
const HTML = String.raw`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WA Bot V1</title>
<style>:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--txt:#e6edf3;--dim:#8b949e;--acc:#58a6ff;--ok:#3fb950;--err:#f85149}*{box-sizing:border-box}body{margin:0;font:14px/1.5 monospace;background:var(--bg);color:var(--txt)}header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.status{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold}.connected{color:var(--ok);border:1px solid var(--ok)}.disconnected,.waiting_qr{color:var(--err);border:1px solid var(--err)}.main{padding:24px;max-width:800px;margin:0 auto;display:grid;gap:20px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}input,button{width:100%;padding:10px;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:4px;margin-top:8px}button{background:var(--acc);color:#fff;font-weight:bold;cursor:pointer}#log{background:#000;padding:12px;border-radius:4px;font-size:12px;height:200px;overflow-y:auto;white-space:pre-wrap;color:var(--ok)}#auth-section{display:none;text-align:center}#qr-img{width:250px;height:250px;margin:10px auto;border:5px solid #fff;border-radius:8px}#pair-code{font-size:28px;font-weight:bold;letter-spacing:5px;color:var(--acc);margin:10px 0}</style></head>
<body><header><h1>🤖 WA Bot V1 (Anti-Ban)</h1><div class="status disconnected" id="stat">checking...</div></header>
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
  // Pake safeSend di web juga
  try { await safeSend(jid(req.body.target), { text: req.body.text }); res.json({ ok: true }); } 
  catch (e) { res.json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
startBot();
app.listen(PORT, () => log(`🌐 Web Dashboard V1 jalan di port ${PORT}`));