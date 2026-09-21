const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'ff-buff-2024'; // ⚠️ đổi trên Render

const ACC_PATH = path.join(__dirname, 'acc.json');

function loadAcc() { return JSON.parse(fs.readFileSync(ACC_PATH, 'utf8')); }
function saveAcc(o) { fs.writeFileSync(ACC_PATH, JSON.stringify(o, null, 2)); }

let cursor = 0;

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const key = req.query.key || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized: sai key' });
  next();
}

// ---------- Utils ----------
function randomIp() {
  return [1,2,3,4].map(() => Math.floor(Math.random()*254)+1).join('.');
}

async function sendLike(targetUid, region, token) {
  const url = 'https://ff.garena.com/api/antispam/like';
  const body = new URLSearchParams({ uid: targetUid, region, token, language: 'vi' });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Referer': `https://ff.garena.com/${region}/`,
      'Origin': 'https://ff.garena.com',
      'X-Forwarded-For': randomIp(),
      'Accept': 'application/json, text/plain, */*'
    },
    body
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch(_) {}
  return { http: resp.status, ok: resp.ok, data: json ?? text };
}

async function checkToken(token, region = 'vn') {
  try {
    const r = await sendLike('1234567890', region, token);
    if (r.http === 200 && r.data && typeof r.data === 'object') {
      const d = r.data.data;
      if (d === 0) return { status: 'alive', note: 'like OK' };
      if (d === 1) return { status: 'alive', note: 'đã like rồi' };
      return { status: 'alive', note: 'phản hồi: ' + JSON.stringify(r.data) };
    }
    if (r.http === 401 || r.http === 403) return { status: 'dead', note: 'token hết hạn' };
    return { status: 'unknown', note: 'http ' + r.http };
  } catch (e) {
    return { status: 'error', note: e.message };
  }
}

// ---------- Routes ----------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'FF Like Buff API',
    endpoints: {
      likes:      '/api/likes?uid=<UID>&region=vn&count=10&key=<KEY>',
      likesAll:   '/api/likes-all?uid=<UID>&region=vn&key=<KEY>',
      accounts:   '/api/accounts?key=<KEY>',
      add:        '/api/add?uid=<UID>&token=<TOKEN>&key=<KEY>',
      delete:     '/api/delete?uid=<UID>&key=<KEY>',
      check:      '/api/check?uid=<UID>&key=<KEY>',
      checkAll:   '/api/check-all?key=<KEY>'
    }
  });
});

// Buff N account
app.get('/api/likes', auth, async (req, res) => {
  const { uid, region = 'vn' } = req.query;
  let count = parseInt(req.query.count || '1', 10);
  if (!uid) return res.status(400).json({ error: 'Thiếu ?uid=' });

  const accs = Object.entries(loadAcc()).map(([u,t]) => ({ uid: u, token: t }));
  if (!accs.length) return res.json({ target: uid, success: 0, failed: 0, results: [] });
  if (isNaN(count) || count < 1) count = 1;
  count = Math.min(count, accs.length);

  const results = [];
  for (let i = 0; i < count; i++) {
    const acc = accs[cursor++ % accs.length];
    try {
      const r = await sendLike(uid, region, acc.token);
      results.push({ account: acc.uid, ...r });
    } catch (e) {
      results.push({ account: acc.uid, error: e.message });
    }
  }
  const success = results.filter(r => r.ok && r.data && r.data.data === 0).length;
  res.json({ target: uid, region, requested: count, success, failed: count - success, results });
});

// Buff toàn bộ
app.get('/api/likes-all', auth, async (req, res) => {
  const { uid, region = 'vn' } = req.query;
  if (!uid) return res.status(400).json({ error: 'Thiếu ?uid=' });

  const accs = Object.entries(loadAcc()).map(([u,t]) => ({ uid: u, token: t }));
  const results = [];
  for (const acc of accs) {
    try {
      const r = await sendLike(uid, region, acc.token);
      results.push({ account: acc.uid, ...r });
    } catch (e) {
      results.push({ account: acc.uid, error: e.message });
    }
  }
  const success = results.filter(r => r.ok && r.data && r.data.data === 0).length;
  res.json({ target: uid, region, total: accs.length, success, failed: accs.length - success, results });
});

// Danh sách account
app.get('/api/accounts', auth, (req, res) => {
  const acc = loadAcc();
  const list = Object.entries(acc).map(([uid, token]) => ({
    uid,
    token_preview: token.length > 20 ? token.slice(0, 12) + '...' + token.slice(-6) : token
  }));
  res.json({ total: list.length, accounts: list });
});

// Thêm account
app.get('/api/add', auth, (req, res) => {
  const { uid, token } = req.query;
  if (!uid || !token) return res.status(400).json({ error: 'Thiếu ?uid= hoặc ?token=' });
  const acc = loadAcc();
  if (acc[uid]) return res.json({ status: 'exists', uid, message: 'UID đã tồn tại' });
  acc[uid] = token;
  saveAcc(acc);
  res.json({ status: 'added', uid, total: Object.keys(acc).length });
});

// Xoá account
app.get('/api/delete', auth, (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'Thiếu ?uid=' });
  const acc = loadAcc();
  if (!acc[uid]) return res.json({ status: 'not_found', uid });
  delete acc[uid];
  saveAcc(acc);
  res.json({ status: 'deleted', uid, total: Object.keys(acc).length });
});

// Check 1 account
app.get('/api/check', auth, async (req, res) => {
  const { uid, region = 'vn' } = req.query;
  if (!uid) return res.status(400).json({ error: 'Thiếu ?uid=' });
  const acc = loadAcc();
  if (!acc[uid]) return res.json({ uid, status: 'not_found' });
  const r = await checkToken(acc[uid], region);
  res.json({ uid, ...r });
});

// Check toàn bộ
app.get('/api/check-all', auth, async (req, res) => {
  const { region = 'vn' } = req.query;
  const acc = loadAcc();
  const entries = Object.entries(acc);
  const results = [];
  for (const [uid, token] of entries) {
    const r = await checkToken(token, region);
    results.push({ uid, ...r });
  }
  const alive = results.filter(r => r.status === 'alive').length;
  const dead  = results.filter(r => r.status === 'dead').length;
  res.json({ total: entries.length, alive, dead, other: entries.length - alive - dead, results });
});

app.listen(PORT, () => {
  console.log(`✅ Server chạy tại port ${PORT}`);
  console.log(`📦 Đã nạp ${Object.keys(loadAcc()).length} account`);
  console.log(`🔐 API key đang dùng: ${API_KEY}`);
});
