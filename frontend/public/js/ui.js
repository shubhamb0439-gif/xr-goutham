// =====================================================ui.js====////=======================================================

// UI wiring converted from EmulatorUI.kt + MainActivity.kt
// Keeps identical semantics, event names, and control flow.
// - Toggles: connect/stream/mute/visibility/voice
// - Device list preference for XR-1238
// - Messages (urgent), transcripts (partial/final)
// - Battery push event & 12s telemetry (when connected)

import { SignalingClient } from './signaling.js';
import WebRtcStreamer from './device.js';
import TelemetryReporter from './telemetry.js';
import { Message, appendMessage } from './messages.js';

// Normalize XR IDs so that "1234" becomes "XR-1234", etc.
function normalizeXrId(raw) {
    if (!raw) return '';
    const trimmed = String(raw).trim().toUpperCase();
    if (!trimmed) return '';
    if (trimmed.startsWith('XR-')) return trimmed;
    // If it's only digits, prefix with XR-
    if (/^[0-9]+$/.test(trimmed)) return `XR-${trimmed}`;
    return trimmed;
}



// ----------------- Constants (parity) -----------------
// XR ID for the Web Device (can be changed from the UI)
let ANDROID_XR_ID = normalizeXrId(window.XR_DEVICE_ID || '');

window.XR_DEVICE_ID = ANDROID_XR_ID;

const DEFAULT_DESKTOP_ID = (window.XR_OPERATOR_ID || 'XR-1238');
const SERVER_URL = (window.SIGNAL_URL || location.origin);

// Speech settings
const PARTIAL_THROTTLE_MS = 800;

// ----------------- XR Device permissions (System_Screens.id = 4) -----------------
const XR_DEVICE_SCREEN_ID = 4; // "XR Device" in System_Screens

let xrDevicePermissions = null;
let xrDevicePermsLoaded = false;

async function loadDevicePermissionsOnce() {
    if (xrDevicePermsLoaded) return;
    xrDevicePermsLoaded = true;

    // Only enforce when fetch is available (browser context)
    if (typeof fetch === 'undefined') {
        xrDevicePermissions = null; // fail-open
        return;
    }

    try {
        const res = await fetch('/api/platform/my-screens', {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });

        if (!res.ok) {
            console.warn('[XRDEVICE] my-screens returned', res.status);
            xrDevicePermissions = null; // fail-open
            return;
        }

        const data = await res.json();
        const screens = data?.screens || [];

        // ✅ Always prefer exact ID match
        let match = screens.find(s => s.id === XR_DEVICE_SCREEN_ID);

        // Defensive fallbacks if ID ever changes
        if (!match) {
            match = screens.find(s => (s.route_path || '').toLowerCase() === '/device');
        }
        if (!match) {
            match = screens.find(s => (s.screen_name || '').toLowerCase() === 'xr device');
        }

        if (!match) {
            console.warn('[XRDEVICE] No screen entry for XR Device; leaving unrestricted.');
            xrDevicePermissions = null;
            return;
        }

        xrDevicePermissions = {
            read: !!match.read,
            write: !!match.write,
            edit: !!match.edit,
            delete: !!match.delete
        };

        console.log('[XRDEVICE] Permissions (UI):', xrDevicePermissions);
    } catch (err) {
        console.warn('[XRDEVICE] Failed to load my-screens for XR Device:', err);
        xrDevicePermissions = null; // fail-open
    }
}

function hasDeviceWritePermission() {
    // If we couldn't load permissions, do not block anything (preserve behaviour)
    if (!xrDevicePermissions) return true;
    return !!xrDevicePermissions.write;
}

function notifyReadOnlyDevice() {
    const text = 'You only have READ permission for XR Device. This action is not allowed.';
    // use the existing msg() rendering if available
    try {
        msg('System', text);
    } catch {
        console.warn(text);
    }
}

function applyDeviceReadOnlyUI() {
    if (!xrDevicePermissions || xrDevicePermissions.write) return;

    console.log('[XRDEVICE] Applying read-only UI on /device');

    const markDisabled = (btn) => {
        if (!btn) return;
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
    };

    // Treat these as "write" actions (cannot be used when write = 0)
    markDisabled(elBtnConnect);
    markDisabled(elBtnStream);
    markDisabled(elBtnMute);
    markDisabled(elBtnVideo);
    markDisabled(elBtnVoice);
    markDisabled(elBtnStartRec);
    markDisabled(elBtnStopRec);
    markDisabled(elBtnSend);

    if (elChkUrgent) elChkUrgent.disabled = true;


    if (elMsgInput) {
        elMsgInput.readOnly = true;
        elMsgInput.placeholder = 'READ-ONLY: you do not have permission to send messages.';
    }
}


// ----------------- Elements -----------------
const elStatus = document.getElementById('status');
const elChip = document.getElementById('chipLastCmd');
const elDeviceXrIdInput = document.getElementById('deviceXrIdInput');
const elBtnConnect = document.getElementById('btnConnect');
const elBtnStream = document.getElementById('btnStream');
const elBtnMute = document.getElementById('btnMute');
const elBtnVideo = document.getElementById('btnVideo');
const elBtnVoice = document.getElementById('btnVoice');
const elBtnStartRec = document.getElementById('btnStartRec');
const elBtnStopRec = document.getElementById('btnStopRec');
const elPreview = document.getElementById('preview');
const elNoStream = document.getElementById('noStream');
const elMsgList = document.getElementById('msgList');
const elMsgInput = document.getElementById('msgInput');
const elChkUrgent = document.getElementById('chkUrgent');
const elBtnSend = document.getElementById('btnSend');


// Initialise Device XR ID input (CLEAN BOOT; no localStorage XR ID)
if (elDeviceXrIdInput) {
    // Always wipe the legacy leaking key
    clearLegacyLocalXrId();

    // ✅ Hard rule: refresh/new tab must start clean (no XR ID carry-over)
    // Use literal key here because XR_ID_SESSION_KEY const is declared later.
    try { sessionStorage.removeItem('xr-device-id'); } catch { }

    ANDROID_XR_ID = '';
    window.XR_DEVICE_ID = '';

    // Show blank on boot
    elDeviceXrIdInput.value = '';
}



// ----------------- State -----------------
let signaling = null;
let streamer = null;
let telemetry = null;

let isServerConnected = false;
let userWantsConnected = false;
let streamActive = false;
let micMuted = true;
let videoVisible = true;
let isListening = false;
let lastRecognizedCommand = '';

let connectedDesktops = []; // XR IDs
let hadDesktops = false;
let pairedDesktopId = null; // Option B: set from room_joined members


// note-taking
let recordingActive = false;
let noteBuffer = '';
let lastPartialSentAt = 0;

// battery push timer (90s)
let batteryTimer = null;
const BATTERY_PUSH_MS = 90_000;

// ----------------- Helpers -----------------
function nowIso() { return new Date().toISOString(); }

// Use signaling's queued send if available; fallback to raw socket emit
function emitSafe(event, data) {
    try {
        if (signaling && typeof signaling._send === 'function') {
            signaling._send(event, data);
        } else {
            signaling?.socket?.emit(event, data);
        }
    } catch (e) {
        console.warn('[SIGNAL][fallback emit] failed', event, e);
    }
}

// ---- XR ID storage (TAB-LOCAL) ----
const XR_ID_SESSION_KEY = 'xr-device-id';

function getSessionXrId() {
    return sessionStorage.getItem(XR_ID_SESSION_KEY) || '';
}
function setSessionXrId(xrId) {
    sessionStorage.setItem(XR_ID_SESSION_KEY, xrId);
}
function clearSessionXrId() {
    sessionStorage.removeItem(XR_ID_SESSION_KEY);
}

// legacy cleanup (old buggy key that leaks across tabs)
function clearLegacyLocalXrId() {
    try { localStorage.removeItem('xr-device-id'); } catch { }
}

// ---- Per-XR state key (history/UI) ----
function stateKeyForXr(xrId) {
    return `xr_state:${xrId}`;
}



// ---- Persistence (localStorage) ----
// XR identity must NOT be stored in localStorage.
// localStorage is ONLY for per-XR persisted UI state (messages, toggles, etc.)

function storageKeyForCurrentXr() {
    const xrId = normalizeXrId(ANDROID_XR_ID || '');
    return xrId ? stateKeyForXr(xrId) : null; // stateKeyForXr(xrId) => `xr_state:${xrId}`
}

let persistedState = {
    messages: [],             // { sender, text, timestamp, xrId, urgent }
    connectedDesktops: [],    // e.g. ['XR-1238']
    selectedDesktopId: null,  // last stream target
    micMuted: true,
    userWantsConnected: false
};

let _rehydrating = false, _saveTimer = null;

function saveState(throttleMs = 300) {
    if (_rehydrating) return;

    const key = storageKeyForCurrentXr();
    if (!key) return; // no XR connected => do not persist

    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try { localStorage.setItem(key, JSON.stringify(persistedState)); } catch { }
    }, throttleMs);
}

function persistNow() {
    const key = storageKeyForCurrentXr();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(persistedState)); } catch { }
}

// IMPORTANT: load only after explicit Connect (after ANDROID_XR_ID is set)
function loadStateForXr(xrId) {
    try {
        const key = xrId ? stateKeyForXr(normalizeXrId(xrId)) : null;
        if (!key) return false;

        const raw = localStorage.getItem(key);
        if (!raw) return false;

        const parsed = JSON.parse(raw);
        for (const k of Object.keys(persistedState)) {
            if (k in parsed) persistedState[k] = parsed[k];
        }
        return true;
    } catch {
        return false;
    }
}

// Backward-compatible wrapper:
// If any existing code still calls loadState(), it will NOT load anything unless
// an XR is already explicitly connected in this tab.
function loadState() {
    const xrId = normalizeXrId(ANDROID_XR_ID || '');
    if (!xrId) return false;
    return loadStateForXr(xrId);
}


// ---- Auto-reload on disconnect (safe + interval-guarded) ----
const AUTO_RELOAD_ON_DISCONNECT = true;
const AUTO_RELOAD_ONLY_MANUAL = false;        // set true to reload only when user clicked Disconnect
const RELOAD_GRACE_MS = 2000;
const MIN_RELOAD_INTERVAL_MS = 15000;
function scheduleAutoReload(reason = 'unknown') {
    if (!AUTO_RELOAD_ON_DISCONNECT) return;
    if (AUTO_RELOAD_ONLY_MANUAL && !(signaling?._manualClose)) return;

    const now = Date.now();
    const last = Number(sessionStorage.getItem('lastAutoReloadTs') || 0);
    if (now - last < MIN_RELOAD_INTERVAL_MS) {
        console.warn('[AUTO-RELOAD] Skipping (interval guard).', { sinceMs: now - last });
        return;
    }
    sessionStorage.setItem('lastAutoReloadTs', String(now));
    console.log('[AUTO-RELOAD] Scheduling reload in', RELOAD_GRACE_MS, 'ms; reason:', reason);

    setTimeout(() => {
        // flush state just before reload
        try { persistNow(); } catch { }
        if (document.visibilityState === 'hidden') {
            const once = () => {
                if (document.visibilityState === 'visible') {
                    document.removeEventListener('visibilitychange', once);
                    try { persistNow(); } catch { }
                    location.reload();
                }
            };
            document.addEventListener('visibilitychange', once);
            return;
        }
        location.reload();
    }, RELOAD_GRACE_MS);
}


function msg(sender, text) {
    const m = new Message({ sender, text, timestamp: nowIso(), xrId: ANDROID_XR_ID, urgent: false });
    appendMessage(elMsgList, m);
    elMsgList.scrollTop = elMsgList.scrollHeight;

    // ⬇️ add this block
    try {
        const N = 200; // cap to avoid storage bloat
        persistedState.messages.push({ sender, text, timestamp: m.timestamp, xrId: ANDROID_XR_ID, urgent: false });
        if (persistedState.messages.length > N) {
            persistedState.messages = persistedState.messages.slice(-N);
        }
        saveState();
    } catch { }
}

function setStatus(connected) {
    elStatus.textContent = connected ? 'Status: Connected' : 'Status: Disconnected';
    elStatus.classList.toggle('status-connected', connected);
    elStatus.classList.toggle('status-disconnected', !connected);

    elBtnConnect.textContent = connected ? 'Disconnect' : 'Connect';
    elBtnStream.textContent = streamActive ? 'Stop Stream' : 'Start Stream';
    elBtnMute.textContent = micMuted ? 'Unmute' : 'Mute';
    elBtnVideo.textContent = videoVisible ? 'Hide Video' : 'Show Video';
    elBtnVoice.textContent = isListening ? 'Stop Voice' : 'Start Voice';

    // preview placeholder
    elNoStream.hidden = !!streamActive;
}

// Apply mic state locally (mirrors Android's handleControlCommand)
function applyMute(wantMuted) {
    const s = ensureStreamer();
    try {
        if (wantMuted) {
            s.mute();           // disable audio tracks (do not stop)
            micMuted = true;

            // ✅ add these two lines right after setting micMuted = true
            persistedState.micMuted = micMuted;
            saveState();
            startVoiceRecognition();
            msg('System', 'Microphone muted.');
        } else {
            stopVoiceRecognition();
            // may need to reacquire mic; unmute() is async
            Promise.resolve(s.unmute()).catch(() => msg('System', 'Failed to unmute mic'));
            micMuted = false;
            // ✅ add these two lines right after setting micMuted = false
            persistedState.micMuted = micMuted;
            saveState();
            msg('System', 'Microphone unmuted.');
        }
    } catch { }
    setStatus(isServerConnected);
}


function preferDesktop(listPairs) {
    const ids = listPairs.map(p => String(p?.[1] || '').toUpperCase()).filter(Boolean);
    connectedDesktops = [];

    // ✅ Option B: if paired desktop known, prefer ONLY that one (strict one-to-one)
    if (pairedDesktopId && ids.includes(String(pairedDesktopId).toUpperCase())) {
        connectedDesktops.push(String(pairedDesktopId).toUpperCase());
    } else if (ids.includes(String(DEFAULT_DESKTOP_ID).toUpperCase())) {
        // fallback keeps old behavior for XR-1238 demo pairing
        connectedDesktops.push(String(DEFAULT_DESKTOP_ID).toUpperCase());
    } else {
        connectedDesktops.push(...ids);
    }

    persistedState.connectedDesktops = connectedDesktops.slice();
    saveState();
}



// ----------------- Signaling wiring (parity) -----------------
function createSignaling() {
    signaling = new SignalingClient({
        serverUrl: SERVER_URL,
        deviceName: 'XR-Web',
        xrId: ANDROID_XR_ID
    });

    signaling.listener = {
        onConnected: () => {
            isServerConnected = true;
            setStatus(true);
            msg('System', 'Connected to server');

            // start 12s telemetry
            telemetry = new TelemetryReporter({
                xrId: ANDROID_XR_ID,
                sendJson: (event, payload) => emitSafe(event, payload),
                periodMs: 12_000
            });
            telemetry.start();

            // battery push
            startBatteryTicker();
        },

        onDisconnected: () => {
            isServerConnected = false;

            userWantsConnected = false; // prevent auto-reconnect after a manual disconnect

            setStatus(false);
            msg('System', 'Disconnected from server');

            telemetry?.stop(); telemetry = null;
            stopBatteryTicker();

            if (streamActive) {
                streamActive = false;
                streamer?.stopStreaming().catch(() => { });
                msg('System', 'Stream stopped.');
            }

            // Ensure camera is off even if we weren't "streaming"
            try { streamer?.stopCamera(); } catch { }

            // Only disable reconnection if this was a *manual* disconnect
            if (signaling?._manualClose) {
                try { signaling.setReconnectionEnabled(false); } catch { }
            }

            // ✅ AUTO-RELOAD block
            console.log('[AUTO-RELOAD] onDisconnected hook firing', { manualClose: signaling?._manualClose });
            try { persistNow(); } catch { }
            if (!streamActive) {
                scheduleAutoReload(signaling?._manualClose ? 'user' : 'network');
            }

            // ✅ finalize hard reset after disconnect handler finishes
            signaling = null;
        },

        // ✅ Option B: dedicated room_joined handler (from signaling.js)
        onRoomJoined: (payload) => {
            const members = Array.isArray(payload?.members) ? payload.members : [];
            const me = normalizeXrId(ANDROID_XR_ID);
            const other = members.map(normalizeXrId).find(x => x && x !== me) || null;

            pairedDesktopId = other;
            signaling.currentDesktopId = other || null;

            if (other) {
                msg('System', `🎯 Paired with Desktop [${other}] in room ${payload?.roomId || ''}`);
            } else {
                msg('System', `🎯 Room joined: ${payload?.roomId || ''}`);
            }
        },

        // Same "signal" handling as MainActivity.kt
        onSignal: (type, from, _to, data) => {
            if (type === 'offer') {
                console.debug('Ignoring unexpected OFFER (web device is the offerer).');
                return;
            }
            if (type === 'answer') {
                streamer?.onRemoteAnswerReceived(data, from);
                return;
            }
            if (type === 'ice-candidate') {
                streamer?.onRemoteIceCandidate(data, from);
                return;
            }
            console.debug('Unhandled signal type:', type);
        },

        // NEW: respond when Dock asks us to send a fresh offer
        onControl: (c) => {
            const cmd = String(c?.command || c?.action || '').toLowerCase();
            if (cmd === 'request_offer') {
                ensureStreamer();
                const to = pairedDesktopId || signaling?.currentDesktopId || DEFAULT_DESKTOP_ID;
                if (!to) {
                    msg('System', '⚠️ Not paired yet (no desktop). Wait for room_joined.');
                    return;
                }

                streamer.sendOfferTo(to).catch(console.error);
                return; // <— KEEP this return
            }

            if (cmd === 'mute') { applyMute(true); return; }
            if (cmd === 'unmute') { applyMute(false); return; }
        },

        onDeviceListUpdated: (listPairs) => {
            preferDesktop(listPairs);

            const hadBefore = hadDesktops;
            hadDesktops = connectedDesktops.length > 0;

            if (!hadBefore && hadDesktops)
                msg('System', "A desktop connected! Tap 'Start Stream' to begin streaming.");

            const shown = (pairedDesktopId || DEFAULT_DESKTOP_ID);
            if (isServerConnected && shown && connectedDesktops.map(x => x.toUpperCase()).includes(shown.toUpperCase()) && !hadBefore) {
                msg('System', `System [${ANDROID_XR_ID}] sees Desktop [${shown}] online.`);
            }

            if (!hadDesktops && streamActive) {
                streamActive = false;
                streamer?.stopStreaming().catch(() => { });
                setStatus(isServerConnected);
                msg('System', 'All desktops disconnected. Stopped streaming.');
            }
        },

        onServerMessage: (event, payload) => {
            // NOTE: room_joined is handled by onRoomJoined now (avoid double handling)

            if (event === 'peer_left') {
                const id = (payload?.xrId || '').toUpperCase();
                const expected = (pairedDesktopId || DEFAULT_DESKTOP_ID).toUpperCase();
                if (id === expected) {
                    msg('System', `Desktop [${expected}] left the room (${payload?.roomId || ''}).`);
                    connectedDesktops = connectedDesktops.filter(x => x.toUpperCase() !== expected);
                    if (streamActive) {
                        streamActive = false;
                        streamer?.stopStreaming().catch(() => { });
                        setStatus(isServerConnected);
                        msg('System', 'Stream stopped (desktop disconnected).');
                    }
                }
                return;
            }

            if (event === 'desktop_disconnected') {
                const id = (payload?.xrId || DEFAULT_DESKTOP_ID).toUpperCase();
                msg('System', `Desktop [${id}] disconnected.`);
                connectedDesktops = connectedDesktops.filter(x => x.toUpperCase() !== id);
                if (streamActive) {
                    streamActive = false;
                    streamer?.stopStreaming().catch(() => { });
                    setStatus(isServerConnected);
                    msg('System', 'Stream stopped (desktop disconnected).');
                }
                return;
            }

            if (event !== 'message') return;

            // Render normal message (skip "transcript" like Android UI)
            const type = payload?.type || '';
            if (type === 'transcript') return;

            const sender = payload?.sender || payload?.from || 'server';
            const text = payload?.text || payload?.message || payload?.data || JSON.stringify(payload);
            const timestamp = payload?.timestamp || nowIso();
            const xrId = payload?.xrId || (payload?.from || 'server');
            const urgent = !!(payload?.urgent || (payload?.priority === 'urgent'));

            appendMessage(elMsgList, new Message({ sender, text, timestamp, xrId, urgent }));
            elMsgList.scrollTop = elMsgList.scrollHeight;
        }
    }; // <-- close signaling.listener object

    signaling.connect();
}



function ensureStreamer() {
    // If streamer exists but XR ID changed (or was blank at creation), recreate safely
    const wantXrId = normalizeXrId(ANDROID_XR_ID || '');
    const hasXrId = !!wantXrId;

    if (streamer) {
        // Best-effort: if streamer has an androidXrId field and it differs, rebuild
        try {
            const current = normalizeXrId(streamer.androidXrId || streamer._androidXrId || '');
            if (hasXrId && current && current !== wantXrId) {
                try { streamer.stopStreaming?.(); } catch { }
                try { streamer.stopCamera?.(); } catch { }
                streamer = null;
            }
        } catch { }
    }

    if (!streamer) {
        streamer = new WebRtcStreamer({ signaling, androidXrId: wantXrId });
        streamer.attachVideo(elPreview);
    }
    return streamer;
}


// ----------------- Controls -----------------
// Connect / Disconnect
elBtnConnect.addEventListener('click', async () => {
    // 🔒 READ-only guard for XR Device
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }
    // Prefer the client’s own state if available; fall back to our flag
    const connected = (typeof signaling?.isConnectedNow === 'function')
        ? signaling.isConnectedNow()
        : !!isServerConnected;

    if (connected) {
        userWantsConnected = false;
        // ✅ persist disconnect intent
        persistedState.userWantsConnected = false;
        saveState();
        msg('System', 'Disconnecting…');

        // stop stream first so peers close cleanly
        try {
            if (streamActive) { await ensureStreamer().stopStreaming(); streamActive = false; }
        } catch { }

        connectedDesktops = [];
        hadDesktops = false;

        // NEW: true manual disconnect (disables reconnection)
        if (typeof signaling?.disconnect === 'function') signaling.disconnect('user');
        else if (typeof signaling?.close === 'function') signaling.close();

        // reflect immediately; onDisconnected will also run
        isServerConnected = false;

        setStatus(false);
        // ✅ Identity reset on Disconnect (critical for Option B)
        clearSessionXrId();
        clearLegacyLocalXrId();

        ANDROID_XR_ID = '';
        window.XR_DEVICE_ID = '';
        pairedDesktopId = null;

        // Clear the input back to blank
        if (elDeviceXrIdInput) elDeviceXrIdInput.value = '';

        // Clear local UI state (do NOT delete per-XR localStorage history)
        connectedDesktops = [];
        hadDesktops = false;

        // ✅ hard reset WebRTC + signaling objects so reconnect always streams cleanly
        try { streamer?.stopCamera?.(); } catch { }
        streamer = null;


        // Cancel any pending offer retry from a previous stream attempt
        if (window.__offerRetryTimer) {
            clearTimeout(window.__offerRetryTimer);
            window.__offerRetryTimer = null;
        }

        return;
    }

    // ---- NOT CONNECTED → require XR Device ID first ----
    // ---- NOT CONNECTED → require XR Device ID first ----
    if (elDeviceXrIdInput) {
        const raw = (elDeviceXrIdInput.value || '').trim();
        const normalized = normalizeXrId(raw);

        if (!normalized) {
            msg('System', 'Please enter your XR Device ID (e.g. 1234) before connecting.');
            elDeviceXrIdInput.focus();
            return;
        }


        ANDROID_XR_ID = normalized;          // will be XR-1234
        window.XR_DEVICE_ID = ANDROID_XR_ID;

        // Load per-XR persisted state ONLY after explicit Connect
        // Reset in-memory state first
        persistedState = {
            messages: [],
            connectedDesktops: [],
            selectedDesktopId: null,
            micMuted: true,
            userWantsConnected: false
        };

        _rehydrating = true;
        try {
            loadStateForXr(ANDROID_XR_ID);

            // restore messages for this XR only
            if (Array.isArray(persistedState.messages)) {
                elMsgList.innerHTML = '';
                for (const m of persistedState.messages) {
                    appendMessage(elMsgList, new Message({
                        sender: m.sender, text: m.text, timestamp: m.timestamp, xrId: m.xrId, urgent: !!m.urgent
                    }));
                }
                elMsgList.scrollTop = elMsgList.scrollHeight;
            }

            micMuted = !!persistedState.micMuted;
        } finally {
            _rehydrating = false;
        }

        // Store XR ID TAB-LOCALLY only (prevents leaking across tabs)
        setSessionXrId(ANDROID_XR_ID);

        // Also ensure legacy localStorage key is not present
        clearLegacyLocalXrId();


        msg('System', `Using XR Device ID [${ANDROID_XR_ID}].`);
    }

    // Not connected → connect
    userWantsConnected = true;
    persistedState.userWantsConnected = true;
    saveState();
    msg('System', 'Connecting…');
    createSignaling();
    ensureStreamer();
    // bind preview element
});



elBtnStream.addEventListener('click', async () => {
    if (!isServerConnected) { msg('System', 'Not connected'); return; }

    // 🔒 READ-only guard for XR Device
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }
    if (streamActive) {
        streamActive = false;
        await ensureStreamer().stopStreaming();
        micMuted = true;
        setStatus(true);
        msg('System', 'Stream stopped.');

        // Tell the Dock to blank out *now* (no waiting for ICE/TURN timeouts)
        try {
            const to = pairedDesktopId || signaling?.currentDesktopId || DEFAULT_DESKTOP_ID;

            // ✅ persist last selected desktop even on stop (keeps continuity)
            persistedState.selectedDesktopId = to;
            saveState();
            emitSafe('control', { from: ANDROID_XR_ID, to, command: 'stop_stream', action: 'stop_stream' });

        } catch { }

        // Also turn off the local camera immediately
        try { streamer?.stopCamera?.(); } catch { }

        // Cancel any offer retry timer you may have started
        if (window.__offerRetryTimer) {
            clearTimeout(window.__offerRetryTimer);
            window.__offerRetryTimer = null;
        }

    } else {
        if (connectedDesktops.length === 0) { msg('System', 'No desktops available for streaming.'); return; }
        await signaling?.waitUntilConnected?.(); // ensure signaling is live
        streamActive = true;
        await ensureStreamer().startStreaming(connectedDesktops);
        micMuted = true;
        ensureStreamer().mute();
        setStatus(true);
        msg('System', "Stream started (muted by default). Say 'unmute' to unmute.");

        // Immediately push an SDP offer to the Dock (device is the offerer)
        ensureStreamer();
        const to = (pairedDesktopId || signaling?.currentDesktopId || DEFAULT_DESKTOP_ID);

        // ✅ persist last selected desktop
        persistedState.selectedDesktopId = to;
        saveState();
        streamer.sendOfferTo(to).catch(console.error);

        // Optional: retry once in case the Dock wasn't ready yet
        if (window.__offerRetryTimer) clearTimeout(window.__offerRetryTimer);
        window.__offerRetryTimer = setTimeout(() => {
            if (streamActive && signaling?.isConnectedNow?.()) {
                streamer.sendOfferTo(to).catch(() => { });
            }
        }, 4000);

    }
});

elBtnMute.addEventListener('click', async () => {
    // 🔒 READ-only guard
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }
    if (!isServerConnected || !streamActive) {
        msg('System', 'Stream not active');
        return;
    }

    // Decide desired state from UI's own source of truth
    const wantMuted = !micMuted;
    const command = wantMuted ? 'mute' : 'unmute';

    // 1) Apply locally immediately (Android parity)
    applyMute(wantMuted);

    // 2) Notify ONLY paired desktop
    const targetId = pairedDesktopId;
    if (!targetId) {
        msg('System', '⚠️ Not paired yet. Wait for room_joined.');
        return;
    }
    emitSafe('control', { from: ANDROID_XR_ID, to: targetId, command, action: command });

});



elBtnVideo.addEventListener('click', () => {
    // 🔒 READ-only guard
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }
    if (!isServerConnected || !streamActive) { msg('System', 'Stream not active'); return; }

    // Toggle local state + choose command
    let cmd;
    if (videoVisible) {
        videoVisible = false;
        ensureStreamer().hideVideo();
        cmd = 'hide_video';
    } else {
        videoVisible = true;
        ensureStreamer().showVideo();
        cmd = 'show_video';
    }

    // ✅ Tell ONLY paired dock (Option B strict)
    const targetId = pairedDesktopId;
    if (!targetId) {
        msg('System', '⚠️ Not paired yet. Wait for room_joined.');
        setStatus(true);
        return;
    }
    emitSafe('control', { from: ANDROID_XR_ID, to: targetId, command: cmd, action: cmd });

    setStatus(true);
});


// ----------------- Voice + Notes (partial/final transcripts) -----------------
let SR = null, rec = null, speechIntentLang = 'en-US';

function setupSR() {
    SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    if (!SR) return false;
    rec = new SR();
    rec.lang = speechIntentLang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
        let interim = '';
        let finalTxt = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript.toLowerCase().trim();
            if (e.results[i].isFinal) finalTxt += (finalTxt ? ' ' : '') + t;
            else interim += (interim ? ' ' : '') + t;
        }

        if (interim && recordingActive) {
            const now = Date.now();
            if (now - lastPartialSentAt > PARTIAL_THROTTLE_MS) {
                lastPartialSentAt = now;
                sendTranscript(interim, false);
            }
        }

        if (finalTxt) {
            lastRecognizedCommand = finalTxt;
            elChip.textContent = `Heard: ${finalTxt}`;
            elChip.hidden = false;

            if (/\bcreate\b/.test(finalTxt)) {
                onStopRecordingNote();
                return;
            } else if (recordingActive) {
                // buffer note only; send once at stop
                noteBuffer += (noteBuffer ? ' ' : '') + finalTxt;
            } else {
                processVoiceCommand(finalTxt);
            }
        }
    };
    rec.onerror = () => {
        if (isListening) try { rec.start(); } catch { }
    };
    rec.onend = () => {
        if (isListening) try { rec.start(); } catch { }
    };
    return true;
}

function startVoiceRecognition() {
    if (!setupSR()) { msg('System', 'Voice API not available in this browser'); return; }
    if (isListening) return;
    isListening = true;
    try { rec.start(); msg('System', 'Voice recognition started'); } catch { msg('System', 'Failed to start voice'); }
    setStatus(isServerConnected);
}

function stopVoiceRecognition() {
    if (!isListening) return;
    isListening = false;
    try { rec.stop(); msg('System', 'Voice recognition stopped'); } catch { msg('System', 'Failed to stop voice recognition'); }
    if (recordingActive) finalizeRecordingNote();
    setStatus(isServerConnected);
}

function processVoiceCommand(cmd) {
    const c = cmd.toLowerCase();

    if (/\bnote\b/.test(c)) { onStartRecordingNote(); return; }
    if (/\bcreate\b/.test(c)) { onStopRecordingNote(); return; }

    if (/\bconnect\b/.test(c)) {
        if (!isServerConnected) elBtnConnect.click(); else msg('Voice', 'Already connected.');
        return;
    }
    if (/\bdisconnect\b/.test(c)) {
        if (isServerConnected) elBtnConnect.click(); else msg('Voice', 'Already disconnected.');
        return;
    }

    // ✅ Voice uses the SAME path as UI buttons (prevents double-trigger)
    if (/\bunmute\b/.test(c)) { if (micMuted) elBtnMute.click(); else msg('Voice', 'Already unmuted.'); return; }
    if (/\bmute\b/.test(c)) { if (!micMuted) elBtnMute.click(); else msg('Voice', 'Already muted.'); return; }

    if (/\bstart\b/.test(c)) { if (!streamActive) elBtnStream.click(); else msg('Voice', 'Stream already active.'); return; }
    if (/\bstop\b/.test(c)) { if (streamActive) elBtnStream.click(); else msg('Voice', 'Stream already stopped.'); return; }

    if (/\bhide\b/.test(c)) { if (videoVisible) elBtnVideo.click(); else msg('Voice', 'Video already hidden.'); return; }
    if (/\bshow\b/.test(c)) { if (!videoVisible) elBtnVideo.click(); else msg('Voice', 'Video already shown.'); return; }

    msg('Voice', `Unrecognized command: ${cmd}`);
}



elBtnVoice.addEventListener('click', () => {
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }
    if (isListening) stopVoiceRecognition(); else startVoiceRecognition();
});

// Recording buttons
function onStartRecordingNote() {
    if (recordingActive) return;
    recordingActive = true;
    noteBuffer = '';
    if (!isListening) startVoiceRecognition();
    msg('System', 'Note recording started (say "create" to stop).');
}
function onStopRecordingNote() {
    if (!recordingActive) return;
    finalizeRecordingNote();
    if (isListening) stopVoiceRecognition();
}
function finalizeRecordingNote() {
    recordingActive = false;
    const finalText = noteBuffer.trim();
    msg('System', `Note saved to console (${finalText.length} chars).`);

    if (finalText) sendTranscript(finalText, true);

    // 🚀 Trigger SOAP on Dock/Scribe (action+command for compatibility)
    const targetId = pairedDesktopId;
    if (!targetId) {
        msg('System', '⚠️ Not paired yet. Wait for room_joined.');
    } else {
        emitSafe('control', {
            from: ANDROID_XR_ID,
            to: targetId,
            command: 'scribe_flush',
            action: 'scribe_flush'
        });
    }


    noteBuffer = '';
}

elBtnStartRec.addEventListener('click', () => {
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }
    onStartRecordingNote();
});
elBtnStopRec.addEventListener('click', onStopRecordingNote);


// Transcript sender (same payload as Android)
async function sendTranscript(text, isFinal) {
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }
    if (!isServerConnected) { msg('System', 'Not connected; transcript not sent.'); return; }
    if (connectedDesktops.length === 0) { msg('System', 'No desktops connected; transcript not sent.'); return; }
    await signaling?.waitUntilConnected?.().catch(() => { });    // <-- INSERT THIS

    const ts = nowIso();
    for (const targetId of connectedDesktops) {
        emitSafe('message', {
            type: 'transcript',
            text,
            final: !!isFinal,
            sender: 'AndroidXR',
            xrId: ANDROID_XR_ID,
            timestamp: ts,
            to: targetId,
            from: ANDROID_XR_ID
        });
    }
}

// ----------------- Control & Chat sending -----------------
function sendControlCommand(command) {
    // 🔒 READ-only guard for any remote control / streaming
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }

    // ✅ Option B strict: ONLY the paired desktop (never broadcast to connectedDesktops)
    const targetId = pairedDesktopId;

    if (!targetId) {
        msg('System', '⚠️ Not paired yet. Wait for room_joined before sending voice commands.');
        return;
    }

    // ✅ Use emitSafe so signaling queue + roomId logic is preserved
    emitSafe('control', { from: ANDROID_XR_ID, to: targetId, command, action: command });


}


elBtnSend.addEventListener('click', () => {
    if (!hasDeviceWritePermission()) {
        notifyReadOnlyDevice();
        return;
    }

    const text = (elMsgInput.value || '').trim();
    const urgent = !!elChkUrgent.checked;
    if (!text) return;

    if (connectedDesktops.length === 0) {
        msg('System', 'Message not sent - no desktops connected');
        return;
    }
    const timestamp = nowIso();
    for (const targetId of connectedDesktops) {
        emitSafe('message', {
            type: 'message',
            text,
            sender: 'AndroidXR',
            xrId: ANDROID_XR_ID,
            timestamp,
            urgent,
            to: targetId,
            from: ANDROID_XR_ID
        });
    }
    elMsgInput.value = '';
    elChkUrgent.checked = false;
});

// ----------------- Battery push (every ~90s) -----------------
async function getBatterySnapshot() {
    try {
        if (!navigator.getBattery) return null;
        const b = await navigator.getBattery();
        return { batteryPct: Math.round((b.level ?? 0) * 100), charging: !!b.charging };
    } catch { return null; }
}
function emitBatteryOnce() {
    if (!isServerConnected) return;
    getBatterySnapshot().then(s => {
        if (!s) return;
        emitSafe('battery', {
            xrId: ANDROID_XR_ID,
            batteryPct: s.batteryPct,
            charging: s.charging,
            ts: Date.now()
        });
    });
}
function startBatteryTicker() {
    emitBatteryOnce();
    stopBatteryTicker();
    batteryTimer = setInterval(emitBatteryOnce, BATTERY_PUSH_MS);
}
function stopBatteryTicker() {
    if (batteryTimer) clearInterval(batteryTimer);
    batteryTimer = null;
}

// ----------------- Boot -----------------
// Do NOT load XR state on boot. State loads only after explicit Connect with an XR ID.
_rehydrating = true;
try {
    // Ensure in-memory state starts clean for a brand-new tab / refresh
    persistedState.messages = [];
    persistedState.connectedDesktops = [];
    persistedState.selectedDesktopId = null;
    persistedState.micMuted = true;
    persistedState.userWantsConnected = false;

    connectedDesktops = [];
    hadDesktops = false;
    pairedDesktopId = null;

    micMuted = true;
    userWantsConnected = false;

    // Clear any rendered messages in the UI
    try { elMsgList.innerHTML = ''; } catch { }
} finally {
    _rehydrating = false;
}

// reflect UI state
setStatus(false);
msg('System', "Disconnected. Tap 'Connect' or say 'connect' to join the server.");


// Load XR Device permissions once and apply read-only UI if needed
if (typeof window !== 'undefined') {
    loadDevicePermissionsOnce()
        .then(() => {
            applyDeviceReadOnlyUI();
        })
        .catch((err) => {
            console.warn('[XRDEVICE] Permission bootstrap failed:', err);
        });
}


