// server.js — Device Check-In standalone public app
// Serves the frontend + JSON API. State in data.json (JSON file DB).
// No external dependencies (plain Node http). Free, $0.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Durable storage: when DATABASE_URL is set (e.g. Supabase Postgres on Render),
// state lives in Postgres and survives restarts. Otherwise data.json is used.
const DATABASE_URL = process.env.DATABASE_URL || '';
let pgPool = null;
let useDb = false;

// ---------- helpers ----------
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function nowISO() { return new Date().toISOString(); }
function makeToken() { return crypto.randomBytes(16).toString('hex'); }

// ET date/time helpers (family is in America/New_York)
function etParts(d) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(d);
  const get = t => parts.find(p => p.type === t).value;
  return { ymd: get('year') + '-' + get('month') + '-' + get('day'), hour: parseInt(get('hour'), 10) % 24, minute: parseInt(get('minute'), 10) };
}
function etYMD(d) { return etParts(d).ymd; }
function etMinutes(d) { const p = etParts(d); return p.hour * 60 + p.minute; }
function etMondayYMD(d) {
  const p = etParts(d);
  const date = new Date(Date.UTC(+p.ymd.slice(0, 4), +p.ymd.slice(5, 7) - 1, +p.ymd.slice(8, 10)));
  const day = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}
function minutesBetween(aISO, bISO) { return Math.max(0, Math.floor((new Date(bISO) - new Date(aISO)) / 60000)); }
function fmtClock(mins) {
  if (mins == null) return '';
  let h = Math.floor(mins / 60), m = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

// ---------- data store ----------
function defaultData() {
  return {
    devices: [
      { id: 1, name: 'PS5', code: 'ps5-c50n', kind: 'console', dailyLimitMinutes: 60, archived: false },
      { id: 2, name: 'Quest 2', code: 'quest-2-gce7', kind: 'vr', dailyLimitMinutes: 30, archived: false },
      { id: 3, name: "Ale's Laptop", code: 'ale-s-laptop-qk2t', kind: 'laptop', dailyLimitMinutes: 90, archived: false }
    ],
    kids: [
      { name: 'Ale', pinHash: sha256('1111'), curfewMinutes: 1320, dailyTotalLimitMinutes: 90 },
      { name: 'Leo', pinHash: sha256('2222'), curfewMinutes: 1260, dailyTotalLimitMinutes: 90 },
      { name: 'Gio', pinHash: sha256('3333'), curfewMinutes: null, dailyTotalLimitMinutes: null }
    ],
    parentPinHash: sha256('0000'),
    sessions: [],
    alerts: [],
    tokens: {}, // token -> { role: 'parent'|'kid', kid: name|null, createdAt }
    nextSessionId: 1,
    nextAlertId: 1
  };
}
// Per-kid daily total cap defaults (minutes across all devices). Used for new
// state AND to migrate older stored state that lacks the field.
const KID_TOTAL_DEFAULTS = { Ale: 90, Leo: 90, Gio: null };
function normalizeKidTotals() {
  if (!data || !Array.isArray(data.kids)) return false;
  let changed = false;
  for (const k of data.kids) {
    if (k.dailyTotalLimitMinutes === undefined) {
      k.dailyTotalLimitMinutes = (k.name in KID_TOTAL_DEFAULTS) ? KID_TOTAL_DEFAULTS[k.name] : null;
      changed = true;
    }
  }
  return changed;
}
let data = null;
function loadData() {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    data = defaultData();
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
  }
  if (normalizeKidTotals()) saveData();
  return data;
}
// serialize writes so concurrent requests don't clobber the store
let writeQueue = Promise.resolve();
function saveData() {
  const snapshot = JSON.stringify(data, null, 2);
  if (useDb && pgPool) {
    writeQueue = writeQueue.then(async () => {
      try {
        await pgPool.query(
          'INSERT INTO app_state (id, state, updated_at) VALUES (1, $1::jsonb, now()) ' +
          'ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()',
          [snapshot]
        );
      } catch (e) { console.error('DB save failed:', e.message); }
    }).catch(() => {});
    return writeQueue;
  }
  writeQueue = writeQueue.then(() => new Promise((res) => {
    fs.writeFile(DATA_FILE, snapshot, () => res());
  })).catch(() => {});
  return writeQueue;
}
// Initialize the store: Postgres when DATABASE_URL is set, else data.json.
// Postgres keeps the whole state as one JSONB row (id=1), so ALL behavior is
// identical — sessions, alerts, limits, PIN hashes, tokens — and history
// survives restarts. Any Postgres failure falls back to data.json.
async function initStore() {
  if (DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      const needsSsl = /sslmode=require/.test(DATABASE_URL) || /supabase\.co/.test(DATABASE_URL);
      pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
        max: 5
      });
      await pgPool.query('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const r = await pgPool.query('SELECT state FROM app_state WHERE id = 1');
      if (r.rows.length) {
        data = r.rows[0].state;
      } else {
        data = defaultData();
        await pgPool.query('INSERT INTO app_state (id, state) VALUES (1, $1::jsonb)', [JSON.stringify(data)]);
      }
      useDb = true;
      if (normalizeKidTotals()) await saveData();
      console.log('State store: Postgres (DATABASE_URL) — history survives restarts');
      return;
    } catch (e) {
      console.error('Postgres init failed, falling back to data.json:', e.message);
      try { if (pgPool) await pgPool.end(); } catch (_) {}
      pgPool = null; useDb = false;
    }
  }
  loadData();
  console.log('State store: data.json (ephemeral on free hosts)');
}

// ---------- derived state ----------
function sessionMinutes(s, now) {
  if (s.status === 'done' && s.minutes != null) return s.minutes;
  return minutesBetween(s.startedAt, now);
}
function deviceTodayMinutes(deviceId, now) {
  const today = etYMD(now);
  let total = 0;
  for (const s of data.sessions) {
    if (s.deviceId !== deviceId) continue;
    if (etYMD(new Date(s.startedAt)) !== today) continue;
    total += sessionMinutes(s, now);
  }
  return total;
}
function kidTodayMinutes(kid, now) {
  const today = etYMD(now);
  let total = 0;
  for (const s of data.sessions) {
    if (s.kid !== kid) continue;
    if (etYMD(new Date(s.startedAt)) !== today) continue;
    total += sessionMinutes(s, now);
  }
  return total;
}
function kidWeekMinutes(kid, now) {
  const monday = etMondayYMD(now);
  let total = 0;
  for (const s of data.sessions) {
    if (s.kid !== kid) continue;
    if (etYMD(new Date(s.startedAt)) < monday) continue;
    total += sessionMinutes(s, now);
  }
  return total;
}
function deviceWeekMinutes(deviceId, now) {
  const monday = etMondayYMD(now);
  let total = 0;
  for (const s of data.sessions) {
    if (s.deviceId !== deviceId) continue;
    if (etYMD(new Date(s.startedAt)) < monday) continue;
    total += sessionMinutes(s, now);
  }
  return total;
}
function activeSessions() { return data.sessions.filter(s => s.status === 'active'); }

// ---------- overdue check (server-side, every 60s + on state fetch) ----------
function runOverdueCheck(now) {
  now = now || new Date();
  if (!data) return false;
  let changed = false;
  for (const s of activeSessions()) {
    const dev = data.devices.find(d => d.id === s.deviceId);
    if (!dev) continue;
    const kid = data.kids.find(k => k.name === s.kid);
    const totalToday = deviceTodayMinutes(dev.id, now);
    const overMin = totalToday - dev.dailyLimitMinutes;
    const pastCurfew = kid && kid.curfewMinutes != null && etMinutes(now) >= kid.curfewMinutes;
    // kid daily total across ALL devices (e.g. Ale capped at 90 min total)
    let totalOverMin = null;
    if (kid && kid.dailyTotalLimitMinutes != null) {
      totalOverMin = kidTodayMinutes(kid.name, now) - kid.dailyTotalLimitMinutes;
    }
    const overDevice = overMin >= 0;
    const overTotal = totalOverMin != null && totalOverMin >= 0;
    if (!overDevice && !overTotal && !pastCurfew) continue;
    // dedupe: one overdue alert per session
    if (data.alerts.some(a => a.kind === 'overdue' && a.sessionId === s.id)) continue;
    let detail;
    if (overTotal) {
      detail = s.kid + " is " + totalOverMin + " min over today's " + kid.dailyTotalLimitMinutes + "-minute total";
      if (overDevice) detail += " (" + dev.name + " also " + overMin + " min over its " + dev.dailyLimitMinutes + "-minute limit)";
      if (pastCurfew) detail += " and past curfew (" + fmtClock(kid.curfewMinutes) + ")";
    } else if (overMin >= 0 && pastCurfew) {
      detail = s.kid + "'s " + dev.name + " is " + overMin + " min over today's " + dev.dailyLimitMinutes + "-minute limit and past curfew (" + fmtClock(kid.curfewMinutes) + ")";
    } else if (overMin >= 0) {
      detail = s.kid + "'s " + dev.name + " is " + overMin + " min over today's " + dev.dailyLimitMinutes + "-minute limit";
    } else {
      detail = s.kid + "'s " + dev.name + " is past curfew (" + fmtClock(kid.curfewMinutes) + ")";
    }
    data.alerts.push({ id: data.nextAlertId++, kind: 'overdue', kid: s.kid, deviceName: dev.name, sessionId: s.id, detail, createdAt: nowISO() });
    changed = true;
  }
  if (changed) saveData();
  return changed;
}
setInterval(() => { try { runOverdueCheck(new Date()); } catch (_) {} }, 60000);

// ---------- auth ----------
function authToken(req) {
  // token via Authorization: Bearer <t> or ?token= or JSON body token
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}
function lookupToken(t) {
  if (!t || !data.tokens[t]) return null;
  return data.tokens[t];
}

// ---------- state builder ----------
function buildState(tokenInfo, now) {
  now = now || new Date();
  runOverdueCheck(now);
  const isParent = tokenInfo && tokenInfo.role === 'parent';
  const kidName = tokenInfo && tokenInfo.role === 'kid' ? tokenInfo.kid : null;
  const devices = data.devices.filter(d => !d.archived).map(d => ({
    id: d.id, name: d.name, code: d.code, kind: d.kind,
    dailyLimitMinutes: d.dailyLimitMinutes,
    todayMinutes: deviceTodayMinutes(d.id, now),
    weekMinutes: deviceWeekMinutes(d.id, now)
  }));
  const allDevices = data.devices.map(d => ({
    id: d.id, name: d.name, code: d.code, kind: d.kind,
    dailyLimitMinutes: d.dailyLimitMinutes, archived: d.archived,
    todayMinutes: deviceTodayMinutes(d.id, now),
    weekMinutes: deviceWeekMinutes(d.id, now)
  }));
  const act = activeSessions().map(s => {
    const dev = data.devices.find(d => d.id === s.deviceId);
    return {
      id: s.id, kid: s.kid, deviceId: s.deviceId, deviceName: dev ? dev.name : '',
      startedAt: s.startedAt, panicAt: s.panicAt,
      elapsedMinutes: minutesBetween(s.startedAt, now.toISOString()),
      usedBeforeMinutes: s.usedBeforeMinutes || 0
    };
  });
  const recent = [...data.sessions].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 30).map(s => {
    const dev = data.devices.find(d => d.id === s.deviceId);
    return { id: s.id, kid: s.kid, deviceName: dev ? dev.name : '', startedAt: s.startedAt, endedAt: s.endedAt, minutes: s.status === 'done' ? s.minutes : minutesBetween(s.startedAt, now.toISOString()), status: s.status };
  });
  const alerts = [...data.alerts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
  const curfews = data.kids.map(k => ({ kid: k.name, cutoffMinutes: k.curfewMinutes, cutoffLabel: k.curfewMinutes == null ? null : fmtClock(k.curfewMinutes) }));
  const kidTotals = data.kids.map(k => ({ kid: k.name, todayMinutes: kidTodayMinutes(k.name, now), weekMinutes: kidWeekMinutes(k.name, now), dailyTotalLimitMinutes: k.dailyTotalLimitMinutes != null ? k.dailyTotalLimitMinutes : null }));
  const base = { ok: true, now: nowISO(), devices, allDevices, curfews, kidTotals, kids: data.kids.map(k => k.name) };
  if (isParent) {
    return Object.assign(base, { role: 'parent', active: act, recent, alerts });
  }
  // kid token: only this kid's data
  return Object.assign(base, {
    role: 'kid', kid: kidName,
    active: act.filter(s => s.kid === kidName),
    recent: recent.filter(s => s.kid === kidName),
    alerts: alerts.filter(a => a.kid === kidName)
  });
}

// ---------- HTTP ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
function serveFile(res, filePath, contentType, extraHeaders) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = Object.assign({ 'Content-Type': contentType, 'Cache-Control': 'no-cache' }, extraHeaders || {});
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // robots.txt — non-indexable
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /\n');
      return;
    }
    // favicon — silence
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    // ---- API ----
    if (pathname.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const token = authToken(req) || url.searchParams.get('token') || body.token || null;
      const info = lookupToken(token);

      if (pathname === '/api/verify-pin' && req.method === 'POST') {
        const role = body.role;
        const pin = String(body.pin || '');
        if (role === 'parent') {
          if (sha256(pin) === data.parentPinHash) {
            const t = makeToken(); data.tokens[t] = { role: 'parent', kid: null, createdAt: nowISO() };
            saveData();
            return sendJSON(res, 200, { ok: true, token: t, role: 'parent' });
          }
          return sendJSON(res, 200, { ok: false, error: 'Wrong PIN' });
        }
        if (role === 'kid') {
          const kid = data.kids.find(k => k.name === body.kid);
          if (!kid) return sendJSON(res, 200, { ok: false, error: 'Unknown kid' });
          if (sha256(pin) === kid.pinHash) {
            const t = makeToken(); data.tokens[t] = { role: 'kid', kid: kid.name, createdAt: nowISO() };
            saveData();
            return sendJSON(res, 200, { ok: true, token: t, role: 'kid', kid: kid.name });
          }
          return sendJSON(res, 200, { ok: false, error: 'Wrong PIN' });
        }
        return sendJSON(res, 400, { ok: false, error: 'Bad role' });
      }

      // all other API calls require a valid token
      if (!info) return sendJSON(res, 401, { ok: false, error: 'Not authorized — enter your PIN first' });

      if (pathname === '/api/state' && req.method === 'GET') {
        return sendJSON(res, 200, buildState(info, new Date()));
      }

      if (pathname === '/api/startsession' && req.method === 'POST') {
        if (info.role !== 'kid') return sendJSON(res, 403, { ok: false, error: 'Kids only' });
        const kidName = info.kid;
        const code = String(body.deviceCode || '').trim();
        const dev = data.devices.find(d => d.code === code && !d.archived);
        if (!dev) return sendJSON(res, 200, { ok: false, error: 'Unknown device — scan the label again' });
        const now = new Date();
        const kid = data.kids.find(k => k.name === kidName);
        if (activeSessions().some(s => s.deviceId === dev.id)) {
          return sendJSON(res, 200, { ok: false, error: dev.name + ' is already in use' });
        }
        const usedToday = deviceTodayMinutes(dev.id, now);
        if (usedToday >= dev.dailyLimitMinutes) {
          return sendJSON(res, 200, { ok: false, error: dev.name + "'s " + dev.dailyLimitMinutes + "-minute daily limit is used up" });
        }
        const kidTotalToday = kidTodayMinutes(kidName, now);
        if (kid && kid.dailyTotalLimitMinutes != null && kidTotalToday >= kid.dailyTotalLimitMinutes) {
          return sendJSON(res, 200, { ok: false, error: kidName + "'s " + kid.dailyTotalLimitMinutes + "-minute daily total is used up" });
        }
        if (kid && kid.curfewMinutes != null && etMinutes(now) >= kid.curfewMinutes) {
          return sendJSON(res, 200, { ok: false, error: 'Past curfew (' + fmtClock(kid.curfewMinutes) + ') — no more devices tonight' });
        }
        const s = { id: data.nextSessionId++, kid: kidName, deviceId: dev.id, startedAt: nowISO(), endedAt: null, minutes: null, panicAt: null, status: 'active', usedBeforeMinutes: usedToday };
        data.sessions.push(s);
        data.alerts.push({ id: data.nextAlertId++, kind: 'started', kid: kidName, deviceName: dev.name, sessionId: s.id, detail: kidName + ' started the ' + dev.name, createdAt: nowISO() });
        saveData();
        return sendJSON(res, 200, { ok: true, session: { id: s.id, kid: s.kid, deviceId: s.deviceId, deviceName: dev.name, startedAt: s.startedAt } });
      }

      if (pathname === '/api/checkin' && req.method === 'POST') {
        const sid = parseInt(body.sessionId, 10);
        const s = data.sessions.find(x => x.id === sid && x.status === 'active');
        if (!s) return sendJSON(res, 200, { ok: false, error: 'No active session' });
        if (info.role === 'kid' && info.kid !== s.kid) return sendJSON(res, 403, { ok: false, error: 'Not your session' });
        const now = new Date();
        s.status = 'done';
        s.endedAt = now.toISOString();
        s.minutes = minutesBetween(s.startedAt, s.endedAt);
        saveData();
        return sendJSON(res, 200, { ok: true, session: { id: s.id, minutes: s.minutes } });
      }

      if (pathname === '/api/panicsession' && req.method === 'POST') {
        if (info.role !== 'parent') return sendJSON(res, 403, { ok: false, error: 'Parents only' });
        const sid = parseInt(body.sessionId, 10);
        const s = data.sessions.find(x => x.id === sid && x.status === 'active');
        if (!s) return sendJSON(res, 200, { ok: false, error: 'No active session' });
        s.panicAt = nowISO();
        saveData();
        return sendJSON(res, 200, { ok: true });
      }

      if (pathname === '/api/setdailylimit' && req.method === 'POST') {
        if (info.role !== 'parent') return sendJSON(res, 403, { ok: false, error: 'Parents only' });
        const dev = data.devices.find(d => d.id === parseInt(body.deviceId, 10));
        const mins = parseInt(body.minutes, 10);
        if (!dev || !(mins >= 5 && mins <= 600)) return sendJSON(res, 200, { ok: false, error: 'Bad device or limit (5–600 min)' });
        dev.dailyLimitMinutes = mins;
        saveData();
        return sendJSON(res, 200, { ok: true });
      }

      if (pathname === '/api/setkidtotallimit' && req.method === 'POST') {
        if (info.role !== 'parent') return sendJSON(res, 403, { ok: false, error: 'Parents only' });
        const kid = data.kids.find(k => k.name === body.kid);
        if (!kid) return sendJSON(res, 200, { ok: false, error: 'Unknown kid' });
        // blank/null = no total cap (device limits still apply)
        if (body.minutes === null || body.minutes === '' || body.minutes === undefined) {
          kid.dailyTotalLimitMinutes = null;
          saveData();
          return sendJSON(res, 200, { ok: true });
        }
        const mins = parseInt(body.minutes, 10);
        if (!(mins >= 5 && mins <= 600)) return sendJSON(res, 200, { ok: false, error: 'Bad limit (5–600 min, or blank for no cap)' });
        kid.dailyTotalLimitMinutes = mins;
        saveData();
        return sendJSON(res, 200, { ok: true });
      }

      if (pathname === '/api/setdevicearchived' && req.method === 'POST') {
        if (info.role !== 'parent') return sendJSON(res, 403, { ok: false, error: 'Parents only' });
        const dev = data.devices.find(d => d.id === parseInt(body.deviceId, 10));
        if (!dev) return sendJSON(res, 200, { ok: false, error: 'Unknown device' });
        dev.archived = !!body.archived;
        saveData();
        return sendJSON(res, 200, { ok: true });
      }

      if (pathname === '/api/clearkidtime' && req.method === 'POST') {
        if (info.role !== 'parent') return sendJSON(res, 403, { ok: false, error: 'Parents only' });
        const kids = Array.isArray(body.kids) ? body.kids : [];
        const before = data.sessions.length;
        data.sessions = data.sessions.filter(s => !kids.includes(s.kid));
        data.alerts = data.alerts.filter(a => !kids.includes(a.kid));
        const deleted = before - data.sessions.length;
        saveData();
        return sendJSON(res, 200, { ok: true, deletedSessions: deleted });
      }

      if (pathname === '/api/setparentpin' && req.method === 'POST') {
        if (info.role !== 'parent') return sendJSON(res, 403, { ok: false, error: 'Parents only' });
        const oldPin = String(body.oldPin || '');
        const newPin = String(body.newPin || '');
        if (sha256(oldPin) !== data.parentPinHash) return sendJSON(res, 200, { ok: false, error: 'Current PIN is wrong' });
        if (!/^\d{4}$/.test(newPin)) return sendJSON(res, 200, { ok: false, error: 'New PIN must be 4 digits' });
        data.parentPinHash = sha256(newPin);
        saveData();
        return sendJSON(res, 200, { ok: true });
      }

      return sendJSON(res, 404, { ok: false, error: 'Unknown API' });
    }

    // ---- static frontend (all routes serve index.html; JS reads the URL) ----
    if (req.method === 'GET') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8', { 'X-Robots-Tag': 'noindex, nofollow' });
    }
    res.writeHead(405); res.end('Method not allowed');
  } catch (e) {
    console.error(e);
    try { sendJSON(res, 500, { ok: false, error: 'Server error' }); } catch (_) {}
  }
});

initStore().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Device Check-In public app listening on port ' + PORT + (useDb ? ' (Postgres)' : ' (data.json)'));
  });
}).catch((e) => {
  console.error('Store init failed:', e);
  loadData();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Device Check-In public app listening on port ' + PORT + ' (data.json fallback)');
  });
});
