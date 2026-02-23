// ------------------------bolt------------ dashboard.js (DROP-IN) ------------------------------------

// ===== DB-driven pairs (Platform ↔ Dashboard parity) =====
let mappedPairs = [];            // [{ providerXrId, scribeXrId, providerName, scribeName }]
const mappedPartner = new Map(); // xrId -> partnerXrId

// Primary pair for the existing center tiles/metrics (keep current UI behavior)
let PRIMARY_LEFT = 'XR-1234';
let PRIMARY_RIGHT = 'XR-1238';

const STATIC_BATTERY_LEFT = 83; // keep fallback


// ===== XR Hub Dashboard permissions (System_Screens.id = 1) =====
const XR_HUB_SCREEN_ID = 1;   // "XR Hub Dashboard" in System_Screens

let xrHubPermissions = null;  // { read, write, edit, delete } or null (fail-open)

async function loadHubPermissions() {
  try {
    const res = await fetch('/api/platform/my-screens', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      console.warn('[XRHUB] my-screens returned', res.status);
      xrHubPermissions = null; // fail-open: keep existing behaviour
      return;
    }

    const data = await res.json();
    const screens = data?.screens || [];

    // ✅ Always match by screen ID to avoid route/name mismatches
    let match = screens.find(s => s.id === XR_HUB_SCREEN_ID);

    // Fallbacks in case IDs ever change
    if (!match) {
      match = screens.find(s => (s.screen_name || '').toLowerCase() === 'xr hub dashboard');
    }
    if (!match) {
      match = screens.find(s => (s.route_path || '').toLowerCase() === '/dashboard');
    }

    if (!match) {
      console.warn('[XRHUB] No screen entry for XR Hub Dashboard; leaving unrestricted.');
      xrHubPermissions = null;
      return;
    }

    xrHubPermissions = {
      read: !!match.read,
      write: !!match.write,
      edit: !!match.edit,
      delete: !!match.delete,
    };

    console.log('[XRHUB] Permissions:', xrHubPermissions);
  } catch (err) {
    console.warn('[XRHUB] Failed to load permissions:', err);
    xrHubPermissions = null; // fail-open
  }
}

function hasHubWritePermission() {
  // If we couldn't load permissions, do not block anything (preserve behaviour)
  if (!xrHubPermissions) return true;
  return !!xrHubPermissions.write;
}

function notifyReadOnlyHub() {
  const msg = 'You only have READ permission for XR Hub Dashboard. Editing is not allowed.';
  if (typeof showToast === 'function') {
    showToast(msg, 'error');
  } else {
    try { alert(msg); } catch { console.warn(msg); }
  }
}

function applyHubReadOnlyUI() {
  if (!xrHubPermissions || xrHubPermissions.write) return; // nothing to lock

  console.log('[XRHUB] Applying read-only UI on dashboard');

  const markDisabled = (btn) => {
    if (!btn) return;
    btn.setAttribute('aria-disabled', 'true');
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    const title = btn.getAttribute('title') || '';
    if (!title.toLowerCase().includes('read-only')) {
      btn.setAttribute('title', `${title ? title + ' · ' : ''}Read-only: no permission to edit.`);
    }
  };

  // These will be added in step 2
  document.querySelectorAll('.hub-edit-btn, .hub-msg-btn').forEach(markDisabled);
}


// ===== A) Per-device WebRTC quality cache =====
// (Keep the tiles/center box behavior the same, but point at PRIMARY pair.)
let XR_ANDROID = PRIMARY_LEFT;  // left of primary
let XR_DOCK = PRIMARY_RIGHT;    // right of primary
const qualityStore = new Map(); // id -> { ts:[], jitter:[], rtt:[], loss:[], kbps:[] }
function getQ(id) {
  if (!qualityStore.has(id)) {
    qualityStore.set(id, { ts: [], jitter: [], rtt: [], loss: [], kbps: [] });
  }
  return qualityStore.get(id);
}
let currentDetailId = null; // which device the modal is showing


// ---------------- Icons (unchanged) ----------------
const Icon = {
  pen: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`,
  battery(pct = 0) {
    const w = Math.max(0, Math.min(18, Math.round((pct / 100) * 18)));
    return `<svg viewBox="0 0 28 16" width="22" height="16" fill="none" stroke="white" stroke-width="2">
      <rect x="1" y="3" width="22" height="10" rx="2"></rect>
      <rect x="23" y="6" width="3" height="4" rx="1" fill="white"></rect>
      <rect x="3" y="5" width="${w}" height="6" fill="white"></rect>
    </svg>`;
  }
};

// ------------- Status chip with explicit colors -------------
function chip(text, state) {
  // state: 'available' (green) | 'connecting' (amber) | 'busy' (red)
  const colors = {
    available: '#16a34a',  // green-600
    connecting: '#f59e0b', // amber-500
    busy: '#dc2626'        // red-600
  };
  const bg = colors[state] || '#6b7280';
  return `<div class="chip"
              style="background:${bg};color:#fff;font-size:12px;padding:6px 8px;border-radius:6px;white-space:nowrap;">
            ${text}
          </div>`;
}

// ---------------- Presence & pairing state ----------------
const onlineDevices = new Map(); // xrId -> { xrId, deviceName }
const activePairs = new Set(); // "XR-1234|XR-1238"
const batteryState = new Map();
// NEW: telemetry store
const telemetry = new Map(); // xrId -> latest telemetry record
// NEW: roomId -> Set<xrId> last seen in that room (prevents stuck amber)
const roomMembers = new Map();

// ---- Streaming state (UI-only) ----
const lastQuality = new Map();  // xrId -> { ts, bitrateKbps }
const STREAMING_FRESH_MS = 6000; // 2 ticks at ~3s

function isStreaming(xrId) {
  const q = lastQuality.get(xrId);
  if (!q) return false;
  const fresh = (Date.now() - q.ts) < STREAMING_FRESH_MS;
  return fresh && (q.bitrateKbps || 0) > 0; // only green when real video is flowing
}


// Toggle the green border on the center "Connection" box
function updateConnBorder() {
  const box = document.getElementById('conn-box');
  if (!box) return;

  // We key the green ring off the DOCK (XR_RIGHT) by default
  const streaming =
    isStreaming(XR_ANDROID || PRIMARY_LEFT || 'XR-1234') ||
    isStreaming(XR_DOCK || PRIMARY_RIGHT || 'XR-1238');



  // If you use Tailwind rings:
  box.classList.toggle('ring-2', streaming);
  box.classList.toggle('ring-green-500', streaming);
  box.classList.toggle('ring-offset-0', streaming);

  // If you don't use Tailwind, use a CSS class instead:
  // box.classList.toggle('conn--streaming', streaming);
}

function updateAllConnBorders() {
  const boxes = document.querySelectorAll('.conn-box[data-left][data-right]');
  for (const box of boxes) {
    const leftId = (box.getAttribute('data-left') || '').trim();
    const rightId = (box.getAttribute('data-right') || '').trim();

    const streaming = isStreaming(leftId) || isStreaming(rightId);

    box.classList.toggle('ring-2', streaming);
    box.classList.toggle('ring-green-500', streaming);
    box.classList.toggle('ring-offset-0', streaming);
  }
}


// ===== Live date/time stamp (top-right above "Scribe") =====
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
function formatStamp() {
  const d = new Date();

  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' }).toUpperCase();
  const day = d.getDate();
  const month = d.toLocaleDateString('en-GB', { month: 'long' }).toUpperCase();
  const year = d.getFullYear();

  // ⏰ Add live time (HH:MM, 12-hour with AM/PM)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `${weekday} ${day}${ordinal(day)} ${month} ${year} · ${time}`;
}
function paintNowStamp() {
  const el = document.getElementById('nowStamp');
  if (el) el.textContent = formatStamp();
}



// Gate first paint until both initial snapshots arrive
let gotInitialDevices = false;
let gotInitialPairs = false;
let currentPage = 1;   // ✅ pagination state (GLOBAL)

function renderIfReady() {
  if (!gotInitialDevices || !gotInitialPairs) return;
  renderDevices();
}

// ===== mappings cache (prevents "empty dashboard on refresh" when session/API 403) =====
const MAPPINGS_CACHE_KEY = 'xrhub:mappings_cache_v1';

function saveMappingsCache(rows) {
  try { localStorage.setItem(MAPPINGS_CACHE_KEY, JSON.stringify(rows || [])); } catch { }
}
function loadMappingsCache() {
  try { return JSON.parse(localStorage.getItem(MAPPINGS_CACHE_KEY) || '[]'); } catch { return []; }
}


// ===== DB mappings loader (Dashboard rows must exist even when offline) =====
async function loadMappedPairsFromDB() {
  try {
    const res = await fetch('/api/platform/scribe-provider-mapping', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      console.warn('[DASHBOARD] mapping API failed:', res.status);

      // ✅ beginner-safe: DO NOT wipe UI. Use last good cached mappings.
      const cached = loadMappingsCache();
      if (Array.isArray(cached) && cached.length) {
        const rows = cached;

        mappedPairs = rows
          .map(m => ({
            providerXrId: m.provider_xr_id || m?.provider?.xrId || null,
            scribeXrId: m.scribe_xr_id || m?.scribe?.xrId || null,
            providerName: m?.provider?.name || null,
            scribeName: m?.scribe?.name || null,
          }))
          .filter(p => !!p.providerXrId && !!p.scribeXrId);

        mappedPartner.clear();
        for (const p of mappedPairs) {
          mappedPartner.set(p.providerXrId, p.scribeXrId);
          mappedPartner.set(p.scribeXrId, p.providerXrId);
        }

        if (mappedPairs.length) {
          PRIMARY_LEFT = mappedPairs[0].providerXrId;
          PRIMARY_RIGHT = mappedPairs[0].scribeXrId;
          XR_ANDROID = PRIMARY_LEFT;
          XR_DOCK = PRIMARY_RIGHT;
        }

        console.warn('[DASHBOARD] Using cached mappings:', mappedPairs.length);
        return;
      }

      // If no cache exists, keep current in-memory mappings (do NOT clear)
      console.warn('[DASHBOARD] No cache found; leaving mappedPairs as-is');
      return;
    }


    const data = await res.json();
    const rows = Array.isArray(data?.mappings) ? data.mappings : [];
    saveMappingsCache(rows); // ✅ persist last good DB mappings


    mappedPairs = rows
      .map(m => ({
        providerXrId: m.provider_xr_id || m?.provider?.xrId || null,
        scribeXrId: m.scribe_xr_id || m?.scribe?.xrId || null,
        providerName: m?.provider?.name || null,
        scribeName: m?.scribe?.name || null,
      }))
      .filter(p => !!p.providerXrId && !!p.scribeXrId);

    mappedPartner.clear();
    for (const p of mappedPairs) {
      mappedPartner.set(p.providerXrId, p.scribeXrId);
      mappedPartner.set(p.scribeXrId, p.providerXrId);
    }

    if (mappedPairs.length) {
      PRIMARY_LEFT = mappedPairs[0].providerXrId;
      PRIMARY_RIGHT = mappedPairs[0].scribeXrId;
      XR_ANDROID = PRIMARY_LEFT;
      XR_DOCK = PRIMARY_RIGHT;
    }

    console.log('[DASHBOARD] Loaded mappings:', mappedPairs.length);

    // ✅ NEW: if socket is already connected, subscribe now (covers race: socket connects before mappings load)
    if (socket?.connected) {
      try {
        const rooms = mappedPairs
          .map(p => {
            const A = String(p.providerXrId || '').trim();
            const B = String(p.scribeXrId || '').trim();
            if (!A || !B) return null;
            const [x, y] = [A, B].sort((m, n) => m.localeCompare(n, undefined, { sensitivity: 'base' }));
            return `pair:${x}:${y}`;
          })
          .filter(Boolean);

        socket.emit('dashboard_subscribe_pairs', { roomIds: [...new Set(rooms)] });
      } catch { }
    }


  } catch (err) {
    console.warn('[DASHBOARD] Failed to load mappings:', err);

    // ✅ DO NOT wipe: fallback to cache
    const cached = loadMappingsCache();
    if (Array.isArray(cached) && cached.length) {
      const rows = cached;

      mappedPairs = rows
        .map(m => ({
          providerXrId: m.provider_xr_id || m?.provider?.xrId || null,
          scribeXrId: m.scribe_xr_id || m?.scribe?.xrId || null,
          providerName: m?.provider?.name || null,
          scribeName: m?.scribe?.name || null,
        }))
        .filter(p => !!p.providerXrId && !!p.scribeXrId);

      mappedPartner.clear();
      for (const p of mappedPairs) {
        mappedPartner.set(p.providerXrId, p.scribeXrId);
        mappedPartner.set(p.scribeXrId, p.providerXrId);
      }

      if (mappedPairs.length) {
        PRIMARY_LEFT = mappedPairs[0].providerXrId;
        PRIMARY_RIGHT = mappedPairs[0].scribeXrId;
        XR_ANDROID = PRIMARY_LEFT;
        XR_DOCK = PRIMARY_RIGHT;
      }

      console.warn('[DASHBOARD] Using cached mappings after exception:', mappedPairs.length);
      return;
    }

    // If no cache exists, keep current in-memory mappings (do NOT clear)
    console.warn('[DASHBOARD] No cache found; leaving mappedPairs as-is');
  }
}


// Helper: battery icon + % text next to it
function batteryMarkup(xrId) {
  const st = batteryState.get(xrId);
  const pct = (st && typeof st.pct === 'number') ? st.pct : null;

  const svg = Icon.battery(pct ?? 0);
  const num = (pct === null) ? '' : `<span class="text-white/90 text-sm">${pct}%</span>`;
  const title = (pct === null) ? 'Battery'
    : `Battery: ${pct}%${st?.charging ? ' (charging)' : ''}`;

  // NOTE: this uses the "battery-btn" class you added in dashboard.html CSS
  return `<div class="icon-btn battery-btn" title="${title}">${svg}${num}</div>`;
}

function inAnyPair(xrId) {
  for (const key of activePairs) {
    if (key.split('|').includes(xrId)) return true;
  }
  return false;
}

// ------- Connection state logic (DB-mapped partner-aware) -------
function computeState(xrId) {
  const online = onlineDevices.has(xrId);

  // Partner comes from DB mapping; fallback to primary pair if needed
  const partner =
    mappedPartner.get(xrId) ||
    (xrId === PRIMARY_LEFT
      ? PRIMARY_RIGHT
      : xrId === PRIMARY_RIGHT
        ? PRIMARY_LEFT
        : null);

  const partnerOnline = partner ? onlineDevices.has(partner) : false;

  // 🔴 red - both offline
  if (!online && !partnerOnline) return 'busy';

  // 🟢 green - both online
  if (online && partnerOnline) return 'available';

  // 🟠 yellow ONLY for the device that is online and waiting for partner
  if (online && !partnerOnline) return 'connecting';

  // 🔴 if THIS device is offline (even if partner is online), keep it red
  return 'busy';
}


// ---- Cache last connection metrics so the box never goes blank ----
function paintConnMetricsFromCache() {
  const boxes = document.querySelectorAll('.conn-box[data-left][data-right]');

  const fmt = (v, suffix) => {
    if (!Number.isFinite(v)) return '—';
    return `${Number(v).toFixed(1)}${suffix}`;
  };

  boxes.forEach(box => {
    const leftId = (box.dataset.left || '').trim();
    const rightId = (box.dataset.right || '').trim();
    if (!leftId || !rightId) return;

    const L = lastQuality.get(leftId);
    const R = lastQuality.get(rightId);

    // LEFT side (Android)
    if (L) {
      const jl = box.querySelector('.metricJitterLeft');
      const ll = box.querySelector('.metricLossLeft');
      const rl = box.querySelector('.metricRttLeft');

      if (jl) jl.textContent = fmt(L.jitterMs, ' ms');
      if (ll) ll.textContent = fmt(L.lossPct, ' %');
      if (rl) rl.textContent = fmt(L.rttMs, ' ms');
    }

    // RIGHT side (Dock)
    if (R) {
      const jr = box.querySelector('.metricJitterRight');
      const lr = box.querySelector('.metricLossRight');
      const rr = box.querySelector('.metricRttRight');

      if (jr) jr.textContent = fmt(R.jitterMs, ' ms');
      if (lr) lr.textContent = fmt(R.lossPct, ' %');
      if (rr) rr.textContent = fmt(R.rttMs, ' ms');
    }
  });
}


// ------- Telemetry helpers (NEW) -------
function barsGlyph(n) {
  if (!Number.isFinite(n)) return '';
  const glyphs = ['▁', '▂', '▃', '▅', '█']; // 0..4
  return ' ' + glyphs[Math.max(0, Math.min(4, n))];
}

function renderNetBadges(xrId) {
  const t = telemetry.get(xrId);
  if (!t) return '';
  if (t.connType === 'wifi') {
    const bits = ['WIFI'];

    // 👉 Only include dBm if it's not 0/null
    if (Number.isFinite(t.wifiDbm) && t.wifiDbm !== 0) {
      bits.push(`${t.wifiDbm} dBm`);
    }

    // Always show Mbps if available
    if (Number.isFinite(t.wifiMbps)) {
      bits.push(`${t.wifiMbps} Mbps`);
    }

    if (Number.isFinite(t.wifiBars)) {
      bits.push(barsGlyph(t.wifiBars));
    }

    return `<div class="text-white/70 text-xs font-medium mt-0.5">${bits.join(' · ')}</div>`;
  }

  if (t.connType === 'cellular') {
    const bits = ['CELLULAR'];
    if (Number.isFinite(t.cellDbm)) bits.push(`${t.cellDbm} dBm`);
    if (Number.isFinite(t.cellBars)) bits.push(barsGlyph(t.cellBars));
    // ✅ Use generic netDownMbps instead of cellMbps
    const mbps = Number.isFinite(t.cellMbps) ? t.cellMbps : t.netDownMbps;
    if (Number.isFinite(mbps)) bits.push(`${mbps} Mbps`);
    return `<div class="text-white/70 text-xs font-medium mt-0.5">${bits.join(' · ')}</div>`;
  }

  if (t.connType === 'ethernet') return `<div class="text-white/70 text-xs font-medium mt-0.5">ETHERNET</div>`;
  if (t.connType === 'none') return `<div class="text-white/70 text-xs font-medium mt-0.5">OFFLINE</div>`;
  return `<div class="text-white/70 text-xs font-medium mt-0.5">${String(t.connType).toUpperCase()}</div>`;
}


// function renderSysPills(xrId) {
//   const t = telemetry.get(xrId);
//   if (!t) return '';

//   // We only show what we have; nothing breaks if a field is missing
//   let ram = '--';
//   if (Number.isFinite(t.memUsedMb) && Number.isFinite(t.memTotalMb) && t.memTotalMb > 0) {
//     ram = `${Math.round((t.memUsedMb / t.memTotalMb) * 100)}%`; // RAM %
//   }
//   const temp = Number.isFinite(t.deviceTempC) ? `${Math.round(t.deviceTempC)}°C` : null;

//   return `
//     <div class="mt-0.5 flex gap-2 text-[11px] text-white/80">
//       <span class="px-2 py-[2px] rounded bg-white/10">RAM ${ram}</span>
//       ${temp ? `<span class="px-2 py-[2px] rounded bg-white/10">TEMP ${temp}</span>` : ``}
//     </div>
//   `;
// }

// ↓↓↓ ADD directly after renderNetBadges(xrId)
function renderSysPills(xrId) {
  const t = telemetry.get(xrId);
  if (!t) return '';

  // Show only when values are meaningful (Android APK sends these; browsers don't).
  const validRam =
    Number.isFinite(t.memUsedMb) &&
    Number.isFinite(t.memTotalMb) &&
    t.memTotalMb >= 128 &&         // ignore bogus/unknown totals
    t.memUsedMb > 0 &&
    t.memUsedMb <= t.memTotalMb;   // sane percentage (1–100)

  const validTemp =
    Number.isFinite(t.deviceTempC) &&
    t.deviceTempC >= 15 &&         // typical device temps (°C)
    t.deviceTempC <= 90;

  // Browser/PWA usually fails both checks → hide the pills entirely.
  if (!validRam && !validTemp) return '';

  const pills = [];
  if (validRam) {
    const pct = Math.round((t.memUsedMb / t.memTotalMb) * 100);
    pills.push(
      `<span class="px-2 py-0.5 rounded bg-white/10 text-white/80 text-[11px]">RAM — ${pct}%</span>`
    );
  }
  if (validTemp) {
    const c = Math.round(t.deviceTempC);
    pills.push(
      `<span class="px-2 py-0.5 rounded bg-white/10 text-white/80 text-[11px]">TEMP — ${c}°C</span>`
    );
  }

  return `<div class="flex gap-2 mt-1">${pills.join('')}</div>`;
}







// --- Signal strength helpers (0..4 like Android) ---
function rssiToBars(dbm) {               // Wi-Fi RSSI thresholds
  if (!Number.isFinite(dbm)) return null;
  if (dbm <= -85) return 0;
  if (dbm <= -75) return 1;
  if (dbm <= -67) return 2;
  if (dbm <= -60) return 3;
  return 4; // > -60 dBm
}

function cellDbmToBars(dbm) {            // LTE/5G typical thresholds
  if (!Number.isFinite(dbm)) return null;
  if (dbm <= -110) return 0;
  if (dbm <= -100) return 1;
  if (dbm <= -90) return 2;
  if (dbm <= -80) return 3;
  return 4; // > -80 dBm
}

function getBarsFor(xrId) {
  const t = telemetry.get(xrId);
  if (!t) return null;

  if (t.connType === 'wifi') {
    let bars = Number.isFinite(t.wifiBars) ? t.wifiBars : rssiToBars(t.wifiDbm);
    if (!Number.isFinite(bars)) return null;
    return { bars: Math.max(0, Math.min(4, Math.round(bars))), label: 'WIFI' };
  }
  if (t.connType === 'cellular') {
    let bars = Number.isFinite(t.cellBars) ? t.cellBars : cellDbmToBars(t.cellDbm);
    if (!Number.isFinite(bars)) return null;
    return { bars: Math.max(0, Math.min(4, Math.round(bars))), label: 'CELL' };
  }
  return null;
}

// Minimal SVG bars (5 columns). Active bars are bright; inactive are dim.
function renderSignalBars(xrId) {
  const s = getBarsFor(xrId);
  if (!s) return '';

  const n = s.bars; // 0..4
  const svg = Array.from({ length: 5 }, (_, i) => {
    const h = 3 + i * 2.2;               // increasing bar heights
    const x = i * 7;
    const y = 14 - h;
    const fill = i <= n ? '#ffffff' : 'rgba(255,255,255,0.35)';
    return `<rect x="${x}" y="${y}" width="5" height="${h}" rx="1" fill="${fill}"></rect>`;
  }).join('');

  // inline style so you don’t need CSS changes
  return `
    <div class="sigbars" style="display:flex;align-items:center" title="${s.label} signal: ${n}/4">
      <svg width="36" height="14" viewBox="0 0 36 14" aria-label="${s.label} signal ${n} of 4">
        ${svg}
      </svg>
    </div>
  `;
}

// ===== C) Connection tiles filler (Android left + Dock right) =====
function latest(id) {
  const q = qualityStore.get(id);
  if (!q || !q.ts.length) return null;
  const i = q.ts.length - 1;
  return { jitter: q.jitter[i], loss: q.loss[i], rtt: q.rtt[i] };
}

function renderConnectionTiles() {
  fillConn('left-connection-box', latest(XR_ANDROID)); // Android
  fillConn('right-connection-box', latest(XR_DOCK));    // Dock
}

function fillConn(containerId, d) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const jitterEl = el.querySelector('.jitter');
  const lossEl = el.querySelector('.loss');
  const rttEl = el.querySelector('.rtt');

  if (jitterEl) jitterEl.textContent = d ? `${Math.round(d.jitter || 0)} ms` : '--';
  if (lossEl) lossEl.textContent = d ? `${(d.loss || 0).toFixed(1)} %` : '--';
  if (rttEl) rttEl.textContent = d ? `${Math.round(d.rtt || 0)} ms` : '--';
}


// ===== Painter for center Connection box =====
function setNum(id, val, suffix = '') {
  const el = document.getElementById(id);
  if (!el) return;
  if (!Number.isFinite(val)) return; // never overwrite with blanks
  el.textContent = `${(typeof val === 'number' ? val : Number(val)).toFixed(1)}${suffix}`;
}

function paintCenterBox() {
  // Android (left)
  const a = latest(XR_ANDROID);
  if (a) {
    setNum('metricJitterLeft', a.jitter, ' ms');
    setNum('metricLossLeft', a.loss, ' %');
    setNum('metricRttLeft', a.rtt, ' ms');
  }

  // Dock (right)
  const d = latest(XR_DOCK);
  if (d) {
    setNum('metricJitterRight', d.jitter, ' ms');
    setNum('metricLossRight', d.loss, ' %');
    setNum('metricRttRight', d.rtt, ' ms');
  }
}

function paintAllCenterBoxes() {
  const boxes = document.querySelectorAll('.conn-box[data-left][data-right]');

  boxes.forEach(box => {
    const leftId = (box.dataset.left || '').trim();
    const rightId = (box.dataset.right || '').trim();
    if (!leftId || !rightId) return;

    const a = latest(leftId);
    const d = latest(rightId);

    const setText = (selector, val, suffix) => {
      const el = box.querySelector(selector);
      if (!el) return;
      if (val === null || val === undefined || Number.isNaN(val)) {
        el.textContent = '—';
        return;
      }
      el.textContent = `${Number(val).toFixed(1)}${suffix}`;
    };

    // Android (left side of this row)
    if (a) {
      setText('.metricJitterLeft', a.jitter, ' ms');
      setText('.metricLossLeft', a.loss, ' %');
      setText('.metricRttLeft', a.rtt, ' ms');
    }

    // Dock (right side of this row)
    if (d) {
      setText('.metricJitterRight', d.jitter, ' ms');
      setText('.metricLossRight', d.loss, ' %');
      setText('.metricRttRight', d.rtt, ' ms');
    }
  });
}




// ------- Rows (DB-driven) -------
function buildRows() {
  // 1) If DB mappings exist, render one row per mapping (even if offline)
  if (mappedPairs.length) {
    const rows = mappedPairs.map((p, i) => {
      const providerState = computeState(p.providerXrId);
      const scribeState = computeState(p.scribeXrId);

      // Battery shown only for provider (same behavior as before)
      const st = batteryState.get(p.providerXrId);
      const batteryPct =
        (st && typeof st.pct === 'number') ? st.pct : STATIC_BATTERY_LEFT;

      return {
        label: `Provider ${i + 1}${p.providerName ? ` — ${p.providerName}` : ''}`,
        left: {
          xrId: p.providerXrId,
          text: `XR VISION : ${p.providerXrId.replace('XR-', '')}`,
          state: providerState,
          battery: batteryPct
        },
        scribe: `Scribe ${i + 1}${p.scribeName ? ` — ${p.scribeName}` : ''}`,
        right: {
          xrId: p.scribeXrId,
          text: `XR VISION DOCK : ${p.scribeXrId.replace('XR-', '')}`,
          state: scribeState
        }
      };
    });

    // ✅ Move fully-connected (both green) pairs to the top (stable sort)
    const isGreen = (s) => s === 'available';

    return rows
      .map((r, idx) => ({ r, idx }))
      .sort((a, b) => {
        const aOn = isGreen(a.r.left.state) && isGreen(a.r.right.state);
        const bOn = isGreen(b.r.left.state) && isGreen(b.r.right.state);
        if (aOn !== bOn) return aOn ? -1 : 1;   // both-online first
        return a.idx - b.idx;                   // preserve DB order inside groups
      })
      .map(x => x.r);

  }

  // 2) Fallback — preserves old hardcoded behavior if DB mappings fail
  const leftState = computeState(PRIMARY_LEFT);
  const rightState = computeState(PRIMARY_RIGHT);

  const st = batteryState.get(PRIMARY_LEFT);
  const batteryPct =
    (st && typeof st.pct === 'number') ? st.pct : STATIC_BATTERY_LEFT;

  return [
    {
      label: 'Provider 1',
      left: {
        xrId: PRIMARY_LEFT,
        text: `XR VISION : ${PRIMARY_LEFT.replace('XR-', '')}`,
        state: leftState,
        battery: batteryPct
      },
      scribe: 'Scribe 1',
      right: {
        xrId: PRIMARY_RIGHT,
        text: `XR VISION DOCK : ${PRIMARY_RIGHT.replace('XR-', '')}`,
        state: rightState
      }
    }
  ];
}



// Render
function rowHTML({ label, left, scribe, right }) {
  const leftId = left.xrId;
  const rightId = right.xrId;

  const leftChip = `<button class="device-chip" data-xr="${leftId}">${chip(left.text, left.state)}</button>`;
  const rightChip = `<button class="device-chip" data-xr="${rightId}">${chip(right.text, right.state)}</button>`;

  return `
  <div class="grid grid-cols-12 gap-3 md:gap-4 items-center">
    <div class="col-span-12 md:col-span-2 text-white/90 text-base md:text-lg">${label}</div>

    <!-- LEFT: Android card -->
    <div class="col-span-12 md:col-span-4 flex flex-col md:pl-6">
      <div class="flex items-center gap-3">
        ${leftChip}
        <div class="flex gap-2">
          <button class="icon-btn hub-edit-btn" title="Edit">${Icon.pen}</button>
          ${renderSignalBars(leftId)}
          ${batteryMarkup(leftId)}
        </div>
      </div>
      ${renderNetBadges(leftId)}
      ${renderSysPills(leftId)}  <!-- NEW: Android-only RAM/TEMP pills -->
    </div>

    <!-- Center: Connection Quality (Android left | Dock right) -->
    <div class="col-span-12 md:col-span-2">
      <div class="conn-box rounded-xl bg-white/5 border border-white/10 p-3 md:p-3.5 ring-0"
           data-left="${leftId}" data-right="${rightId}">

        <div class="grid grid-cols-2 gap-3">
          <!-- ANDROID (left) -->
          <div class="pr-2 border-r border-white/20">
            <div class="grid grid-cols-3 gap-2 text-sm text-white/90 text-left">
              <div>
                <div class="text-[10px] text-white/60">J</div>
                <div class="metricJitterLeft">—</div>
              </div>
              <div>
                <div class="text-[10px] text-white/60">L</div>
                <div class="metricLossLeft">—</div>
              </div>
              <div>
                <div class="text-[10px] text-white/60">R</div>
                <div class="metricRttLeft">—</div>
              </div>
            </div>
          </div>

          <!-- DOCK (right) -->
          <div class="pl-2">
            <div class="grid grid-cols-3 gap-2 text-sm text-white/90 text-right">
              <div>
                <div class="text-[10px] text-white/60">J</div>
                <div class="metricJitterRight">—</div>
              </div>
              <div>
                <div class="text-[10px] text-white/60">L</div>
                <div class="metricLossRight">—</div>
              </div>
              <div>
                <div class="text-[10px] text-white/60">R</div>
                <div class="metricRttRight">—</div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- RIGHT: Dock card -->
    <div class="col-span-12 md:col-span-4 flex flex-col items-end">
      <div class="flex items-center justify-end gap-3">
        <div class="text-white/90 text-base md:text-lg mr-20 pr-2">${scribe}</div><!-- ✅ matched size -->
        ${rightChip}
        <div class="flex gap-2">
          <button class="icon-btn hub-edit-btn" title="Edit">${Icon.pen}</button>
          ${renderSignalBars(rightId)}
          <button class="icon-btn hub-msg-btn" title="Message">${Icon.mail}</button>
        </div>
      </div>
      ${renderNetBadges(rightId)}
    </div>
  </div>
  <div class="border-b divider"></div>`;
}



function renderDevices() {
  const el = document.getElementById('rows');
  if (!el) return;
  const rows = buildRows();

  // pagination: 10 per page
  const PER_PAGE = 8;
  const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));

  // keep page index safe
  currentPage = Math.min(Math.max(1, currentPage), totalPages);

  const start = (currentPage - 1) * PER_PAGE;
  const pageRows = rows.slice(start, start + PER_PAGE);

  // render ONLY current page rows
  el.innerHTML = pageRows.map(rowHTML).join('');

  // render pagination UI (no effect on rows)
  if (typeof renderPagination === 'function') {
    renderPagination(totalPages, rows.length);
  }


  // Keep metrics visible between updates
  paintConnMetricsFromCache();
  updateConnBorder();
  renderConnectionTiles();   // 🔸 add this line
  paintCenterBox();        // ← keep this
  paintAllCenterBoxes();     // ✅ NEW: updates metrics for EVERY row


  // After first successful render, stop gating future renders
  gotInitialDevices = true;
  gotInitialPairs = true;
}

function renderPagination(totalPages, totalItems) {
  const host = document.getElementById('hubPagination');
  if (!host) return;

  // Hide pager when not needed
  if (!totalPages || totalPages <= 1) {
    host.innerHTML = '';
    return;
  }

  const mkBtn = ({ label, page, disabled = false, active = false, aria }) => {
    const base =
      'px-3 py-1.5 rounded-lg text-sm font-semibold border transition ' +
      'select-none';
    const cls = active
      ? base + ' bg-white text-black border-white'
      : base + ' bg-white/5 text-white border-white/20 hover:bg-white/10';
    const dis = disabled ? ' opacity-40 cursor-not-allowed pointer-events-none' : '';
    return `<button
      type="button"
      class="${cls}${dis}"
      data-page="${page}"
      ${aria ? `aria-label="${aria}"` : ''}
      ${active ? 'aria-current="page"' : ''}>${label}</button>`;
  };

  // Compact modern pager: Prev | 1 … (window) … N | Next
  const windowSize = 5; // show up to 5 page numbers in the middle
  const half = Math.floor(windowSize / 2);

  let start = Math.max(1, currentPage - half);
  let end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);

  const parts = [];

  parts.push(mkBtn({
    label: 'Prev',
    page: Math.max(1, currentPage - 1),
    disabled: currentPage === 1,
    aria: 'Previous page'
  }));

  // First page + leading ellipsis
  parts.push(mkBtn({ label: '1', page: 1, active: currentPage === 1, aria: 'Page 1' }));
  if (start > 2) parts.push(`<span class="px-2 text-white/60">…</span>`);

  // Middle window (avoid duplicating page 1 / last page)
  for (let p = Math.max(2, start); p <= Math.min(end, totalPages - 1); p++) {
    parts.push(mkBtn({ label: String(p), page: p, active: currentPage === p, aria: `Page ${p}` }));
  }

  // Trailing ellipsis + last page
  if (end < totalPages - 1) parts.push(`<span class="px-2 text-white/60">…</span>`);
  if (totalPages > 1) {
    parts.push(mkBtn({
      label: String(totalPages),
      page: totalPages,
      active: currentPage === totalPages,
      aria: `Page ${totalPages}`
    }));
  }

  parts.push(mkBtn({
    label: 'Next',
    page: Math.min(totalPages, currentPage + 1),
    disabled: currentPage === totalPages,
    aria: 'Next page'
  }));

  // Top row: buttons (keeps same dashboard size; only adds a small footer)
  host.innerHTML = `
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2 flex-wrap">${parts.join('')}</div>
      <div class="text-xs text-white/60">
        Showing ${(totalItems ? ((currentPage - 1) * 10 + 1) : 0)}–${Math.min(totalItems, currentPage * 10)} of ${totalItems}
      </div>
    </div>
  `;

  // Click handling (single delegated handler, replaces old one each render)
  host.onclick = (e) => {
    const btn = e.target.closest('button[data-page]');
    if (!btn) return;
    const next = Number(btn.getAttribute('data-page'));
    if (!Number.isFinite(next)) return;
    if (next === currentPage) return;

    currentPage = next;
    renderDevices(); // re-render current page only
  };
}



// ---------------- Socket wiring ----------------
let socket = null;

// Fallback to same-origin if the HTML didn't set SOCKET_URL
if (!window.SOCKET_URL) {
  window.SOCKET_URL = window.location.origin;
}
function initSocket() {
  if (!window.io) {
    console.warn('[DASHBOARD] socket.io client missing; showing static view only.');
    // Don't render immediately; no live snapshots available
    return;
  }
  if (socket) return;

  socket = io(window.SOCKET_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    timeout: 10000,
  });


  function toPairRoomId(a, b) {
    const A = String(a || '').trim();
    const B = String(b || '').trim();
    if (!A || !B) return null;

    const [x, y] = [A, B].sort((m, n) =>
      m.localeCompare(n, undefined, { sensitivity: 'base' })
    );

    return `pair:${x}:${y}`;
  }


  function buildRoomsFromMappedPairs() {
    // mappedPairs must already exist (your DB-driven mappings)
    // Try multiple shapes safely
    const rooms = [];
    const arr = Array.isArray(window.mappedPairs) ? window.mappedPairs : (Array.isArray(mappedPairs) ? mappedPairs : []);

    for (const m of arr) {
      const a = String(m.providerXrId || m.leftXrId || m.a || m.xrLeft || m.xrA || '').trim();
      const b = String(m.scribeXrId || m.rightXrId || m.b || m.xrRight || m.xrB || '').trim();

      const roomId = toPairRoomId(a, b);
      if (roomId) rooms.push(roomId);
    }
    // remove duplicates
    return [...new Set(rooms)];
  }

  function subscribeDashboardToRooms() {
    const rooms = buildRoomsFromMappedPairs();
    if (!rooms.length) {
      console.warn('[DASHBOARD] No mapped pairs yet; skipping subscribe for now.');
      return;
    }
    socket.emit('dashboard_subscribe_pairs', { roomIds: rooms });
    console.log('[DASHBOARD] subscribed to rooms:', rooms.length);
  }

  socket.on('connect', () => {
    try {
      // ✅ identify as view-only dashboard
      socket.emit('identify', { clientType: 'dashboard', deviceName: 'XR Hub Dashboard' });

      // ✅ join all pair rooms so we receive room-scoped device_list/telemetry/battery/quality
      subscribeDashboardToRooms();
    } catch { }
  });


  socket.on('device_list', (payload = []) => {
    // Support BOTH shapes:
    // 1) legacy: payload = [{xrId,...}, ...]
    // 2) new: payload = { roomId, devices: [{xrId,...}, ...] }

    const isLegacy = Array.isArray(payload);
    const roomId = isLegacy ? null : (typeof payload?.roomId === 'string' ? payload.roomId : null);

    const list = isLegacy
      ? payload
      : (Array.isArray(payload?.devices) ? payload.devices : []);

    // Build next membership for THIS room
    const nextIds = new Set();
    for (const d of list) {
      const id = (d?.xrId || '').trim();
      if (!id) continue;
      nextIds.add(id);
      onlineDevices.set(id, d); // latest snapshot
    }

    // ✅ CRITICAL: remove devices that disappeared from THIS room
    if (roomId) {
      const prev = roomMembers.get(roomId) || new Set();

      for (const oldId of prev) {
        if (!nextIds.has(oldId)) {
          onlineDevices.delete(oldId);
          batteryState.delete(oldId);
          telemetry.delete(oldId);
          lastQuality.delete(oldId);
        }
      }

      roomMembers.set(roomId, nextIds);
    }

    gotInitialDevices = true;
    renderIfReady();
  });




  socket.on('peer_left', ({ xrId } = {}) => {
    const id = (xrId || '').trim();
    if (id) {
      onlineDevices.delete(id);
      batteryState.delete(id);
      telemetry.delete(id);
    }

    renderDevices();
  });



  // Live battery updates (render immediately; post-first-paint this is fine)
  socket.on('battery_update', ({ xrId, pct, charging }) => {
    const id = (xrId || '').trim();
    if (id) batteryState.set(id, { pct, charging: !!charging });
    renderDevices();
  });


  socket.on('room_update', ({ pairs = [] } = {}) => {
    activePairs.clear();
    for (const { a, b } of pairs) activePairs.add([a, b].sort().join('|'));
    gotInitialPairs = true;
    renderIfReady(); // 🔸 first paint waits for devices too
  });

  // NEW: telemetry updates
  // socket.on('telemetry_update', (rec = {}) => {
  //   if (rec.xrId) telemetry.set(rec.xrId, rec);
  //   renderDevices();
  // });

  socket.on('telemetry_update', (data = {}) => {
    const deviceId = (data.deviceId || data.xrId || '').trim();// supports both shapes
    const sample = data.sample || data;          // supports both shapes
    if (deviceId) telemetry.set(deviceId, sample);
    renderDevices();
  });




  // ===== B) Per-device WebRTC quality: update tiles + modal =====
  socket.on('webrtc_quality_update', (payload) => {
    // Server may send: { deviceId, samples } OR an array of { xrId, ... } (legacy)
    // Normalize both shapes into an array of { xrId, ts, jitterMs, rttMs, lossPct, bitrateKbps }
    const items = [];

    if (Array.isArray(payload)) {
      // legacy: array of flat samples
      for (const s of payload) {
        const xrId = s.xrId || s.deviceId;
        if (!xrId) continue;
        items.push({
          xrId,
          ts: s.ts ?? Date.now(),
          jitterMs: s.jitterMs,
          rttMs: s.rttMs,
          lossPct: s.lossPct,
          bitrateKbps: s.bitrateKbps
        });
      }
    } else if (payload && payload.deviceId && Array.isArray(payload.samples)) {
      for (const s of payload.samples) {
        items.push({
          xrId: payload.deviceId,
          ts: s.ts ?? Date.now(),
          jitterMs: s.jitterMs,
          rttMs: s.rttMs,
          lossPct: s.lossPct,
          bitrateKbps: s.bitrateKbps
        });
      }
    } else {
      return; // unknown shape
    }

    // 1) Feed per-device rolling history (cap ~200 points)
    for (const s of items) {
      const q = getQ(s.xrId);
      q.ts.push(s.ts);
      q.jitter.push(s.jitterMs);
      q.rtt.push(s.rttMs);
      q.loss.push(s.lossPct);
      q.kbps.push(s.bitrateKbps);
      if (q.ts.length > 200) { q.ts.shift(); q.jitter.shift(); q.rtt.shift(); q.loss.shift(); q.kbps.shift(); }
    }

    // 2) Update tiles for BOTH devices
    renderConnectionTiles();
    // paintCenterBox();        // ← keep this
    paintAllCenterBoxes();   // ✅ mandatory: updates every row by data-left/data-right

    // 3) Update lastQuality cache for EVERY device in this payload
    //    (so each row can paint from cache even between updates)
    for (const s of items) {
      const xrId = (s.xrId || '').trim();
      if (!xrId) continue;

      const prev = lastQuality.get(xrId) || {};
      lastQuality.set(xrId, {
        ts: s.ts ?? Date.now(),
        bitrateKbps: Number.isFinite(s.bitrateKbps) ? s.bitrateKbps : (prev.bitrateKbps ?? null),
        jitterMs: Number.isFinite(s.jitterMs) ? s.jitterMs : (prev.jitterMs ?? null),
        lossPct: Number.isFinite(s.lossPct) ? s.lossPct : (prev.lossPct ?? null),
        rttMs: Number.isFinite(s.rttMs) ? s.rttMs : (prev.rttMs ?? null),
      });
    }

    // Paint cached metrics into EVERY row's conn-box + keep border logic
    paintAllCenterBoxes();
    updateAllConnBorders();


    // 4) If the detail modal is open for a specific device, push these points to charts
    if (window.__metricsXrId) {
      const forThis = items.filter(s => s.xrId === window.__metricsXrId);
      if (forThis.length && typeof addQualityPoints === 'function' && typeof updateAll === 'function') {
        addQualityPoints(forThis.map(s => ({
          ts: s.ts,
          jitterMs: s.jitterMs,
          rttMs: s.rttMs,
          lossPct: s.lossPct,
          bitrateKbps: s.bitrateKbps
        })));
        updateAll();
      }
    }
  });




  // ---- Detail modal + charts (NEW) ----
  const modal = document.getElementById('detailModal');
  const titleEl = document.getElementById('detailTitle');
  const closeBtn = document.getElementById('detailClose');

  let batteryChart, netChart, bitrateChart, qualityChart;


  function initCharts() {
    if (batteryChart) return;

    const timeOpts = {
      parsing: false,
      spanGaps: true, // keep lines continuous across brief gaps
      elements: {
        // remove point markers (also on hover)
        point: { radius: 0, hoverRadius: 0, hitRadius: 6 }
      },
      plugins: {
        legend: { display: true },
        // safe perf boost when many points stream in
        decimation: { enabled: true, algorithm: 'lttb', samples: 600 }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'minute' } // keep your current unit
        }
      }
    };

    batteryChart = new Chart(document.getElementById('batteryChart'), {
      type: 'line',
      data: { datasets: [{ label: 'Battery %', data: [] }] },
      options: timeOpts
    });

    netChart = new Chart(document.getElementById('netChart'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Down Mbps', data: [] },
          { label: 'Up Mbps', data: [] }
        ]
      },
      options: timeOpts
    });

    bitrateChart = new Chart(document.getElementById('bitrateChart'), {
      type: 'line',
      data: { datasets: [{ label: 'Bitrate kbps', data: [] }] },
      options: timeOpts
    });

    qualityChart = new Chart(document.getElementById('qualityChart'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Jitter ms', data: [] },
          { label: 'RTT ms', data: [] },
          { label: 'Loss %', data: [] }
        ]
      },
      options: timeOpts
    });
  }


  function openDeviceDetail(xrId, label = xrId) {
    window.__metricsXrId = xrId;
    initCharts();
    titleEl.textContent = `Device Detail – ${label}`;
    [batteryChart, netChart, bitrateChart, qualityChart].forEach(ch => {
      ch.data.datasets.forEach(ds => ds.data = []);
      ch.update();
    });
    socket.emit('metrics_subscribe', { xrId });
    modal.classList.remove('hidden');
  }

  closeBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
    if (window.__metricsXrId) {
      socket.emit('metrics_unsubscribe', { xrId: window.__metricsXrId });
      window.__metricsXrId = null;
    }
  });

  // Snapshot + live points
  socket.on('metrics_snapshot', ({ xrId, telemetry = [], quality = [] }) => {
    if (xrId !== window.__metricsXrId) return;
    addTelemetryPoints(telemetry);
    addQualityPoints(quality);
    updateAll();
  });
  socket.on('metrics_update', ({ xrId, telemetry = [], quality = [] }) => {
    if (xrId !== window.__metricsXrId) return;
    addTelemetryPoints(telemetry);
    addQualityPoints(quality);
    updateAll();
  });

  function addTelemetryPoints(arr) {
    for (const p of arr) {
      const x = p.ts;
      if (Number.isFinite(p.batteryPct)) batteryChart.data.datasets[0].data.push({ x, y: p.batteryPct });
      const down = Number.isFinite(p.wifiMbps) ? p.wifiMbps :
        Number.isFinite(p.netDownMbps) ? p.netDownMbps : null;
      const up = Number.isFinite(p.netUpMbps) ? p.netUpMbps : null;
      if (down != null) netChart.data.datasets[0].data.push({ x, y: down });
      if (up != null) netChart.data.datasets[1].data.push({ x, y: up });
    }
  }
  function addQualityPoints(arr) {
    for (const q of arr) {
      const x = q.ts;
      if (Number.isFinite(q.jitterMs)) qualityChart.data.datasets[0].data.push({ x, y: q.jitterMs });
      if (Number.isFinite(q.rttMs)) qualityChart.data.datasets[1].data.push({ x, y: q.rttMs });
      if (Number.isFinite(q.lossPct)) qualityChart.data.datasets[2].data.push({ x, y: q.lossPct });
      if (Number.isFinite(q.bitrateKbps)) bitrateChart.data.datasets[0].data.push({ x, y: q.bitrateKbps });
    }
  }
  function updateAll() {
    batteryChart.update('none');
    netChart.update('none');
    bitrateChart.update('none');
    qualityChart.update('none');
  }

  // Delegate clicks on any .device-chip[data-xr] (open device detail)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.device-chip[data-xr]');
    if (!btn) return;
    const xr = btn.getAttribute('data-xr');
    const label = btn.textContent.trim();
    currentDetailId = xr; // track for parity with A–D plan
    openDeviceDetail(xr, label);
  });

  // Guard edit/message actions when user has only READ permission on XR Hub
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.hub-edit-btn, .hub-msg-btn');
    if (!btn) return;

    if (!hasHubWritePermission()) {
      e.preventDefault();
      e.stopPropagation();
      notifyReadOnlyHub();
    }
  });

  // Re-evaluate the border every second so it auto-clears ~6s after stop/hide
  setInterval(updateConnBorder, 1000);
} // <— end of initSocket()






// ---------------- Boot ----------------
document.addEventListener('DOMContentLoaded', async () => {
  // 1) Load XR Hub permissions & lock UI if user is READ-only
  await loadHubPermissions();


  // 2) Load DB mappings so rows exist even when offline (Platform parity)
  await loadMappedPairsFromDB();

  // ✅ Render immediately (offline rows will show RED)
  renderDevices();

  applyHubReadOnlyUI();

  // 3) Now wire sockets + live telemetry (will flip colors as devices connect)
  initSocket();

  // 4) Paint date after DOM is ready and refresh it
  paintNowStamp();
  setInterval(paintNowStamp, 60 * 1000); // update every minute
});

