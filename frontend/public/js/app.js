// --------------------------------27-5:12-----/////////-------------App.js ----------------duplicate id working version ----29-08-25------------------------------------

// -------------------------------------------- --------------dashbaord and cockpit working verison============================
console.log('[INIT] Initializing DOM elements');
const videoElement = document.getElementById('xrVideo');
const statusElement = document.getElementById('status');
const deviceListElement = document.getElementById('deviceList');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const urgentCheckbox = document.getElementById('urgentCheckbox');
const recentMessagesDiv = document.getElementById('recentMessages');
const messageHistoryDiv = document.getElementById('messageHistory');
const usernameInput = document.getElementById('usernameInput');
const xrIdInput = document.getElementById('xrIdInput');
const muteBadge = document.getElementById('muteBadge');
const videoOverlay = document.getElementById('videoOverlay');
const openEmulatorBtn = document.getElementById('openEmulator');
const clearMessagesBtn = document.getElementById('clearMessagesBtn');
const XR_VISION_DOCK_SCREEN_ID = 3; // From System_Screens table
// =======================
// XR Vision Dock permissions
// =======================
let xrDockPermissions = null;  // { read, write, edit, delete } for this screen, or null if unknown

async function loadDockPermissions() {
    try {
        const res = await fetch('/api/platform/my-screens', {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });

        if (!res.ok) {
            console.warn('[PERM] my-screens error:', res.status);
            xrDockPermissions = null;
            return;
        }

        const data = await res.json();
        const screens = data?.screens || [];

        // *** FIX: ALWAYS MATCH BY SCREEN ID ***
        const match = screens.find(s => s.id === XR_VISION_DOCK_SCREEN_ID);

        if (!match) {
            console.warn('[PERM] XR Vision Dock screen ID not found, defaulting to unrestricted');
            xrDockPermissions = null;
            return;
        }

        xrDockPermissions = {
            read: !!match.read,
            write: !!match.write,
            edit: !!match.edit,
            delete: !!match.delete
        };

        console.log("[PERM] XR Vision Dock Permission Loaded:", xrDockPermissions);

    } catch (err) {
        console.warn("[PERM] Failed to load XR Vision Dock permissions:", err);
        xrDockPermissions = null;
    }
}



function hasDockWritePermission() {
    // If we couldn't load permissions, do NOT block anything (preserve existing behaviour)
    if (!xrDockPermissions) return true;
    return !!xrDockPermissions.write;
}

// Show the same message as Create User; use showToast if available.
function notifyReadOnlyXRDock() {
    const msg = 'You only have READ permission for XR Vision Dock. Editing is not allowed.';
    if (typeof showToast === 'function') {
        showToast(msg, 'error');
    } else {
        addSystemMessage(msg);
    }
}

// Disable Send / Clear / urgent toggle for read-only users
function applyDockReadOnlyUI() {
    if (!xrDockPermissions || xrDockPermissions.write) return; // nothing to lock

    console.log('[PERM] Applying read-only UI for XR Vision Dock');

    if (messageInput) {
        messageInput.readOnly = true;
        messageInput.placeholder = 'READ-ONLY: You do not have permission to send messages.';
    }
    if (urgentCheckbox) urgentCheckbox.disabled = true;
    if (sendButton) sendButton.disabled = true;
    if (clearMessagesBtn) clearMessagesBtn.disabled = true;
}


// Mirror helper for the scribe view
function setMirror(on) {
    if (!videoElement) return;
    videoElement.classList.toggle('mirror', !!on);
}

console.log('[INIT] DOM elements initialized:', {
    videoElement,
    statusElement,
    deviceListElement,
    messageInput,
    sendButton,
    urgentCheckbox,
    recentMessagesDiv,
    messageHistoryDiv,
});

let socket = null;
let peerConnection = null;
let remoteStream = null;
let clearedMessages = new Set();
let pendingIceCandidates = [];
// ✅ Option B race buffers: offer/ICE may arrive before room_joined
let pendingLocalAnswer = null;     // RTCSessionDescriptionInit
let pendingLocalIce = [];          // array of ICE candidates

let isStreamActive = false;
let reconnectTimeout = null;
let heartbeatInterval = null;
let lastDeviceList = []; // remember last list we got
let duplicateNotified = false; // notify once per session about duplicate tabs
let duplicateLock = false; // 🔒 prevents reconnect loops once server says ID is in use
// --- perfect-negotiation helpers (for safe offer handling) ---
let handlingOffer = false;          // prevent overlapping handleOffer() runs
let lastRemoteOfferSdp = '';        // drop duplicate re-sent offers


// --- Desktop network telemetry (renderer) ---
let dockTelTimer = null;

// Map 0..100 -> 0..4 "bars"
function barsFromPercent(pct) {
    if (!Number.isFinite(pct)) return null;
    return Math.max(0, Math.min(4, Math.round((pct / 100) * 4)));
}

// Collect network snapshot (works in browser/Electron renderer)
// - Uses navigator.connection when available
// - If a preload exposes systeminformation as window.si, we use that for better Wi-Fi info
async function collectDockTelemetry() {
    try {
        // Prefer preload-provided "systeminformation" if available
        if (window.si && typeof window.si.wifiConnections === 'function') {
            try {
                const wifi = await window.si.wifiConnections();
                if (Array.isArray(wifi) && wifi.length) {
                    const w = wifi[0];
                    const bars = barsFromPercent(Number(w.signalLevel)); // 0..100 -> 0..4
                    return {
                        connType: 'wifi',
                        wifiDbm: null, // many OSes don't expose dBm cross-platform
                        wifiMbps: Number.isFinite(w.txRate) ? Math.round(w.txRate) : null,
                        wifiBars: bars,
                    };
                }
                // Fall back to generic interface list
                if (typeof window.si.networkInterfaces === 'function') {
                    const nets = await window.si.networkInterfaces();
                    const active = nets.find(n => n.operstate === 'up');
                    if (active) {
                        if (active.type === 'wired') return { connType: 'ethernet' };
                        if (active.type === 'cellular') return { connType: 'cellular' };
                    }
                }
            } catch { /* ignore and fall through */ }
        }

        // Fallback: Network Information API (browser/Electron)
        const nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (nc) {
            // nc.effectiveType: 'slow-2g' | '2g' | '3g' | '4g'
            // nc.downlink: Mbps (approx)
            const eff = (nc.effectiveType || '').toLowerCase();
            const down = Number.isFinite(nc.downlink) ? Math.round(nc.downlink) : null;

            // We can’t reliably tell Wi-Fi vs Ethernet in plain browser; treat as 'wifi' if downlink present
            // If you want Ethernet label, change to 'other' here
            const connType = eff ? 'wifi' : (down ? 'wifi' : 'other');

            // No dBm in browsers; derive rough bars from downlink
            let bars = null;
            if (Number.isFinite(down)) {
                if (down >= 100) bars = 4;
                else if (down >= 30) bars = 3;
                else if (down >= 10) bars = 2;
                else if (down > 0) bars = 1;
                else bars = 0;
            }

            return {
                connType,
                wifiDbm: null,
                wifiMbps: down,
                wifiBars: bars,
            };
        }

        return { connType: 'other' };
    } catch {
        return { connType: 'other' };
    }
}





// --- Transcript aggregation state (console-only) ---
const transcriptState = {
    // key = `${from}->${to}`
    byKey: Object.create(null),
};

function transcriptKey(from, to) {
    return `${from || 'unknown'}->${to || 'unknown'}`;
}

/**
 * Merge incremental text to avoid duplicate tails.
 * If next includes prev as prefix, take next; otherwise join with maximal overlap.
 */
function mergeIncremental(prev, next) {
    if (!prev) return next || '';
    if (!next) return prev;
    if (next.startsWith(prev)) return next;
    if (prev.startsWith(next)) return prev;
    const max = Math.min(prev.length, next.length);
    let k = max;
    while (k > 0 && !prev.endsWith(next.slice(0, k))) k--;
    return prev + next.slice(k);
}


// 🔷 ROOM: track the private room we're paired into (if any)
let currentRoom = null;
let pairedPeerId = null; // set when server emits room_joined

function messageHistoryKey(roomId) {
    // If not paired yet, still isolate per XR (never global)
    const solo = `solo:${normalizeId(XR_ID || 'unknown')}`;

    return roomId
        ? `messageHistory:${roomId}`
        : `messageHistory:${solo}`;
}



// 🔒 Sticky autoconnect flag (persist across refresh)
const AUTO_KEY = 'XR_AUTOCONNECT';

// 💊 Medication availability state
const medicationAvailabilityMap = new Map();

async function checkMedicationAvailability(medications) {
    if (!Array.isArray(medications) || medications.length === 0) {
        return [];
    }

    try {
        const response = await fetch(`${SERVER_URL}/api/medications/availability`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ names: medications }),
        });

        if (!response.ok) {
            console.warn('[MED_CHECK] API returned error:', response.status);
            return [];
        }

        const data = await response.json();
        return data.results || [];
    } catch (err) {
        console.error('[MED_CHECK] Error checking medications:', err);
        return [];
    }
}

/* =========================
   ✅ ID-gating helpers (added)
   ========================= */
const ALLOWED_ID_NUM = '1238';
const ALLOWED_ID = `XR-${ALLOWED_ID_NUM}`;

function sanitizeIdInput(v) {
    // keep previous placeholder behavior + trimming
    const s = (v || '').trim();
    if (/^Dynamic_ID\(\)$/i.test(s)) return '';
    return s;
}
function normalizeId(v) {
    // accept "1238" or "XR-1238", normalize to "XR-1238"
    const s = sanitizeIdInput(v);
    if (!s) return '';
    if (/^\d+$/.test(s)) return `XR-${s}`;
    const up = s.toUpperCase();
    return up.startsWith('XR-') ? up : s;
}
function isAllowedId(id) {
    return normalizeId(id) === ALLOWED_ID;
}

// 🔄 Fresh-start control
let manualDisconnect = false;     // true only when user clicks Disconnect
let ignoreHistoryOnce = false;    // drop server history just for the next connect
const CLEAR_KEY = 'XR_CLEAR_ON_NEXT_CONNECT'; // '1' => wipe on next connect

// ---------------- CONFIG ----------------
console.log('[CONFIG] Loading configuration');

/**
 * Priority (first non-null wins):
 * 1) ?signal=...                      (handy for phone tests over HTTPS)
 * 2) localStorage('signal_url')       (remember last explicit override)
 * 3) location.origin                  (SAME-ORIGIN: http://localhost:8080, https://<ngrok>, or prod URL)
 *
 * NOTE: We deliberately removed any fallback to :3000 or hardcoded ngrok.
 */
const __qp = new URLSearchParams(location.search);
const __signalOverride = __qp.get('signal');

let __stored = null;
try { __stored = localStorage.getItem('signal_url') || null; } catch { }

const __sameOrigin = window.location.origin;

// Final hub URL
const SERVER_URL = __signalOverride || __stored || __sameOrigin;

// Remember explicit override for next time
if (__signalOverride) {
    try { localStorage.setItem('signal_url', SERVER_URL); } catch { }
}

console.log('[CONFIG] Server URL:', SERVER_URL);


/* ------------- XR_ID / NAME init (updated) ------------- */
// XR ID is editable from the front-end before connecting

// ========================================
// Start empty unless the user types it (no default to XR-1238)
let XR_ID = normalizeId(xrIdInput.value) || '';
let DEVICE_NAME = (usernameInput.value || '').trim() || 'Desktop';
if (isAllowedId(XR_ID)) {
    DEVICE_NAME = `Desktop${ALLOWED_ID_NUM}`;
}


console.log('[CONFIG] Server URL:', SERVER_URL);

console.log('[CONFIG] XR ID (initial):', XR_ID);
console.log('[CONFIG] Device Name:', DEVICE_NAME);

// Peer-ID mapping: LEGACY fallback only.
// Option B: the server tells us the peer via room_joined members (pairedPeerId).
function mapPeerId(desktopId) {
    // ✅ Prefer server-determined peer (Option B)
    if (pairedPeerId) return pairedPeerId;

    // ✅ Legacy fallback only (avoid hardcoding XR-1234)
    // If you truly need a manual mapping for older setups, implement it here.
    // Returning null is safer than returning the wrong peer.
    return null;
}

function currentPeerId() {
    // Option B: peer is determined by server (room_joined members)
    return pairedPeerId || null;
}



/* =========================
   📣 Cross‑tab presence (duplicate guard)
   ========================= */
const TAB_ID = Math.random().toString(36).slice(2);
let presenceChan = null;
let duplicateActive = false;
let presencePingInterval = null;

function openPresenceChannel() {
    if (presenceChan) try { presenceChan.close(); } catch { }
    presenceChan = new BroadcastChannel('xr-presence');

    presenceChan.onmessage = (e) => {
        const msg = e.data || {};
        // ignore self
        if (msg.tabId === TAB_ID) return;

        // only care about our target ID (XR-1238)
        if (!isAllowedId(msg.xrId)) return;

        if (msg.type === 'who') {
            // another tab is probing: answer with our state
            presenceChan.postMessage({
                type: 'presence',
                xrId: XR_ID,
                tabId: TAB_ID,
                state: socket?.connected ? 'connected' : 'idle',
            });
        } else if (msg.type === 'presence') {
            // we received another tab's presence; if it's connected on the same allowed ID, flag duplicate
            if (msg.state === 'connected') {
                duplicateActive = true;
            }
        }
    };
}

function announcePresence(state = (socket?.connected ? 'connected' : 'idle')) {
    presenceChan?.postMessage({
        type: 'presence',
        xrId: XR_ID,
        tabId: TAB_ID,
        state,
    });
}

function startPresencePings() {
    if (presencePingInterval) clearInterval(presencePingInterval);
    presencePingInterval = setInterval(() => {
        announcePresence(socket?.connected ? 'connected' : 'idle');
    }, 4000);
}

function stopPresencePings() {
    if (presencePingInterval) {
        clearInterval(presencePingInterval);
        presencePingInterval = null;
    }
}

/* ------------- XR ID change listener (Option B) ------------- */
xrIdInput.addEventListener('change', () => {
    // Read and normalize the latest input (no fallback to XR-1238)
    const newId = normalizeId(xrIdInput.value);
    XR_ID = newId;

    // user changed ID → allow attempts again
    duplicateLock = false;

    // Option B: do NOT restrict XR_ID here, and do NOT auto-connect on change.
    DEVICE_NAME = XR_ID ? `Desktop${String(XR_ID).replace(/^XR-/i, '')}` : 'Desktop';
    addSystemMessage(`✅ ID set to ${XR_ID || '(empty)'}.`);

    // If connected already, require manual disconnect/reconnect to apply the new ID safely
    if (socket?.connected) {
        addSystemMessage('ℹ️ XR ID changed while connected. Please Disconnect and Connect again to use the new ID.');
        setStatus('Connected');
        announcePresence('connected');
        return;
    }

    // If not connected, just reflect UI state (toggle button will connect)
    setStatus('Disconnected');
    announcePresence('idle');
});


// ---------------- Status pill ----------------
function setStatus(status) {
    console.log('[STATUS] Updating status to:', status);
    statusElement.textContent = status;
    statusElement.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
    switch ((status || '').toLowerCase()) {
        case 'connected':
            console.log('[STATUS] Setting connected state');
            statusElement.classList.add('bg-green-500');
            break;
        case 'connecting':
            console.log('[STATUS] Setting connecting state');
            statusElement.classList.add('bg-yellow-500');
            break;
        case 'disconnected':
            console.log('[STATUS] Setting disconnected state');
            statusElement.classList.add('bg-red-600');
            break;
        default:
            console.log('[STATUS] Setting default (connecting) state');
            statusElement.classList.add('bg-yellow-500');
    }
}



// ---- Heartbeat helpers ----
function startHeartbeat() {
    console.log('[HEARTBEAT] Starting heartbeat interval');
    if (heartbeatInterval) {
        console.log('[HEARTBEAT] Clearing existing heartbeat interval');
        clearInterval(heartbeatInterval);
    }
    heartbeatInterval = setInterval(() => {
        if (socket?.connected) {
            console.log('[HEARTBEAT] Sending ping to server');
            socket.emit('ping');
        } else {
            console.log('[HEARTBEAT] Socket not connected - skipping ping');
        }
    }, 25000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        console.log('[HEARTBEAT] Stopped heartbeat');
    }
}

// ---------------- Helpers ----------------
function wipeLocalMessages(reason = '') {
    try {
        console.log('[CHAT] Wiping local messages', reason ? `(${reason})` : '');
        if (messageHistoryDiv) messageHistoryDiv.innerHTML = '';
        if (recentMessagesDiv) recentMessagesDiv.innerHTML = '';
        clearedMessages = new Set();
    } catch (e) {
        console.warn('[CHAT] wipeLocalMessages failed:', e);
    }
}

// ---------------- Manual init (no auto-connect) ----------------
function initSocket() {
    if (socket) return; // init once
    console.log('[SOCKET] Initializing Socket.IO client (manual connect mode)');
    setStatus('Disconnected');

    socket = io(SERVER_URL, {
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        secure: (location.protocol === 'https:'),
        autoConnect: false, // 🔴 start DISCONNECTED; we control dial
    });

    // --- lifecycle events ---
    socket.on('connect', () => {
        // 🔐 Block accidental connects if ID isn't allowed OR a duplicate tab is active
        duplicateActive = false;
        presenceChan?.postMessage({ type: 'who', xrId: XR_ID, tabId: TAB_ID });

        // Defer the rest of the connect flow until presence check returns
        setTimeout(() => {
            // Only block duplicates; do NOT hardcode XR-1238
            if (!XR_ID) {
                addSystemMessage('❌ Please enter an XR ID before connecting.');
                try { localStorage.setItem(AUTO_KEY, '0'); } catch { }
                if (socket?.io) socket.io.opts.reconnection = false;
                socket.disconnect();
                setStatus('Disconnected');
                announcePresence('idle');
                return;
            }

            if (duplicateActive) {
                addSystemMessage('⚠️ This XR ID is already active in another tab/window. Disconnecting…');
                try { localStorage.setItem(AUTO_KEY, '0'); } catch { }
                if (socket?.io) socket.io.opts.reconnection = false;
                socket.disconnect();
                setStatus('Disconnected');
                announcePresence('idle');
                return;
            }


            console.log('[SOCKET] ✅ Connected');
            loadMessageHistory();

            // If previous session requested a fresh start, wipe now and ignore server history once
            try {
                if (localStorage.getItem(CLEAR_KEY) === '1') {
                    wipeLocalMessages('fresh connect (CLEAR_KEY=1)');
                    ignoreHistoryOnce = true;                   // drop upcoming message_history once
                    localStorage.setItem(CLEAR_KEY, '0');       // consume the flag
                }
            } catch (e) {
                console.warn('[CLEAR] Failed to read/clear CLEAR_KEY:', e);
            }

            setStatus('Connecting');
            console.log('[STATUS] socket connected -> Connecting (waiting for room_joined)');


            // keep refresh-safe autoconnect behavior
            try { localStorage.setItem(AUTO_KEY, '1'); } catch { }

            const payload = { deviceName: DEVICE_NAME, xrId: XR_ID };
            console.log('[SOCKET] Emitting identify + request_device_list', payload);
            socket.emit('identify', payload);
            // socket.emit('request_device_list');

            console.log('[PAIR] Option B: waiting for server auto-pair (room_joined)');


            if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
            startHeartbeat();
            announcePresence('connected');

            // 🔵 Start desktop network telemetry (every ~12s)
            if (dockTelTimer) clearInterval(dockTelTimer);
            dockTelTimer = setInterval(async () => {
                const snap = await collectDockTelemetry();
                const payload = { xrId: XR_ID, ...snap, ts: Date.now() };
                try { socket.emit('telemetry', payload); } catch { }
            }, 12_000);

            // Push one immediately on connect (nice for first render)
            (async () => {
                const snap = await collectDockTelemetry();
                const payload = { xrId: XR_ID, ...snap, ts: Date.now() };
                try { socket.emit('telemetry', payload); } catch { }
            })();

            const nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (nc && typeof nc.addEventListener === 'function') {
                try {
                    nc.addEventListener('change', async () => {
                        const snap = await collectDockTelemetry();
                        socket?.emit('telemetry', { xrId: XR_ID, ...snap, ts: Date.now() });
                    });
                } catch { }
            }
        }, 250);
    });

    socket.io.on('reconnect', (attempt) => {
        console.log('[SOCKET] 🔄 Reconnected. attempt=', attempt);
        const payload = { deviceName: DEVICE_NAME, xrId: XR_ID };
        socket.emit('identify', payload);
        // socket.emit('request_device_list');

        // On reconnect, try to re-pair if room was lost
        if (!currentRoom) {
            console.log('[PAIR] Option B: waiting for server auto-pair (room_joined)');

        }

        startHeartbeat();
        announcePresence('connected');
    });

    socket.on('connect_error', (err) => {
        console.warn('[SOCKET] connect_error:', err?.message || err);
        setStatus('Disconnected');
        stopHeartbeat();
        announcePresence('idle');
    });

    socket.on('disconnect', (reason) => {
        console.warn('[SOCKET] disconnected:', reason);
        setStatus('Disconnected');
        stopHeartbeat();

        if (manualDisconnect) {
            console.log('[SOCKET] Manual disconnect completed');
        } else {
            console.log('[SOCKET] Non-manual disconnect (e.g. refresh or network) — preserving messages');
        }

        currentRoom = null;
        pairedPeerId = null;
        manualDisconnect = false;

        // ✅ IMPORTANT: clear UI, don’t re-render stale server list while disconnected
        lastDeviceList = [];
        updateDeviceList([]);

        announcePresence('idle');

        if (dockTelTimer) { clearInterval(dockTelTimer); dockTelTimer = null; }
    });


    socket.on('error', (data) => {
        // If the server warns about duplicate desktops, surface that to the UI
        if (data?.message?.includes('Duplicate desktop')) {
            console.warn('[SOCKET] Duplicate desktop notice from server:', data.message);
            addSystemMessage('⚠️ This XR ID is already active in another tab/window.');
        }
    });

    // 🔒 Global duplicate block from server (works across laptops/phones)
    socket.on('duplicate_id', ({ xrId, holderInfo }) => {
        console.warn('[SOCKET] duplicate_id from server:', xrId, holderInfo);
        duplicateLock = true;                    // stop future attempts with this ID
        try { localStorage.setItem(AUTO_KEY, '0'); } catch { }
        addSystemMessage(`❌ XR ID ${xrId} is already in use on another device/session.`);
        if (socket?.io) {
            socket.io.opts.reconnection = false;   // prevent auto-retries
            socket.io.opts.autoConnect = false;
        }
        if (socket?.connected) socket.disconnect();
        setStatus('Disconnected');
        announcePresence('idle');
    });

    // --- 🔎 server -> browser debug channel (temporary) ---
    socket.on("debug_log", (d) => {
        console.log("SERVER DEBUG:", d?.msg, d);
    });



    // --- your existing handlers ---
    socket.on('signal', handleSignalMessage);
    socket.on('message', handleChatMessage);
    socket.on('device_list', (payload = []) => {
        // Support BOTH shapes:
        // 1) legacy: payload = [{xrId,...}, ...]
        // 2) new:    payload = { roomId, devices: [{xrId,...}, ...] }

        const isLegacy = Array.isArray(payload);
        const roomIdFromPayload = isLegacy
            ? null
            : (typeof payload?.roomId === 'string' ? payload.roomId : null);

        const devices = isLegacy
            ? payload
            : (Array.isArray(payload?.devices) ? payload.devices : []);

        // Ignore device_list for other rooms (prevents overwriting UI during reconnect races)
        if (roomIdFromPayload && currentRoom && roomIdFromPayload !== currentRoom) {
            console.log('[SOCKET] device_list ignored (wrong room)', {
                currentRoom,
                roomIdFromPayload,
                len: devices.length
            });
            return;
        }

        console.log('[SOCKET] device_list event received', {
            currentRoom,
            roomIdFromPayload,
            len: devices.length
        });
        updateDeviceList(devices);
    });

    socket.on('control', handleControlCommand);
    socket.on('message-cleared', handleMessagesCleared);
    socket.on('message_history', handleMessageHistory);

    // --- 🔷 ROOM events ---
    socket.on('pair_error', ({ message }) => {
        console.warn('[PAIR] pair_error:', message);
        addSystemMessage(`Pair error: ${message}`);
    });

    socket.on('room_joined', ({ roomId, members }) => {
        console.log('[PAIR] room_joined:', roomId, members);

        // 1) Authoritative room routing
        currentRoom = roomId || null;
        console.log('[PAIR] currentRoom set', { currentRoom });
        // ✅ Load ONLY this room’s local history (clears old XR-9002 UI too)
        loadMessageHistory(currentRoom);

        // ✅ Ask server for authoritative room-scoped history
        socket.emit('message_history');



        // 2) Determine peer safely
        try {
            const me = normalizeId(XR_ID);
            const other = Array.isArray(members)
                ? members.map(normalizeId).find(m => m && m !== me)
                : null;

            pairedPeerId = other || pairedPeerId || null;
            console.log('[PAIR] pairedPeerId =', pairedPeerId);

            // ✅ Ask server for authoritative room-scoped list
            try { socket?.emit('request_device_list'); } catch (e) {
                console.warn('[DEVICES] request_device_list failed:', e);
            }

        } catch (e) {
            console.warn('[PAIR] failed to derive pairedPeerId:', e);
            pairedPeerId = null;
        }

        // 3) Safe message
        const memList = Array.isArray(members) ? members.join(', ') : '';
        addSystemMessage(`🎯 VR Room created: ${roomId}.${memList ? ` Members: ${memList}` : ''}`);

        // // 4) Clear UI immediately; device_list will repaint shortly
        console.log('[DEVICES] room_joined -> clearing UI; will repaint on device_list');
        updateDeviceList([]);


        // ✅ pairing complete = connected (AFTER room + request + UI clear)
        setStatus('Connected');

        // ---- WebRTC flush unchanged ----
        if (pendingLocalAnswer && socket?.connected) {
            try {
                socket.emit('signal', { type: 'answer', from: XR_ID, roomId: currentRoom, data: pendingLocalAnswer });
                console.log('[WEBRTC] Flushed buffered answer after room_joined');
            } catch (e) {
                console.warn('[WEBRTC] Failed to flush buffered answer:', e);
            }
            pendingLocalAnswer = null;
        }

        if (Array.isArray(pendingLocalIce) && pendingLocalIce.length && socket?.connected) {
            const queued = pendingLocalIce.slice();
            pendingLocalIce.length = 0;
            for (const c of queued) {
                try {
                    socket.emit('signal', { type: 'ice-candidate', from: XR_ID, roomId: currentRoom, data: c });
                } catch (e) {
                    console.warn('[WEBRTC] Failed to flush buffered ICE:', e);
                }
            }
            console.log('[WEBRTC] Flushed buffered ICE after room_joined:', queued.length);
        }

        // ---- Deferred start unchanged ----
        const startWasDeferred = (window.__startWasClickedBeforePair === true);
        if (startWasDeferred) {
            console.log('[PAIR] releasing deferred start after room_joined');
            window.__startWasClickedBeforePair = false;
            try { startStream(); } catch (e) { console.warn('[PAIR] deferred startStream failed:', e); }
        }

        if (startWasDeferred) {
            try { socket?.emit('signal', { type: 'request_offer', from: XR_ID, roomId: currentRoom }); } catch { }
        }
    });



    socket.on('peer_left', ({ xrId, roomId }) => {
        console.log('[PAIR] peer_left', xrId, roomId);

        if (currentRoom === roomId) {
            addSystemMessage(`${xrId} left the room.`);
            currentRoom = null;
            pairedPeerId = null;

            stopStream();

            // ✅ do NOT reuse lastDeviceList here
            updateDeviceList([]);

            // optional: only if connected
            if (socket?.connected) {
                try { socket.emit('request_device_list'); } catch { }
            }
        }
    });


}

// ---------------- Clickable status pill: Connect/Disconnect ----------------
function toggleConnection() {
    if (!socket) initSocket();

    // Always read the latest input
    // XR_ID = normalizeId(xrIdInput.value) || ALLOWED_ID;
    // ============================================================
    XR_ID = normalizeId(xrIdInput.value);

    if (duplicateLock) {
        addSystemMessage('🚫 This XR ID is already active elsewhere. Choose a different ID or disconnect the other session.');
        setStatus('Disconnected');
        announcePresence('idle');
        return;
    }


    if (socket.connected) {
        console.log('[SOCKET] Manual disconnect requested');
        manualDisconnect = true;                 // mark user-initiated
        try {
            localStorage.setItem(AUTO_KEY, '0');   // block future auto-connects
        } catch { }
        // Hard-disable reconnection until user explicitly connects
        if (socket?.io) socket.io.opts.reconnection = false;

        wipeLocalMessages('manual disconnect');
        socket.disconnect();
        setStatus('Disconnected');
        announcePresence('idle');
        return;
    }

    // Not connected -> require a non-empty XR ID (Option B allows any XR ID)
    if (!XR_ID) {
        addSystemMessage('Please enter the XR ID to connect (e.g., XR-8005).');
        try { localStorage.setItem(AUTO_KEY, '0'); } catch { }
        setStatus('Disconnected');
        announcePresence('idle');
        return;
    }


    // 🔎 Probe other tabs for duplicates before connecting
    duplicateActive = false;
    presenceChan?.postMessage({ type: 'who', xrId: XR_ID, tabId: TAB_ID });

    setStatus('Checking…');
    setTimeout(() => {
        if (duplicateActive) {
            addSystemMessage('⚠️ This XR ID is already active in another tab/window.');
            try { localStorage.setItem(AUTO_KEY, '0'); } catch { }
            setStatus('Disconnected');
            announcePresence('idle');
            return;
        }

        console.log('[SOCKET] Manual connect requested with allowed ID:', XR_ID);
        // Re-enable reconnection for active sessions
        if (socket?.io) socket.io.opts.reconnection = true;

        setStatus('Connecting');
        try { localStorage.setItem(AUTO_KEY, '1'); } catch { }
        socket.connect();
    }, 300); // small window to receive presence replies
}

// Make the status chip clickable
statusElement.style.cursor = 'pointer';
statusElement.title = 'Click to connect / disconnect';
statusElement.addEventListener('click', toggleConnection);

// Ensure refresh keeps autoconnect if currently connected
window.addEventListener('beforeunload', () => {
    try {
        if (socket?.connected) {
            localStorage.setItem(AUTO_KEY, '1');
            console.log('[AUTO] beforeunload: XR_AUTOCONNECT kept as 1');
        }
    } catch (e) {
        console.warn('[AUTO] beforeunload: failed to persist XR_AUTOCONNECT:', e);
    }
});


// ---------- Persistent BroadcastChannels ----------
const transcriptBC = new BroadcastChannel('scribe-transcript');
const soapBC = new BroadcastChannel('scribe-soap-note');

function handleSignalMessage(data) {
    const type = data?.type;
    console.log('[SIGNAL] Received signal message:', type);

    // ---------- Transcript handling ----------
    if (type === 'transcript_console') {
        const p = data.data || {};
        const { from, to, text = '', final = false, timestamp } = p;

        const key = transcriptKey(from, to);
        const slot = (transcriptState.byKey[key] ||= {
            partial: '',
            paragraph: '',
            flushTimer: null,
            lastTs: 0,
        });

        if (!final) {
            slot.partial = text;
            slot.lastTs = Date.parse(timestamp) || Date.now();
            return;
        }

        const mergedFinal = mergeIncremental(slot.partial, text);
        slot.partial = '';

        slot.paragraph = mergeIncremental(slot.paragraph ? slot.paragraph + ' ' : '', mergedFinal);

        if (slot.flushTimer) clearTimeout(slot.flushTimer);
        slot.flushTimer = setTimeout(() => {
            if (slot.paragraph) {
                console.log(`[TRANSCRIPT] ${timestamp} final ${from} -> ${to}: "${slot.paragraph}"`);
                transcriptBC.postMessage({
                    type: 'transcript_console',
                    data: { from, to, text: slot.paragraph, final: true, timestamp },
                });
                slot.paragraph = '';
            }
            slot.flushTimer = null;
        }, 1200);

        return;
    }

    // ---------- SOAP Note handling ----------
    if (type === 'soap_note_console') {
        const soap = data.data || {};
        const ts = data.timestamp || Date.now();

        console.log('[SOAP_NOTE] Received:', JSON.stringify(soap, null, 2));
        soapBC.postMessage({
            type: 'soap_note_console',
            data: soap,
            timestamp: ts,
        });

        return; // prevent fallthrough
    }

    // ---------- Drug Availability handling ----------
    if (type === 'drug_availability' || type === 'drug_availability_console') {
        const results = data.data || [];
        console.log('[DRUG_AVAILABILITY] Received drug availability:', results);

        medicationAvailabilityMap.clear();
        results.forEach(item => {
            const name = item.query || item.name || '';
            const available = item.status === 'exists' || item.available === true;
            if (name) {
                medicationAvailabilityMap.set(name.toLowerCase().trim(), available);
            }
            const status = available ? '✓ AVAILABLE' : '✖ NOT FOUND';
            console.log(`[DRUG_AVAILABILITY] ${name}: ${status}`, item.matched ? `(matched as: ${item.matched})` : '');
        });

        return; // prevent fallthrough
    }

    // ---------- Existing WebRTC signaling ----------
    switch (type) {
        case 'offer':
            console.log('[WEBRTC] 📞 Received offer from peer');
            handleOffer(data.data);
            break;
        case 'ice-candidate':
            console.log('[WEBRTC] ❄️ Received ICE candidate from peer');
            handleRemoteIceCandidate(data.data);
            break;
        case 'answer':
            console.log('[WEBRTC] Received answer (unexpected for desktop) – ignoring');
            break;
        default:
            console.log('[WEBRTC] Unhandled signal type:', type);
    }
}




function handleChatMessage(msg) {
    console.log('[CHAT] Received chat message:', msg);

    const normalized = normalizeMessage(msg);

    // ✅ preserve roomId (server includes it OR fall back to currentRoom)
    const roomId = msg?.roomId || currentRoom;
    addMessageToHistory({ ...normalized, roomId });

    addToRecentMessages({ ...normalized, roomId });
}


function handleMessagesCleared(data) {
    if (!clearedMessages.has(data.messageId)) {
        console.log('[CHAT] Messages cleared by', data.by, 'messageId:', data.messageId);
        clearedMessages.add(data.messageId);
        addSystemMessage(`🧹 Messages cleared by ${data.by}`);
        recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
    } else {
        console.log('[CHAT] Already processed clear message for messageId:', data.messageId);
    }
}

function handleMessageHistory(data) {
    if (ignoreHistoryOnce) {
        console.log('[CHAT] Dropping server message_history once for fresh start');
        ignoreHistoryOnce = false;
        return;
    }

    const roomId = data?.roomId || currentRoom;   // ✅ authoritative
    const msgs = Array.isArray(data?.messages) ? data.messages : [];

    console.log('[CHAT] Received message_history', { roomId, count: msgs.length });

    // ✅ Safety: if server history is for a different room, ignore it
    if (roomId && currentRoom && roomId !== currentRoom) {
        console.warn('[CHAT] Ignoring message_history for stale room', { roomId, currentRoom });
        return;
    }

    msgs.forEach((msg) => {
        const normalized = normalizeMessage(msg);

        // ✅ preserve roomId so storage goes to the correct key
        addMessageToHistory({ ...normalized, roomId });
    });
}

function createPeerConnection() {
    console.log('[WEBRTC] Creating new peer connection');

    const turnConfig = window.TURN_CONFIG || {};
    console.log('[WEBRTC] TURN config:', turnConfig);

    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
    ];

    if (turnConfig.urls && turnConfig.username && turnConfig.credential) {
        iceServers.push({
            urls: turnConfig.urls,
            username: turnConfig.username,
            credential: turnConfig.credential,
        });
        console.log('[WEBRTC] Added TURN server to ICE configuration');
    }

    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
    console.log('[WEBRTC] Peer connection created with ICE servers:', iceServers);

    // 🔽 INSERT THIS FLAG (scoped to this call)
    let qualityStarted = false;

    if (typeof window.startWebRtcQualityMonitor !== 'function') {
        console.warn('[QUALITY] webrtc-quality.js not loaded (startWebRtcQualityMonitor missing)');
    }



    // Start WebRTC quality sampling as soon as we get the first remote track
    pc.ontrack = (event) => {
        console.log('[WEBRTC] Received track:', event.track.kind);

        if (!remoteStream) {
            console.log('[WEBRTC] Creating new remote stream');
            remoteStream = new MediaStream();
            videoElement.srcObject = remoteStream;
            videoElement.muted = true;
            setMirror(true);
            // iOS autoplay/rendering requirements
            videoElement.playsInline = true;
            videoElement.autoplay = true;
            videoElement.setAttribute('playsinline', '');
            videoElement.setAttribute('autoplay', '');
            // mirror for front-cam view
        }

        if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
            console.log('[WEBRTC] Adding track to remote stream');
            remoteStream.addTrack(event.track);
        }

        videoElement.play().catch((e) => {
            if (e && e.name === 'AbortError') {
                console.debug('[WEBRTC] play() aborted (teardown race) — safe to ignore');
            } else {
                console.warn('[WEBRTC] Video play error:', e);
                showClickToPlayOverlay();
            }
        });
    };



    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('[WEBRTC] Generated ICE candidate:', event.candidate);

            // Option B: Do not emit ICE until we have a server-issued pair room.
            // Otherwise ICE gets dropped server-side and the video stays black after reconnect.
            if (!currentRoom) {
                console.warn('[WEBRTC] ICE generated before room_joined; queueing until paired');
                (pendingLocalIce ||= []).push(event.candidate);
                return;
            }


            socket?.emit('signal', {
                type: 'ice-candidate',
                from: XR_ID,
                roomId: currentRoom,
                data: event.candidate,
            });

        } else {
            console.log('[WEBRTC] ICE gathering complete');
        }
    };




    pc.oniceconnectionstatechange = () => {
        console.log('[WEBRTC] ICE connection state changed:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            console.log('[WEBRTC] ICE connection failed or disconnected - stopping stream');
            stopStream();


        }
    };



    pc.onconnectionstatechange = () => {
        console.log('[WEBRTC] Connection state changed:', pc.connectionState);

        if (pc.connectionState === 'connected') {
            setStatus('Connected');

            // Start the quality monitor once per session
            if (!qualityStarted) {
                qualityStarted = true;
                console.log('[QUALITY] starting monitor…');

                // stop any previous sampler defensively
                if (window.__stopQuality) { try { window.__stopQuality(); } catch { } }

                window.__stopQuality = window.startWebRtcQualityMonitor(pc, {
                    intervalMs: 3000, // sample every ~3s
                    onSample: (s) => {
                        // 1) Existing dashboard summary (small Jitter/Loss/RTT tiles)
                        try {
                            const id = (typeof XR_ID !== 'undefined' && XR_ID) ? XR_ID : 'XR-1238';
                            (window.socket || socket)?.emit('webrtc_quality', {
                                xrId: id,
                                ts: Date.now(),
                                jitterMs: s.jitterMs,
                                lossPct: s.lossPct,
                                rttMs: s.rttMs,
                                bitrateKbps: s.bitrateKbps ?? null,
                                fps: s.fps,
                                dropped: s.dropped,
                                nackCount: s.nackCount
                            });
                        } catch { }

                        // 2) NEW: time-series modal (battery/net/bitrate/jitter/rtt/loss)
                        try {
                            (window.socket || socket)?.emit('quality_stats', {
                                xrId: (pairedPeerId || currentPeerId() || XR_ID),
                                ts: Date.now(),
                                jitterMs: s.jitterMs ?? null,
                                rttMs: s.rttMs ?? null,
                                lossPct: s.lossPct ?? null,
                                // include if your monitor exposes it; otherwise fine to be null
                                bitrateKbps: s.bitrateKbps ?? null,
                            });
                        } catch { }
                    }
                });
            }

        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            console.log('[WEBRTC] Connection failed or disconnected - stopping stream');

            // Stop the quality monitor when leaving connected
            if (window.__stopQuality) {
                try { window.__stopQuality(); } catch { }
                window.__stopQuality = null;
            }
            qualityStarted = false;

            stopStream();
            setStatus('Connecting');
        }
    };






    isStreamActive = true;
    return pc;
}


async function handleOffer(offer) {
    console.log('[WEBRTC] Handling offer:', offer);

    // 1) serialize offer handling so two offers can't overlap
    if (handlingOffer) {
        console.log('[WEBRTC] Offer handler busy; ignoring this offer.');
        return;
    }
    handlingOffer = true;

    try {
        // 2) make sure we have a PC (no stop/recreate here)
        if (!peerConnection) {
            peerConnection = createPeerConnection();
        }

        const desc = new RTCSessionDescription(offer);

        // 3) ignore exact duplicate offers we've already applied
        if (peerConnection.remoteDescription?.sdp === desc.sdp || lastRemoteOfferSdp === desc.sdp) {
            console.log('[WEBRTC] Duplicate offer SDP; skipping.');
            return;
        }

        // 4) perfect-negotiation: if we had a local offer, roll it back first
        if (peerConnection.signalingState === 'have-local-offer') {
            try { await peerConnection.setLocalDescription({ type: 'rollback' }); } catch { }
        }

        // 5) apply the remote offer
        console.log('[WEBRTC] Setting remote description');
        await peerConnection.setRemoteDescription(desc);
        lastRemoteOfferSdp = desc.sdp;
        // ✅ NEW: flush any ICE that arrived before PC/remote description was ready
        if (pendingIceCandidates && pendingIceCandidates.length) {
            console.log('[WEBRTC] Flushing buffered ICE:', pendingIceCandidates.length);
            const queued = pendingIceCandidates.slice();
            pendingIceCandidates.length = 0;
            for (const c of queued) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(c));
                } catch (e) {
                    console.warn('[WEBRTC] Failed to apply buffered ICE:', e);
                }
            }
        }


        // Prefer H.264 when answering (iOS Safari camera sends H.264 best)
        try {
            const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
            if (caps && Array.isArray(caps.codecs)) {
                const h264 = caps.codecs.filter(c => (c.mimeType || '').toLowerCase() === 'video/h264');
                if (h264.length && typeof peerConnection.getTransceivers === 'function') {
                    for (const t of peerConnection.getTransceivers()) {
                        if (t.receiver && t.receiver.track && t.receiver.track.kind === 'video' &&
                            typeof t.setCodecPreferences === 'function') {
                            t.setCodecPreferences(h264);
                        }
                    }
                }
            }
        } catch {/* never block negotiation for this */ }


        // 6) only answer when the state is exactly have-remote-offer
        if (peerConnection.signalingState !== 'have-remote-offer') {
            console.log('[WEBRTC] Not in have-remote-offer (state =', peerConnection.signalingState, ') — skipping answer.');
            return;
        }

        console.log('[WEBRTC] Creating answer');
        const answer = await peerConnection.createAnswer();

        console.log('[WEBRTC] Setting local description');
        await peerConnection.setLocalDescription(answer);

        // Option B: Don't emit answer until paired room exists.
        if (!currentRoom) {
            console.warn('[WEBRTC] Have answer ready but no currentRoom yet; buffering until room_joined');
            pendingLocalAnswer = peerConnection.localDescription;
            return;
        }


        const payload = {
            type: 'answer',
            from: XR_ID,
            roomId: currentRoom,
            data: peerConnection.localDescription,
        };


        console.log('[WEBRTC] Emitting signal (answer):', payload);
        socket?.emit('signal', payload);


        console.log('[WEBRTC] Answer sent to peer');

    } catch (err) {
        console.error('[WEBRTC] Error handling offer:', err);
        // No teardown here; let the next clean offer repair the session.
    } finally {
        handlingOffer = false;
    }
}



async function handleRemoteIceCandidate(candidate) {
    console.log('[WEBRTC] Handling remote ICE candidate:', candidate);
    if (peerConnection && peerConnection.remoteDescription && candidate && candidate.candidate) {

        try {
            console.log('[WEBRTC] Adding ICE candidate to peer connection');
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error('[WEBRTC] Error adding ICE candidate:', err);
        }
    } else if (candidate) {
        console.log('[WEBRTC] Buffering ICE candidate for later');
        pendingIceCandidates.push(candidate);
    }
}

function stopStream() {
    console.log('[STREAM] Stopping stream');
    isStreamActive = false;

    if (videoElement) {
        console.log('[STREAM] Pausing and clearing video element');
        try {
            videoElement.pause();
        } catch (e) { }
        videoElement.srcObject = null;
        videoElement.removeAttribute('src');
        try {
            videoElement.load();
        } catch (e) { }
    }

    if (muteBadge) {
        console.log('[STREAM] Hiding mute badge');
        muteBadge.style.display = 'none';
    }

    if (videoOverlay) {
        console.log('[STREAM] Hiding video overlay');
        videoOverlay.style.display = 'none';
    }

    if (peerConnection) {
        console.log('[STREAM] Closing peer connection');
        try {
            peerConnection.close();
        } catch (e) {
            console.warn('[STREAM] Error closing peer connection:', e);
        }
        peerConnection = null;
    }

    if (remoteStream) {
        console.log('[STREAM] Stopping remote stream tracks');
        remoteStream.getTracks().forEach((track) => {
            try {
                track.stop();
            } catch (e) {
                console.warn('[STREAM] Error stopping track:', e);
            }
        });
        remoteStream = null;
    }

    pendingIceCandidates = [];
    pendingLocalAnswer = null;
    pendingLocalIce = [];


    // ✅ Stop quality monitor
    if (window.__stopQuality) {
        try { window.__stopQuality(); } catch { }
        window.__stopQuality = null;
    }
    console.log('[STREAM] Stream stopped completely');
}

function showClickToPlayOverlay() {
    console.log('[UI] Showing click-to-play overlay');
    if (!videoOverlay) return;
    videoOverlay.style.display = 'flex';
    videoOverlay.innerHTML = `<button id="clickToPlayBtn" style="padding:1rem 2rem;font-size:1.25rem;">Click to Start Video</button>`;
    const btn = document.getElementById('clickToPlayBtn');
    if (btn) {
        btn.onclick = () => {
            console.log('[UI] Click-to-play button clicked');
            videoOverlay.style.display = 'none';
            videoElement.play().catch((e) => {
                console.warn('[UI] Error playing video after click:', e);
            });
        };
    }
}


// ---------------- Devices list UI ----------------
function updateDeviceList(devices) {
    if (!Array.isArray(devices)) {
        console.error('Device list is not an array:', devices);
        return;
    }

    lastDeviceList = devices;

    console.log('[DEVICES] device_list recv', {
        socketConnected: !!socket?.connected,
        currentRoom,
        pairedPeerId,
        count: devices.length,
        ids: devices.map(d => d?.xrId).filter(Boolean)
    });


    console.log('[DEVICES] Updating device list with', devices.length, 'devices');
    // ✅ IMPORTANT: Do NOT suppress empty lists.
    // Empty lists can occur during pairing / peer_left / reconnect races.
    // We must render server truth to keep Dock + Cockpit in sync.
    if (currentRoom && devices.length === 0) {
        console.warn('[DEVICES] empty device_list received while paired (rendering anyway)', {
            currentRoom,
            pairedPeerId
        });
        // DO NOT return
    }


    deviceListElement.innerHTML = '';

    const myId = XR_ID;

    // ✅ Auto-heal pairedPeerId from device_list when in a room
    if (currentRoom) {
        const myNorm = normalizeId(myId);
        const others = devices
            .map(d => normalizeId(d?.xrId))
            .filter(id => id && id !== myNorm);

        if (others.length === 1) {
            const guessedPeer = others[0];
            if (!pairedPeerId || normalizeId(pairedPeerId) !== guessedPeer) {
                pairedPeerId = guessedPeer;
                console.log('[PAIR] auto-heal pairedPeerId ->', pairedPeerId);
            }
        }
    }

    const peerId = pairedPeerId;

    // Restrict only after room_joined + peer known
    const wantOnlyPair = !!(currentRoom && peerId);
    const allowed = new Set([normalizeId(myId), normalizeId(peerId)].filter(Boolean));

    let peerOnline = false;
    let sameIdCount = 0;

    devices.forEach((device) => {
        const devIdNorm = normalizeId(device?.xrId);

        if (wantOnlyPair && !allowed.has(devIdNorm)) return;

        const isSelfId = devIdNorm === normalizeId(myId);
        if (isSelfId) sameIdCount += 1;


        // If disconnected, hide our own Desktop entry (prevents showing stale self while offline)
        if (isSelfId && !(socket && socket.connected)) return;



        const name = isSelfId
            ? (DEVICE_NAME || 'This device')
            : (device.deviceName || device.name || 'Unknown');

        console.log(`[DEVICE] Adding device: ${name} (${device.xrId})`);
        const li = document.createElement('li');
        li.textContent = `${name} (${device.xrId})`;
        deviceListElement.appendChild(li);

        if (peerId && devIdNorm === normalizeId(peerId)) {
            peerOnline = true;
        }
    });

    if (sameIdCount > 1 && !duplicateNotified) {
        addSystemMessage('⚠️ This XR ID is active in another tab/window. Only one desktop should use the same XR ID.');
        duplicateNotified = true;
    }

    if (peerId && !peerOnline) {
        console.log(`[PAIR] Peer (${peerId}) is not online yet — waiting`);
    }
}



function sendMessage() {
    // Permission guard: block send for READ-only users
    if (!hasDockWritePermission()) {
        notifyReadOnlyXRDock();
        return;
    }
    const text = (messageInput.value || '').trim();
    console.log('[CHAT] Sending message:', text);
    if (!text) return;

    if (!socket?.connected) {
        console.warn('[CHAT] Cannot send: socket not connected');
        return;
    }

    const to = pairedPeerId; // Option B: peer comes from room_joined members
    if (!currentRoom) {
        console.warn('[CHAT] Not paired yet (no currentRoom). Wait for room_joined.');
        addSystemMessage?.('⚠️ Not paired yet. Wait for pairing before sending messages.');
        return;
    }


    // Fully specified payload to satisfy both server and Android client
    const message = {
        ...(to ? { to } : {}),       // optional; server routes by pair-room anyway
        from: XR_ID,                 // sender id
        sender: DEVICE_NAME,         // human-friendly name
        xrId: XR_ID,                 // some clients expect xrId explicitly
        text,
        urgent: !!urgentCheckbox.checked,
        roomId: currentRoom          // always include roomId once paired
    };


    console.log('[CHAT] Emitting message payload:', message);
    socket.emit('message', message);


    messageInput.value = '';
}


function normalizeMessage(message) {
    return {
        text: message?.text || '',
        sender: message?.sender || message?.from || 'unknown',
        xrId: message?.xrId || message?.from || 'unknown',
        timestamp: message?.timestamp || new Date().toLocaleTimeString(),
        priority:
            message?.urgent || message?.priority === 'urgent' ? 'urgent' : 'normal',
    };
}


function addMessageToHistory(message) {
    const msg = normalizeMessage(message);

    // ✅ enforce room ownership (never store global)
    msg.roomId = msg.roomId || currentRoom;
    if (!msg.roomId) return;

    // Add to UI
    const el = document.createElement('div');
    el.className = `message ${msg.priority}`;
    el.innerHTML = `
<div class="message-header">
<div class="sender-info">
<span class="sender-name">${msg.sender}</span>
<span class="xr-id">${msg.xrId}</span>
</div>
<div class="message-time">${msg.timestamp}</div>
</div>
<div class="message-content">${msg.text}</div>
    ${msg.priority === 'urgent' ? '<div class="urgent-badge">URGENT</div>' : ''}
  `;
    messageHistoryDiv.appendChild(el);
    messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;

    // ✅ Save to ROOM-SCOPED localStorage
    const key = messageHistoryKey(msg.roomId);
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    history.push(msg);
    localStorage.setItem(key, JSON.stringify(history));
}



function loadMessageHistory(roomId = null) {
    const key = messageHistoryKey(roomId || currentRoom);
    const history = JSON.parse(localStorage.getItem(key) || '[]');

    // ✅ clear UI first (prevents XR-9002 history staying on screen)
    messageHistoryDiv.innerHTML = '';

    history.forEach(msg => {
        const el = document.createElement('div');
        el.className = `message ${msg.priority}`;
        el.innerHTML = `
<div class="message-header">
<div class="sender-info">
<span class="sender-name">${msg.sender}</span>
<span class="xr-id">${msg.xrId}</span>
</div>
<div class="message-time">${msg.timestamp}</div>
</div>
<div class="message-content">${msg.text}</div>
      ${msg.priority === 'urgent' ? '<div class="urgent-badge">URGENT</div>' : ''}
    `;
        messageHistoryDiv.appendChild(el);
    });

    messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
}




function addToRecentMessages(message) {
    console.log('[CHAT] Adding to recent messages:', message);
    const msg = normalizeMessage(message);
    const el = document.createElement('div');
    el.className = `recent-message ${msg.priority}`;
    el.innerHTML = `
    <div class="recent-message-header">
      <span class="recent-sender">${msg.sender}</span>
      <span class="recent-xr-id">${msg.xrId}</span>
      <span class="recent-time">${msg.timestamp}</span>
    </div>
    <div class="recent-message-content">${msg.text}</div>
  `;
    recentMessagesDiv.prepend(el);
    if (recentMessagesDiv.children.length > 5) {
        console.log('[CHAT] Trimming recent messages to 5');
        recentMessagesDiv.removeChild(recentMessagesDiv.lastChild);
    }
}

function addSystemMessage(text) {
    console.log('[CHAT] Adding system message:', text);
    const el = document.createElement('div');
    el.className = 'system-message';
    el.textContent = text;
    messageHistoryDiv.appendChild(el);
    messageHistoryDiv.scrollTop = messageHistoryDiv.scrollHeight;
}


function clearMessages() {
    // Permission guard: block clear for READ-only users
    if (!hasDockWritePermission()) {
        notifyReadOnlyXRDock();
        return;
    }
    socket?.emit('clear-messages', { by: DEVICE_NAME });
    clearedMessages.clear();

    // Clear UI
    messageHistoryDiv.innerHTML = '';
    recentMessagesDiv.innerHTML = '<div class="system-message">Messages cleared</div>';
    addSystemMessage(`🧹 Cleared messages locally by ${DEVICE_NAME}`);

    // Clear ONLY this room’s message history
    if (currentRoom) {
        localStorage.removeItem(messageHistoryKey(currentRoom));
    }
}

/* =========================
   🔔 WebRTC offer helpers (NEW)
   ========================= */
function requestOfferFromPeer() {
    if (!socket?.connected) {
        console.warn('[CONTROL] Cannot request_offer: socket not connected');
        return;
    }

    // Option B: must be paired first (server routes control only within pair room)
    if (!currentRoom) {
        console.warn('[CONTROL] Cannot request_offer: not paired yet (no currentRoom)');
        addSystemMessage?.('⚠️ Not paired yet. Wait for room_joined before starting stream.');
        return;
    }

    console.log('[CONTROL] Requesting SDP offer from peer (pair-room)');
    socket.emit('control', { command: 'request_offer' });
}


function ensurePeerReadyThenRequestOffer() {
    if (!peerConnection) {
        console.log('[CONTROL] No RTCPeerConnection; creating before request_offer');
        peerConnection = createPeerConnection();
    }
    requestOfferFromPeer();
}

// ---------------- Remote control / commands ----------------
function handleControlCommand(data) {
    console.log('[CONTROL] Received control command:', data?.command);
    const command = (data?.command || data?.action || '').toLowerCase();

    // allow start_stream (and request_offer) even if stream is not yet active
    if (!isStreamActive && !['start_stream', 'request_offer', 'stop_stream', 'scribe_flush'].includes(command)) {
        console.log('[CONTROL] Stream not active - ignoring command:', command);
        return;
    }

    switch (command) {
        // case 'start_stream':
        //   console.log('[CONTROL] Executing start_stream command');
        //   addSystemMessage('🎥 Start stream requested');
        //   ensurePeerReadyThenRequestOffer();  // prepare PC and ask peer to send an SDP offer
        //   break;
        case 'start_stream': {
            console.log('[CONTROL] Executing start_stream command');
            addSystemMessage('🎥 Start stream requested');

            // Always start clean so repeated starts work
            stopStream();

            // New RTCPeerConnection for this session
            peerConnection = createPeerConnection();

            // Option B: request offer within the pair room (server routes control by room)
            if (!currentRoom) {
                addSystemMessage('⚠️ Not paired yet. Wait for room_joined before starting stream.');
                console.warn('[CONTROL] start_stream: not paired yet (no currentRoom)');
                window.__startWasClickedBeforePair = true;   // ✅ defer start until room_joined
                break;
            }

            console.log('[CONTROL] Requesting SDP offer from peer (pair-room)');
            socket?.emit('control', { command: 'request_offer' });

            // Optional: retry if no offer arrives
            if (window.__offerRetryTimer) clearTimeout(window.__offerRetryTimer);
            window.__offerRetryTimer = setTimeout(() => {
                if (!peerConnection || peerConnection.signalingState === 'closed') return;
                console.log('[CONTROL] No offer yet, re-requesting (pair-room)…');
                socket?.emit('control', { command: 'request_offer' });
            }, 4000);
            break;
        }



        case 'request_offer': // optional round‑trip support if peer asks us to prompt again
            console.log('[CONTROL] Executing request_offer');
            ensurePeerReadyThenRequestOffer();
            break;

        case 'mute':
            console.log('[CONTROL] Executing mute command');
            if (muteBadge) muteBadge.style.display = 'block';
            if (videoElement) videoElement.muted = true;
            break;
        case 'unmute':
            console.log('[CONTROL] Executing unmute command');
            if (muteBadge) muteBadge.style.display = 'none';
            if (videoElement) {
                videoElement.muted = false;
                videoElement.play().catch(() => { });
            }
            break;
        case 'hide_video':
            console.log('[CONTROL] Executing hide_video command');
            if (videoOverlay) videoOverlay.style.display = 'flex';
            if (videoElement) videoElement.style.visibility = 'hidden';
            break;
        case 'show_video':
            console.log('[CONTROL] Executing show_video command');
            if (videoOverlay) videoOverlay.style.display = 'none';
            if (videoElement) videoElement.style.visibility = 'visible';
            break;
        case 'stop_stream':
            console.log('[CONTROL] Executing stop_stream command');
            stopStream();
            break;

        case 'scribe_flush':
            console.log('[CONTROL] Executing scribe_flush (forward to Cockpit)');

            // Forward to Scribe Cockpit if it's open on the same origin
            try {
                const bc = new BroadcastChannel('scribe-control');
                bc.postMessage({ type: 'scribe_flush', from: XR_ID, ts: Date.now() });
            } catch (err) {
                console.warn('[CONTROL] BroadcastChannel not available:', err);
            }

            // If this page (Dock) has a SOAP generator injected, call it defensively
            if (typeof window.generateSoapFromBufferedTranscripts === 'function') {
                try {
                    window.generateSoapFromBufferedTranscripts();
                } catch (err) {
                    console.warn('[CONTROL] Local SOAP generation failed:', err);
                }
            }
            break;

        default:
            console.warn('[CONTROL] Unknown command received:', command);
    }
}


// ---------------- 🔷 Pairing helper ----------------
// Option B: server auto-pairs from DB. Keep this function only for backward compatibility,
// but do NOT emit pair_with.
function pairWith(peerId) {
    console.log('[PAIR] pairWith ignored (Option B auto-pair). peerId=', peerId);
    // no-op
}




// ---------------- Event listeners ----------------
console.log('[INIT] Setting up event listeners');
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

if (clearMessagesBtn) {
    clearMessagesBtn.addEventListener('click', clearMessages);
}

if (openEmulatorBtn) {
    openEmulatorBtn.addEventListener('click', () => {
        console.log('[UI] Opening emulator in new window');
        const url = `${location.origin}/device`;      // or "/" if you meant the Dock, or "/operator" for legacy
        window.open(url, '_blank', 'noopener');
    });
}

if (videoOverlay) {
    videoOverlay.addEventListener('click', () => {
        console.log('[UI] Video overlay clicked - attempting to play video');
        videoOverlay.style.display = 'none';
        videoElement.play().catch((e) => {
            console.warn('[UI] Error playing video after overlay click:', e);
        });
    });
}


// =========================================
window.addEventListener('load', async () => {
    console.log('[APP] Window loaded - initializing (manual connect + refresh-safe)');

    // 1) Load XR Vision Dock permissions & apply read-only UI if needed
    await loadDockPermissions();
    applyDockReadOnlyUI();

    // Cross-tab presence
    openPresenceChannel();
    startPresencePings();
    announcePresence('idle');

    // Detect if this navigation is a reload (vs brand-new open)
    const navEntry = performance.getEntriesByType('navigation')[0];
    const isReload = navEntry
        ? navEntry.type === 'reload'
        // fallback for older browsers
        : (performance.navigation && performance.navigation.type === 1);

    console.log('[APP] Navigation type -> isReload =', isReload);

    // Initialize socket (handlers only; do not dial yet)
    initSocket();

    /* (5) Auto-reconnect on reload for any XR_ID (Option B) */
    let shouldAuto = false;
    try {
        const flag = localStorage.getItem(AUTO_KEY);
        const inputId = normalizeId(xrIdInput.value);
        // Auto-connect on reload if user opted in and XR_ID exists
        shouldAuto = (flag === '1') && isReload && !!inputId;
        console.log('[AUTO] XR_AUTOCONNECT:', flag, 'inputId:', inputId, ' => shouldAuto:', shouldAuto);
    } catch (e) {
        console.warn('[AUTO] Failed to read XR_AUTOCONNECT:', e);
    }

    if (shouldAuto) {
        console.log('[APP] Auto-connect enabled for reload — dialing now');

        // ✅ Ensure XR_ID is set for this reload auto-connect (no effect on manual connects)
        // ✅ Reload auto-connect: XR_ID must come ONLY from input (no fallback)
        const chosenId = normalizeId(xrIdInput.value);
        XR_ID = chosenId;

        console.log('[AUTO] Reload auto-connect with XR_ID:', XR_ID);


        DEVICE_NAME = 'Desktop';

        setStatus('Connecting');
        if (socket?.io) socket.io.opts.reconnection = true;
        socket.connect();
    } else {
        console.log('[APP] Starting disconnected (cold open or flag off / disallowed ID)');
        // Normalize flag on cold opens so future loads don't surprise-connect
        try {
            if (!isReload) localStorage.setItem(AUTO_KEY, '0');
        } catch (e) {
            console.warn('[AUTO] Could not normalize XR_AUTOCONNECT on cold open:', e);
        }
        setStatus('Disconnected'); // show red pill initially
    }
});

// --- Scribe Cockpit opener ---
(() => {
    const btn = document.getElementById('openScribeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const url = `${location.origin}/scribe-cockpit`;  // routed page (no .html)
        window.open(url, '_blank', 'noopener');
    });
})();


console.log('[INIT] Application initialization complete');
