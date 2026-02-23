// ---------------------------------------------Server.js ----12-01-2026------------------------------------------------

// ========================================
// CRITICAL: Load environment variables FIRST
// ========================================
// This MUST be the first require() to ensure
// all env vars are available before any other module
const envLoader = require('./config/env-loader');

// -------------------- Imports & Env --------------------
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const axios = require('axios'); // for SOAP note generation
const sql = require('mssql');   // MSSQL driver
const { Sequelize } = require('sequelize');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const nodemailer = require('nodemailer');
const { userInfo } = require('os');
const { sequelize, connectToDatabase, closeDatabase } = require('./database/database-config');
const { getAzureSqlConnection } = require('./database/azure-db-helper');



console.log('[BOOT] Instance:', process.env.WEBSITE_INSTANCE_ID || process.pid);

// -------------------- Process-level safety --------------------
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection:', err?.stack || err);
});

// -------------------- Debug helpers --------------------
const DEBUG_LOGS = (process.env.DEBUG_LOGS || 'true').toLowerCase() === 'true';
function dlog(...args) {
  if (DEBUG_LOGS) console.log(...['[DEBUG]'].concat(args));
}
function dwarn(...args) {
  console.warn(...['[WARN]'].concat(args));
}
function derr(...args) {
  console.error(...['[ERROR]'].concat(args));
}
function trimStr(s, max = 140) {
  if (typeof s !== 'string') return s;
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}
function safeDataPreview(obj) {
  try {
    const s = JSON.stringify(obj);
    return trimStr(s, 300);
  } catch {
    return '[unserializable]';
  }
}

// NEW: numeric coercion helper for telemetry
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- Safe global socket snapshot (fast-fail + local fallback) ---
async function safeFetchSockets(io, namespace = "/") {
  const nsp = io.of(namespace);

  // Always include local sockets immediately (never blocks)
  const local = Array.from(nsp.sockets?.values?.() || []);

  const adapter = nsp.adapter;
  const supportsGlobal = typeof nsp.fetchSockets === "function" && adapter && adapter.broadcast?.apply;
  if (!supportsGlobal) return local;

  try {
    // Short guard so device-list / identify / health never stall on a stale peer
    const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("guard-timeout")), 2500));

    const globalSockets = await Promise.race([nsp.fetchSockets(), guard]);

    if (!Array.isArray(globalSockets)) {
      console.warn("[WARN] [safeFetchSockets] fetchSockets returned non-array; using local only:", typeof globalSockets);
      return local;
    }


    // Merge local + global by socket.id
    const byId = new Map(local.map(s => [s.id, s]));
    for (const s of globalSockets) byId.set(s.id, s);
    return Array.from(byId.values());
  } catch (e) {
    console.warn("[WARN] [safeFetchSockets] global fetch failed; using local only:", e.message);
    return local;
  }
}


// -------------------- Env Flags --------------------
const IS_PROD =
  (process.env.NODE_ENV || '').toLowerCase().startsWith('prod') ||
  !!process.env.WEBSITE_SITE_NAME; // Azure sets this

// ✅ SECURITY FIX (scanner requirement)
// Force Express to run in production mode when deployed.
// Express reads NODE_ENV at app creation time.
if (IS_PROD && String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
  process.env.NODE_ENV = 'production';
  console.log('[SECURITY] Forced NODE_ENV=production');
}

// -------------------- Config & Servers --------------------
console.log('[INIT] Starting server initialization...');
const PORT = process.env.PORT || 8080;
console.log(`[CONFIG] Using port: ${PORT}`);

// (DO NOT redeclare IS_PROD here — use the one already defined above)

const app = express();

// Azure App Service runs behind a reverse proxy (TLS terminated upstream)
if (IS_PROD) {
  app.set('trust proxy', 1);
}


const server = http.createServer(app);
console.log('[HTTP] Server created');

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'], // include polling
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 30000,
});

console.log('[SOCKET.IO] Socket.IO server initialized');

/* =========================================================
   DEBUG HELPER (TEMP – SAFE)
   ========================================================= */
function dbgToSocket(socket, msg, extra = {}) {
  try {
    socket.emit("debug_log", {
      msg,
      ...extra,
      t: new Date().toISOString()
    });
  } catch { }
}

/* =========================================================
   DEBUG HELPER – ROOM (TEMP – SAFE)
   ========================================================= */
function dbgToRoom(roomId, msg, extra = {}) {
  try {
    if (!roomId) return;
    io.to(roomId).emit("debug_log", {
      msg,
      ...extra,
      t: new Date().toISOString()
    });
  } catch { }
}


// -------------------- Socket.IO Redis Adapter (MANDATORY for multi-instance) --------------------
let ioRedisReady = false;

if (IS_PROD && process.env.REDIS_URL) {
  const pubClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      keepAlive: 5000,
      reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
    },
  });

  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => console.error('[SOCKET.IO][REDIS][PUB] error', err));
  subClient.on('error', (err) => console.error('[SOCKET.IO][REDIS][SUB] error', err));

  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      ioRedisReady = true;
      console.log('[SOCKET.IO][REDIS] adapter attached (multi-instance room sync ON)');
    })
    .catch((err) => {
      console.error(
        '[SOCKET.IO][REDIS] adapter connect failed — exiting (prod requires Redis adapter):',
        err?.message || err
      );

      // ❌ Do NOT allow server to run without adapter in prod
      process.exit(1);
    });

} else {
  console.log('[SOCKET.IO][REDIS] adapter not enabled (dev or missing REDIS_URL)');
}


// -------------------- Middleware --------------------
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.json());
console.log('[MIDDLEWARE] CORS + JSON enabled');

// -------------------- Redis Client Factory (Stability Hardened) --------------------
function createStableRedisClient(url, tag) {
  const client = createClient({
    url,
    socket: {
      keepAlive: 10000,
      connectTimeout: 10000,
      reconnectStrategy: (retries) => {
        // backoff: 200ms → 2s max
        return Math.min(200 + retries * 200, 2000);
      },
    },
  });

  client.on('error', (e) =>
    console.error(`[${tag}][REDIS] error`, e?.message || e)
  );
  client.on('reconnecting', () =>
    console.warn(`[${tag}][REDIS] reconnecting...`)
  );
  client.on('ready', () =>
    console.log(`[${tag}][REDIS] ready`)
  );
  client.on('end', () =>
    console.warn(`[${tag}][REDIS] connection ended`)
  );

  return client;
}




// -------------------- Session Store (Prod: Redis) --------------------
let sessionStore;

if (IS_PROD && process.env.REDIS_URL) {
  const connectRedis = require('connect-redis');
  // connect-redis v9 CommonJS: class is usually at .RedisStore
  const RedisStore = connectRedis.RedisStore || connectRedis.default || connectRedis;

  const sessionRedis = createStableRedisClient(
    process.env.REDIS_URL,
    'SESSION'
  );



  sessionRedis.connect().then(
    () => console.log('[SESSION][REDIS] connected'),
    (err) =>
      console.error(
        '[SESSION][REDIS] connect failed (continuing)',
        err?.message || err
      )
  );

  sessionStore = new RedisStore({
    client: sessionRedis,
    prefix: 'sess:',
  });
}

// -------------------- XR Runtime Redis (Owner Locks) --------------------
// Separate Redis client for XR online/offline authority (Option B)
let xrRedis = null;

if (IS_PROD && process.env.REDIS_URL) {
  xrRedis = createStableRedisClient(
    process.env.REDIS_URL,
    'XR'
  );



  xrRedis.connect().then(
    () => console.log('[XR][REDIS] connected'),
    (err) =>
      console.error(
        '[XR][REDIS] connect failed (continuing)',
        err?.message || err
      )
  );
}



// Session middleware for platform admin
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-production';
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,

    // ✅ critical for Azure scale-out / restarts
    store: sessionStore || undefined,

    // helps when behind proxy (pairs with trust proxy)
    proxy: IS_PROD,

    cookie: {
      httpOnly: true,

      // ✅ REQUIRED for HTTPS + Azure proxy
      sameSite: IS_PROD ? 'none' : 'lax',
      secure: IS_PROD,

      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

console.log('[MIDDLEWARE] Session enabled');

// ✅ Connect to Azure SQL via Sequelize on boot (non-fatal if it fails)
(async () => {
  try {
    await connectToDatabase();
    console.log('🚀 [DB] Azure SQL connection established');
  } catch (err) {
    console.error('❌ [DB] Failed to connect to Azure SQL (continuing without DB):', err?.message || err);
    // NOTE: Do not exit; server keeps running without DB.
  }
})();


// // -------------------- UI routes (migrated from frontend/server.js) --------------------
// 🧩 Paths
const FRONTEND_VIEWS = path.join(__dirname, '..', 'frontend', 'views');
const FRONTEND_PUBLIC = path.join(__dirname, '..', 'frontend', 'public');
const BACKEND_PUBLIC = path.join(__dirname, 'public');

// 🧠 Choose which directory actually exists
const VIEWS_DIR = fs.existsSync(FRONTEND_VIEWS) ? FRONTEND_VIEWS : BACKEND_PUBLIC;
const PUBLIC_DIR = fs.existsSync(FRONTEND_PUBLIC) ? FRONTEND_PUBLIC : BACKEND_PUBLIC;

app.use('/public', express.static(PUBLIC_DIR));
console.log(`[STATIC] Serving UI assets from ${PUBLIC_DIR}`);

// Keep HTML fresh (safe for XR flows)
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const sendView = (name) => (_req, res) => {
  const filePath = path.join(VIEWS_DIR, name);
  if (!fs.existsSync(filePath)) {
    console.warn(`[WARN] Missing view: ${filePath}`);
    return res.status(404).send(`View not found: ${name}`);
  }

  try {
    const html = fs.readFileSync(filePath, 'utf8');

    // inject TURN config if function available
    const injected = (typeof injectTurnConfig === 'function')
      ? injectTurnConfig(html)
      : html;

    // Make sure the result is HTML
    res.type('html').send(injected);
  } catch (err) {
    console.error('[sendView] error reading / sending view:', err);
    res.status(500).send('Server error');
  }
};

// PWA assets — keep this ABOVE any /device HTML route
// Serve both common manifest URLs, but point both to device.webmanifest
app.get(['/manifest.webmanifest', '/device.webmanifest'], (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'device.webmanifest')); // file exists here
});

// Map ALL service-worker entrypoints to the same script
app.get(['/sw.js', '/sw-device.js', '/device/sw.js'], (req, res) => {
  res.type('application/javascript');
  res.set('Service-Worker-Allowed', '/device/');             // allow /device/* scope
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'sw-device.js'));       // NOTE: no /js subfolder
});


// Pretty routes → views
app.get(['/device', '/device/'], sendView('device.html'));
app.get(['/dashboard', '/dashboard/'], sendView('dashboard.html'));
app.get(['/scribe-cockpit', '/scribe-cockpit/'], sendView('scribe-cockpit.html'));
app.get(['/operator', '/operator/'], sendView('operator.html'));
app.get(['/platform', '/platform/'], sendView('platform.html'));
app.get('/', sendView('index.html'));




// -------------------- Static --------------------
// Frontend now serves all UI. Do NOT expose ../frontend here.
const backendPublic = path.join(__dirname, 'public');
if (fs.existsSync(backendPublic)) {
  app.use(express.static(backendPublic)); // keep only if you really have backend-only assets
  console.log(`[STATIC] Serving static from ${backendPublic}`);
} else {
  dlog('[STATIC] backend/public not found');
}

// -------------------- TURN Injection --------------------
function injectTurnConfig(html) {
  const raw = (process.env.TURN_URL || '').split(/[,\s]+/).filter(Boolean);

  const expand = (u) => {
    if (!u) return [];
    // If full turn/turns URL provided, use as-is
    if (/^(stun|turns?):/i.test(u)) return [u];
    // If only a host was given (e.g. "turn.example.com"), synthesize common variants.
    const host = String(u).replace(/:\d+$/, '');
    return [
      `turns:${host}:443?transport=tcp`,   // <- critical for iOS/corporate/captive networks
      `turns:${host}:5349?transport=tcp`,
      `turn:${host}:3478?transport=tcp`,
      `turn:${host}:3478?transport=udp`
    ];
  };

  // Flatten all provided items (comma/space separated env)
  const urls = raw.flatMap(expand);

  const cfg = `
    <script>
      window.TURN_CONFIG = {
        urls: ${urls.length <= 1 ? JSON.stringify(urls[0] || '') : JSON.stringify(urls)},
        username: ${JSON.stringify(process.env.TURN_USERNAME || '')},
        credential: ${JSON.stringify(process.env.TURN_CREDENTIAL || '')}
      };
    </script>`;

  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${cfg}\n</body>`) : (html + cfg);
}



// -------------------- Room Concept State --------------------
const clients = new Map();        // xrId -> socket
const desktopClients = new Map(); // xrId -> desktop socket
const onlineDevices = new Map();  // xrId -> socket (convenience)
// NEW: latest battery snapshot per device
const batteryByDevice = new Map(); // xrId -> { pct, charging, ts }

// NEW: latest network telemetry per device
// shape: { xrId, connType, wifiDbm, wifiMbps, wifiBars, cellDbm, cellBars, ts }
const telemetryByDevice = new Map();

const qualityByDevice = new Map(); // xrId -> latest webrtc quality snapshot

dlog('[ROOM] State maps initialized');

// --- Time-series history for charts (keep last 24 hours) ---
const METRIC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const telemetryHist = new Map(); // xrId -> [{ ts, connType, wifiMbps, netDownMbps, netUpMbps, batteryPct }]
const qualityHist = new Map();   // xrId -> [{ ts, jitterMs, rttMs, lossPct, bitrateKbps }]


function pushHist(map, xrId, sample) {
  const arr = map.get(xrId) || [];
  arr.push(sample);
  const cutoff = Date.now() - METRIC_WINDOW_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  map.set(xrId, arr);
}


// ===============================
// Option B: DB-driven 1:1 pairing
// ===============================

// In-memory exclusivity map (case-insensitive keys)
// key = normalized xrId (lowercase)
// value = normalized partner xrId (lowercase)
const pairedWith = new Map();

function normXr(x) {
  return String(x || '').trim().toUpperCase();
}

// Normalize pair for comparisons / uniqueness (case-insensitive)
function normalizePair(a, b) {
  return [normXr(a), normXr(b)].sort().join('|');
}

// Canonical room id for a pair (case-insensitive room naming)
function getRoomIdForPair(a, b) {
  const [one, two] = [normXr(a), normXr(b)].sort();
  const roomId = `pair:${one}:${two}`;
  dlog('[ROOM] getRoomIdForPair', a, b, '=>', roomId);
  return roomId;
}

// Helper: find an online socket by xrId (case-insensitive) using your existing clients Map
function getClientSocketByXrIdCI(xrId) {
  const wanted = normXr(xrId);
  for (const [key, sock] of clients.entries()) {
    if (normXr(key) === wanted) return sock;
  }
  return null;
}


// NEW: cluster-aware lookup (multi-instance safe)
// Finds a socket by xrId across all instances (requires Redis adapter).
async function getClientSocketByXrIdCI_Cluster(XR, debugSocket = null) {
  const wanted = normXr(XR);
  if (!wanted) return null;

  try {
    const sockets = await io.fetchSockets(); // cluster-wide with Redis adapter
    const found = sockets.find(s =>
      typeof s.data?.xrId === 'string' &&
      normXr(s.data.xrId) === wanted &&
      s.data?.clientType !== 'cockpit' &&
      s.data?.clientType !== 'dashboard'
    ) || null;


    if (debugSocket) {
      dbgToSocket(debugSocket, "[COCKPIT][FIND_PRIMARY] result", {
        wanted,
        foundSocketId: found?.id || null,
        foundClientType: found?.data?.clientType || null,
        foundRoomId: found?.data?.roomId || null
      });
    }

    dlog('[COCKPIT][FIND_PRIMARY] cluster lookup', {
      wanted,
      found: !!found,
      foundSocketId: found?.id || null,
      foundRoomId: found?.data?.roomId || null
    });

    return found;
  } catch (e) {
    dwarn('[COCKPIT][FIND_PRIMARY] fetchSockets failed', { wanted, err: e?.message || e });
    if (debugSocket) dbgToSocket(debugSocket, "[COCKPIT][FIND_PRIMARY] fetchSockets failed", {
      wanted, err: e?.message || String(e)
    });
    return null;
  }
}

// Notify any cockpit viewers watching this XR (even when not paired yet).
async function notifyCockpitsWatchingXr(XR, payloadDevices) {
  try {
    const wanted = normXr(XR);
    if (!wanted) return;

    // Needs Redis adapter to be truly cluster-wide in prod.
    const sockets = await io.fetchSockets();

    const watchers = sockets.filter(s =>
      s?.data?.clientType === 'cockpit' &&
      normXr(s.data?.cockpitForXrId) === wanted &&
      !s.data?.roomId // only push when they are NOT in a pair room yet
    );

    for (const w of watchers) {
      try {
        // Keep cockpit unpaired state consistent
        w.emit('room_joined', { roomId: null, reason: 'watch_update' });
        w.emit('device_list', Array.isArray(payloadDevices) ? payloadDevices : []);
      } catch { }
    }

    dlog('[COCKPIT][WATCH_NOTIFY] pushed', { wanted, watchers: watchers.length, count: payloadDevices?.length || 0 });
  } catch (e) {
    dwarn('[COCKPIT][WATCH_NOTIFY] failed', { XR, err: e?.message || e });
  }
}


// Helper: clear pairing on disconnect (we will call this in disconnect later)
function clearPairByXrId(xrId) {
  const me = normXr(xrId);
  const partner = pairedWith.get(me);
  if (partner) pairedWith.delete(partner);
  pairedWith.delete(me);
  return partner || null;
}

function isAlreadyPaired(xrId) {
  return pairedWith.has(normXr(xrId));
}

// RoomId is canonical: pair:<XR-A>:<XR-B>
function parsePairRoom(roomId) {
  // roomId example: "pair:XR-8000:XR-8005"
  const parts = String(roomId || '').split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'pair') return null;

  const a = normXr(parts[1]);
  const b = normXr(parts[2]);
  if (!a || !b) return null;
  return { a, b };
}

function collectPairs() {
  const pairs = [];
  for (const [roomId] of io.sockets.adapter.rooms) {
    if (!String(roomId).startsWith('pair:')) continue;

    const parsed = parsePairRoom(roomId);
    if (!parsed) continue;

    // normalize + keep stable order
    const key = normalizePair(parsed.a, parsed.b);
    const [a, b] = key.split('|');
    pairs.push({ a, b });
  }
  return pairs;
}


function broadcastPairs() {
  const pairs = collectPairs();
  io.emit('room_update', { pairs });
  dlog('[PAIR] broadcastPairs:', pairs);
}

// ---- DB resolvers using Sequelize (you already use sequelize.query elsewhere) ----
// NOTE: This assumes `sequelize` and `Sequelize` are in scope in server.js (they are in your existing routes).

async function resolveUserIdByXrId(xrId) {
  const xr = normXr(xrId);
  if (!xr) return null;

  const rows = await sequelize.query(
    `
      SELECT TOP 1 id
      FROM System_Users
      WHERE row_status = 1
        AND LOWER(LTRIM(RTRIM(xr_id))) = :xr
    `,
    { replacements: { xr }, type: Sequelize.QueryTypes.SELECT }
  );

  return rows?.[0]?.id ?? null;
}

async function resolvePartnerUserId(userId) {
  if (!userId) return null;

  const rows = await sequelize.query(
    `
      SELECT TOP 1
        CASE
          WHEN scribe_user_id = :userId THEN provider_user_id
          WHEN provider_user_id = :userId THEN scribe_user_id
          ELSE NULL
        END AS partnerUserId
      FROM Scribe_Provider_Mapping
      WHERE row_status = 1
        AND (:userId IN (scribe_user_id, provider_user_id))
      ORDER BY id DESC
    `,
    { replacements: { userId }, type: Sequelize.QueryTypes.SELECT }
  );

  return rows?.[0]?.partnerUserId ?? null;
}

async function resolveXrIdByUserId(userId) {
  if (!userId) return null;

  const rows = await sequelize.query(
    `
      SELECT TOP 1 xr_id
      FROM System_Users
      WHERE row_status = 1
        AND id = :userId
    `,
    { replacements: { userId }, type: Sequelize.QueryTypes.SELECT }
  );

  const xr = rows?.[0]?.xr_id;
  return xr ? String(xr).trim() : null;
}
async function findSocketByXrIdCI_Cluster(xrId, debugSocket = null) {
  const XR = normXr(xrId);
  if (!XR) {
    if (debugSocket) dbgToSocket(debugSocket, "[PAIR][FIND] invalid xrId", { xrId });
    return null;
  }

  const sockets = await safeFetchSockets(io, "/");

  // Send a small summary to browser for debugging (limit to 10 entries)
  if (debugSocket) {
    dbgToSocket(debugSocket, "[PAIR][FIND] scanned sockets", {
      targetXR: XR,
      totalSockets: sockets.length,
      sample: sockets.slice(0, 10).map(s => ({
        id: s.id,
        connected: s.connected,        // often undefined for RemoteSocket (this is the bug)
        dataXrId: s.data?.xrId
      })),
    });
  }

  // ✅ CRITICAL FIX: do NOT filter by s.connected in cluster mode
  const found =
    sockets.find(s =>
      typeof s.data?.xrId === "string" &&
      normXr(s.data.xrId) === XR &&
      s.data?.clientType !== 'cockpit'
    ) || null;

  if (debugSocket) dbgToSocket(debugSocket, "[PAIR][FIND] result", {
    targetXR: XR,
    foundSocketId: found?.id || null,
    foundClientType: found?.data?.clientType || null
  });


  if (debugSocket) {
    dbgToSocket(debugSocket, found ? "[PAIR][FIND] FOUND" : "[PAIR][FIND] NOT FOUND", {
      xrId: XR,
      socketId: found?.id || null,
      connected: found?.connected,
      dataXrId: found?.data?.xrId
    });
  }

  return found;
}

// =========================================================
// Pair retry scheduler (MANDATORY for Option B reliability)
// =========================================================
const pairRetryTimers = new Map();   // xrId -> timeoutId
const pairRetryCounts = new Map();   // xrId -> count (for backoff)

function schedulePairRetry(xrId, debugSocket = null) {
  const XR = normXr(xrId);
  if (!XR) return;

  // If already paired, no retry needed
  if (isAlreadyPaired(XR)) return;

  // Avoid stacking multiple timers for same XR
  if (pairRetryTimers.has(XR)) return;

  const attempt = (pairRetryCounts.get(XR) || 0) + 1;
  pairRetryCounts.set(XR, attempt);

  // Backoff: 500ms, 1s, 2s, 3s, 5s (cap)
  const delay = Math.min(500 * Math.pow(2, Math.min(attempt - 1, 3)), 5000);

  dlog("[DB_AUTO_PAIR] retry scheduled", { xrId: XR, attempt, delay });
  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] retry scheduled", { xrId: XR, attempt, delay });

  const t = setTimeout(async () => {
    pairRetryTimers.delete(XR);

    // If got paired while waiting, stop
    if (isAlreadyPaired(XR)) return;

    try {
      // Try again. This will either pair or schedule again if still missing.
      await tryDbAutoPair(XR, debugSocket);
    } catch (e) {
      dwarn("[DB_AUTO_PAIR] retry attempt failed", { xrId: XR, err: e?.message || e });
      if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] retry attempt failed", { xrId: XR, err: e?.message || String(e) });
      // If it fails, allow another retry later
      pairRetryTimers.delete(XR);
    }
  }, delay);

  pairRetryTimers.set(XR, t);
}

// Optional cleanup helper (safe to call on disconnect)
function clearPairRetry(xrId) {
  const XR = normXr(xrId);
  const t = pairRetryTimers.get(XR);
  if (t) clearTimeout(t);
  pairRetryTimers.delete(XR);
  pairRetryCounts.delete(XR);
}


//------------changes made regarding dashabord ***----------------------------------------------------------------
async function tryDbAutoPair(deviceId, debugSocket = null) {
  const meXr = normXr(deviceId);
  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] start", { deviceId: meXr });

  const myUserId = await resolveUserIdByXrId(deviceId);
  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] myUserId", { myUserId });
  if (!myUserId) return false;

  const partnerUserId = await resolvePartnerUserId(myUserId);
  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] partnerUserId", { partnerUserId });
  if (!partnerUserId) return false;

  const partnerId = await resolveXrIdByUserId(partnerUserId);
  const partnerXr = normXr(partnerId);
  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] partner xrId", { partnerId, partnerXr });
  if (!partnerXr) return false;

  if (meXr === partnerXr) {
    if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] bail: mapping points to self", { meXr, partnerXr });
    return false;
  }

  const meSocket = await findSocketByXrIdCI_Cluster(deviceId, debugSocket);
  const partnerSocket = await findSocketByXrIdCI_Cluster(partnerXr, debugSocket);

  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] socket presence", {
    meSocket: !!meSocket,
    partnerSocket: !!partnerSocket,
    partnerXr
  });

  // ✅ If *me* socket is missing, we cannot do anything
  if (!meSocket) {
    if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] missing meSocket — retry scheduled", { meXr, partnerXr });
    schedulePairRetry(meXr, debugSocket);
    return false;
  }

  // ✅ If partner missing: join ME solo so dashboard can show YELLOW/RED with no refresh
  if (!partnerSocket) {
    const roomId = getRoomIdForPair(deviceId, partnerXr);
    if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] partner missing — join me only + broadcast", { meXr, partnerXr, roomId });

    try { await meSocket.join(roomId); } catch { }
    try { meSocket.data.roomId = roomId; } catch { }

    // do NOT set pairedWith yet (partner not online)
    // ✅ DO NOT emit room_joined when partner is offline (prevents Dock “VR Room created…” spam)

    try { await broadcastDeviceList(roomId); } catch { }

    schedulePairRetry(meXr, debugSocket);
    return false;
  }


  if (isAlreadyPaired(meXr) || isAlreadyPaired(partnerXr)) {
    if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] bail: one side already paired", { meXr, partnerXr });
    return false;
  }

  const roomId = getRoomIdForPair(deviceId, partnerXr);
  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] joining room", { roomId });

  await meSocket.join(roomId);
  await partnerSocket.join(roomId);

  try { meSocket.data.roomId = roomId; } catch { }
  try { partnerSocket.data.roomId = roomId; } catch { }

  pairedWith.set(meXr, partnerXr);
  pairedWith.set(partnerXr, meXr);

  // ✅ MANDATORY: prevent delayed retry firing after successful pair
  clearPairRetry(meXr);
  clearPairRetry(partnerXr);

  if (debugSocket) dbgToSocket(debugSocket, "[DB_AUTO_PAIR] joined both", { roomId, meXr, partnerXr });

  const parsed = String(roomId).split(':');
  const members = (parsed.length === 3) ? [normXr(parsed[1]), normXr(parsed[2])] : [meXr, partnerXr];
  io.to(roomId).emit("room_joined", { roomId, members });


  await broadcastDeviceList(roomId);

  // ✅ Stabilizer: Redis adapter room propagation can be briefly behind.
  // Broadcast once more shortly after so the list becomes consistent.
  setTimeout(() => {
    try { broadcastDeviceList(roomId); } catch { }
  }, 250);

  broadcastPairs();


  return true;
}




// -------------------- Utilities --------------------
function roomOf(xrId) {
  return `xr:${normXr(xrId)}`;
}

// Message history MUST be isolated per pair room
// Key = canonical roomId (pair:<XR-A>:<XR-B>) or solo:<XR-ID> if not paired yet
const messageHistoryByRoom = new Map(); // Map<roomId, Array<Message>>
const MAX_MESSAGES_PER_ROOM = 200;

function roomForHistory(socket) {
  // Option B: paired sockets have socket.data.roomId set
  const roomId = socket?.data?.roomId;
  if (roomId) return roomId;

  // If not paired yet, keep history isolated per XR (never global)
  const xrId = socket?.data?.xrId || 'unknown';
  return `solo:${normXr(xrId)}`;
}

function appendMessage(roomId, msg) {
  const arr = messageHistoryByRoom.get(roomId) || [];
  arr.push(msg);
  if (arr.length > MAX_MESSAGES_PER_ROOM) arr.splice(0, arr.length - MAX_MESSAGES_PER_ROOM);
  messageHistoryByRoom.set(roomId, arr);
}

function getMessages(roomId) {
  return messageHistoryByRoom.get(roomId) || [];
}

dlog('[STATE] messageHistoryByRoom initialized'); function roomOf(xrId) {
  return `xr:${normXr(xrId)}`;
}

const messageHistory = [];
dlog('[STATE] messageHistory initialized');




async function buildDeviceListGlobal() {
  dlog('[DEVICE_LIST] building (global via fetchSockets)');
  const sockets = await safeFetchSockets(io, "/");
  const byId = new Map();

  for (const s of sockets) {
    const id = s?.data?.xrId;
    if (!id) continue;

    // Pull latest battery snapshot if we have one
    const b = batteryByDevice?.get(id) || {};
    // 🔵 NEW: network telemetry snapshot
    const t = telemetryByDevice?.get(id) || null;

    byId.set(id, {
      xrId: id,
      deviceName: s.data?.deviceName || 'Unknown',
      // Battery fields
      battery: (typeof b.pct === 'number') ? b.pct : null,
      charging: !!b.charging,
      batteryTs: b.ts || null,
      // 🔵 Telemetry fields (optional)
      ...(t ? { telemetry: t } : {}),
    });
  }

  const list = [...byId.values()];
  dlog('[DEVICE_LIST] built:', list);
  return list;
}

//------------changes made regarding dashabord ***----------------------------------------------------------------
// ✅ Build device list strictly for a given room (pair isolation)
// ✅ FIX: do NOT use fetchSockets() (it is timing out with your adapter)
// Instead: parse the canonical room name "pair:XR-A:XR-B" and use online maps.
async function buildDeviceListForRoom(roomId) {
  const stamp = new Date().toISOString();
  const inst = process.env.WEBSITE_INSTANCE_ID || process.env.COMPUTERNAME || 'local';

  dlog(`[DEVICE_LIST][${stamp}][${inst}] ▶ buildDeviceListForRoom called`, { roomId });
  dbgToRoom(roomId, "[DEVICE_LIST] buildDeviceListForRoom called", { roomId, inst });

  if (!roomId || !roomId.startsWith('pair:')) {
    dwarn(`[DEVICE_LIST][${stamp}][${inst}] invalid or non-pair roomId`, { roomId });
    dbgToRoom(roomId, "[DEVICE_LIST] invalid/non-pair roomId", { roomId, inst });
    return [];
  }

  // Local room size (instance-local only)
  try {
    const localRoom = io?.sockets?.adapter?.rooms?.get?.(roomId);
    const localRoomSize = localRoom ? localRoom.size : 0;

    dlog(`[DEVICE_LIST][${stamp}][${inst}] local adapter room size`, {
      roomId,
      localRoomSize,
      ioRedisReady,
      IS_PROD,
      adapterName: io?.sockets?.adapter?.constructor?.name || 'unknown',
    });

    dbgToRoom(roomId, "[DEVICE_LIST] local adapter room size", {
      roomId,
      localRoomSize,
      ioRedisReady,
      IS_PROD,
      adapterName: io?.sockets?.adapter?.constructor?.name || 'unknown',
      inst
    });
  } catch (e) {
    dwarn(`[DEVICE_LIST][${stamp}][${inst}] failed reading local room size`, e?.message || e);
    dbgToRoom(roomId, "[DEVICE_LIST] failed reading local room size", {
      err: e?.message || String(e),
      inst
    });
  }

  // ================= CLUSTER PATH =================
  if (IS_PROD && ioRedisReady && typeof io?.in === 'function') {
    dlog(`[DEVICE_LIST][${stamp}][${inst}] attempting CLUSTER fetchSockets`, { roomId });
    dbgToRoom(roomId, "[DEVICE_LIST] attempting CLUSTER fetchSockets", { roomId, inst });

    let sockets;
    try {
      sockets = await Promise.race([
        io.in(roomId).fetchSockets(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('room fetchSockets timeout')), 5000)
        ),
      ]);
    } catch (e) {
      dwarn(`[DEVICE_LIST][${stamp}][${inst}] ❌ cluster fetchSockets failed`, {
        roomId,
        err: e?.message || e,
        ioRedisReady,
        adapterName: io?.sockets?.adapter?.constructor?.name,
      });

      dbgToRoom(roomId, "[DEVICE_LIST] CLUSTER fetchSockets FAILED (stable fallback)", {
        roomId,
        err: e?.message || String(e),
        ioRedisReady,
        adapterName: io?.sockets?.adapter?.constructor?.name,
        inst
      });

      // ✅ stable fallback (unchanged)
      const parts = String(roomId).split(':');
      const a = normXr(parts[1] || '');
      const b = normXr(parts[2] || '');
      const ids = [a, b].filter(Boolean).slice(0, 2);

      const list = ids.map(id => {
        const bRec = batteryByDevice?.get(id) || {};
        const tRec = telemetryByDevice?.get(id) || null;

        return {
          xrId: id,
          deviceName: 'Unknown',
          battery: (typeof bRec.pct === 'number') ? bRec.pct : null,
          charging: !!bRec.charging,
          batteryTs: bRec.ts || null,
          ...(tRec ? { telemetry: tRec } : {}),
        };
      });

      dlog(`[DEVICE_LIST][${stamp}][${inst}] ✅ built (cluster-fallback stable)`, {
        roomId,
        xrIds: list.map(x => x.xrId),
      });

      dbgToRoom(roomId, "[DEVICE_LIST] built (cluster-fallback stable)", {
        roomId,
        xrIds: list.map(x => x.xrId),
        inst
      });

      return list;
    }

    if (Array.isArray(sockets)) {
      dlog(`[DEVICE_LIST][${stamp}][${inst}] fetchSockets returned`, {
        roomId,
        count: sockets.length,
        sockets: sockets.map(s => ({
          sid: s.id,
          xrId: s?.data?.xrId,
          deviceName: s?.data?.deviceName,
          connected: s.connected,
          roomId: s?.data?.roomId,
        })),
      });

      dbgToRoom(roomId, "[DEVICE_LIST] fetchSockets returned (cluster)", {
        roomId,
        count: sockets.length,
        xrIds: sockets.map(s => normXr(s?.data?.xrId)).filter(Boolean),
        inst
      });

      // ✅ If fetchSockets returns empty array, fall back to stable roomId-derived list
      if (sockets.length === 0) {
        dwarn(`[DEVICE_LIST][${stamp}][${inst}] fetchSockets returned EMPTY array; using stable fallback`, { roomId });
        dbgToRoom(roomId, "[DEVICE_LIST] fetchSockets EMPTY (stable fallback)", {
          roomId,
          ioRedisReady,
          adapterName: io?.sockets?.adapter?.constructor?.name,
          inst
        });

        const parts = String(roomId).split(':');
        const a = normXr(parts[1] || '');
        const b = normXr(parts[2] || '');
        const ids = [a, b].filter(Boolean).slice(0, 2);

        const list = ids.map(id => {
          const bRec = batteryByDevice?.get(id) || {};
          const tRec = telemetryByDevice?.get(id) || null;

          return {
            xrId: id,
            deviceName: 'Unknown',
            battery: (typeof bRec.pct === 'number') ? bRec.pct : null,
            charging: !!bRec.charging,
            batteryTs: bRec.ts || null,
            ...(tRec ? { telemetry: tRec } : {}),
          };
        });

        dlog(`[DEVICE_LIST][${stamp}][${inst}] ✅ built (empty-array fallback)`, {
          roomId,
          xrIds: list.map(x => x.xrId),
        });

        dbgToRoom(roomId, "[DEVICE_LIST] built (empty-array fallback)", {
          roomId,
          xrIds: list.map(x => x.xrId),
          inst
        });

        return list;
      }


      const list = [];
      for (const s of sockets) {
        const id = normXr(s?.data?.xrId);
        if (!id) continue;

        if (s?.data?.clientType === 'cockpit') continue; // ✅ do NOT count cockpit as a device


        const bRec = batteryByDevice?.get(id) || {};
        const tRec = telemetryByDevice?.get(id) || null;

        list.push({
          xrId: id,
          deviceName: s.data?.deviceName || 'Unknown',
          battery: (typeof bRec.pct === 'number') ? bRec.pct : null,
          charging: !!bRec.charging,
          batteryTs: bRec.ts || null,
          ...(tRec ? { telemetry: tRec } : {}),
        });
      }

      const unique = Array.from(new Map(list.map(x => [x.xrId, x])).values()).slice(0, 2);

      // ✅ CRITICAL FIX:///-------------------------------------------------------------------------till
      // fetchSockets can return ONLY viewer sockets (dashboard/cockpit) in the room.
      // In that case list/unique becomes empty even though sockets.length > 0.
      // We must fall back to "roomId-derived IDs" BUT only include devices that are truly online.
      if (unique.length === 0) {
        dwarn(`[DEVICE_LIST][${stamp}][${inst}] fetchSockets had sockets but no xr devices; using ONLINE-only fallback`, { roomId });
        dbgToRoom(roomId, "[DEVICE_LIST] sockets present but no xrId devices (ONLINE-only fallback)", { roomId, inst });

        const parts = String(roomId).split(':');
        const a = normXr(parts[1] || '');
        const b = normXr(parts[2] || '');
        const ids = [a, b].filter(Boolean).slice(0, 2);

        const onlineIds = [];
        for (const id of ids) {
          // Prefer Redis owner-lock as authoritative online indicator in prod
          const online = await isXrOnlineRedis(id);
          if (online) onlineIds.push(id);
        }

        const fallbackList = onlineIds.map(id => {
          const bRec = batteryByDevice?.get(id) || {};
          const tRec = telemetryByDevice?.get(id) || null;
          return {
            xrId: id,
            deviceName: 'Unknown',
            battery: (typeof bRec.pct === 'number') ? bRec.pct : null,
            charging: !!bRec.charging,
            batteryTs: bRec.ts || null,
            ...(tRec ? { telemetry: tRec } : {}),
          };
        });

        dlog(`[DEVICE_LIST][${stamp}][${inst}] ✅ built (cluster viewer-only fallback)`, {
          roomId,
          xrIds: fallbackList.map(x => x.xrId),
        });

        dbgToRoom(roomId, "[DEVICE_LIST] built (cluster viewer-only fallback)", {
          roomId,
          xrIds: fallbackList.map(x => x.xrId),
          inst
        });

        return fallbackList;
      }


      dlog(`[DEVICE_LIST][${stamp}][${inst}] ✅ built (cluster)`, {
        roomId,
        xrIds: unique.map(x => x.xrId),
      });

      dbgToRoom(roomId, "[DEVICE_LIST] built (cluster)", {
        roomId,
        xrIds: unique.map(x => x.xrId),
        inst
      });

      return unique;
    } else {
      dwarn(`[DEVICE_LIST][${stamp}][${inst}] fetchSockets returned NON-array`, {
        roomId,
        socketsType: typeof sockets,
      });

      dbgToRoom(roomId, "[DEVICE_LIST] fetchSockets NON-array (stable fallback)", {
        roomId,
        socketsType: typeof sockets,
        inst
      });

      // ✅ stable fallback (unchanged)
      const parts = String(roomId).split(':');
      const a = normXr(parts[1] || '');
      const b = normXr(parts[2] || '');
      const ids = [a, b].filter(Boolean).slice(0, 2);

      const list = ids.map(id => ({
        xrId: id,
        deviceName: 'Unknown',
        battery: null,
        charging: false,
        batteryTs: null,
      }));

      dlog(`[DEVICE_LIST][${stamp}][${inst}] ✅ built (non-array fallback)`, {
        roomId,
        xrIds: ids,
      });

      dbgToRoom(roomId, "[DEVICE_LIST] built (non-array fallback)", {
        roomId,
        xrIds: ids,
        inst
      });

      return list;
    }
  }

  // ================= LOCAL FALLBACK (unchanged) =================
  dlog(`[DEVICE_LIST][${stamp}][${inst}] using LOCAL fallback`, { roomId });
  dbgToRoom(roomId, "[DEVICE_LIST] using LOCAL fallback", { roomId, inst });

  const parts = String(roomId).split(':');
  const a = normXr(parts[1] || '');
  const b = normXr(parts[2] || '');
  const ids = [a, b].filter(Boolean);

  const list = [];
  for (const id of ids) {
    const s = getClientSocketByXrIdCI(id);
    if (!s || !s.connected) continue;

    const bRec = batteryByDevice?.get(id) || {};
    const tRec = telemetryByDevice?.get(id) || null;

    list.push({
      xrId: id,
      deviceName: s.data?.deviceName || 'Unknown',
      battery: (typeof bRec.pct === 'number') ? bRec.pct : null,
      charging: !!bRec.charging,
      batteryTs: bRec.ts || null,
      ...(tRec ? { telemetry: tRec } : {}),
    });
  }

  const finalList = list.slice(0, 2);
  dlog(`[DEVICE_LIST][${stamp}][${inst}] built (local)`, {
    roomId,
    xrIds: finalList.map(x => x.xrId),
  });

  dbgToRoom(roomId, "[DEVICE_LIST] built (local)", {
    roomId,
    xrIds: finalList.map(x => x.xrId),
    inst
  });

  return finalList;
}

const deviceListInFlight = new Map(); // roomId -> Promise

//------------changes made regarding dashabord ***----------------------------------------------------------------
// ✅ Broadcast device list: global OR room-scoped (Option B safe)
async function broadcastDeviceList(roomId) {
  dlog('[DEVICE_LIST] broadcast start', roomId ? `(room: ${roomId})` : '(global)');
  if (roomId) dbgToRoom(roomId, "[DEVICE_LIST] broadcast start", { roomId });

  try {
    // ✅ ROOM PATH (Option B)
    if (roomId) {
      // ✅ Single-flight MUST be checked before expensive buildDeviceListForRoom()
      if (deviceListInFlight.has(roomId)) {
        dlog('[DEVICE_LIST] skip duplicate broadcast (in-flight)', { roomId });
        dbgToRoom(roomId, "[DEVICE_LIST] skip duplicate broadcast (in-flight)", { roomId });
        return;
      }

      const p = (async () => {
        const list = await buildDeviceListForRoom(roomId);

        const safeList = Array.isArray(list) ? list : [];
        io.to(roomId).emit('device_list', { roomId, devices: safeList });

        dbgToRoom(roomId, "[DEVICE_LIST] broadcast done", {
          roomId,
          size: safeList.length,
          xrIds: safeList.map(x => x.xrId)
        });

        dlog('[DEVICE_LIST] broadcast done (size:', safeList.length, ')', `(room: ${roomId})`);
        return;

      })().finally(() => {
        deviceListInFlight.delete(roomId);
      });

      deviceListInFlight.set(roomId, p);
      return; // ✅ important: don't fall through to global
    }

    // ✅ GLOBAL PATH (dev only)
    const list = await buildDeviceListGlobal();

    if (IS_PROD) {
      dwarn('[DEVICE_LIST] Refusing global broadcast in prod (Option B).');
      return;
    }
    io.emit('device_list', list);

    dlog(
      '[DEVICE_LIST] broadcast done (size:',
      Array.isArray(list) ? list.length : 'INVALID',
      ')',
      '(global)'
    );
  } catch (e) {
    dwarn('[DEVICE_LIST] Failed to build list:', e?.message || e);
    if (roomId) dbgToRoom(roomId, "[DEVICE_LIST] Failed to build list", {
      roomId,
      err: e?.message || String(e)
    });

    // ✅ safety: clear in-flight if error happened before finally ran
    if (roomId) deviceListInFlight.delete(roomId);
  }
}


function addToMessageHistory(socket, message) {
  const roomId = roomForHistory(socket);

  const msg = {
    ...message,
    id: Date.now(),
    timestamp: new Date().toISOString(),
    roomId, // tag for safety/debug
  };

  appendMessage(roomId, msg);

  const len = getMessages(roomId).length;
  dlog('[MSG_HISTORY] added; room=', roomId, 'len=', len);
}


// -------------------- Routes --------------------
app.get('/health', async (_req, res) => {
  dlog('[HEALTH] request');
  try {
    const sockets = await safeFetchSockets(io, "/");
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instanceId: process.env.WEBSITE_INSTANCE_ID || process.pid,
      connectedClients: sockets.length,
    });
  } catch {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instanceId: process.env.WEBSITE_INSTANCE_ID || process.pid,
      connectedClients: 'unknown',
    });
  }
});

app.post('/api/medications/availability', async (req, res) => {
  dlog('[MEDICATION_API] request received');
  try {
    const { names } = req.body;

    if (!Array.isArray(names)) {
      return res.status(400).json({ error: 'Expected "names" array in request body' });
    }

    if (names.length === 0) {
      return res.json({ results: [] });
    }

    dlog(`[MEDICATION_API] Checking ${names.length} medication(s)`);

    const schema = 'dbo';
    const table = 'DrugMaster';
    const nameCol = 'drug';

    function normalizeTerm(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[ \-\/\.,'()]/g, '');
    }

    function extractDrugQuery(raw) {
      if (!raw) return null;
      let s = String(raw)
        .replace(/^[-•]\s*/u, '')
        .replace(/\(.*?\)/g, '')
        .replace(/\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|susp(?:ension)?|inj(?:ection)?)\b/gi, '')
        .replace(/\b(po|od|bd|tid|qid|prn|q\d+h|iv|im|sc|sl)\b/gi, '')
        .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|kg|ml|l|iu|units|%)\b/gi, '')
        .split(/\b\d/)[0]
        .replace(/[.,;:/]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return s || null;
    }

    async function findDrugMatch(q) {
      const raw = String(q || '').trim();
      const rawLike = `%${raw}%`;
      const norm = normalizeTerm(raw);
      const normLike = `%${norm}%`;

      const normExpr = `
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(LOWER([${nameCol}]), '-', ''), ',', ''), '/', ''), '.', ''), '''', ''), ' ', ''), '(', ''), ')', '')
      `;

      const sql = `
        SELECT TOP 1 [${nameCol}] AS name
        FROM [${schema}].[${table}]
        WHERE status = 1
          AND [${nameCol}] IS NOT NULL
          AND (
            LOWER([${nameCol}]) = LOWER(:raw)
            OR LOWER([${nameCol}]) LIKE LOWER(:rawLike)
            OR ${normExpr} = :norm
            OR ${normExpr} LIKE :normLike
          )
        ORDER BY
          CASE
            WHEN ${normExpr} = :norm THEN 1
            WHEN LOWER([${nameCol}]) = LOWER(:raw) THEN 2
            WHEN ${normExpr} LIKE :normLike THEN 3
            ELSE 4
          END,
          [${nameCol}];
      `;

      const rows = await sequelize.query(sql, {
        replacements: { raw, rawLike, norm, normLike },
        type: Sequelize.QueryTypes.SELECT
      });
      return rows?.[0]?.name || null;
    }

    const results = [];
    for (const name of names) {
      const query = extractDrugQuery(name);
      if (!query) {
        results.push({ name, available: false });
        continue;
      }

      try {
        const matched = await findDrugMatch(query);
        results.push({ name, available: !!matched });
        dlog(`[MEDICATION_API] "${name}" => ${matched ? 'AVAILABLE' : 'NOT FOUND'}`);
      } catch (e) {
        dwarn(`[MEDICATION_API] Error checking "${name}":`, e.message);
        results.push({ name, available: false });
      }
    }

    res.json({ results });
  } catch (err) {
    derr('[MEDICATION_API] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// -------------------- Routes --------------------
// NOTE: make sure this exists somewhere near the top of server.js
// app.use(express.json());

/**
 * 1) GET /api/templates
 *    Used by UI dropdown to list templates
 */
app.get("/api/templates", async (_req, res) => {
  try {
    const templates = await sequelize.query(
      `
      SELECT id, template AS name, short_name
      FROM [dbo].[Templates]
      WHERE row_status = 1
      ORDER BY template ASC;
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );

    return res.json({ templates });
  } catch (err) {
    derr("[TEMPLATES_API] /api/templates failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to load templates" });
  }
});
/**
 * 2) POST /api/notes/generate
 *    UI calls this when template dropdown changes to regenerate note
 *    Body: { transcript: string, templateId?: number | "default" }
 */
app.post("/api/notes/generate", async (req, res) => {
  try {
    const transcript = String(req.body?.transcript || "").trim();
    const templateId = req.body?.templateId; // number OR "default" OR null

    if (!transcript) {
      return res.status(400).json({ error: "transcript is required" });
    }

    const note = await generateSoapNote(transcript, templateId);
    return res.json({ note });
  } catch (err) {
    derr("[NOTES_API] /api/notes/generate failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to generate note" });
  }
});

app.get('/ehr/patient/:mrn', async (req, res) => {
  dlog('[EHR_API] /ehr/patient/:mrn request received');

  try {
    const mrn = (req.params.mrn || '').trim();
    if (!mrn) {
      return res.status(400).json({ error: 'MRN parameter is required' });
    }

    const sqlText = `
      SELECT
          su.id                  AS patient_id,
          su.full_name           AS full_name,
          su.email               AS email,
          su.mrn_no              AS mrn_no,
          su.contact_no_primary  AS contact_no_primary,

          pn.id                  AS note_id,
          pn.created_date        AS document_created_date,

          MAX(vpn.template)      AS template,
          MAX(vpn.short_name)    AS short_name

      FROM [dbo].[System_Users] su
      LEFT JOIN [dbo].[Patient_Notes] pn
        ON pn.patient_id = su.id
      LEFT JOIN [dbo].[View_Patient_Note_Content] vpn
        ON vpn.patient_note_id = pn.id

      WHERE su.mrn_no = :mrn

      GROUP BY
          su.id,
          su.full_name,
          su.email,
          su.mrn_no,
          su.contact_no_primary,
          pn.id,
          pn.created_date

      ORDER BY pn.created_date DESC;
    `;

    const rows = await sequelize.query(sqlText, {
      replacements: { mrn },
      type: Sequelize.QueryTypes.SELECT
    });

    if (!rows.length) {
      return res.status(404).json({ error: 'Patient not found', mrn });
    }

    const patient = {
      patient_id: rows[0].patient_id,
      full_name: rows[0].full_name,
      email: rows[0].email,
      mrn_no: rows[0].mrn_no,
      contact_no_primary: rows[0].contact_no_primary ?? null
    };

    const notes = rows
      .filter(r => r.note_id !== null)
      .map(r => ({
        note_id: r.note_id,
        short_name: r.short_name ?? null,
        template: r.template ?? null,
        document_created_date: r.document_created_date
      }));

    return res.json({ success: true, patient, notes });

  } catch (err) {
    derr('[EHR_API] Error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
});

app.get('/ehr/notes/:noteId', async (req, res) => {
  dlog('[EHR_API] /ehr/notes/:noteId request received');

  try {
    const noteId = parseInt(req.params.noteId, 10);
    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ error: 'noteId must be a number' });
    }

    const sqlText = `
      SELECT
        pn.id AS patient_note_id,
        pn.created_date AS document_created_date,
        vpn.template,
        vpn.short_name,
        vpn.position,
        vpn.component,
        vpn.text
      FROM [dbo].[Patient_Notes] pn
      LEFT JOIN [dbo].[View_Patient_Note_Content] vpn
        ON vpn.patient_note_id = pn.id
      WHERE pn.id = :noteId
      ORDER BY vpn.position ASC;
    `;

    const rows = await sequelize.query(sqlText, {
      replacements: { noteId },
      type: Sequelize.QueryTypes.SELECT
    });

    if (!rows.length) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const meta = {
      patient_note_id: noteId,
      template: rows[0].template ?? null,
      short_name: rows[0].short_name ?? null,
      document_created_date: rows[0].document_created_date
    };

    const sections = rows
      .map(r => ({
        position: Number(r.position ?? 0),
        component: String(r.component ?? '').trim(),
        text: String(r.text ?? '').trim()
      }))
      .filter(s => s.component || s.text);

    return res.json({
      success: true,
      note: meta,
      sections
    });

  } catch (err) {
    derr('[EHR_API] Error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
});
// ============================================================================
// ADDED: Template Driven Note → Add to EHR save endpoint
// - Inserts Patient_Notes then Patient_Note_Content in one transaction
// - Called by cockpit "Add to EHR" (template-driven notes only)
// - MRN is dynamic (sent from frontend in payload) 
// ============================================================================
app.post('/ehr/patient_notes/template', async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const body = req.body || {};

    // Expected payload shape (built in scribe_cockpit.js):
    // {
    //   patient_notes: { patient_id, doctor_id, document_created_date, created_by, modified_by, modified_date, row_status },
    //   patient_note_content: [{ template_component_mapping_id, text, edit_count, created_by, modified_by, created_date, modified_date, row_status }, ...]
    // }

    const pn = body.patient_notes || null;
    const rows = Array.isArray(body.patient_note_content) ? body.patient_note_content : [];

    if (!pn) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_notes' });
    }
    if (!pn.patient_id) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_notes.patient_id' });
    }
    if (!pn.doctor_id) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_notes.doctor_id' });
    }
    if (!pn.created_by) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_notes.created_by' });
    }
    if (!pn.modified_by) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_notes.modified_by' });
    }
    if (!pn.document_created_date) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_notes.document_created_date' });
    }
    if (!pn.modified_date) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_notes.modified_date' });
    }
    if (!rows.length) {
      await t.rollback();
      return res.status(400).json({ ok: false, message: 'Missing patient_note_content rows' });
    }
    const insertPatientNotesSql = `
      INSERT INTO Patient_Notes
        (patient_id, doctor_id, created_date, created_by, modified_date, modified_by, row_status)
      OUTPUT INSERTED.id AS patient_note_id
      VALUES
        (:patient_id, :doctor_id, :created_date, :created_by, :modified_date, :modified_by, :row_status)
    `;

    const inserted = await sequelize.query(insertPatientNotesSql, {
      replacements: {
        patient_id: pn.patient_id,
        doctor_id: pn.doctor_id,
        created_date: pn.document_created_date,
        created_by: pn.created_by,
        modified_date: pn.modified_date,
        modified_by: pn.modified_by,
        row_status: pn.row_status ?? 1,
      },
      type: Sequelize.QueryTypes.SELECT,
      transaction: t,
    });

    const patientNoteId = inserted?.[0]?.patient_note_id ?? null;
    if (!patientNoteId) {
      await t.rollback();
      return res.status(500).json({ ok: false, message: 'Failed to create Patient_Notes row (no id returned)' });
    }

    // 2) Insert Patient_Note_Content rows (row-by-row, minimal + safe)
    const insertContentSql = `
      INSERT INTO Patient_Note_Content
        (patient_note_id, template_component_mapping_id, text, edit_count, created_date, created_by, modified_date, modified_by, row_status)
      VALUES
        (:patient_note_id, :template_component_mapping_id, :text, :edit_count, :created_date, :created_by, :modified_date, :modified_by, :row_status)
    `;

    for (const r of rows) {
      const mappingId = r?.template_component_mapping_id ?? null;
      if (!mappingId) {
        await t.rollback();
        return res.status(400).json({ ok: false, message: 'Missing template_component_mapping_id in a content row' });
      }

      await sequelize.query(insertContentSql, {
        replacements: {
          patient_note_id: patientNoteId,
          template_component_mapping_id: mappingId,
          text: String(r?.text ?? ''),
          edit_count: (r?.edit_count ?? 0),
          created_date: r?.created_date ?? pn.document_created_date,
          created_by: r?.created_by ?? pn.created_by,
          modified_date: r?.modified_date ?? pn.modified_date,
          modified_by: r?.modified_by ?? pn.modified_by,
          row_status: r?.row_status ?? 1,
        },
        type: Sequelize.QueryTypes.INSERT,
        transaction: t,
      });
    }

    await t.commit();
    return res.json({ ok: true, patient_note_id: patientNoteId });
  } catch (e) {
    try { await t.rollback(); } catch { }
    console.error('[EHR][TEMPLATE_SAVE] failed:', e);
    return res.status(500).json({ ok: false, message: String(e?.message || e || 'Save failed') });
  }
});

app.post('/ehr/ai/summary', async (req, res) => {
  try {
    const mrn = String(req.body?.mrn || '').trim();
    if (!mrn) {
      return res.status(400).json({ error: 'mrn is required' });
    }

    const summary = await generateSummaryForMrn(mrn);
    return res.json(summary);
  } catch (err) {
    console.error('Summary Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

async function generateSummaryForMrn(mrn) {
  if (!mrn) throw new Error('MRN is required');

  const ABACUS_API_KEY = process.env.ABACUS_API_KEY;
  if (!ABACUS_API_KEY) throw new Error('Missing ABACUS_API_KEY');

  const ABACUS_MODEL =
    String(process.env.ABACUS_MODEL || '').trim() || 'claude-opus-4-6';

  // 1) Find patient + NAME
  const patientRows = await sequelize.query(
    `SELECT id AS patient_id, full_name
     FROM [dbo].[System_Users]
     WHERE mrn_no = :mrn`,
    { replacements: { mrn }, type: Sequelize.QueryTypes.SELECT }
  );

  if (!patientRows.length) return buildEmptySummary();

  const patientId = patientRows[0].patient_id;
  const patientName = String(patientRows[0].full_name || '').trim();

  // 2) Fetch ALL notes with content (latest first)
  const rows = await sequelize.query(
    `SELECT
        pn.id AS note_id,
        pn.created_date,
        v.position,
        v.component,
        v.text
     FROM [dbo].[Patient_Notes] pn
     LEFT JOIN [dbo].[View_Patient_Note_Content] v
       ON v.patient_note_id = pn.id
     WHERE pn.patient_id = :patientId
     ORDER BY pn.created_date DESC, pn.id DESC, v.position ASC`,
    { replacements: { patientId }, type: Sequelize.QueryTypes.SELECT }
  );

  if (!rows.length) return buildEmptySummary();

  // 3) Group content by visit
  const visits = new Map();

  for (const r of rows) {
    if (!visits.has(r.note_id)) {
      visits.set(r.note_id, { created_date: r.created_date, lines: [] });
    }

    const text = String(r.text || '').trim();
    if (!text) continue;

    const component = String(r.component || '').trim();
    visits.get(r.note_id).lines.push(
      component ? `${component}: ${text}` : text
    );
  }

  // 4) Build visits text
  const visitsText = [...visits.entries()]
    .map(([noteId, v], index) => {
      const created = v.created_date
        ? ` | created_date: ${v.created_date}`
        : '';
      const body = v.lines.length ? v.lines.join('\n') : 'N/A';
      return `VISIT ${index + 1} | note_id: ${noteId}${created}\n${body}`;
    })
    .join('\n\n');

  // 5) Prompt with NAME RULE
  const prompt = `
You are generating a comprehensive clinical summary with 100% accuracy.

Use ONLY the information provided in the visits below.

PATIENT NAME:
${patientName || 'N/A'}

CRITICAL ACCURACY RULES:
- ONLY use facts explicitly stated in the visits.
- Do NOT infer, extrapolate, or assume anything.
- Do NOT invent demographics or gender unless documented.
- If data is missing, state "not documented" or "N/A".

PATIENT REFERENCE RULES (MANDATORY):
- On FIRST mention, use the patient's full name exactly as provided.
- After that, you may use "the patient".
- If gender is clearly stated in visits, pronouns (he/she) may be used.
- NEVER use the phrase "this patient".

FORMATTING RULES:
- EXACTLY ONE paragraph.
- No headings, labels, lists, or line breaks.
- Smooth clinical narrative style.

Output MUST be valid JSON only.

Required Output:
{
  "template_title": "AI Summary Note",
  "text": "..."
}

Visits (latest first):
${visitsText}
`.trim();

  // 6) AI CALL
  const aiResponse = await axios.post(
    'https://routellm.abacus.ai/v1/chat/completions',
    {
      model: ABACUS_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Return ONLY valid JSON. The text must be one paragraph. ' +
            'Use the patient name on first mention if provided. ' +
            'Never write "this patient".'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    },
    {
      headers: { Authorization: `Bearer ${ABACUS_API_KEY}` },
      timeout: 60000
    }
  );

  const raw = aiResponse?.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty AI response');

  const parsed = parseJsonObject(raw);

  if (!parsed || typeof parsed.text !== 'string') {
    throw new Error('AI response JSON missing "text"');
  }

  parsed.text = normalizeSingleParagraph(parsed.text);

  // Safety enforcement
  parsed.text = parsed.text.replace(/\bthis patient\b/gi, 'the patient');

  // If AI ignored name on first mention, fix it
  if (patientName) {
    const startsWithPatient = /^the patient/i.test(parsed.text);
    if (startsWithPatient) {
      parsed.text = parsed.text.replace(/^the patient/i, patientName);
    }
  }

  return parsed;
}


function buildEmptySummary() {
  return {
    template_title: 'AI Summary Note',
    text: 'No clinical notes were found for this patient in the available records; clinical details are not documented (N/A).'
  };
}

// Helper: convert note_sections[] into a single SOAP-like text block for the model
function noteSectionsToSoapText(noteSections) {
  if (!Array.isArray(noteSections)) return '';

  return noteSections
    .map((s) => {
      const component = String(s?.component || '').trim();
      const text = String(s?.text || '').trim();

      // skip empty rows
      if (!component && !text) return '';

      // Keep labels for better grounding (Chief Complaint, HPI, etc.)
      return component ? `${component}: ${text || 'N/A'}` : (text || 'N/A');
    })
    .filter(Boolean)
    .join('\n\n');
}

// ROUTE: receives note_sections + summary_text (optional)
app.post('/ehr/ai/diagnosis', async (req, res) => {
  try {
    const note_sections = req.body?.note_sections;
    const summary_text = String(req.body?.summary_text || '').trim();

    // Validate the exact fields you send from scribe cockpit
    if (!Array.isArray(note_sections)) {
      return res.status(400).json({ error: 'note_sections must be an array' });
    }

    // Convert note_sections -> soapText
    const soapText = noteSectionsToSoapText(note_sections);
    if (!soapText.trim()) {
      return res.status(400).json({ error: 'note_sections has no usable text' });
    }

    const out = await generateDiagnosisFromContext({
      soapText,
      summaryText: summary_text || 'No patient summary available'
    });

    return res.json(out);
  } catch (err) {
    console.error('Diagnosis Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

// AI CALL: uses only SOAP + Summary
async function generateDiagnosisFromContext({ soapText, summaryText }) {
  const ABACUS_API_KEY = process.env.ABACUS_API_KEY;
  if (!ABACUS_API_KEY) throw new Error('Missing ABACUS_API_KEY');

  const ABACUS_MODEL = String(process.env.ABACUS_MODEL || '').trim() || 'claude-opus-4-6';

  const clip = (v, maxChars) => {
    const s = (v == null ? '' : String(v));
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + '\n\n[TRUNCATED]';
  };

  const safeSummary = clip(summaryText || 'N/A', 12000);
  const safeSoap = clip(soapText || 'N/A', 20000);

  const prompt = `
You are drafting an "Assessment", "Plan", and "Medications" section for clinician review.

Use ONLY the information in the inputs below (SOAP note content and patient summary).
Do NOT invent facts, vitals, diagnoses, labs, imaging, allergies, or medications that are not explicitly present.
If something is not documented, write "N/A".
Medication output must be medication reconciliation ONLY (meds explicitly mentioned). Do not add new meds.

Output MUST be valid JSON only. No markdown. No extra text.

Required Output Schema:
{
  "template_title": "AI Diagnosis",
  "assessment": "...",
  "plan": "...",
  "medications": "..."
}

PATIENT SUMMARY:
${safeSummary}

SOAP NOTE:
${safeSoap}
`.trim();

  const aiResponse = await axios.post(
    'https://routellm.abacus.ai/v1/chat/completions',
    {
      model: ABACUS_MODEL,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON matching the schema.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
      stream: false
    },
    {
      headers: {
        Authorization: `Bearer ${ABACUS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000,
      validateStatus: () => true
    }
  );

  if (aiResponse.status < 200 || aiResponse.status >= 300) {
    const msg =
      aiResponse?.data?.error?.message ||
      aiResponse?.data?.message ||
      `RouteLLM error: HTTP ${aiResponse.status}`;
    throw new Error(msg);
  }

  const raw = aiResponse?.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty AI response');

  const parsed = (typeof parseJsonObject === 'function')
    ? parseJsonObject(raw)
    : JSON.parse(raw);

  const norm = (v) => {
    const s = (v == null ? '' : String(v)).trim();
    return s || 'N/A';
  };

  return {
    template_title: 'AI Diagnosis',
    assessment: norm(parsed.assessment),
    plan: norm(parsed.plan),
    medications: norm(parsed.medications)
  };
}

// If you DON'T already have this helper in server.js, add it once:
function parseJsonObject(raw) {
  const s = String(raw || '').trim();
  const unfenced = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('Model did not return JSON');
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

function normalizeSingleParagraph(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts and parses the first JSON object from the model output.
 * Handles accidental ```json fences or extra surrounding text.
 */
function parseJsonObject(raw) {
  const s = String(raw).trim();

  const unfenced = s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch (_) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Model did not return a JSON object');
    }
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

/**
 * Extracts and parses the first JSON object from the model output.
 * This prevents crashes if the model accidentally adds ```json fences or extra text.
 */
function parseJsonObject(raw) {
  const s = String(raw).trim();

  // Strip common fenced-code wrappers if present
  const unfenced = s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  // Try direct parse first
  try {
    return JSON.parse(unfenced);
  } catch (_) {
    // Fallback: extract between first '{' and last '}'
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Model did not return a JSON object');
    }
    const candidate = unfenced.slice(start, end + 1);
    return JSON.parse(candidate);
  }
}

// -------------------- Login check middleware --------------------
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }
  next();
}


// -------------------- Platform Admin Routes --------------------

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'superadmin') {
    return next();
  }
  return res.status(401).json({ ok: false, message: 'Unauthorized' });
}

// 🔐 Screen-level permission guard based on Access_Rights
function requireScreen(screenId) {
  return async (req, res, next) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, message: 'Not logged in' });
      }

      const { type, userRoleMappingId } = req.session.user;

      // SuperAdmin TYPE always allowed to pass
      if (type === 'SuperAdmin') {
        return next();
      }

      if (!userRoleMappingId) {
        return res
          .status(403)
          .json({ ok: false, message: 'No screen access configured' });
      }

      const userId = req.session.user.id;

      // ✅ Effective permission = User_Additional_Permissions override OR Access_Rights default
      const rows = await sequelize.query(
        `
        SELECT TOP 1 ss.id
        FROM [dbo].[System_Screens] ss
        LEFT JOIN [dbo].[Access_Rights] ar
          ON ar.system_screen_id = ss.id
         AND ar.user_role_mapping_id = :urmId
         AND ar.row_status = 1
        LEFT JOIN [dbo].[User_Additional_Permissions] uap
          ON uap.system_screen_id = ss.id
         AND uap.user_id = :userId
         AND uap.row_status = 1
         AND (uap.start_date IS NULL OR uap.start_date <= SYSDATETIME())
         AND (uap.end_date   IS NULL OR uap.end_date   >= SYSDATETIME())
        WHERE ss.id = :screenId
          AND ss.row_status = 1
          -- if override exists use uap.read, else fallback to ar.read
          AND COALESCE(uap.[read], ar.[read], 0) = 1
        `,
        {
          replacements: {
            userId,
            urmId: userRoleMappingId,
            screenId,
          },
          type: Sequelize.QueryTypes.SELECT,
        }
      );


      if (!rows || rows.length === 0) {
        return res
          .status(403)
          .json({ ok: false, message: 'You do not have access to this screen' });
      }

      return next();
    } catch (err) {
      console.error('[PLATFORM] requireScreen error:', err);
      return res
        .status(500)
        .json({ ok: false, message: 'Internal server error' });
    }
  };
}

// 🔐 Screen-level WRITE permission guard (Create User, etc.)
function requireScreenWrite(screenId) {
  return async (req, res, next) => {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, message: 'Not logged in' });
      }

      const { type, userRoleMappingId, id: userId } = req.session.user;

      // SuperAdmin always allowed
      if (type === 'SuperAdmin') {
        return next();
      }

      if (!userRoleMappingId) {
        return res
          .status(403)
          .json({ ok: false, message: 'No screen access configured' });
      }

      const rows = await sequelize.query(
        `
        SELECT TOP 1 ss.id
        FROM [dbo].[System_Screens] ss
        LEFT JOIN [dbo].[Access_Rights] ar
          ON ar.system_screen_id = ss.id
         AND ar.user_role_mapping_id = :urmId
         AND ar.row_status = 1
        LEFT JOIN [dbo].[User_Additional_Permissions] uap
          ON uap.system_screen_id = ss.id
         AND uap.user_id = :userId
         AND uap.row_status = 1
         AND (uap.start_date IS NULL OR uap.start_date <= SYSDATETIME())
         AND (uap.end_date   IS NULL OR uap.end_date   >= SYSDATETIME())
        WHERE ss.id = :screenId
          AND ss.row_status = 1
          -- require effective WRITE = 1
          AND COALESCE(uap.[write], ar.[write], 0) = 1
        `,
        {
          replacements: {
            userId,
            urmId: userRoleMappingId,
            screenId,
          },
          type: Sequelize.QueryTypes.SELECT,
        }
      );

      if (!rows || rows.length === 0) {
        return res
          .status(403)
          .json({ ok: false, message: 'You do not have write access to this screen' });
      }

      return next();
    } catch (err) {
      console.error('[PLATFORM] requireScreenWrite error:', err);
      return res
        .status(500)
        .json({ ok: false, message: 'Internal server error' });
    }
  };
}


app.post('/api/platform/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    // Basic validation
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: 'Email and password required' });
    }

    // Look up the user in the real schema
    // Super Admin is defined as:
    //   Persona:    'Employee'
    //   Department: 'IT'
    //   Type:       'SuperAdmin'
    //   Status:     'Active' (optional check – allows NULL)
    const rows = await sequelize.query(
      `
      SELECT TOP 1
        su.id,
        su.full_name,
        su.email,
        su.password,
        su.manager_user_id,
        su.clinic_id,
        su.xr_id,
        su.status_id,
        su.user_role_mapping_id,
        p.persona,
        d.department,
        t.type,
        s.status
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
      JOIN [dbo].[Departments] d
        ON urm.department_id = d.id
      JOIN [dbo].[Types] t
        ON urm.type_id = t.id
      LEFT JOIN [dbo].[Status] s
        ON su.status_id = s.id
      WHERE su.email = :email
        AND su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND d.row_status = 1
        AND t.row_status = 1
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!rows || rows.length === 0) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid credentials' });
    }

    const user = rows[0];

    // ✅ For now: allow ANY active System_Users row to log in to the Platform.
    // Later you can tighten this to check persona/department/type again.
    const isActive = !user.status || user.status === 'Active';

    if (!isActive) {
      return res
        .status(403)
        .json({ ok: false, message: 'Not authorized for platform (inactive user)' });
    }

    // Plain-text password check for now (matches your seeded row)
    if (user.password !== password) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid credentials' });
    }

    // Decide if this DB user is the true Master Admin / SuperAdmin
    const isSuperAdminUser =
      user.type === 'SuperAdmin' ||              // from Types table
      user.full_name === 'Master Admin' ||       // your seeded name in System_Users
      user.email === 'admin@company.com';        // adjust if your master admin email differs

    // Create session – keep the same shape so existing frontend logic still works
    req.session.user = {
      role: isSuperAdminUser ? 'superadmin' : 'user',   // 🔑 only Master Admin gets 'superadmin'
      id: user.id,
      name: user.full_name,
      email: user.email,
      persona: user.persona,
      department: user.department,
      type: user.type,
      userType: user.type,                               // alias used by frontend checks
      xrId: user.xr_id || null,
      clinicId: user.clinic_id || null,
      managerUserId: user.manager_user_id || null,
      userRoleMappingId: user.user_role_mapping_id || null,
    };

    if (isSuperAdminUser) {
      console.log('[PLATFORM] ✅ SuperAdmin logged in via System_Users:', user.email);
    } else {
      console.log('[PLATFORM] ✅ Platform user logged in via System_Users:', user.email);
    }

    // ✅ NEW: If logged-in user is Provider, log provider list (id/email/xr_id) as JSON.
    // This is side-effect-free: does not change response/session and cannot block login.
    // ✅ Provider-only: log ONLY the logged-in provider (id/email/xr_id)
    if (String(user.persona || '').toLowerCase() === 'provider') {
      console.log(
        '[PLATFORM][PROVIDER_ME_JSON]',
        JSON.stringify(
          {
            ok: true,
            provider: {
              id: user.id,
              email: user.email,
              xr_id: user.xr_id || null,
            },
          },
          null,
          2
        )
      );
    }

    // Response shape kept compatible with old code (we only ADD extra fields)
    return res.json({
      ok: true,
      role: req.session.user.role,
      email: user.email,
      name: user.full_name,

      // 👇 NEW helper fields (do NOT break old frontend that only reads ok/role/email/name)
      id: user.id,
      persona: user.persona,
      department: user.department,
      type: user.type,
      managerUserId: user.manager_user_id,
      clinicId: user.clinic_id,
      xrId: user.xr_id,
      userRoleMappingId: user.user_role_mapping_id,
    });

  } catch (err) {
    console.error('[PLATFORM] Login error (System_Users):', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});




app.get('/api/platform/me', async (req, res) => {
  try {
    if (!(req.session && req.session.user)) return res.json({ ok: false });

    const u = req.session.user;

    // Fetch latest active mapping row where user is either side
    const rows = await sequelize.query(
      `
      SELECT TOP 1
        id AS mappingId,
        scribe_user_id AS scribeId,
        provider_user_id AS doctorId
      FROM Scribe_Provider_Mapping
      WHERE row_status = 1
        AND (:uid IN (scribe_user_id, provider_user_id))
      ORDER BY id DESC
      `,
      {
        replacements: { uid: u.id },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    const map = rows?.[0] || null;

    return res.json({
      ok: true,
      role: u.role,
      email: u.email,
      name: u.name,
      type: u.type,
      userType: u.userType || u.type,
      id: u.id,

      // existing safe extras
      userRoleMappingId: u.userRoleMappingId,
      xrId: u.xrId,
      clinicId: u.clinicId,
      managerUserId: u.managerUserId,
      department: u.department,
      persona: u.persona,

      // ✅ NEW: pair identity for note saving
      mappingId: map?.mappingId ?? null,
      doctorId: map?.doctorId ?? null,
      scribeId: map?.scribeId ?? null,
    });
  } catch (err) {
    console.error('[ME] error:', err);
    return res.status(500).json({ ok: false, message: 'Internal error' });
  }
});


app.post('/api/platform/logout', (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        console.error('[PLATFORM] Logout error:', err);
        return res.status(500).json({ ok: false, message: 'Logout failed' });
      }
      return res.json({ ok: true });
    });
  } else {
    return res.json({ ok: true });
  }
});

app.get('/platform/secure/ping', requireSuperAdmin, (req, res) => {
  const conn = getAzureSqlConnection();
  const dbStatus = conn ? 'configured' : 'mock_mode';
  return res.json({
    ok: true,
    message: 'Authorized',
    user: req.session.user,
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/platform/config-status', (req, res) => {
  return res.json({
    env: envLoader.envStatus,
    ready: envLoader.isReady,
    loadedFrom: envLoader.loadedFrom || 'process.env only',
  });
});

app.get('/api/platform/stats', requireLogin, async (req, res) => {
  try {
    // --- 1. Total users (from System_Users) -------------------------
    const totalUsersResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users]
      WHERE row_status = 1
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalUsers = totalUsersResult[0]?.count || 0;

    // --- 2. Providers (persona = 'Provider') -----------------------
    const totalProvidersResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p ON urm.persona_id = p.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND p.persona = 'Provider'
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalProviders = totalProvidersResult[0]?.count || 0;

    // --- 3. Employees (persona = 'Employee') -----------------------
    const totalEmployeesResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p ON urm.persona_id = p.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND p.persona = 'Employee'
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalEmployees = totalEmployeesResult[0]?.count || 0;

    // --- 4. Scribes (Employee + type = 'Scribe') -------------------
    const totalScribesResult = await sequelize.query(
      `
      SELECT COUNT(*) AS count
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Personas] p ON urm.persona_id = p.id
      JOIN [dbo].[Types] t ON urm.type_id = t.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND p.row_status = 1
        AND t.row_status = 1
        AND p.persona = 'Employee'
        AND t.type = 'Scribe'
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const totalScribes = totalScribesResult[0]?.count || 0;

    // --- 5. Build response object ---------------------------------
    const stats = {
      totalUsers,
      totalProviders,
      totalScribes,
      totalEmployees,
      recentLogins: [], // we’ll wire this up later
    };

    return res.json({ ok: true, stats });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/stats error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});


// -------------------- Screens visible to current platform user --------------------
app.get('/api/platform/my-screens', requireLogin, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const userRoleMappingId = sessionUser.userRoleMappingId;
    const userType = sessionUser.type; // e.g. 'SuperAdmin', 'Scribe', 'Employee'

    // SuperAdmin: see all screens with full permissions
    if (userType === 'SuperAdmin') {
      const screens = await sequelize.query(
        `
        SELECT
          id,
          screen_name,
          route_path,
          1 AS [read],
          1 AS [write],
          1 AS [edit],
          1 AS [delete]
        FROM [dbo].[System_Screens]
        WHERE row_status = 1
        ORDER BY id
        `,
        { type: Sequelize.QueryTypes.SELECT }
      );

      return res.json({ ok: true, screens });
    }


    // Everyone else: defaults from Access_Rights + optional overrides from User_Additional_Permissions
    if (!userRoleMappingId) {
      // no mapping id – safest is to return no screens
      return res.json({ ok: true, screens: [] });
    }

    const userId = sessionUser.id;

    const screens = await sequelize.query(
      `
      SELECT
        ss.id,
        ss.screen_name,
        ss.route_path,
        -- effective permissions: per-user override first, then role default
        COALESCE(uap.[read],  ar.[read],  0) AS [read],
        COALESCE(uap.[write], ar.[write], 0) AS [write],
        COALESCE(uap.[edit],  ar.[edit],  0) AS [edit],
        COALESCE(uap.[delete],ar.[delete],0) AS [delete]
      FROM [dbo].[System_Screens] ss
      LEFT JOIN [dbo].[Access_Rights] ar
        ON ar.system_screen_id = ss.id
       AND ar.user_role_mapping_id = :userRoleMappingId
       AND ar.row_status = 1
      LEFT JOIN [dbo].[User_Additional_Permissions] uap
        ON uap.system_screen_id = ss.id
       AND uap.user_id = :userId
       AND uap.row_status = 1
       AND (uap.start_date IS NULL OR uap.start_date <= SYSDATETIME())
       AND (uap.end_date   IS NULL OR uap.end_date   >= SYSDATETIME())
      WHERE ss.row_status = 1
        -- only show screens where effective READ = 1
        AND COALESCE(uap.[read], ar.[read], 0) = 1
      ORDER BY ss.id
      `,
      {
        replacements: { userRoleMappingId, userId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );


    return res.json({ ok: true, screens });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/my-screens error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// Helper: normalize rights from old & new payload shapes into
// [{ screenId, read, write, edit, delete }]
function normalizeScreenRights(rawRights) {
  const result = [];
  if (!Array.isArray(rawRights)) return result;

  for (const entry of rawRights) {
    if (!entry) continue;

    // NEW shape: { screenId, read, write, edit, delete }
    if (typeof entry === 'object') {
      const screenId = Number(entry.screenId ?? entry.id);
      if (!Number.isFinite(screenId)) continue;

      result.push({
        screenId,
        read: entry.read ? 1 : 0,
        write: entry.write ? 1 : 0,
        edit: entry.edit ? 1 : 0,
        delete: entry.delete ? 1 : 0,
      });
      continue;
    }

    // OLD shape: "1", "2", 3 → defaults to READ=1 only
    const screenId = Number(entry);
    if (!Number.isFinite(screenId)) continue;

    result.push({
      screenId,
      read: 1,
      write: 0,
      edit: 0,
      delete: 0,
    });
  }

  return result;
}




app.post('/api/platform/create-user', requireLogin, requireScreenWrite(6), async (req, res) => {

  try {
    // ---- 0. Normalise incoming body (support old + new field names) ----
    const body = req.body || {};

    const category =
      body.category ||
      body.userCategory ||       // old / alternative name
      body.persona ||
      null;

    const name = body.name || body.full_name || null;
    const email = body.email || null;

    const department =
      body.department ||
      body.dept ||
      null;

    const type =
      body.type ||
      body.userType ||          // old field name
      body.typeName ||
      null;

    const status = body.status || null;

    const password =
      body.password ||
      body.tempPassword ||      // if frontend ever uses a different key
      null;

    const rights =
      Array.isArray(body.rights) ? body.rights :
        Array.isArray(body.screenAccess) ? body.screenAccess :
          Array.isArray(body.screenRights) ? body.screenRights :
            [];

    // Normalize rights into consistent structure
    const normalizedRights = normalizeScreenRights(rights);



    const reportingManagerId =
      body.reportingManagerId ||
      body.reportingManager ||
      body.managerUserId ||
      null;

    const clinicId = body.clinicId || body.clinic || null;
    const xrId = body.xrId || body.xr_id || null;
    const contactNoPrimary =
      body.contact_no_primary ||
      body.phone ||
      body.phoneNumber ||
      null;

    const mrnNo =
      body.mrn_no ||
      body.mrn ||
      null;

    const primaryProviderId =
      body.primaryProviderUserId ||
      body.primaryProviderId ||
      body.primaryProvider ||
      null;

    // Small debug to help if this ever fails again
    console.log('[PLATFORM] /create-user incoming body (sanitised):', {
      category,
      name,
      email,
      department,
      type,
      status,
      hasPassword: !!password,
      rights,
      reportingManagerId,
      clinicId,
      xrId,
      primaryProviderId
    });

    // Normalize category to match Personas values
    const normalizedCategory = String(category).toLowerCase();

    // --- 1. Basic validation --------------------------------------------
    if (
      !category ||
      !name ||
      !email ||
      !password ||
      (normalizedCategory !== 'patient' && !status) ||
      (normalizedCategory === 'patient' && (!contactNoPrimary || !mrnNo))
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Required fields are missing'
      });
    }


    // Personas table: 'Employee' and 'Provider'
    // For Scribe, we treat persona = 'Employee' with type = 'Scribe'
    let personaName;
    if (normalizedCategory === 'provider') {
      personaName = 'Provider';
    } else if (normalizedCategory === 'patient') {
      personaName = 'Patient';
    } else {
      // Employee, Scribe
      personaName = 'Employee';
    }


    // If department not supplied, default sensibly
    // ✅ Enforce: Patient MUST always be OPS (ignore any incoming department)
    const departmentName =
      normalizedCategory === 'patient'
        ? 'OPS'
        : (department || (normalizedCategory === 'provider' ? 'OPS' : 'IT'));

    // Decide which "type" (Types table) to use
    let typeName = type || 'Employee';

    // Our Types table does NOT have "Provider" as a type.
    // Providers should use the "Employee" type entry.
    if (normalizedCategory === 'provider') {
      typeName = 'Employee';
    }

    const statusName =
      status || (normalizedCategory === 'patient' ? 'Active' : null);



    // --- 2. Look up IDs from master tables ------------------------------

    const personaRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Personas]
      WHERE persona = :personaName
        AND row_status = 1
      `,
      {
        replacements: { personaName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!personaRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid persona/category' });
    }
    const personaId = personaRow[0].id;

    const deptRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Departments]
      WHERE department = :departmentName
        AND row_status = 1
      `,
      {
        replacements: { departmentName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!deptRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid department' });
    }
    const departmentId = deptRow[0].id;

    const typeRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Types]
      WHERE type = :typeName
        AND row_status = 1
      `,
      {
        replacements: { typeName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!typeRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid type' });
    }
    const typeId = typeRow[0].id;

    const statusRow = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[Status]
      WHERE status = :statusName
        AND row_status = 1
      `,
      {
        replacements: { statusName },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (!statusRow.length) {
      return res
        .status(400)
        .json({ ok: false, message: 'Invalid status' });
    }
    const statusId = statusRow[0].id;

    // --- 3. Check if email already exists in System_Users ----------------
    const existingUser = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[System_Users]
      WHERE email = :email
        AND row_status = 1
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT
      }
    );
    if (existingUser.length) {
      return res.status(400).json({
        ok: false,
        message: 'A user with this email already exists'
      });
    }

    const createdById = (req.session.user && req.session.user.id) || null;

    // --- 4. Insert into User_Role_Mapping + System_Users (transaction) ---

    const transaction = await sequelize.transaction();

    try {

      // 4a) Decide user_role_mapping_id
      // ✅ Patient must ALWAYS reuse the shared mapping id = 85 (no new row in User_Role_Mapping)
      let userRoleMappingId = null;

      if (normalizedCategory === 'patient') {
        userRoleMappingId = 85;
      } else if (normalizedCategory === 'provider') {
        userRoleMappingId = 11;
      } else {

        // Insert into User_Role_Mapping and get id via OUTPUT
        const roleRowsRaw = await sequelize.query(
          `
          INSERT INTO [dbo].[User_Role_Mapping] (
            persona_id,
            department_id,
            type_id,
            created_date,
            created_by,
            modified_date,
            modified_by,
            row_status
          )
          OUTPUT INSERTED.id AS id
          VALUES (
            :personaId,
            :departmentId,
            :typeId,
            SYSDATETIME(),
            :createdBy,
            SYSDATETIME(),
            :createdBy,
            1
          )
          `,
          {
            replacements: {
              personaId,
              departmentId,
              typeId,
              createdBy: createdById
            },
            type: Sequelize.QueryTypes.SELECT,
            transaction
          }
        );

        console.log('[DEBUG] roleRowsRaw from User_Role_Mapping insert:', roleRowsRaw);

        if (Array.isArray(roleRowsRaw)) {
          if (roleRowsRaw.length && roleRowsRaw[0] && typeof roleRowsRaw[0].id !== 'undefined') {
            userRoleMappingId = roleRowsRaw[0].id;
          } else if (
            Array.isArray(roleRowsRaw[0]) &&
            roleRowsRaw[0].length &&
            roleRowsRaw[0][0] &&
            typeof roleRowsRaw[0][0].id !== 'undefined'
          ) {
            userRoleMappingId = roleRowsRaw[0][0].id;
          }
        }

        if (!userRoleMappingId) {
          throw new Error('User_Role_Mapping insert did not return an id (check roleRowsRaw debug log)');
        }
      }

      // 4b) Insert into System_Users
      const managerUserId = reportingManagerId || null;

      await sequelize.query(
        `
        INSERT INTO [dbo].[System_Users] (
          full_name,
          email,
          password,
          manager_user_id,
          clinic_id,
          xr_id,
          status_id,
          user_role_mapping_id,
          contact_no_primary,
          mrn_no,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :full_name,
          :email,
          :password,
          :manager_user_id,
          :clinic_id,
          :xr_id,
          :status_id,
          :user_role_mapping_id,
          :contact_no_primary,
          :mrn_no,
          SYSDATETIME(),
          :created_by,
          SYSDATETIME(),
          :created_by,
          1
        )
        `,
        {
          replacements: {
            full_name: name,
            email,
            password, // still plain, matching your seed; can switch to bcrypt later
            manager_user_id: managerUserId,
            clinic_id: clinicId || null,
            xr_id: xrId || null,
            status_id: statusId,
            user_role_mapping_id: userRoleMappingId,
            // ✅ ADD THESE TWO LINES HERE
            contact_no_primary: contactNoPrimary,
            mrn_no: mrnNo,
            created_by: createdById
          },
          type: Sequelize.QueryTypes.INSERT,
          transaction
        }
      );
      // 4c) Insert screen rights into Access_Rights (if any screens were selected)
      if (normalizedRights && normalizedRights.length > 0) {
        for (const r of normalizedRights) {
          const screenId = Number(r.screenId);
          if (!Number.isFinite(screenId)) continue; // skip bad values

          await sequelize.query(
            `
            INSERT INTO [dbo].[Access_Rights] (
              user_role_mapping_id,
              system_screen_id,
              [read],
              [write],
              [edit],
              [delete],
              created_date,
              created_by,
              modified_date,
              modified_by,
              row_status
            )
            VALUES (
              :user_role_mapping_id,
              :system_screen_id,
              :read,
              :write,
              :edit,
              :delete,
              SYSDATETIME(),
              :created_by,
              SYSDATETIME(),
              :created_by,
              1
            )
            `,
            {
              replacements: {
                user_role_mapping_id: userRoleMappingId,
                system_screen_id: screenId,
                read: r.read ? 1 : 0,
                write: r.write ? 1 : 0,
                edit: r.edit ? 1 : 0,
                delete: r.delete ? 1 : 0,
                created_by: createdById,
              },
              type: Sequelize.QueryTypes.INSERT,
              transaction,
            }
          );
        }
      }



      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    console.log('[PLATFORM] System_Users user created:', {
      name,
      email,
      category: personaName,
      department: departmentName,
      type: typeName
    });

    // --- 5. Send welcome email with login credentials --------------------
    try {
      await sendNewLoginEmail({
        to: email,
        name,
        email,
        password
      });
    } catch (mailErr) {
      console.error(
        '[PLATFORM] Failed to send welcome email:',
        mailErr.message || mailErr
      );
      // Do NOT fail the request just because email failed
    }

    return res.json({
      ok: true,
      message: 'User created in System_Users and login email sent'
    });
  } catch (err) {
    console.error('[PLATFORM] Create user error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// -------------------- USERS FOR ASSIGN USERS TABLE --------------------
// Returns providers + scribes with any existing assignment rows.
// - SuperAdmin  → sees all providers + all scribes
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
// - Manager     → sees all providers + only scribes that report to them
app.get('/api/platform/users', requireLogin, requireScreen(8), async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const currentUserId = sessionUser.id;
    const isSuperAdmin =
      sessionUser.role === 'superadmin' || sessionUser.type === 'SuperAdmin';
    const isSuperAdminBit = isSuperAdmin ? 1 : 0;

    const sql = `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.xr_id,
        su.clinic_id,
        CASE
          WHEN vur.persona_id = 5 THEN 'Provider'
          WHEN vur.type_id   = 4 THEN 'Scribe'
          ELSE 'Other'
        END AS userType
      FROM [dbo].[System_Users] su
      JOIN [dbo].[View_User_Role_Mapping] vur
        ON su.user_role_mapping_id = vur.id
      WHERE
        su.row_status = 1
        AND su.status_id = 1
        AND (
             -- Providers
             vur.persona_id = 5
             OR
             -- Scribes (SuperAdmin sees all; Manager only own reportees)
             (
               vur.type_id = 4
               AND (
                 :isSuperAdmin = 1
                 OR su.manager_user_id = :managerId
               )
             )
        )
      ORDER BY su.full_name ASC;
    `;

    const rows = await sequelize.query(sql, {
      replacements: {
        isSuperAdmin: isSuperAdminBit,
        managerId: currentUserId,
      },
      type: Sequelize.QueryTypes.SELECT,
    });

    const users = (rows || []).map((u) => ({
      id: u.id,
      name: u.full_name,
      email: u.email,
      xr_id: u.xr_id,
      clinic_id: u.clinic_id,
      userType: u.userType,       // 'Provider' or 'Scribe'
      // mapping fields start empty; Save will fill them
      provider_id: null,
      scribe_id: null,
      level: null,
    }));

    return res.json({ ok: true, users });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/users error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});




app.post('/api/platform/assign-user', requireSuperAdmin, async (req, res) => {
  try {
    const { userId, providerId, scribeId, level } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, message: 'User ID is required' });
    }

    const checkQuery = 'SELECT * FROM [dbo].[assignusers] WHERE user_id = :userId';
    const existing = await sequelize.query(checkQuery, {
      replacements: { userId },
      type: Sequelize.QueryTypes.SELECT,
    });

    if (existing && existing.length > 0) {
      const updateQuery = `
        UPDATE [dbo].[assignusers]
        SET provider_id = :providerId, scribe_id = :scribeId, level = :level, updated_at = GETDATE()
        WHERE user_id = :userId
      `;
      await sequelize.query(updateQuery, {
        replacements: { userId, providerId: providerId || null, scribeId: scribeId || null, level: level || null },
        type: Sequelize.QueryTypes.UPDATE,
      });
    } else {
      const insertQuery = `
        INSERT INTO [dbo].[assignusers] (user_id, provider_id, scribe_id, level, created_at)
        VALUES (:userId, :providerId, :scribeId, :level, GETDATE())
      `;
      await sequelize.query(insertQuery, {
        replacements: { userId, providerId: providerId || null, scribeId: scribeId || null, level: level || null },
        type: Sequelize.QueryTypes.INSERT,
      });
    }

    console.log('[PLATFORM] User assignment updated:', { userId, providerId, scribeId, level });
    return res.json({ ok: true, message: 'Assignment saved successfully' });
  } catch (err) {
    console.error('[PLATFORM] Assign user error:', err);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});


// -------------------- ASSIGN USERS DROPDOWN OPTIONS --------------------
// Returns:
//  - scribes: 
//      Master Admin  -> ALL scribes in System_Users
//      Manager       -> ONLY scribes where manager_user_id = current manager
//  - providers: ALL providers (for now, both Master Admin & Manager)
// New Assign Users top-panel dropdown options
app.get('/api/platform/assign-users/options', requireLogin, requireScreen(8), async (req, res) => {

  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const currentUserId = sessionUser.id;
    // Master Admin flag:
    //  - role === 'superadmin' (we set this in /api/platform/login)
    //  - OR Types.type === 'SuperAdmin'
    const isMasterAdmin =
      sessionUser.role === 'superadmin' ||
      sessionUser.type === 'SuperAdmin';

    const isMasterAdminBit = isMasterAdmin ? 1 : 0;

    // 👇 Scribes:
    // - type_id = 4 in View_User_Role_Mapping = Scribe
    // - if NOT Master Admin, restrict by manager_user_id
    const scribesQuery = `
  SELECT
    su.id,
    su.full_name,
    su.email,
    su.xr_id,
    su.manager_user_id,
    mgr.full_name AS manager_name
  FROM [dbo].[System_Users] su
  LEFT JOIN [dbo].[System_Users] mgr
    ON mgr.id = su.manager_user_id
   AND mgr.row_status = 1
  WHERE
    su.row_status = 1
    AND su.user_role_mapping_id IN (
      SELECT id
      FROM [dbo].[View_User_Role_Mapping]
      WHERE type_id = 4      -- Scribe
    )
    AND (
      :isMasterAdmin = 1
      OR su.manager_user_id = :currentUserId
    )
  ORDER BY su.full_name;
`;


    // 👇 Providers:
    // - persona_id = 5 in View_User_Role_Mapping = Provider
    // - no manager filter (both Master Admin & Manager see all providers)
    const providersQuery = `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.xr_id,
        su.clinic_id
      FROM [dbo].[System_Users] su
      WHERE
        su.row_status = 1
        AND su.status_id = 1
        AND su.user_role_mapping_id IN (
          SELECT id
          FROM [dbo].[View_User_Role_Mapping]
          WHERE persona_id = 5   -- Provider
        )
      ORDER BY su.full_name;
    `;


    const [scribes, providers] = await Promise.all([
      sequelize.query(scribesQuery, {
        replacements: { currentUserId, isMasterAdmin: isMasterAdminBit },
        type: Sequelize.QueryTypes.SELECT,
      }),
      sequelize.query(providersQuery, {
        type: Sequelize.QueryTypes.SELECT,
      }),
    ]);

    return res.json({
      ok: true,
      scope: isMasterAdmin ? 'all' : 'manager', // just for debugging in UI
      scribes,       // [{ id, full_name }]
      providers,     // [{ id, full_name }]
    });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/assign-users/options error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// -------------------- Scribe ⇄ Provider mappings (bottom Assign Users grid) --------------------
// Returns one row per active mapping in Scribe_Provider_Mapping.
// - Master Admin: sees all mappings
// - Manager: sees only mappings where *their* scribes are mapped
// - Master Admin: sees all mappings
// - Manager: sees only mappings where *their* scribes are mapped
app.get('/api/platform/scribe-provider-mapping', requireLogin, requireScreen(8), async (req, res) => {

  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const currentUserId = sessionUser.id;
    const isMasterAdmin =
      sessionUser.role === 'superadmin' ||
      sessionUser.type === 'SuperAdmin';
    const isMasterAdminBit = isMasterAdmin ? 1 : 0;

    // ✅ Global mapped provider IDs (used to compute "Unmapped Providers" correctly)
    // Important: this is NOT scoped by manager, and it does not expose scribe details.
    const mappedProviderRows = await sequelize.query(
      `
      SELECT DISTINCT provider_user_id
      FROM [dbo].[Scribe_Provider_Mapping]
      WHERE row_status = 1
        AND provider_user_id IS NOT NULL
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );

    const mappedProviderIdsAll = (mappedProviderRows || [])
      .map(r => r.provider_user_id)
      .filter(v => v != null)
      .map(v => Number(v))
      .filter(n => Number.isFinite(n))
      .map(n => String(n)); // normalize to string for easy frontend Set usage


    const rows = await sequelize.query(
      `
      SELECT
        m.id,

        -- Scribe side
        s.id          AS scribe_id,
        s.full_name   AS scribe_name,
        s.email       AS scribe_email,
        s.xr_id       AS scribe_xr_id,

        -- Provider side
        p.id          AS provider_id,
        p.full_name   AS provider_name,
        p.email       AS provider_email,
        p.xr_id       AS provider_xr_id,
        p.clinic_id   AS provider_clinic_id,
        c.clinic      AS provider_clinic_name,


        -- Manager of the scribe
        mgr.full_name AS scribe_manager_name
      FROM [dbo].[Scribe_Provider_Mapping] m
      JOIN [dbo].[System_Users] s
        ON m.scribe_user_id = s.id
       AND s.row_status = 1
      JOIN [dbo].[System_Users] p
        ON m.provider_user_id = p.id
       AND p.row_status = 1
       LEFT JOIN [dbo].[Clinics] c
      ON p.clinic_id = c.id
      AND c.row_status = 1
      LEFT JOIN [dbo].[System_Users] mgr
        ON s.manager_user_id = mgr.id
       AND mgr.row_status = 1
      WHERE
        m.row_status = 1
        AND (
          :isMasterAdmin = 1
          OR s.manager_user_id = :managerId
        )
      ORDER BY
        s.full_name ASC,
        p.full_name ASC;
      `,
      {
        replacements: {
          isMasterAdmin: isMasterAdminBit,
          managerId: currentUserId,
        },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    // Shape it nicely for the frontend (no behavior impact on other routes)
    const mappings = rows.map((r) => ({
      id: r.id,
      scribe: {
        id: r.scribe_id,
        name: r.scribe_name,
        email: r.scribe_email,
        xrId: r.scribe_xr_id,
        managerName: r.scribe_manager_name || null,
      },
      provider: {
        id: r.provider_id,
        name: r.provider_name,
        email: r.provider_email,
        xrId: r.provider_xr_id,
        // ✅ add these
        clinic_id: r.provider_clinic_id,
        clinic_name: r.provider_clinic_name,

      },
    }));

    return res.json({ ok: true, mappings, mappedProviderIdsAll });

  } catch (err) {
    console.error('[PLATFORM] /api/platform/scribe-provider-mapping (GET) error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// Create / update a Scribe ⇄ Provider mapping from the top "Save Assignment" button
// Create / update a Scribe ⇄ Provider mapping from the top "Save Assignment" button
app.post('/api/platform/scribe-provider-mapping', requireLogin, requireScreenWrite(8), async (req, res) => {

  try {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    const { scribeUserId, providerUserId } = req.body || {};
    const scribeId = parseInt(scribeUserId, 10);
    const providerId = parseInt(providerUserId, 10);

    if (!scribeId || !providerId) {
      return res.status(400).json({
        ok: false,
        message: 'scribeUserId and providerUserId are required',
      });
    }

    const currentUserId = sessionUser.id;
    const isMasterAdmin =
      sessionUser.role === 'superadmin' ||
      sessionUser.type === 'SuperAdmin';

    // Managers can only assign their own scribes
    if (!isMasterAdmin) {
      const [check] = await sequelize.query(
        `
        SELECT TOP 1 id
        FROM [dbo].[System_Users]
        WHERE id = :scribeId
          AND manager_user_id = :managerId
          AND row_status = 1
        `,
        {
          replacements: { scribeId, managerId: currentUserId },
          type: Sequelize.QueryTypes.SELECT,
        }
      );

      if (!check) {
        return res.status(403).json({
          ok: false,
          message: 'You can only assign scribes that report to you',
        });
      }
    }

    const nowUserId = currentUserId || null;

    // Upsert model: one *active* mapping per scribe
    const existing = await sequelize.query(
      `
      SELECT TOP 1 id
      FROM [dbo].[Scribe_Provider_Mapping]
      WHERE scribe_user_id = :scribeId
        AND row_status = 1
      `,
      {
        replacements: { scribeId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (existing && existing.length > 0) {
      // Update provider for this scribe
      const mappingId = existing[0].id;
      await sequelize.query(
        `
        UPDATE [dbo].[Scribe_Provider_Mapping]
        SET
          provider_user_id = :providerId,
          modified_date    = SYSDATETIME(),
          modified_by      = :userId
        WHERE id = :id
        `,
        {
          replacements: {
            id: mappingId,
            providerId,
            userId: nowUserId,
          },
          type: Sequelize.QueryTypes.UPDATE,
        }
      );
    } else {
      // Insert new mapping row
      await sequelize.query(
        `
        INSERT INTO [dbo].[Scribe_Provider_Mapping] (
          scribe_user_id,
          provider_user_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :scribeId,
          :providerId,
          SYSDATETIME(),
          :userId,
          SYSDATETIME(),
          :userId,
          1
        )
        `,
        {
          replacements: {
            scribeId,
            providerId,
            userId: nowUserId,
          },
          type: Sequelize.QueryTypes.INSERT,
        }
      );
    }

    console.log('[PLATFORM] Scribe_Provider_Mapping saved:', {
      scribeId,
      providerId,
      by: nowUserId,
    });

    return res.json({ ok: true, message: 'Mapping saved successfully' });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/scribe-provider-mapping (POST) error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// Lookup options for create-user form based on NEW XRBase schema
// -------------------- Create-User dropdown / lookup data --------------------
app.get('/api/platform/lookup-options', requireLogin, requireScreen(6), async (req, res) => {

  try {
    const personasQuery = `
      SELECT id, persona
      FROM [dbo].[Personas]
      WHERE row_status = 1
      ORDER BY id
    `;

    const departmentsQuery = `
      SELECT id, department
      FROM [dbo].[Departments]
      WHERE row_status = 1
      ORDER BY id
    `;

    const typesQuery = `
      SELECT id, type
      FROM [dbo].[Types]
      WHERE row_status = 1
      ORDER BY id
    `;

    const statusesQuery = `
      SELECT id, status
      FROM [dbo].[Status]
      WHERE row_status = 1
      ORDER BY id
    `;

    const clinicsQuery = `
      SELECT id, clinic
      FROM [dbo].[Clinics]
      WHERE row_status = 1
      ORDER BY id
    `;

    const screensQuery = `
      SELECT id, screen_name, route_path
      FROM [dbo].[System_Screens]
      WHERE row_status = 1
      ORDER BY id
    `;

    // All active MANAGERS (Types.type = 'Manager') for Reporting Manager dropdown
    const managersQuery = `
      SELECT
        su.id,
        su.full_name
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
      JOIN [dbo].[Types] t
        ON urm.type_id = t.id
      WHERE su.row_status = 1
        AND urm.row_status = 1
        AND t.row_status = 1
        AND t.type = 'Manager'
      ORDER BY su.full_name ASC
    `;




    // ✅ now we grab 7 results, including managers
    const [personas, departments, types, statuses, clinics, screens, managers] =
      await Promise.all([
        sequelize.query(personasQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(departmentsQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(typesQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(statusesQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(clinicsQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(screensQuery, { type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(managersQuery, { type: Sequelize.QueryTypes.SELECT }), // 👈 NEW
      ]);


    return res.json({
      ok: true,
      options: {
        personas,
        departments,
        types,
        statuses,
        clinics,
        screens,
        managers,   // 👈 NEW: list of { id, full_name } for Reporting Manager dropdown
      },
    });

  } catch (err) {
    console.error('[PLATFORM] /api/platform/lookup-options error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// -------------------- Providers for a clinic (Primary Provider dropdown) --------------------
app.get('/api/platform/providers', requireLogin, requireScreen(6), async (req, res) => {
  try {
    const clinicId = parseInt(req.query.clinicId, 10);

    if (!clinicId || Number.isNaN(clinicId)) {
      return res.status(400).json({
        ok: false,
        message: 'clinicId is required and must be a number',
      });
    }

    // A "provider" = active user in that clinic with effective READ=1 for XR Device (screen 4)
    // A "provider" = active user in that clinic whose persona is Provider
    // A "provider" = active user in that clinic whose persona is Provider
    const providers = await sequelize.query(
      `
      SELECT
        su.id,
        su.full_name
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
       AND urm.row_status = 1
      JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
       AND p.row_status = 1
       AND p.persona = 'Provider'
      WHERE
        su.clinic_id = :clinicId
        AND su.status_id = 1      -- Active
        AND su.row_status = 1
      ORDER BY
        su.full_name ASC
      `,
      {
        replacements: { clinicId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );



    return res.json({ ok: true, providers });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/providers error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// -------------------- USER RELATIONS (Manager + Reportees) --------------------
app.get('/api/platform/my-relations', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // 1️⃣ Load this user's full profile including manager
    const [me] = await sequelize.query(`
      SELECT 
        su.id,
        su.full_name,
        su.email,
        su.manager_user_id,
        mgr.full_name AS manager_name
      FROM System_Users su
      LEFT JOIN System_Users mgr 
        ON mgr.id = su.manager_user_id AND mgr.row_status = 1
      WHERE su.id = :userId AND su.row_status = 1
    `, {
      replacements: { userId },
      type: Sequelize.QueryTypes.SELECT
    });

    // 2️⃣ Load all reportees under this user
    const reportees = await sequelize.query(`
      SELECT 
        su.id,
        su.full_name,
        su.email
      FROM System_Users su
      WHERE su.manager_user_id = :userId 
        AND su.row_status = 1
      ORDER BY su.full_name
    `, {
      replacements: { userId },
      type: Sequelize.QueryTypes.SELECT
    });

    return res.json({
      ok: true,
      me,
      manager: me.manager_user_id
        ? { id: me.manager_user_id, name: me.manager_name }
        : null,
      reportees
    });

  } catch (err) {
    console.error('my-relations error:', err);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});


// -------------------- SUBTREE HIERARCHY FOR CURRENT USER --------------------
app.get('/api/platform/my-hierarchy', requireLogin, async (req, res) => {
  try {
    const currentUserId = req.session.user && req.session.user.id;
    if (!currentUserId) {
      return res.status(401).json({ ok: false, message: 'Not logged in' });
    }

    // 1️⃣ Load ALL active users with role/persona/department
    const users = await sequelize.query(
      `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.manager_user_id,
        su.xr_id,
        su.clinic_id,
        urm.id AS user_role_mapping_id,
        p.persona,
        d.department,
        t.type AS role_type
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
       AND urm.row_status = 1
      LEFT JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
       AND p.row_status = 1
      LEFT JOIN [dbo].[Departments] d
        ON urm.department_id = d.id
       AND d.row_status = 1
      LEFT JOIN [dbo].[Types] t
        ON urm.type_id = t.id
       AND t.row_status = 1
      WHERE su.row_status = 1
      ORDER BY su.full_name ASC
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );

    if (!users || users.length === 0) {
      return res.json({ ok: true, roots: [], stats: { totalUsers: 0 } });
    }

    // 2️⃣ Build id -> node map
    const byId = new Map();
    users.forEach((u) => {
      byId.set(u.id, {
        id: u.id,
        name: u.full_name,
        email: u.email,
        manager_user_id: u.manager_user_id,
        xrId: u.xr_id,
        clinicId: u.clinic_id,
        userRoleMappingId: u.user_role_mapping_id,
        persona: u.persona,
        department: u.department,
        role: u.role_type, // 'SuperAdmin', 'Manager', 'Scribe', 'Employee', etc.
        children: [],
      });
    });

    // 3️⃣ Hook each user to their manager
    users.forEach((u) => {
      const node = byId.get(u.id);
      if (u.manager_user_id && byId.has(u.manager_user_id)) {
        byId.get(u.manager_user_id).children.push(node);
      }
    });

    const rootNode = byId.get(currentUserId);
    if (!rootNode) {
      return res.json({
        ok: false,
        message: 'Current user not found in hierarchy',
      });
    }

    // 4️⃣ Collect subtree stats (current user + everyone under them)
    const collected = [];
    (function collect(node) {
      collected.push(node);
      if (Array.isArray(node.children)) {
        node.children.forEach(collect);
      }
    })(rootNode);

    const totalUsers = collected.length;
    const totalManagers = collected.filter((u) => u.role === 'Manager').length;
    const totalScribes = collected.filter((u) => u.role === 'Scribe').length;
    const totalProviders = collected.filter((u) => u.persona === 'Provider').length;

    const stats = {
      totalUsers,
      totalManagers,
      totalScribes,
      totalProviders,
    };

    return res.json({
      ok: true,
      roots: [rootNode], // subtree starting at THIS user
      stats,
    });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/my-hierarchy error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// -------------------- FULL USER HIERARCHY (SuperAdmin only) --------------------
app.get('/api/platform/user-hierarchy', requireSuperAdmin, async (req, res) => {
  try {
    // 1️⃣ Load ALL active users with role/persona/department
    const users = await sequelize.query(
      `
      SELECT
        su.id,
        su.full_name,
        su.email,
        su.manager_user_id,
        su.xr_id,
        su.clinic_id,
        urm.id AS user_role_mapping_id,
        p.persona,
        d.department,
        t.type AS role_type
      FROM [dbo].[System_Users] su
      JOIN [dbo].[User_Role_Mapping] urm
        ON su.user_role_mapping_id = urm.id
       AND urm.row_status = 1
      LEFT JOIN [dbo].[Personas] p
        ON urm.persona_id = p.id
       AND p.row_status = 1
      LEFT JOIN [dbo].[Departments] d
        ON urm.department_id = d.id
       AND d.row_status = 1
      LEFT JOIN [dbo].[Types] t
        ON urm.type_id = t.id
       AND t.row_status = 1
      WHERE su.row_status = 1
      ORDER BY su.full_name ASC
      `,
      { type: Sequelize.QueryTypes.SELECT }
    );

    // 2️⃣ Build a map: id -> node
    const byId = new Map();
    users.forEach((u) => {
      byId.set(u.id, {
        id: u.id,
        name: u.full_name,
        email: u.email,
        manager_user_id: u.manager_user_id,
        xrId: u.xr_id,
        clinicId: u.clinic_id,
        userRoleMappingId: u.user_role_mapping_id,
        persona: u.persona,
        department: u.department,
        role: u.role_type,   // e.g. 'SuperAdmin', 'Manager', 'Scribe', 'Member'
        children: [],
      });
    });

    // 3️⃣ Attach children to their manager; collect roots
    const roots = [];
    users.forEach((u) => {
      const node = byId.get(u.id);
      if (u.manager_user_id && byId.has(u.manager_user_id)) {
        byId.get(u.manager_user_id).children.push(node);
      } else {
        // No valid manager → top-level in the tree
        roots.push(node);
      }
    });

    // 4️⃣ Simple stats for dashboard / profile header
    const totalUsers = users.length;
    const totalManagers = users.filter((u) => u.role_type === 'Manager').length;
    const totalScribes = users.filter((u) => u.role_type === 'Scribe').length;
    const totalProviders = users.filter((u) => u.persona === 'Provider').length;

    const stats = {
      totalUsers,
      totalManagers,
      totalScribes,
      totalProviders,
    };

    return res.json({
      ok: true,
      roots,     // full tree: SuperAdmin -> Managers -> Employees etc.
      stats,     // useful summary
    });
  } catch (err) {
    console.error('[PLATFORM] /api/platform/user-hierarchy error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});

// ================== EMAIL (login user welcome) ==================
const { EmailClient } = require("@azure/communication-email");
const { DefaultAzureCredential, ClientSecretCredential } = require("@azure/identity");

const ACS_ENDPOINT = process.env.ACS_ENDPOINT;
const EMAIL_FROM = process.env.EMAIL_FROM || "xr@oghealthcare.com";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "xr@oghealthcare.com";
const SENDER_NAME = process.env.SENDER_NAME || "XR Platform ";

let emailClient = null;

try {
  // ✅ PRIORITY 1: Use Connection String (SIMPLEST & MOST RELIABLE)
  if (process.env.ACS_CONNECTION_STRING) {
    emailClient = new EmailClient(process.env.ACS_CONNECTION_STRING);
    console.log("[MAIL] ✅ ACS EmailClient initialized with CONNECTION STRING");
    console.log("[MAIL] 🔐 Using connection string authentication - RECOMMENDED FOR DEVELOPMENT");
  }
  // ✅ PRIORITY 2: Use ACS-specific credentials if available
  else if (process.env.ACS_TENANT_ID && process.env.ACS_CLIENT_ID && process.env.ACS_CLIENT_SECRET) {
    const credential = new ClientSecretCredential(
      process.env.ACS_TENANT_ID,
      process.env.ACS_CLIENT_ID,
      process.env.ACS_CLIENT_SECRET
    );

    if (ACS_ENDPOINT) {
      emailClient = new EmailClient(ACS_ENDPOINT, credential);
      console.log("[MAIL] ✅ ACS EmailClient initialized with DEDICATED ACS service principal");
    }
  }
  // ✅ PRIORITY 3: Use managed identity if configured
  else if (!!process.env.AZURE_CLIENT_ID_MI && !process.env.AZURE_CLIENT_SECRET) {
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: process.env.AZURE_CLIENT_ID_MI,
    });

    if (ACS_ENDPOINT) {
      emailClient = new EmailClient(ACS_ENDPOINT, credential);
      console.log("[MAIL] ✅ ACS EmailClient initialized with Managed Identity");
    }
  }
  // ✅ PRIORITY 4: Fallback to DB credentials (LAST RESORT)
  else if (process.env.DB_TENANT_ID && process.env.DB_CLIENT_ID && process.env.DB_CLIENT_SECRET) {
    const credential = new ClientSecretCredential(
      process.env.DB_TENANT_ID,
      process.env.DB_CLIENT_ID,
      process.env.DB_CLIENT_SECRET
    );

    if (ACS_ENDPOINT) {
      emailClient = new EmailClient(ACS_ENDPOINT, credential);
      console.log("[MAIL] ⚠️ ACS EmailClient initialized with DB credentials - LIKELY TO FAIL");
      console.log("[MAIL] ⚠️ Add ACS_CONNECTION_STRING to .env for reliable email delivery");
    }
  }
  else {
    console.warn("[MAIL] ❌ No valid credentials found - emails disabled");
  }

  if (!ACS_ENDPOINT && !process.env.ACS_CONNECTION_STRING) {
    console.warn("[MAIL] ACS_ENDPOINT or ACS_CONNECTION_STRING missing – emails skipped");
  }
} catch (e) {
  console.warn("[MAIL] ❌ ACS Email init failed – emails skipped", e?.message || e);
}

async function sendNewLoginEmail({ to, name, email, password }) {
  if (!emailClient) {
    console.warn("[MAIL] EmailClient unavailable – skip email to", to);
    return;
  }

  const subject = "Your XR Platform login details";

  const text = [
    `Hi ${name || "User"},`,
    "",
    "Your XR Platform login has been created.",
    "",
    "Login URL: http://localhost:8080/platform",
    `Email: ${email}`,
    `Password: ${password}`,
    "",
    "Please sign in and change your password after first login.",
    "",
    "Thanks,",
    "XR Platform",
  ].join("\n");

  const html = `
    <p>Hi ${name || "User"},</p>
    <p>Your <strong>XR Platform</strong> login has been created.</p>
    <p>
      <strong>Login URL:</strong>
      <a href="http://localhost:8080/platform">http://localhost:8080/platform</a><br/>
      <strong>Email:</strong> ${email}<br/>
      <strong>Password:</strong> ${password}
    </p>
    <p>Please sign in and change your password after first login.</p>
    <p>Thanks,<br/>XR Platform</p>
  `;

  try {
    const message = {
      senderAddress: EMAIL_FROM,
      recipients: {
        to: [{ address: to }],
      },
      content: {
        subject,
        plainText: text,
        html,
      },
      replyTo: [{ address: EMAIL_REPLY_TO, displayName: SENDER_NAME }],
    };

    console.log("[MAIL] ACS_ENDPOINT:", ACS_ENDPOINT || "Using connection string");
    console.log("[MAIL] senderAddress:", EMAIL_FROM);
    console.log("[MAIL] replyTo:", EMAIL_REPLY_TO);

    const poller = await emailClient.beginSend(message);
    await poller.pollUntilDone();

    console.log("[MAIL] ✅ Login details sent to", to);
  } catch (err) {
    console.error("[MAIL] ❌ Failed to send login email to", to);
    console.error("[MAIL] name:", err?.name);
    console.error("[MAIL] message:", err?.message);
    console.error("[MAIL] status:", err?.statusCode || err?.status);
    console.error("[MAIL] code:", err?.code);
    console.error("[MAIL] details:", err?.details);
    // Don't log full error to keep console clean
  }
}


// -------------------- Create Login User (System_Users) --------------------
app.post('/api/auth/create-user', requireSuperAdmin, async (req, res) => {
  try {
    const { name, email, password, reportingManager } = req.body || {};
    // Optional screen rights for this auth-created user (not used by default)
    const rights = Array.isArray(req.body?.rights) ? req.body.rights : [];


    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: 'Name, email, and password are required' });
    }

    // 1) Check if a System_Users row already exists for this email
    const existing = await sequelize.query(
      `
      SELECT id
      FROM [dbo].[System_Users]
      WHERE email = :email
        AND row_status = 1
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (existing && existing.length > 0) {
      return res
        .status(400)
        .json({ ok: false, message: 'A user with this email already exists' });
    }

    // 2) Look up basic role + status IDs.
    // For now, treat login-created users as Employee / IT / Member / Active.
    // For now, treat login-created users as Employee / IT / Employee / Active.
    // 2) Look up basic role + status IDs.
    // For now, treat login-created users as Employee / IT / Employee / Active.
    const personaRow = await sequelize.query(
      `SELECT id FROM [dbo].[Personas] WHERE persona = 'Employee' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const deptRow = await sequelize.query(
      `SELECT id FROM [dbo].[Departments] WHERE department = 'IT' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const typeRow = await sequelize.query(
      `SELECT id FROM [dbo].[Types] WHERE type = 'Employee' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const statusRow = await sequelize.query(
      `SELECT id FROM [dbo].[Status] WHERE status = 'Active' AND row_status = 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );


    if (!personaRow.length || !deptRow.length || !typeRow.length || !statusRow.length) {
      return res
        .status(500)
        .json({ ok: false, message: 'Master data (Personas/Departments/Types/Status) missing' });
    }

    const personaId = personaRow[0].id;
    const departmentId = deptRow[0].id;
    const typeId = typeRow[0].id;
    const statusId = statusRow[0].id;

    const createdById = (req.session.user && req.session.user.id) || null;

    // For now, we don’t resolve reportingManager → System_Users.id yet
    const managerUserId = null;

    // 3) Wrap inserts in a transaction
    const transaction = await sequelize.transaction();

    try {
      // 3a) Insert into User_Role_Mapping
      const [roleRows] = await sequelize.query(
        `
        INSERT INTO [dbo].[User_Role_Mapping] (
          persona_id,
          department_id,
          type_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :personaId,
          :departmentId,
          :typeId,
          SYSDATETIME(),
          :createdBy,
          SYSDATETIME(),
          :createdBy,
          1
        );
        SELECT SCOPE_IDENTITY() AS id;
        `,
        {
          replacements: { personaId, departmentId, typeId, createdBy: createdById },
          type: Sequelize.QueryTypes.SELECT,
          transaction,
        }
      );

      const userRoleMappingId = roleRows[0].id;

      // 3b) Insert into System_Users
      await sequelize.query(
        `
        INSERT INTO [dbo].[System_Users] (
          full_name,
          email,
          password,
          manager_user_id,
          clinic_id,
          xr_id,
          status_id,
          user_role_mapping_id,
          created_date,
          created_by,
          modified_date,
          modified_by,
          row_status
        )
        VALUES (
          :full_name,
          :email,
          :password,
          :manager_user_id,
          NULL,
          NULL,
          :status_id,
          :user_role_mapping_id,
          SYSDATETIME(),
          :created_by,
          SYSDATETIME(),
          :created_by,
          1
        )
        `,
        {
          replacements: {
            full_name: name,
            email,
            password,          // plain for now, same as before
            manager_user_id: managerUserId,
            status_id: statusId,
            user_role_mapping_id: userRoleMappingId,
            created_by: createdById,
          },
          type: Sequelize.QueryTypes.INSERT,
          transaction,
        }
      );

      // 3c) Insert screen rights into Access_Rights (if any screens were selected)
      if (rights && rights.length > 0) {
        for (const rawId of rights) {
          const screenId = Number(rawId);
          if (!Number.isFinite(screenId)) continue; // skip bad values

          await sequelize.query(
            `
            INSERT INTO [dbo].[Access_Rights] (
              user_role_mapping_id,
              system_screen_id,
              [read],
              [write],
              [edit],
              [delete],
              created_date,
              created_by,
              modified_date,
              modified_by,
              row_status
            )
            VALUES (
              :user_role_mapping_id,
              :system_screen_id,
              1,  -- read allowed
              0,  -- write
              0,  -- edit
              0,  -- delete
              SYSDATETIME(),
              :created_by,
              SYSDATETIME(),
              :created_by,
              1
            )
            `,
            {
              replacements: {
                user_role_mapping_id: userRoleMappingId,
                system_screen_id: screenId,
                created_by: createdById,
              },
              type: Sequelize.QueryTypes.INSERT,
              transaction,
            }
          );
        }
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }



    console.log('[AUTH/System_Users] Login user created via /api/auth/create-user:', {
      name,
      email,
    });

    // 4) Send welcome email (same helper)
    try {
      await sendNewLoginEmail({
        to: email,
        name,
        email,
        password,
      });
    } catch (mailErr) {
      console.error('[AUTH/System_Users] Failed to send welcome email:', mailErr.message || mailErr);
      // do not fail request because of email
    }

    return res.json({
      ok: true,
      message: 'Login user created in System_Users and email sent',
    });
  } catch (err) {
    console.error('[AUTH/System_Users] Create login user error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// -------------------- Simple DB Login (auth_users) --------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1) Basic validation
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: 'Email and password are required' });
    }

    // 2) Look up user in auth_users by email
    const users = await sequelize.query(
      `
      SELECT id, name, email, password_hash, reporting_manager
      FROM [dbo].[auth_users]
      WHERE email = :email
      `,
      {
        replacements: { email },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!users || users.length === 0) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid email or password' });
    }

    const user = users[0];

    // 3) For now: plain password compare (later we'll use bcrypt)
    if (user.password_hash !== password) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid email or password' });
    }

    // 4) Success – return user info (no session/JWT yet)
    return res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        reporting_manager: user.reporting_manager,
      },
    });
  } catch (err) {
    console.error('[AUTH] /api/auth/login error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Internal server error' });
  }
});



// ---- Desktop HTTP telemetry (beginner path) ----
app.post('/desktop-telemetry', (req, res) => {
  try {
    const d = req.body || {};
    const xrId = typeof d.xrId === 'string' ? d.xrId : null;
    if (!xrId) return res.status(400).json({ error: 'xrId required' });

    const rec = {
      xrId,
      connType: d.connType || 'other',
      // network (optional)
      wifiDbm: numOrNull(d.wifiDbm),
      wifiMbps: numOrNull(d.wifiMbps),
      wifiBars: numOrNull(d.wifiBars),
      cellDbm: numOrNull(d.cellDbm),
      cellBars: numOrNull(d.cellBars),
      netDownMbps: numOrNull(d.netDownMbps),
      netUpMbps: numOrNull(d.netUpMbps),
      // system
      cpuPct: numOrNull(d.cpuPct),
      memUsedMb: numOrNull(d.memUsedMb),
      memTotalMb: numOrNull(d.memTotalMb),
      deviceTempC: numOrNull(d.deviceTempC),
      ts: Date.now(),
    };

    // latest snapshot for device rows
    telemetryByDevice.set(xrId, rec);

    // history (drives charts/detail modal)
    pushHist(telemetryHist, xrId, {
      ts: rec.ts,
      connType: rec.connType,
      wifiMbps: rec.wifiMbps,
      netDownMbps: rec.netDownMbps,
      netUpMbps: rec.netUpMbps,
      batteryPct: batteryByDevice.get(xrId)?.pct ?? null,
      cpuPct: rec.cpuPct,
      memUsedMb: rec.memUsedMb,
      memTotalMb: rec.memTotalMb,
      deviceTempC: rec.deviceTempC,
    });

    // Option B: do not broadcast telemetry globally in prod.
    // Desktop HTTP telemetry is not tied to a socket room, so in prod we only emit to dev global.
    // (If you later include roomId in the POST body, we can route it to that room.)
    if (!IS_PROD) {
      io.emit('telemetry_update', rec); // dev only
    }


    dlog('[desktop-telemetry] update', rec);
    res.status(204).end();
  } catch (e) {
    dwarn('[desktop-telemetry] bad payload:', e?.message || e);
    res.status(400).json({ error: 'bad payload' });
  }
});




// ---- Medication sanitizer: keep only "pure" medication (name ± strength) ----
function normalizeMedicationList(raw) {
  // Accept string or array; split strings into items
  let items = Array.isArray(raw) ? raw.slice() :
    typeof raw === 'string' ? raw.split(/[\n;,]+/) : [];

  return items
    .map(s => (s ?? '').toString())
    // strip bullets/numbering
    .map(s => s.replace(/^\s*[-•\u2022\u25CF]*\s*\d*[.)]?\s*/g, '').trim())
    // keep only the leading "drug name [strength unit]" and drop trailing sentences
    .map(s => {
      // Try to capture: Name (letters, numbers, spaces, -, /) + optional strength (e.g., 500 mg)
      const m = s.match(/^([A-Za-z][A-Za-z0-9\s\-\/]+?(?:\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|kg|ml|mL|l|L|iu|IU|units|mcL|µg|%))?)/);
      if (m) return m[1].trim();

      // Fallback: cut at the first sentence break, but keep decimals like "2.5 mg"
      const cut = s.split(/(?<!\d)\.(?!\d)/)[0]; // split on period not between digits
      return cut.trim();
    })
    // remove common instruction tails if any slipped through
    .map(s => s.replace(/\b(take|give|use|apply|instill|one|two|daily|once|twice|bid|tid|qid|po|prn|before|after|with|without|meals?|for|x|weeks?|days?|hours?)\b.*$/i, '').trim())
    // collapse extra spaces
    .map(s => s.replace(/\s{2,}/g, ' ').trim())
    // drop empties
    .filter(s => s.length > 0);
}

// -------------------- SOAP Note Generator --------------------
async function generateSoapNote(transcript, templateId = null) {
  const SOAP_TEMPLATE_ID = Number(process.env.SOAP_NOTE_TEMPLATE_ID || 20);
  const ABACUS_API_KEY = process.env.ABACUS_API_KEY;

  const text = String(transcript || "").trim();
  if (!text) return { Error: ["Empty transcript"] };
  if (!ABACUS_API_KEY) return { Error: ["Missing ABACUS_API_KEY"] };

  const model = String(process.env.ABACUS_MODEL || "").trim();
  if (!model) return { Error: ["Missing ABACUS_MODEL"] };

  const tplId = (() => {
    if (templateId === null || templateId === undefined || templateId === "default") {
      return SOAP_TEMPLATE_ID;
    }
    const n = Number(templateId);
    return Number.isFinite(n) && n > 0 ? n : SOAP_TEMPLATE_ID;
  })();

  const extractErrMsg = (err) =>
    String(
      err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        (typeof err?.response?.data === "string" ? err.response.data : "") ||
        err?.message ||
        "Error generating note"
    );

  try {
    // 1) Template meta
    const templateRows = await sequelize.query(
      `
      SELECT TOP 1 id, template AS name, short_name
      FROM [dbo].[Templates]
      WHERE id = :templateId AND row_status = 1;
      `,
      { replacements: { templateId: tplId }, type: Sequelize.QueryTypes.SELECT }
    );

    if (!templateRows?.length) {
      return { Error: [`Template ${tplId} not found or inactive (row_status != 1).`] };
    }

    // 2) Components (retry if view doesn't have v.row_status)
    let components = [];
    try {
      components = await sequelize.query(
        `
        SELECT v.mapping_id, v.component AS name, v.position
        FROM [dbo].[View_Template_Component_Mapping] v
        WHERE v.template_id = :templateId
          AND v.row_status = 1
        ORDER BY v.position ASC;
        `,
        { replacements: { templateId: tplId }, type: Sequelize.QueryTypes.SELECT }
      );
    } catch (e) {
      const msg = String(e?.message || "");
      const rowStatusMissing = /invalid column/i.test(msg) && /row_status/i.test(msg);
      if (!rowStatusMissing) throw e;

      components = await sequelize.query(
        `
        SELECT v.mapping_id, v.component AS name, v.position
        FROM [dbo].[View_Template_Component_Mapping] v
        WHERE v.template_id = :templateId
        ORDER BY v.position ASC;
        `,
        { replacements: { templateId: tplId }, type: Sequelize.QueryTypes.SELECT }
      );
    }

    if (!components?.length) {
      return { Error: [`Template ${tplId} has no active components/mappings.`] };
    }

    // 3) Normalize component rows -> sections
    const seen = new Set();
    const orderedComponentRows = components
      .map((r) => ({
        mapping_id: Number(r.mapping_id),
        name: String(r.name || "").trim(),
        position: Number(r.position ?? 0),
      }))
      .filter((r) => Number.isFinite(r.mapping_id) && r.mapping_id > 0 && r.name)
      .filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true)));

    if (!orderedComponentRows.length) {
      return { Error: [`Template ${tplId} components are invalid (missing mapping_id/name).`] };
    }

    const sections = orderedComponentRows.map((r) => r.name);

    const sectionToMappingId = {};
    for (const r of orderedComponentRows) sectionToMappingId[r.name] = r.mapping_id;

    const templateMeta = {
      templateId: templateRows[0].id,
      templateName: templateRows[0].name,
      short_name: templateRows[0].short_name || null,
      components: orderedComponentRows.map((r) => ({
        mapping_id: r.mapping_id,
        template_component_mapping_id: r.mapping_id,
        name: r.name,
        position: r.position,
      })),
    };

    // 4) Prompt
    const sectionListText = sections.map((s) => `- ${s}`).join("\n");
    const prompt = `
                    You are a clinical documentation assistant.

                     CRITICAL RULES:
                     - Use ONLY information explicitly present in the transcript.
                     - If not stated, write exactly: "Not mentioned in transcript"
                     - Preserve negations/uncertainty exactly.
                     - Do not invent vitals, exam, diagnoses, meds, allergies, labs/imaging, or timelines.
                     - If contradictory, include both and mark: "Conflicting in transcript"

                    OUTPUT (strict):
                    - Return ONLY valid JSON.
                    - Keys MUST exactly match the section names below (same spelling/casing).
                    - Each value MUST be an array of strings OR the exact string "Not mentioned in transcript".

                    SECTION NAMES (in order):
                    ${sectionListText}

                   TRANSCRIPT (raw):
                  ${text}
                `.trim();

    // 5) RouteLLM call (model comes ONLY from env)
    const temperature = Number(process.env.ABACUS_TEMPERATURE || 0.1);

    const response = await axios.post(
      "https://routellm.abacus.ai/v1/chat/completions",
      {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        stream: false,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${ABACUS_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    // 6) Parse JSON
    let raw = response?.data?.choices?.[0]?.message?.content ?? "{}";
    if (typeof raw !== "string") raw = JSON.stringify(raw);

    raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const first = raw.indexOf("{");
      const last = raw.lastIndexOf("}");
      if (first !== -1 && last !== -1) parsed = JSON.parse(raw.slice(first, last + 1));
      else throw new Error("Model did not return valid JSON");
    }

    // 7) Normalize output + attach meta for EHR insert
    const note = {};
    for (const s of sections) {
      const v = parsed?.[s];

      if (Array.isArray(v)) {
        const arr = v.map((x) => String(x || "").trim()).filter(Boolean);
        note[s] = arr.length ? arr : "Not mentioned in transcript";
      } else if (typeof v === "string") {
        const t = v.trim();
        note[s] = !t
          ? "Not mentioned in transcript"
          : t === "Not mentioned in transcript"
            ? "Not mentioned in transcript"
            : [t];
      } else {
        note[s] = "Not mentioned in transcript";
      }
    }

    note._templateMeta = templateMeta;
    note._templateComponentMappingIds = sectionToMappingId;

    note._rowsForPatientNoteInsert = sections.map((sectionName, idx) => {
      const mappingId = sectionToMappingId[sectionName] ?? null;
      const value = note[sectionName];
      const textValue = Array.isArray(value)
        ? value.join("\n")
        : String(value || "Not mentioned in transcript");

      return {
        template_component_mapping_id: mappingId,
        component: sectionName,
        position: idx + 1,
        text: textValue,
      };
    });

    return note;
  } catch (err) {
    console.error("[SOAP_NOTE] generation failed:", extractErrMsg(err));
    if (err?.response) {
      console.error("[SOAP_NOTE] RouteLLM status:", err.response.status);
      console.error("[SOAP_NOTE] RouteLLM data:", err.response.data);
    }
    return { Error: [extractErrMsg(err)] };
  }
}

// Parse Medication from SOAP note, check dbo.DrugMaster.drug, and log availability
async function checkSoapMedicationAvailability(soapNote, opts = {}) {
  const schema = opts.schema || 'dbo';
  const table = opts.table || 'DrugMaster';
  const nameCol = opts.nameCol || 'drug';

  // Normalize a term in JS exactly the same way we normalize in SQL
  function normalizeTerm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[ \-\/\.,'()]/g, ''); // remove spaces and punctuation
  }

  function extractDrugQuery(raw) {
    if (!raw) return null;
    let s = String(raw)
      .replace(/^[-•]\s*/u, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|susp(?:ension)?|inj(?:ection)?)\b/gi, '')
      .replace(/\b(po|od|bd|tid|qid|prn|q\d+h|iv|im|sc|sl)\b/gi, '')
      .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|kg|ml|l|iu|units|%)\b/gi, '')
      .split(/\b\d/)[0]
      .replace(/[.,;:/]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s || null;
  }

  // Updated: stronger, consistent matching with status=1 filter
  async function findDrugMatch(q) {
    const raw = String(q || '').trim();
    const rawLike = `%${raw}%`;
    const norm = normalizeTerm(raw);
    const normLike = `%${norm}%`;

    // SQL-side normalization expression (mirrors normalizeTerm)
    const normExpr = `
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(LOWER([${nameCol}]), '-', ''), ',', ''), '/', ''), '.', ''), '''', ''), ' ', ''), '(', ''), ')', '')
    `;

    const sql = `
      SELECT TOP 1 [${nameCol}] AS name
      FROM [${schema}].[${table}]
      WHERE status = 1
        AND [${nameCol}] IS NOT NULL
        AND (
          -- Exact (raw)
          LOWER([${nameCol}]) = LOWER(:raw)
          -- Contains (raw)
          OR LOWER([${nameCol}]) LIKE LOWER(:rawLike)
          -- Exact (normalized)
          OR ${normExpr} = :norm
          -- Contains (normalized)
          OR ${normExpr} LIKE :normLike
        )
      ORDER BY
        CASE
          WHEN ${normExpr} = :norm THEN 1
          WHEN LOWER([${nameCol}]) = LOWER(:raw) THEN 2
          WHEN ${normExpr} LIKE :normLike THEN 3
          ELSE 4
        END,
        [${nameCol}];
    `;

    const rows = await sequelize.query(sql, {
      replacements: { raw, rawLike, norm, normLike },
      type: Sequelize.QueryTypes.SELECT
    });
    return rows?.[0]?.name || null;
  }

  const meds = Array.isArray(soapNote?.Medication) ? soapNote.Medication : [];
  const queries = Array.from(new Set(
    meds
      .map(m => typeof m === 'string' ? m : (m?.name || m?.drug || m?.Medication || ''))
      .map(extractDrugQuery)
      .filter(Boolean)
  ));

  if (queries.length === 0) {
    console.log('[DRUG_CHECK] No medication entries to check.');
    return { results: [] };
  }

  const results = [];
  console.log(`[DRUG_CHECK] Checking ${queries.length} medication name(s) against ${schema}.${table}.${nameCol} ...`);
  for (const q of queries) {
    try {
      const matched = await findDrugMatch(q);
      if (matched) {
        console.log(`[DRUG_CHECK] "${q}" => AVAILABLE (matched as "${matched}")`);
        results.push({ query: q, status: 'exists', matched });
      } else {
        console.log(`[DRUG_CHECK] "${q}" => NOT FOUND`);
        results.push({ query: q, status: 'not_found', matched: null });
      }
    } catch (e) {
      console.log(`[DRUG_CHECK] "${q}" => ERROR: ${e.message || e}`);
      results.push({ query: q, status: 'error', error: String(e) });
    }
  }

  const ok = results.filter(r => r.status === 'exists').length;
  const nf = results.filter(r => r.status === 'not_found').length;
  console.log(`[DRUG_CHECK] Summary: ${ok} found, ${nf} not found, ${results.length - ok - nf} errors.`);
  return { results };
}

// -------------------- XR Owner Lock Helpers --------------------
async function releaseOwnerLockIfOwned(xrId, socketId) {
  try {
    if (!IS_PROD || !xrRedis) return;

    const XR = normXr(xrId);
    if (!XR || !socketId) return;

    const key = `xr:owner:${XR}`;
    const currentOwner = await xrRedis.get(key);

    if (currentOwner === socketId) {
      await xrRedis.del(key);
      dlog('[OWNER_LOCK] released', { xrId: XR });
    }
  } catch (e) {
    dwarn('[OWNER_LOCK] release failed', e?.message || e);
  }
}


// -------------------- Socket.IO Handlers --------------------
io.on('connection', (socket) => {
  console.log(`🔌 [CONNECTION] ${socket.id}`);
  dlog('[CONNECTION] handshake.query:', safeDataPreview(socket.handshake?.query));



  // after sending message_history (or right at the top of the connection handler)
  (async () => {
    try {
      // ✅ Option B strict: do NOT send global device list before pairing.
      // Client will request room-scoped list after room_joined.
      // socket.emit('device_list', []);

      // send current active pair snapshot
      socket.emit('room_update', { pairs: collectPairs() });
    } catch (e) {
      dwarn('[connection] initial snapshots failed:', e?.message || e);
    }
  })();

  // -------- join (legacy) --------
  // ✅ Option B strict: keep join for backward compatibility, but NEVER leak global device lists.
  // ✅ Behavior:
  //   - Register xrId on this socket
  //   - Attempt DB auto-pair immediately
  //   - If paired → broadcast room-only device list
  //   - If not paired → emit self-only device list
  socket.on('join', async (xrId) => {

    // ✅ Hard block cockpit from legacy join (prevents xrId collisions)
    if (socket.data?.clientType === 'cockpit' || socket.data?.cockpitForXrId) {
      dwarn('[COCKPIT] attempted legacy join - ignored', {
        socketId: socket.id,
        xrId
      });
      return;
    }

    const XR = normXr(xrId);
    dlog('[EVENT] join', XR);
    if (!XR) return;

    socket.data.xrId = XR;

    // ❌ IMPORTANT (Option B): do NOT join per-xr legacy rooms.
    // socket.join(roomOf(XR));

    clients.set(XR, socket);
    onlineDevices.set(XR, socket);

    try {
      await tryDbAutoPair(XR);

      const roomId = socket.data?.roomId;
      if (roomId) {
        await broadcastDeviceList(roomId);   // ✅ room-only list
        return;
      }

      // ✅ not paired yet → self-only list
      const b = batteryByDevice?.get(XR) || {};
      const t = telemetryByDevice?.get(XR) || null;

      socket.emit('device_list', [{
        xrId: XR,
        deviceName: socket.data?.deviceName || 'Unknown',
        battery: (typeof b.pct === 'number') ? b.pct : null,
        charging: !!b.charging,
        batteryTs: b.ts || null,
        ...(t ? { telemetry: t } : {}),
      }]);
    } catch (e) {
      derr('[join] err:', e.message);

      // Option B safety: never wipe device list to [] (causes UI drift).
      // Fallback to self-only so the UI stays stable.
      try {
        const b = batteryByDevice?.get(XR) || {};
        const t = telemetryByDevice?.get(XR) || null;
        socket.emit('device_list', [{
          xrId: XR,
          deviceName: socket.data?.deviceName || 'Unknown',
          battery: (typeof b.pct === 'number') ? b.pct : null,
          charging: !!b.charging,
          batteryTs: b.ts || null,
          ...(t ? { telemetry: t } : {}),
        }]);
      } catch { }
    }

  });




  // -------- identify --------
  socket.on('identify', async ({ deviceName, xrId, clientType }) => {
    dlog('[EVENT] identify', { deviceName, xrId, clientType });

    // ✅ NEW: XR Hub Dashboard (view-only)
    if (clientType === 'dashboard') {
      socket.data.clientType = 'dashboard';
      socket.data.deviceName = deviceName || 'XR Hub Dashboard';
      socket.data.connectedAt = Date.now();

      // Do NOT set socket.data.xrId
      // Do NOT touch owner locks
      // Do NOT add to clients/onlineDevices
      socket.emit('dashboard_ready', { ok: true });
      dlog('[DASHBOARD][IDENTIFY] viewer socket ready', { socketId: socket.id });

      return; // IMPORTANT: prevent running XR-device logic
    }

    // Validate
    if (!xrId || typeof xrId !== 'string') {
      dwarn('[IDENTIFY] missing/invalid xrId');
      socket.emit('error', { message: 'Missing xrId' });
      return socket.disconnect(true);
    }

    // ✅ normalize once (Option B)
    const XR = normXr(xrId);

    // -------------------- Cockpit / XR Dock (view-only) --------------------
    // If this socket is the Scribe Cockpit, it should NOT be treated as a real XR device.
    // It should only "subscribe" to the same pair room as the real XR Dock XR socket.
    // It should only "subscribe" to the same pair room as the real XR Dock XR socket.
    if (clientType === 'cockpit') {
      socket.data.clientType = 'cockpit';
      socket.data.deviceName = deviceName || 'XR Dock (Scribe Cockpit)';

      // ✅ cockpit watches this XR (target)
      socket.data.cockpitForXrId = XR;
      dlog('[COCKPIT][IDENTIFY] viewer socket', { socketId: socket.id, cockpitForXrId: XR });

      socket.data.connectedAt = Date.now();

      // Try to find the primary XR socket for this XR id (cluster-safe)
      const primary = await getClientSocketByXrIdCI_Cluster(XR, socket);
      // ✅ Fallback: if cluster lookup misses (timing/adapter), use local map as backup
      const primaryLocal = clients?.get?.(XR) || null;
      const primaryFinal = primary || primaryLocal;

      const roomId = primaryFinal?.data?.roomId || null;
      dlog('[COCKPIT][IDENTIFY] primary+room', {
        cockpitForXrId: XR,
        primarySocketId: primaryFinal?.id || null,
        roomId
      });

      // ✅ CASE 1: Primary is paired → join same pair room and mirror room device_list
      if (roomId) {
        try {
          await socket.join(roomId);
          socket.data.roomId = roomId;

          socket.emit('room_joined', { roomId });

          try {
            const list = await buildDeviceListForRoom(roomId);
            socket.emit('device_list', Array.isArray(list) ? list : []);
          } catch (e) {
            socket.emit('device_list', []);
          }

          dlog('[COCKPIT] joined room', { xrId: XR, roomId, socketId: socket.id });
        } catch (e) {
          dwarn('[COCKPIT] failed to join room', { xrId: XR, roomId, err: e?.message || e });

          socket.data.roomId = null;
          socket.emit('room_joined', { roomId: null, reason: 'cockpit_join_failed' });
          socket.emit('device_list', []);
          dlog('[COCKPIT][IDENTIFY] join failed → sent room_joined(null)+empty list', {
            socketId: socket.id, cockpitForXrId: XR, roomId
          });
        }

        return; // IMPORTANT
      }

      // ✅ CASE 2: Primary exists but not paired yet → SHOW SINGLE DEVICE (self-only)
      if (primaryFinal) {

        socket.data.roomId = null;
        socket.emit('room_joined', { roomId: null, reason: 'target_not_paired_yet' });

        try {
          const b = batteryByDevice?.get(XR) || {};
          const t = telemetryByDevice?.get(XR) || null;

          socket.emit('device_list', [{
            xrId: XR,
            deviceName: primaryFinal.data?.deviceName || 'Unknown',
            battery: (typeof b.pct === 'number') ? b.pct : null,
            charging: !!b.charging,
            batteryTs: b.ts || null,
            ...(t ? { telemetry: t } : {}),
          }]);

          dlog('[COCKPIT][IDENTIFY] primary online but not paired → sent self-only device_list', {
            socketId: socket.id, cockpitForXrId: XR
          });
        } catch (e) {
          socket.emit('device_list', []);
          dwarn('[COCKPIT][IDENTIFY] self-only list failed', { err: e?.message || e });
        }

        return; // IMPORTANT
      }

      // ✅ CASE 3: Primary not online yet → empty list (no devices)
      socket.data.roomId = null;
      socket.emit('room_joined', { roomId: null, reason: 'primary_not_online_yet' });
      socket.emit('device_list', []);
      dlog('[COCKPIT] primary not online yet → empty list', { xrId: XR, socketId: socket.id });

      return; // IMPORTANT
    }



    // 🔒 Duplicate xrId handling (NEWEST WINS): if an old socket exists, kick it and accept this one.
    try {
      const all = await safeFetchSockets(io, "/");
      const holder = all.find(s =>
        s.id !== socket.id &&
        typeof s.data?.xrId === 'string' &&
        normXr(s.data.xrId) === XR &&
        s.data?.clientType !== 'cockpit'   // ✅ do not treat cockpit as duplicate holder
      );


      if (holder) {
        const holderInfo = {
          xrId: XR,
          deviceName: holder.data?.deviceName || 'Unknown',
          since: holder.data?.connectedAt || null,
          socketId: holder.id,
        };
        dlog('[IDENTIFY] Duplicate xrId detected — disconnecting old socket, keeping new:', holderInfo);
        // ✅ Capture partner BEFORE clearing pairing so we can clear partner socket roomId too
        const oldPartner = pairedWith.get(XR) || null;


        // Clear stale pairing state for this XR (and its partner) so re-pair works cleanly
        clearPairByXrId(XR);
        // ✅ Also clear partner socket roomId (prevents stale "I'm still paired" state)
        if (oldPartner) {
          const pSock = await getClientSocketByXrIdCI_Cluster(oldPartner);
          if (pSock) {
            try { pSock.data.roomId = null; } catch { }
            dlog('[IDENTIFY] cleared partner roomId (cluster)', { xrId: XR, oldPartner, partnerSocketId: pSock.id });
          } else {
            dlog('[IDENTIFY] partner socket not found (cluster) to clear roomId', { xrId: XR, oldPartner });
          }
        }



        // Best-effort: disconnect the old socket
        try {
          try { holder.data.roomId = null; } catch { }
          holder.emit('replaced_by_new_session', { xrId: XR });
        } catch { }
        try {
          holder.disconnect(true);
        } catch (e) {
          dwarn('[IDENTIFY] failed to disconnect old holder:', e?.message || e);
        }
      }
    } catch (e) {
      dwarn('[IDENTIFY] fetchSockets failed; continuing cautiously:', e?.message || e);
    }


    // ✅ Accept this socket
    socket.data.deviceName = deviceName || 'Unknown';
    socket.data.xrId = XR;

    // ✅ Option B: Redis owner lock (authoritative online/offline)
    try {
      if (IS_PROD && xrRedis) {
        await xrRedis.set(`xr:owner:${XR}`, socket.id);
        dlog('[OWNER_LOCK] set', { xrId: XR, socketId: socket.id });
      }
    } catch (e) {
      dwarn('[OWNER_LOCK] set failed (continuing):', e?.message || e);
    }

    socket.data.connectedAt = Date.now();

    // try { await socket.join(roomOf(XR)); }
    // catch (e) { dwarn('[IDENTIFY] join room failed:', e?.message || e); }

    clients.set(XR, socket);
    onlineDevices.set(XR, socket);

    // Track desktop for convenience
    if (deviceName?.toLowerCase().includes('desktop')) {

      desktopClients.set(XR, socket);
      dlog('[IDENTIFY] desktop client tracked', XR);
    }

    // Send ONLY self until DB pairing completes (prevents global device leak)
    try {
      const b = batteryByDevice?.get(XR) || {};
      const t = telemetryByDevice?.get(XR) || null;

      socket.emit('device_list', [{
        xrId: XR,
        deviceName: socket.data?.deviceName || 'Unknown',
        battery: (typeof b.pct === 'number') ? b.pct : null,
        charging: !!b.charging,
        batteryTs: b.ts || null,
        ...(t ? { telemetry: t } : {}),
      }]);
    } catch (e) {
      derr('[identify] self device_list error:', e.message);
    }
    // ✅ NEW: push single-device list to any cockpit watching this XR (prod cold-start fix)
    try {
      const b = batteryByDevice?.get(XR) || {};
      const t = telemetryByDevice?.get(XR) || null;

      await notifyCockpitsWatchingXr(XR, [{
        xrId: XR,
        deviceName: socket.data?.deviceName || 'Unknown',
        battery: (typeof b.pct === 'number') ? b.pct : null,
        charging: !!b.charging,
        batteryTs: b.ts || null,
        ...(t ? { telemetry: t } : {}),
      }]);
    } catch (e) {
      // never break identify flow
      dwarn('[COCKPIT][WATCH_NOTIFY] failed (ignored)', { XR, err: e?.message || e });
    }




    try {
      if (!socket.data?.roomId) {
        dbgToSocket(socket, "[IDENTIFY] calling tryDbAutoPair", { XR, socketId: socket.id });
        await tryDbAutoPair(XR, socket); // ✅ pass socket so debug goes to browser
      } else {
        dbgToSocket(socket, "[IDENTIFY] skipping tryDbAutoPair; already in room", { roomId: socket.data.roomId });
        dlog('[IDENTIFY] Skipping tryDbAutoPair; already in room', socket.data.roomId);
      }

    } catch (e) {
      derr('[identify] tryDbAutoPair error:', e.message);
    }
  });

  // -------- metrics_subscribe / unsubscribe (NEW) --------
  socket.on('metrics_subscribe', ({ xrId }) => {
    if (!xrId) return;
    socket.join(`metrics:${xrId}`);
    socket.emit('metrics_snapshot', {
      xrId,
      telemetry: telemetryHist.get(xrId) || [],
      quality: qualityHist.get(xrId) || [],
    });
  });

  socket.on('metrics_unsubscribe', ({ xrId }) => {
    if (!xrId) return;
    socket.leave(`metrics:${xrId}`);
  });


  //------------changes made regarding dashabord ***----------------------------------------------------------------
  socket.on('dashboard_subscribe_pairs', async ({ roomIds } = {}) => {
    if (socket.data?.clientType !== 'dashboard') return;

    const safeRooms = (Array.isArray(roomIds) ? roomIds : [])
      .filter(r => typeof r === 'string')
      .filter(r => r.startsWith('pair:') && r.split(':').length === 3)
      .slice(0, 500);

    for (const roomId of safeRooms) {
      try { await socket.join(roomId); } catch { }
    }

    // send initial device_list per room so UI updates instantly
    for (const roomId of safeRooms) {
      try {
        const dl = await buildDeviceListForRoom(roomId);
        socket.emit('device_list', { roomId, devices: (Array.isArray(dl) ? dl : []) });
      } catch {
        socket.emit('device_list', { roomId, devices: [] });
      }
    }

    dlog('[DASHBOARD] subscribed rooms', { socketId: socket.id, count: safeRooms.length });
  });

  // -------- request_device_list --------
  socket.on('request_device_list', async () => {
    dlog('[EVENT] request_device_list');
    try {
      const roomId = socket.data?.roomId;

      // prevents spamming room_joined/device_list on every watchdog tick
      if (socket.data._lastRoomJoined === undefined) socket.data._lastRoomJoined = '__init__';
      if (socket.data._lastDeviceListSig === undefined) socket.data._lastDeviceListSig = '__init__';

      // ✅ Cockpit VIEW-ONLY
      if (socket.data?.clientType === 'cockpit' && !roomId) {
        const target = normXr(socket.data?.cockpitForXrId);
        dlog('[COCKPIT][REQ_LIST] no room yet, attempting join', { socketId: socket.id, target });

        if (target) {
          const primary = await getClientSocketByXrIdCI_Cluster(target, socket);
          const primaryLocal = clients?.get?.(target) || null;
          const primaryFinal = primary || primaryLocal;

          const targetRoom = primaryFinal?.data?.roomId || null;

          dlog('[COCKPIT][REQ_LIST] primary lookup (cluster+local)', {
            socketId: socket.id,
            target,
            primarySocketId: primaryFinal?.id || null,
            targetRoom,
            usedLocalFallback: !!(!primary && primaryLocal)
          });

          // ✅ CASE 1: target paired → join room
          if (targetRoom) {
            try {
              await socket.join(targetRoom);
              socket.data.roomId = targetRoom;

              // ✅ CHANGED: emit room_joined ONLY if changed
              if (socket.data._lastRoomJoined !== targetRoom) {
                socket.emit('room_joined', { roomId: targetRoom });
                socket.data._lastRoomJoined = targetRoom;
              }

              const list = await buildDeviceListForRoom(targetRoom);
              const safeList = Array.isArray(list) ? list : [];

              // ✅ CHANGED: emit device_list ONLY if changed
              const sig = JSON.stringify(safeList.map(d => [d?.xrId || '', d?.deviceName || '']));
              if (sig !== socket.data._lastDeviceListSig) {
                socket.emit('device_list', safeList);
                socket.data._lastDeviceListSig = sig;
              }

              dlog('[COCKPIT][REQ_LIST] joined + sent list', { socketId: socket.id, targetRoom });
              return;
            } catch (e) {
              dwarn('[COCKPIT][REQ_LIST] join failed', { err: e?.message || e, targetRoom });
            }
          }

          // ✅ CASE 2: target online but NOT paired → show single device
          if (primaryFinal) {
            socket.data.roomId = null;

            // ✅ CHANGED: DO NOT spam room_joined(null) every poll (this was causing flicker)
            if (socket.data._lastRoomJoined !== null) {
              socket.emit('room_joined', { roomId: null, reason: 'target_not_paired_yet' });
              socket.data._lastRoomJoined = null;
            }

            try {
              const b = batteryByDevice?.get(target) || {};
              const t = telemetryByDevice?.get(target) || null;

              const one = [{
                xrId: target,
                deviceName: primaryFinal.data?.deviceName || 'Unknown',
                battery: (typeof b.pct === 'number') ? b.pct : null,
                charging: !!b.charging,
                batteryTs: b.ts || null,
                ...(t ? { telemetry: t } : {}),
              }];

              // ✅ CHANGED: emit device_list ONLY if changed
              const sig = JSON.stringify(one.map(d => [d?.xrId || '', d?.deviceName || '']));
              if (sig !== socket.data._lastDeviceListSig) {
                socket.emit('device_list', one);
                socket.data._lastDeviceListSig = sig;
              }

              dlog('[COCKPIT][REQ_LIST] target online but not paired → sent self-only device_list', {
                socketId: socket.id, target
              });
            } catch (e) {
              const emptySig = '[]';
              if (emptySig !== socket.data._lastDeviceListSig) {
                socket.emit('device_list', []);
                socket.data._lastDeviceListSig = emptySig;
              }
              dwarn('[COCKPIT][REQ_LIST] self-only list failed', { err: e?.message || e });
            }
            return;
          }
        }

        // ✅ CASE 3: target offline → empty list
        // ✅ CHANGED: DO NOT spam room_joined(null) every poll
        if (socket.data._lastRoomJoined !== null) {
          socket.emit('room_joined', { roomId: null, reason: 'primary_not_online_yet' });
          socket.data._lastRoomJoined = null;
        }

        // ✅ CHANGED: emit empty device_list only if changed
        const emptySig = '[]';
        if (emptySig !== socket.data._lastDeviceListSig) {
          socket.emit('device_list', []);
          socket.data._lastDeviceListSig = emptySig;
        }

        dlog('[COCKPIT][REQ_LIST] target offline; sent empty list', { socketId: socket.id, target });
        return;
      }

      // ✅ If paired → ONLY devices in this room
      if (roomId) {
        const list = await buildDeviceListForRoom(roomId);
        const safeList = Array.isArray(list) ? list : [];

        const sig = JSON.stringify(safeList.map(d => [d?.xrId || '', d?.deviceName || '']));
        if (sig !== socket.data._lastDeviceListSig) {
          socket.emit('device_list', safeList);
          socket.data._lastDeviceListSig = sig;
        }
        return;
      }

      // ✅ Pair-aware fallback
      const xrIdTmp = normXr(socket.data?.xrId);
      const partnerTmp = xrIdTmp ? (pairedWith?.get?.(xrIdTmp) || null) : null;

      if (!roomId && xrIdTmp && partnerTmp) {
        const derivedRoom = getRoomIdForPair(xrIdTmp, partnerTmp);
        try {
          const list = await buildDeviceListForRoom(derivedRoom);
          const safeList = Array.isArray(list) ? list : [];

          const sig = JSON.stringify(safeList.map(d => [d?.xrId || '', d?.deviceName || '']));
          if (sig !== socket.data._lastDeviceListSig) {
            socket.emit('device_list', safeList);
            socket.data._lastDeviceListSig = sig;
          }
        } catch (e) {
          const emptySig = '[]';
          if (emptySig !== socket.data._lastDeviceListSig) {
            socket.emit('device_list', []);
            socket.data._lastDeviceListSig = emptySig;
          }
        }
        return;
      }

      // ✅ NOT paired yet → show only self device
      const xrId = normXr(socket.data?.xrId);
      if (!xrId) {
        const emptySig = '[]';
        if (emptySig !== socket.data._lastDeviceListSig) {
          socket.emit('device_list', []);
          socket.data._lastDeviceListSig = emptySig;
        }
        return;
      }

      const b = batteryByDevice?.get(xrId) || {};
      const t = telemetryByDevice?.get(xrId) || null;

      const one = [{
        xrId,
        deviceName: socket.data?.deviceName || 'Unknown',
        battery: (typeof b.pct === 'number') ? b.pct : null,
        charging: !!b.charging,
        batteryTs: b.ts || null,
        ...(t ? { telemetry: t } : {}),
      }];

      const sig = JSON.stringify(one.map(d => [d?.xrId || '', d?.deviceName || '']));
      if (sig !== socket.data._lastDeviceListSig) {
        socket.emit('device_list', one);
        socket.data._lastDeviceListSig = sig;
      }

    } catch (e) {
      dwarn('[request_device_list] failed:', e.message);
      try {
        const emptySig = '[]';
        if (socket.data?._lastDeviceListSig !== emptySig) {
          socket.emit('device_list', []);
          socket.data._lastDeviceListSig = emptySig;
        }
      } catch { }
    }
  });

  // -------- pair_with --------
  // Option B: DB-driven auto pairing is enabled.
  // Keep this handler for backward compatibility (frontend may still emit it),
  // but do NOT allow manual pairing to override DB mapping.
  socket.on('pair_with', async ({ peerId }) => {
    dlog('[EVENT] pair_with (disabled - auto pairing)', { me: socket.data?.xrId, peerId });

    // If the socket is not identified yet, keep the old error behavior.
    const me = socket.data?.xrId;
    if (!me) {
      socket.emit('pair_error', { message: 'Identify first (missing xrId)' });
      return;
    }

    // If already paired, just tell the client what room it is in.
    if (socket.data?.roomId) {
      socket.emit('pair_error', {
        message: 'Auto pairing enabled (already paired)',
        roomId: socket.data.roomId,
      });
      return;
    }

    // Try DB auto pairing as a convenience (safe fallback).
    // This does NOT use peerId; server decides partner from DB.
    try {
      const ok = await tryDbAutoPair(me);
      if (!ok) {
        socket.emit('pair_error', {
          message: 'Auto pairing enabled. Partner not available yet (or no active DB mapping).',
        });
      }
    } catch (err) {
      derr('[pair_with] auto pairing fallback error:', err?.message || err);
      socket.emit('pair_error', { message: 'Auto pairing enabled, but pairing attempt failed.' });
    }
  });


  // -------- signal --------
  socket.on('signal', (payload) => {
    // 1) Normalize payload (object or JSON string)
    let msg = payload;
    try { msg = (typeof payload === 'string') ? JSON.parse(payload) : (payload || {}); }
    catch (e) { return dwarn('[signal] JSON parse failed'); }

    const { type } = msg;
    dlog('📡 [EVENT] signal', { type, preview: safeDataPreview(msg) });

    try {
      // 2) Intercept Android/Dock quality feed and **return** (don’t fall through)
      if (type === 'webrtc_quality_update') {
        const deviceId = msg.deviceId;
        const samples = Array.isArray(msg.samples) ? msg.samples : [];

        if (deviceId && samples.length) {
          // Store to the existing per-device history so your detail modal works
          for (const s of samples) {
            pushHist(qualityHist, deviceId, {
              ts: s.ts,
              jitterMs: numOrNull(s.jitterMs),
              rttMs: numOrNull(s.rttMs),
              lossPct: numOrNull(s.lossPct),
              bitrateKbps: numOrNull(s.bitrateKbps),
            });
          }

          // Stream the latest deltas to any open detail modal subscribers
          io.to(`metrics:${deviceId}`).emit('metrics_update', {
            xrId: deviceId,
            quality: samples.map(s => ({
              ts: s.ts,
              jitterMs: s.jitterMs,
              rttMs: s.rttMs,
              lossPct: s.lossPct,
              bitrateKbps: s.bitrateKbps,
            })),
          });

          // Broadcast to dashboards (powers the connection tiles)
          // Option B: route quality updates only to the paired room (no global emit)
          const roomId = socket.data?.roomId;
          if (roomId) io.to(roomId).emit('webrtc_quality_update', { deviceId, samples });

        }
        return; // ✅ do not route as a regular signaling message
      }

      // 3) offer/answer/ICE path (Option B: strict pair-room only)

      // ✅ Always trust socket identity, never payload
      const from = socket.data?.xrId;
      if (!from) {
        dwarn('[signal] missing socket.data.xrId; ignoring');
        return;
      }

      const data = msg.data;

      // ✅ OPTIONAL but recommended: allowlist only WebRTC signaling types from clients
      const allowed = new Set(['offer', 'answer', 'ice-candidate', 'request_offer']);
      if (!allowed.has(type)) {
        dwarn('[signal] blocked non-webrtc client signal type:', type);
        return;
      }

      const roomId = socket.data?.roomId;
      if (!roomId) {
        dwarn('[signal] no roomId (not paired yet); ignoring');
        socket.emit('signal_error', { message: 'Not paired yet (no room)' });
        return;
      }

      dlog('[signal] pair-room forward', { roomId, type });
      // Forward ONLY within pair room
      socket.to(roomId).emit('signal', { type, from, data });



    } catch (err) {
      derr('[signal] handler error:', err.message);
    }
  });


  // -------- control --------
  socket.on('control', (raw) => {
    // Accept string or object payloads
    let p = raw;
    try {
      p = (typeof raw === 'string') ? JSON.parse(raw) : (raw || {});
    } catch {
      p = (raw || {});
    }

    // Accept both `command` and `action`; keep original casing for compatibility
    const cmdRaw = (p.command != null ? p.command : p.action) || '';
    const cmd = String(cmdRaw);
    const from = socket.data?.xrId;
    if (!from) {
      dwarn('[control] missing socket.data.xrId; ignoring');
      return;
    }

    const to = p.to;
    const msg = p.message;

    dlog('🎮 [EVENT] control', { command: cmd, from, to, message: trimStr(msg || '') });

    // Keep both keys so all clients see what they expect
    const payload = { command: cmd, action: cmd, from, to, message: msg };


    try {
      // Option B strict isolation:
      // Ignore "to" and NEVER broadcast control globally.
      // Control messages must stay inside the paired room only.
      const roomId = socket.data?.roomId;
      if (!roomId) {
        dwarn('[control] no roomId (not paired yet); ignoring', { command: cmd });
        socket.emit('control_error', { message: 'Not paired yet (no room)', command: cmd });
        return;
      }

      dlog('[control] pair-room emit', { roomId, ignoredTo: to || null });
      socket.to(roomId).emit('control', payload); // ✅ do not echo back to sender

    } catch (err) {
      derr('[control] handler error:', err.message);
    }
  });

  // -------- message (transcript -> web console via signal) --------
  socket.on('message', (payload) => {
    dlog('[EVENT] message', safeDataPreview(payload));

    let data;
    try {
      data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      return dwarn('[message] JSON parse failed:', e.message);
    }

    const type = data?.type || 'message';
    const from = socket.data?.xrId;
    if (!from) {
      dwarn('[message] missing socket.data.xrId; ignoring');
      return;
    }

    const to = data?.to;
    const text = data?.text;
    const urgent = !!data?.urgent;
    const timestamp = data?.timestamp || new Date().toISOString();
    // Option B strict isolation: all messaging must stay inside the paired room
    const pairRoomId = socket.data?.roomId || null;


    // ✳️ Intercept transcripts: forward to desktop's web console via a signal, then STOP
    if (type === 'transcript') {
      const out = {
        type: 'transcript',
        from,
        to: null,
        text,
        final: !!data?.final,
        timestamp,
      };

      try {
        // Forward transcript ONLY within pair room
        if (!pairRoomId) {
          dwarn('[transcript] no pairRoomId (not paired yet); ignoring');
          socket.emit('message_error', { message: 'Not paired yet (no room)' });
          return;
        }
        io.to(pairRoomId).emit('signal', { type: 'transcript_console', from, data: out });
        dlog('[transcript] emitted signal "transcript_console" to pair room', pairRoomId);
      } catch (e) {
        dwarn('[transcript] emit failed:', e.message);
      }

      return; // stop normal message path
    }



    /// Normal chat message path (Option B: pair-room only)

    try {
      const msg = {
        type: 'message',
        from,
        to: null,
        text,
        urgent,
        sender: socket.data?.deviceName || from || 'unknown',
        xrId: from,
        timestamp,
      };


      if (!pairRoomId) {
        dwarn('[message] no pairRoomId (not paired yet); ignoring');
        socket.emit('message_error', { message: 'Not paired yet (no room)' });
        return;
      }

      // ✅ store only after we know the pair room
      addToMessageHistory(socket, msg);

      dlog('[message] pair-room emit', { roomId: pairRoomId, ignoredTo: to || null });
      io.to(pairRoomId).emit('message', msg);

    } catch (err) {
      derr('[message] handler error:', err.message);
    }
  });






  // -------- clear-messages --------
  socket.on('clear-messages', ({ by }) => {
    dlog('[EVENT] clear-messages', { by });

    const roomId = socket.data?.roomId;
    if (!roomId) {
      dwarn('[clear-messages] no roomId; ignoring');
      return;
    }

    const payload = { type: 'message-cleared', by, messageId: Date.now() };
    io.to(roomId).emit('message-cleared', payload);
  });

  // -------- clear_confirmation --------
  socket.on('clear_confirmation', ({ device }) => {
    dlog('[EVENT] clear_confirmation', { device });

    const roomId = socket.data?.roomId;
    if (!roomId) {
      dwarn('[clear_confirmation] no roomId; ignoring');
      return;
    }

    const payload = { type: 'message_cleared', by: device, timestamp: new Date().toISOString() };
    io.to(roomId).emit('message_cleared', payload);
  });


  // -------- status_report --------
  socket.on('status_report', ({ from, status }) => {
    dlog('[EVENT] status_report', { from, status: trimStr(status || '') });
    const payload = {
      type: 'status_report',
      from,
      status,
      timestamp: new Date().toISOString(),
    };
    const roomId = socket.data?.roomId;
    if (roomId) {
      dlog('[status_report] room emit', roomId);
      io.to(roomId).emit('status_report', payload);
    } else {
      // Option B safety: no global status_report in prod (prevents cross-pair noise)
      if (IS_PROD) return;
      dlog('[status_report] global emit (dev only)');
      io.emit('status_report', payload);
    }

  });

  // -------- battery (NEW) --------
  socket.on('battery', ({ xrId, batteryPct, charging }) => {
    try {
      const id = xrId || socket.data?.xrId;
      if (!id) return;
      const pct = Math.max(0, Math.min(100, Number(batteryPct)));
      const rec = { pct, charging: !!charging, ts: Date.now() };

      batteryByDevice.set(id, rec);
      const roomId = socket.data?.roomId;
      if (roomId) {
        io.to(roomId).emit('battery_update', { xrId: id, pct: rec.pct, charging: rec.charging, ts: rec.ts });
      } else if (!IS_PROD) {
        io.emit('battery_update', { xrId: id, pct: rec.pct, charging: rec.charging, ts: rec.ts }); // dev only
      } else {
        socket.emit('battery_update', { xrId: id, pct: rec.pct, charging: rec.charging, ts: rec.ts }); // prod self-only
      }

      dlog('[battery] update', { id, pct: rec.pct, charging: rec.charging });
    } catch (e) {
      dwarn('[battery] bad payload:', e?.message || e);
    }
  });

  // -------- telemetry (NEW) --------
  socket.on('telemetry', (payload) => {
    try {
      const d = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const xrId = d.xrId || socket.data?.xrId;
      if (!xrId) return;

      // keep ALL fields (network + system)
      const rec = {
        xrId,
        connType: d.connType || 'none',

        // network (existing)
        wifiDbm: numOrNull(d.wifiDbm),
        wifiMbps: numOrNull(d.wifiMbps),
        wifiBars: numOrNull(d.wifiBars),
        cellDbm: numOrNull(d.cellDbm),
        cellBars: numOrNull(d.cellBars),
        netDownMbps: numOrNull(d.netDownMbps),
        netUpMbps: numOrNull(d.netUpMbps),

        // 🔵 system (NEW)
        cpuPct: numOrNull(d.cpuPct),
        memUsedMb: numOrNull(d.memUsedMb),
        memTotalMb: numOrNull(d.memTotalMb),
        deviceTempC: numOrNull(d.deviceTempC),

        ts: Date.now(),
      };

      // keep latest snapshot for device rows
      telemetryByDevice.set(xrId, rec);

      // time-series history (for modal charts)
      pushHist(telemetryHist, xrId, {
        ts: rec.ts,
        connType: rec.connType,
        wifiMbps: rec.wifiMbps,
        netDownMbps: rec.netDownMbps,
        netUpMbps: rec.netUpMbps,
        batteryPct: batteryByDevice.get(xrId)?.pct ?? null,

        // include system series
        cpuPct: rec.cpuPct,
        memUsedMb: rec.memUsedMb,
        memTotalMb: rec.memTotalMb,
        deviceTempC: rec.deviceTempC,
      });

      // live delta for open detail modal subscribers
      io.to(`metrics:${xrId}`).emit('metrics_update', {
        xrId,
        telemetry: [telemetryHist.get(xrId).at(-1)]
      });

      // broadcast the latest snapshot to dashboards
      // Option B: keep telemetry inside pair room in prod to prevent cross-pair UI contamination
      const roomId = socket.data?.roomId;
      if (roomId) {
        io.to(roomId).emit('telemetry_update', rec);
      } else if (!IS_PROD) {
        io.emit('telemetry_update', rec); // dev only
      } else {
        socket.emit('telemetry_update', rec); // prod self-only
      }


      dlog('[telemetry] update', rec);
    } catch (e) {
      dwarn('[telemetry] bad payload:', e?.message || e);
    }
  });



  //------------changes made regarding dashabord ***----------------------------------------------------------------
  socket.on('webrtc_quality', (q) => {
    dlog('[QUALITY] recv', q);
    try {
      const xrId = (q && q.xrId) || socket.data?.xrId;
      if (!xrId) return;

      const snap = {
        xrId,
        ts: q.ts || Date.now(),
        jitterMs: numOrNull(q.jitterMs),
        lossPct: numOrNull(q.lossPct),
        rttMs: numOrNull(q.rttMs),
        fps: numOrNull(q.fps),
        dropped: numOrNull(q.dropped),
        nackCount: numOrNull(q.nackCount),
        // optional if your Dock computes it and sends it:
        bitrateKbps: numOrNull(q.bitrateKbps),
      };

      // keep latest (powers center tiles)
      qualityByDevice.set(xrId, snap);

      // 🔵 store to history + stream to detail subscribers
      pushHist(qualityHist, xrId, {
        ts: snap.ts,
        jitterMs: snap.jitterMs,
        rttMs: snap.rttMs,
        lossPct: snap.lossPct,
        bitrateKbps: snap.bitrateKbps,
      });
      io.to(`metrics:${xrId}`).emit('metrics_update', {
        xrId,
        quality: [qualityHist.get(xrId).at(-1)]
      });

      // existing broadcast (summary tiles)
      // Option B: keep quality updates inside pair room in prod
      const roomId = socket.data?.roomId;
      if (roomId) {
        const parts = String(roomId).split(':');   // "pair:XR-A:XR-B"
        // ✅ SAFETY GUARD (mandatory)
        if (parts.length !== 3 || parts[0] !== 'pair') return;
        const a = parts[1];
        const b = parts[2];

        const roomQuality = [a, b]
          .map(id => qualityByDevice.get(id))
          .filter(Boolean);

        io.to(roomId).emit('webrtc_quality_update', roomQuality);

      } else if (!IS_PROD) {
        io.emit('webrtc_quality_update', Array.from(qualityByDevice.values())); // dev only
      } else {
        socket.emit('webrtc_quality_update', Array.from(qualityByDevice.values())); // prod self-only
      }

    } catch (e) {
      dwarn('[QUALITY] store/broadcast failed:', e?.message || e);
    }
  });




  // -------- message_history (on demand) --------
  socket.on('message_history', () => {
    const roomId = roomForHistory(socket);
    dlog('[EVENT] message_history request; room=', roomId);

    socket.emit('message_history', {
      type: 'message_history',
      roomId,
      messages: getMessages(roomId).slice(-10),
    });
  });






  // ✅ IMPORTANT: disconnecting runs before Socket.IO removes the socket from rooms.
  // We use it ONLY to notify the peer. Never emit device_list here.
  socket.on('disconnecting', (reason) => {
    if (socket.data?.clientType === 'cockpit' || socket.data?.clientType === 'dashboard') return;
    try {
      const xrId = normXr(socket.data?.xrId);

      // ✅ capture partner BEFORE anything changes
      const oldPartner = pairedWith?.get?.(xrId) || null;

      // ✅ prefer socket roomId, but if missing derive from pair
      const roomId = socket.data?.roomId || (oldPartner ? getRoomIdForPair(xrId, oldPartner) : null);

      dlog('⚠️ [EVENT] disconnecting', { reason, xrId, roomId });

      if (roomId) {
        io.to(roomId).emit('peer_left', { xrId, roomId, reason });

        // keep legacy compatibility (was in the removed handler)
        io.to(roomId).emit('desktop_disconnected', { xrId, roomId, reason });
      }
    } catch (e) {
      derr('[disconnecting] error:', e?.message || e);
    }
  });




  //------------changes made regarding dashabord ***----------------------------------------------------------------
  socket.on('disconnect', async (reason) => {
    if (socket.data?.clientType === 'cockpit' || socket.data?.clientType === 'dashboard') return;
    dlog('❎ [EVENT] disconnect', {
      reason,
      xrId: socket.data?.xrId,
      device: socket.data?.deviceName
    });

    try {
      const xrId = normXr(socket.data?.xrId);
      clearPairRetry(xrId);

      if (xrId) {
        // ✅ PROD: release Redis online owner lock so device_list can't go stale
        await releaseOwnerLockIfOwned(xrId, socket.id);

        // ✅ capture partner BEFORE clearing pair (needed for room fallback + partner.roomId cleanup)
        const oldPartner = pairedWith?.get?.(xrId) || null;

        // ✅ Capture room before clearing it; if missing, derive from pair (critical for 2nd disconnect)
        const roomIdAtDisconnect =
          socket.data?.roomId || (oldPartner ? getRoomIdForPair(xrId, oldPartner) : null);


        // ✅ Clear authoritative room routing for this socket
        socket.data.roomId = null;

        // ✅ Option B: release one-to-one lock (do this ONCE)
        const partner = clearPairByXrId(xrId);

        // ✅ Keep partner in canonical pair room SOLO so dashboard stays correct (cluster-safe).
        // DO NOT clear partnerSocket.data.roomId here.
        if (oldPartner) {
          const partnerSocket = await getClientSocketByXrIdCI_Cluster(oldPartner, socket);
          if (partnerSocket) {
            if (roomIdAtDisconnect) {
              try { partnerSocket.join(roomIdAtDisconnect); } catch { }
              try { partnerSocket.data.roomId = roomIdAtDisconnect; } catch { }
            }
            dlog('[disconnect] kept partner in room (cluster)', {
              xrId,
              oldPartner,
              roomIdAtDisconnect,
              partnerSocketId: partnerSocket.id
            });
          } else {
            dlog('[disconnect] partner socket not found (cluster) to keep in room', { xrId, oldPartner });
          }
        }



        if (partner) {
          dlog('[PAIR] cleared pairing', { xrId, partner });
        }

        // Remove from your in-memory maps (done after partner cleanup)
        clients.delete(xrId);
        onlineDevices.delete(xrId);

        // ✅ NEW: If any cockpit is watching this XR (and not yet in a pair room),
        // push empty list so UI goes red immediately (prod consistency).
        try {
          await notifyCockpitsWatchingXr(xrId, []);
        } catch (e) {
          dwarn('[COCKPIT][WATCH_NOTIFY] disconnect push failed (ignored)', { xrId, err: e?.message || e });
        }

        if (desktopClients.get(xrId) === socket) {
          desktopClients.delete(xrId);
          dlog('[disconnect] removed desktop client:', xrId);
        }

        // ✅ Broadcast device list ONLY to the pair room (after Socket.IO prunes rooms)
        if (roomIdAtDisconnect) {
          setTimeout(() => {
            broadcastDeviceList(roomIdAtDisconnect).catch(() => { });
          }, 0);
        }

        // ✅ After Socket.IO prunes rooms, reflect pair changes
        setTimeout(() => {
          broadcastPairs();
        }, 0);
      }
    } catch (err) {
      derr('[disconnect] cleanup error:', err.message);
    }
  });







  // -------- error --------
  socket.on('error', (err) => {
    derr(`[SOCKET_ERROR] ${socket.id}:`, err?.message || err);
  });
});




// -------------------- Start & Shutdown --------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [SERVER] Running on http://0.0.0.0:${PORT}`);
});

process.on('uncaughtException', (err) => {
  derr('[FATAL] uncaughtException:', err?.stack || err?.message || err);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('\n[SHUTDOWN] Starting graceful shutdown…');
  (async () => {
    try {
      const socketCount = io.sockets.sockets.size;
      dlog('[SHUTDOWN] active sockets:', socketCount);

      // 1) stop socket.io
      io.sockets.sockets.forEach((s) => s.disconnect(true));
      await new Promise((resolve) => io.close(resolve));
      console.log('[SHUTDOWN] Socket.IO closed');

      // 2) close HTTP server
      await new Promise((resolve) => server.close(resolve));
      console.log('[SHUTDOWN] HTTP server closed');

      // 3) close DB
      try {
        await closeDatabase();
      } catch (e) {
        dwarn('[SHUTDOWN] DB close error:', e?.message || e);
      }

      process.exit(0);
    } catch (e) {
      derr('[SHUTDOWN] error:', e?.message || e);
      process.exit(1);
    }
  })();
}

