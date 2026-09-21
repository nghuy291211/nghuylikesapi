const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'ff-buff-2024';

const ACC_PATH = path.join(__dirname, 'acc.json');

// ---------- Load / Save acc.json an toàn ----------
function loadAcc() {
  try {
    if (!fs.existsSync(ACC_PATH)) {
      fs.writeFileSync(ACC_PATH, '{}');
      return {};
    }
    return JSON.parse(fs.readFileSync(ACC_PATH, 'utf8'));
  } catch (e) {
    console.error('Lỗi đọc acc.json:', e.message);
    return {};
  }
}

function saveAcc(o) {
  try {
    fs.writeFileSync(ACC_PATH, JSON.stringify(o, null, 2));
  } catch (e) {
    console.error('Lỗi ghi acc.json:', e.message);
  }
}

let cursor = 0;

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const key = req.query.key || req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: sai key' });
  }
  next();
}

// ---------- Utils ----------
function randomIp() {
  return [1, 2, 3, 4].map(() => Math.floor(Math.random() * 254) + 1).join('.');
}

// ---------- Cookie store (cache 5 phút / region) ----------
const cookieCache = {};

async function getGarenaCookies(region) {
  const cached = cookieCache[region];
  if (cached && Date.now() - cached.time < 5 * 60 * 1000 && cached.data) {
    return cached.data;
  }
  try {
    const r = await fetch(`https://ff.garena.com/${region}/`, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        'X-Forwarded-For': randomIp()
      },
      redirect: 'follow'
    });

    let cookies = [];
    if (typeof r.headers.getSetCookie === 'function') {
      cookies = r.headers.getSetCookie();
    } else {
      const sc = r.headers.get('set-cookie');
      if (sc) cookies = [sc];
    }

    const cookie = cookies
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');

    cookieCache[region] = { data: cookie, time: Date.now() };
    return cookie;
  } catch (e) {
    return '';
  }
}

// ---------- Send like ----------
async function sendLike(targetUid, region, token) {
  const url = 'https://ff.garena.com/api/antispam/like';
  const cookie = await getGarenaCookies(region);

  const body = new URLSearchParams({
    uid: targetUid,
    region: region,
    token: token,
    language: 'vi'
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
    'Referer': `https://ff.garena.com/${region}/`,
    'Origin': 'https://ff.garena.com',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="120", "Android WebView";v="120"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Forwarded-For': randomIp()
  };
  if (cookie) headers['Cookie'] = cookie;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}

  // Garena trả về HTML (Cloudflare / block)
  if (!json && text && text.trim().toLowerCase().startsWith('<!doctype')) {
    return {
      http: resp.status,
      ok: false,
      data: {
        error: 'Garena trả HTML (bị chặn / Cloudflare)',
        status: resp.status
      }
    };
  }

  return { http: resp.status, ok: resp.ok, data: json ?? text };
}

// ---------- Check token ----------
async function checkToken(token, region = 'vn') {
  try {
    const r = await sendLike('1234567890', region, token);
    if (r.http === 200 && r.data && typeof r.data === 'object') {
      const d = r.data.data;
      if (d === 0) return { status: 'alive', note: 'like OK' };
      if (d === 1) return { status: 'alive', note: 'đã like rồi' };
      return { status: 'alive', note: 'phản hồi: ' + JSON.stringify(r.data) };
    }
    if (r.http === 401 || r.http === 403) {
      return { status: 'dead', note: 'token hết hạn' };
    }
    if (r.http === 404) {
      return { status: 'dead', note: 'endpoint 404 (Garena đổi API)' };
    }
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
      likes: '/api/likes?uid=<UID>&region=vn&count=10&key=<KEY>',
      likesAll: '/api/likes-all?uid=<UID>&region=vn&key=<KEY>',
      accounts: '/api/accounts?key=<KEY>',
      add: '/api/add?uid=<UID>&token=<TOKEN>&key=<KEY>',
      delete: '/api/delete?uid=<UID>&key=<KEY>',
      check: '/api/check?uid=<UID>&key=<KEY>',
      checkAll: '/api/check-all?key=<KEY>',
      diagnose: '/api/diagnose?uid=<UID>&region=vn&token=<TOKEN>&key=<KEY>'
    }
  });
});

// Buff N account
app.get('/api/likes', auth, async (req, res) => {
  const { uid, region = 'vn' } = req.query;
  let count = parseInt(req.query.count || '1', 10);
  if (!uid) return res.status(400).json({ error: 'Thiếu ?uid=' });

  const accs = Object.entries(loadAcc()).map(([u, t]) => ({ uid: u, token: t }));
  if (!accs.length) {
    return res.json({ target: uid, success: 0, failed: 0, results: [] });
  }
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

  const success = results.filter(
    (r) => r.ok && r.data && r.data.data === 0
  ).length;

  res.json({
    target: uid,
    region,
    requested: count,
    success,
    failed: count - success,
    results
  });
});

// Buff toàn bộ
app.get('/api/likes-all', auth, async (req, res) => {
  const { uid, region = 'vn' } = req.query;
  if (!uid) return res.status(400).json({ error: 'Thiếu ?uid=' });

  const accs = Object.entries(loadAcc()).map(([u, t]) => ({ uid: u, token: t }));
  const results = [];
  for (const acc of accs) {
    try {
      const r = await sendLike(uid, region, acc.token);
      results.push({ account: acc.uid, ...r });
    } catch (e) {
      results.push({ account: acc.uid, error: e.message });
    }
  }

  const success = results.filter(
    (r) => r.ok && r.data && r.data.data === 0
  ).length;

  res.json({
    target: uid,
    region,
    total: accs.length,
    success,
    failed: accs.length - success,
    results
  });
});

// Danh sách account
app.get('/api/accounts', auth, (req, res) => {
  const acc = loadAcc();
  const list = Object.entries(acc).map(([uid, token]) => ({
    uid,
    token_preview:
      token.length > 20
        ? token.slice(0, 12) + '...' + token.slice(-6)
        : token
  }));
  res.json({ total: list.length, accounts: list });
});

// Thêm account
app.get('/api/add', auth, (req, res) => {
  const { uid, token } = req.query;
  if (!uid || !token) {
    return res.status(400).json({ error: 'Thiếu ?uid= hoặc ?token=' });
  }
  const acc = loadAcc();
  if (acc[uid]) {
    return res.json({ status: 'exists', uid, message: 'UID đã tồn tại' });
  }
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
  const alive = results.filter((r) => r.status === 'alive').length;
  const dead = results.filter((r) => r.status === 'dead').length;
  res.json({
    total: entries.length,
    alive,
    dead,
    other: entries.length - alive - dead,
    results
  });
});

// ---------- Diagnose: xem raw response từ Garena ----------
app.get('/api/diagnose', auth, async (req, res) => {
  const { uid = '1234567890', region = 'vn', token = '' } = req.query;
  if (!token) return res.status(400).json({ error: 'Thiếu ?token=' });

  const endpoints = [
    'https://ff.garena.com/api/antispam/like',
    'https://ff.garena.com/api/antispam/likes',
    'https://ff.garena.com/api/like'
  ];

  const cookie = await getGarenaCookies(region);
  const results = [];

  for (const url of endpoints) {
    try {
      const body = new URLSearchParams({
        uid,
        region,
        token,
        language: 'vi'
      });
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://ff.garena.com/${region}/`,
          'Origin': 'https://ff.garena.com',
          'Cookie': cookie,
          'X-Forwarded-For': randomIp()
        },
        body
      });
      const text = await r.text();
      results.push({
        url,
        http: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        body_preview: text.slice(0, 500)
      });
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }

  res.json({
    note: 'Gửi kết quả này cho dev để chẩn đoán',
    cookie_obtained: cookie ? 'yes (' + cookie.length + ' chars)' : 'no',
    cookie_preview: cookie.slice(0, 120),
    results
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server chạy tại port ${PORT}`);
  console.log(`📦 Đã nạp ${Object.keys(loadAcc()).length} account`);
  console.log(`🔐 API key đang dùng: ${API_KEY}`);
});
