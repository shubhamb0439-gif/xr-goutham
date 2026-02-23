// =============================================================signaling.js=====================================================
// public/js/signaling.js
// Browser/PWA port of Android SocketIOClient + SignalingClient.
// Requires the Socket.IO client to be available as global `io`
// (e.g., <script src="/socket.io/socket.io.js"></script>).

export class SignalingClient {
  /**
   * @param {Object} opts
   * @param {string} opts.serverUrl   - e.g. "https://yourdomain.com"
   * @param {string} opts.deviceName  - friendly device name
   * @param {string} opts.xrId        - XR-1234 / unique id
   * @param {Object} [opts.listener]  - callbacks (see below)
   * @param {any}    [opts.ioOverride]- pass a custom io() for testing (optional)
   */
  constructor({ serverUrl, deviceName, xrId, listener = null, ioOverride = null }) {
    // Resolve hub URL from (in priority): ?signal → window.__SIGNAL_URL__ → localStorage → window.SIGNAL_URL → same-origin → explicit arg
    // One server → always same-origin
    let resolvedUrl = (typeof window !== 'undefined' && window.location?.origin) || serverUrl || null;


    if (!resolvedUrl) throw new Error('serverUrl is required (pass opts.serverUrl or set window.SIGNAL_URL / ?signal=)');
    if (!deviceName) throw new Error('deviceName is required');
    if (!xrId) throw new Error('xrId is required');

    this.serverUrl = resolvedUrl;
    this.deviceName = deviceName;
    this.xrId = xrId;
    this.listener = listener;

    this.socket = null;
    this.isConnected = false;
    this._manualClose = false;
    // Queue emits while offline; flush on connect (prevents lost offer/ICE during blips)
    this._outbox = [];            // [{event, data}]
    this._OUTBOX_MAX = 200;       // cap to avoid unbounded growth
    this._gen = 0; // increments each connect/disconnect cycle (prevents stale outbox flush)

    // Presence / desktop preference (parity with Android)
    this.currentDesktopId = null;
    this.roomId = null;  // ✅ server-issued pair room

    this._wasDesktopOnline = false;
    this.DESKTOP_ID = (typeof window !== 'undefined' && window.XR_OPERATOR_ID)
      ? String(window.XR_OPERATOR_ID).toUpperCase()
      : null;


    // Socket.IO entry point
    this.io = ioOverride || (typeof window !== 'undefined' ? window.io : null);
    if (!this.io) {
      throw new Error(
        'Socket.IO client not found. Include <script src="/socket.io/socket.io.js"></script> before this module.'
      );
    }

    // bind once
    this._onConnect = this._onConnect.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
    this._onConnectError = this._onConnectError.bind(this); // ← FIX: make sure method exists below
    this._onSignal = this._onSignal.bind(this);
    this._onRoomJoined = this._onRoomJoined.bind(this);
    this._onDeviceList = this._onDeviceList.bind(this);
    this._onPeerLeft = this._onPeerLeft.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onMessageHistory = this._onMessageHistory.bind(this);
    this._onControl = this._onControl.bind(this);      // ← NEW: control passthrough
  }

  /** Establish the Socket.IO connection. Mirrors Android options. */

  connect() {
    if (this.socket) return;

    const opts = {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      forceNew: true
    };

    this._manualClose = false;
    this.socket = this.io(opts);

    // Core lifecycle
    this.socket.on('connect', this._onConnect);
    this.socket.on('disconnect', this._onDisconnect);
    this.socket.on('connect_error', this._onConnectError);

    // Signaling + presence
    this.socket.on('signal', this._onSignal);
    this.socket.on('device_list', this._onDeviceList);
    this.socket.on('peer_left', this._onPeerLeft);

    // ✅ Pair-room event (ONLY ONCE)
    this.socket.on('room_joined', this._onRoomJoined);

    // Optional passthroughs
    this.socket.on('message', this._onMessage);
    this.socket.on('message_history', this._onMessageHistory);

    // Control passthrough
    this.socket.on('control', this._onControl);
  }


  /** Disable/enable automatic reconnection like Android setReconnectionEnabled(). */
  setReconnectionEnabled(enable) {
    try { this.socket?.io?.reconnection(!!enable); } catch { /* no-op */ }
  }

  /** expose current state to UI */
  isConnectedNow() { return !!this.isConnected; }

  /** User-initiated disconnect that disables reconnection and notifies UI immediately. */
  disconnect(reason = 'user') {
    if (!this.socket) return;
    this._manualClose = true;
    try { this.socket.io?.reconnection(false); } catch { /* no-op */ }
    try { this.socket.disconnect(); } catch { /* no-op */ }
    this.isConnected = false;
    this.listener?.onDisconnected?.(reason);
  }

  /** Close the connection and remove listeners. */
  close() {
    if (!this.socket) return;
    this._manualClose = true;                      // mark this as user/manual
    try { this.socket.io?.reconnection(false); } catch { /* no-op */ }

    // Remove listeners
    this.socket.off('connect', this._onConnect);
    this.socket.off('disconnect', this._onDisconnect);
    this.socket.off('connect_error', this._onConnectError);
    this.socket.off('signal', this._onSignal);
    this.socket.off('device_list', this._onDeviceList);
    this.socket.off('peer_left', this._onPeerLeft);

    // ✅ NEW: pair-room event
    this.socket.off('room_joined', this._onRoomJoined);

    this.socket.off('message', this._onMessage);
    this.socket.off('message_history', this._onMessageHistory);
    this.socket.off('control', this._onControl);

    try { this.socket.disconnect(); } catch { /* no-op */ }
    this.socket = null;
    this.isConnected = false;
  }

  /** Promise that resolves when connected (or rejects on timeout). */
  waitUntilConnected(ms = 10000) {
    if (this.isConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup(); reject(new Error('waitUntilConnected: timeout'));
      }, ms);
      const onUp = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error('waitUntilConnected: error')); };
      const cleanup = () => {
        clearTimeout(t);
        try {
          this.socket?.off('connect', onUp);
          this.socket?.off('connect_error', onErr);
        } catch { }
      };
      try {
        this.socket?.once('connect', onUp);
        this.socket?.once('connect_error', onErr);
      } catch {
        cleanup(); reject(new Error('waitUntilConnected: no socket'));
      }
    });
  }


  // ------------------------- Public API (parity) -------------------------

  /**
   * @param {{type:'offer', sdp:string}} offer
   * @param {string} from
   * @param {string} to
   */
  sendOffer(offer, from, to) {
    const data = { sdp: offer.sdp, type: (offer.type || 'offer') };
    this._emitSignal('offer', from, to, data);
  }

  /**
   * @param {{type:'answer', sdp:string}} answer
   * @param {string} from
   * @param {string} to
   */
  sendAnswer(answer, from, to) {
    const data = { sdp: answer.sdp, type: (answer.type || 'answer') };
    this._emitSignal('answer', from, to, data);
  }

  /**
   * @param {{candidate:string, sdpMid?:string, sdpMLineIndex?:number}} candidate
   * @param {string} from
   * @param {string} to
   */
  sendIceCandidate(candidate, from, to) {
    const data = {
      sdpMid: candidate.sdpMid ?? candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex ?? candidate.sdpMLineIndex,
      candidate: candidate.candidate ?? candidate.candidate
    };
    this._emitSignal('ice-candidate', from, to, data);
  }

  /**
   * Send a raw JSON string via the 'signal' channel (used for quality updates, etc.).
   * @param {string} json
   */
  sendRaw(json) {
    try {
      const payload = JSON.parse(json);
      this._send('signal', payload);
    } catch (e) {
      console.warn('sendRaw: invalid JSON', e);
    }
  }

  /** Manually override the preferred desktop id. */
  setCurrentDesktopId(xrId) {
    this.currentDesktopId = xrId || null;
  }

  // --------------------------- Internals ---------------------------

  _onConnect() {
    this.isConnected = true;
    this._gen++;
    // Clear any stale queued emits from previous sessions.
    // Fresh session must start with clean outbox.
    this._outbox.length = 0;

    // ✅ Option B strict: identify only (no legacy join)
    this.socket.emit('identify', { deviceName: this.deviceName, xrId: this.xrId });

    // Optional: request self-only list while waiting (server returns self-only when unpaired)
    this.socket.emit('request_device_list');


    // NOTE: do NOT flush outbox here.
    // We flush only after room_joined so pairing-sensitive commands can't fire too early.

    this.listener?.onConnected?.();
  }


  _onDisconnect(reason) {
    this.isConnected = false;
    this.roomId = null;
    this.listener?.onDisconnected?.(reason || (this._manualClose ? 'user' : 'transport'));
  }

  _onConnectError(err) {                 // ← FIXED name (was __onConnectError)
    this.isConnected = false;
    console.error('connect_error:', err?.message || err);
    this.listener?.onDisconnected?.('error');
  }

  _onSignal(obj) {
    // Server relays: { type, from, to?, data }
    const type = obj?.type;
    const from = obj?.from;
    const to = obj?.to ?? null;
    const data = obj?.data ?? {};
    this.listener?.onSignal?.(type, from, to, data);
  }

  _onRoomJoined(evt) {
    // Expected from server: { roomId, members? }
    const rid = evt?.roomId || null;
    this.roomId = rid;
    try { this.socket?.emit('request_device_list'); } catch { }

    // Now that we have roomId, flush any queued signals that were waiting for pairing.
    // Now that we have roomId, flush only items queued for THIS connect generation.
    try {
      const remaining = [];
      for (const item of this._outbox) {
        if (item?.gen === this._gen) this.socket?.emit(item.event, item.data);
        else remaining.push(item); // defensive: keep anything stale (should be none)
      }
      this._outbox = remaining;
    } catch {
      // ignore
    }



    console.log('[SIGNAL] room_joined → roomId:', rid);

    // Optional: forward to UI if needed
    this.listener?.onRoomJoined?.(evt);
  }


  _onDeviceList(arr) {
    if (!Array.isArray(arr)) return;
    const list = [];
    let desktopOnline = false;

    for (const o of arr) {
      const xrId = o?.xrId;
      const name = o?.deviceName || o?.name || 'Unknown';
      if (xrId && xrId !== this.xrId) list.push([name, xrId]);
      if (this.DESKTOP_ID && xrId && String(xrId).toUpperCase() === this.DESKTOP_ID) desktopOnline = true;

    }

    // Option B: no global "desktop" preference. Pick first available peer.
    // (Server enforces strict 1:1 pairing anyway.)
    this.currentDesktopId = (list[0]?.[1]) || null;


    // Fire single "desktop_disconnected" on transition (parity with Android)
    if (this.DESKTOP_ID && this._wasDesktopOnline && !desktopOnline) {
      const notice = { xrId: this.DESKTOP_ID, message: `Desktop [${this.DESKTOP_ID}] disconnected.` };
      this.listener?.onServerMessage?.('desktop_disconnected', notice);
    }

    this._wasDesktopOnline = desktopOnline;

    this.listener?.onDeviceListUpdated?.(list);
  }

  _onPeerLeft(obj) {
    const xrId = obj?.xrId;
    if (this.DESKTOP_ID && xrId && String(xrId).toUpperCase() === this.DESKTOP_ID) {
      this._wasDesktopOnline = false;
      this.listener?.onServerMessage?.('peer_left', obj);
    }
  }

  _onMessage(first) {
    this.listener?.onServerMessage?.('message', first);
  }

  _onMessageHistory(first) {
    this.listener?.onServerMessage?.('message_history', first);
  }

  // NEW: forward server 'control' events to UI (for request_offer, mute, etc.)
  _onControl(obj) {
    this.listener?.onControl?.(obj);
    this.listener?.onServerMessage?.('control', obj);
  }

  _emitSignal(type, from, to, data) {
    const payload = {
      type,
      from,
      to,
      ...(this.roomId ? { roomId: this.roomId } : {}),
      data
    };
    this._send('signal', payload);
  }

  // --- Optional convenience (APK parity) ---
  sendMessage(payload) { this._send('message', payload); }
  sendControl(payload) { this._send('control', payload); }
  sendTelemetry(payload) { this._send('telemetry', payload); }

  _send(event, data) {
    const s = this.socket;

    // Option B: never emit WebRTC signaling until we have server-issued roomId.
    // Otherwise offers/ICE get dropped server-side (no roomId yet) and streaming won't start.
    if (event === 'signal') {
      const t = data?.type;
      const webrtcTypes = new Set(['offer', 'answer', 'ice-candidate', 'request_offer']);
      if (webrtcTypes.has(t) && !this.roomId) {
        const item = { event, data, gen: this._gen };
        if (this._outbox.length < this._OUTBOX_MAX) this._outbox.push(item);
        else this._outbox.shift(), this._outbox.push(item);
        console.warn(`Queued WebRTC signal [${t}] until room_joined.`);
        return;
      }
    }

    // Option B: also gate pairing-sensitive CONTROL commands until room_joined.
    // Otherwise request_offer/start_stream can fire before pairing and get ignored,
    // causing "Connecting..." until a refresh.
    if (event === 'control') {
      const cmd = String(data?.command || data?.action || '').toLowerCase();
      const needsRoom = new Set(['request_offer', 'start_stream', 'stop_stream', 'scribe_flush']);
      if (needsRoom.has(cmd) && !this.roomId) {
        const item = { event, data, gen: this._gen };
        if (this._outbox.length < this._OUTBOX_MAX) this._outbox.push(item);
        else this._outbox.shift(), this._outbox.push(item);
        console.warn(`Queued CONTROL [${cmd}] until room_joined.`);
        return;
      }
    }

    if (s && this.isConnected) {
      s.emit(event, data);
    } else {
      // Queue and warn once for visibility
      const item = { event, data, gen: this._gen };
      if (this._outbox.length < this._OUTBOX_MAX) this._outbox.push(item);
      else this._outbox.shift(), this._outbox.push(item);
      console.warn(`Socket not connected. Queued emit [${event}].`);
    }
  }

}

export default SignalingClient;
