//-------------------------------------- public/js/device.js------------------------------------------------------------
// Browser/PWA port of: WebRtcStreamer.kt (+AudioStreamer.kt folded into getUserMedia)
// and PeerConnectionObserver logs (inline). Mirrors Android behavior.
// CITED FROM ANDROID SOURCE: WebRtcStreamer, AudioStreamer, PeerConnectionObserver.  (See upload) 

import { SignalingClient } from './signaling.js';
// ================= XR Device (/device) permissions ==================
// System_Screens.id = 4 → "XR Device" with route_path = "/device"
const XR_DEVICE_SCREEN_ID = 4;

let xrDevicePermissions = null;
let xrDevicePermsLoaded = false;

async function loadDevicePermissionsOnce() {
  if (xrDevicePermsLoaded) return;
  xrDevicePermsLoaded = true;

  // Only run in a browser context
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
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

    // ✅ Always match by screen ID to avoid route/name mismatch
    let match = screens.find(s => s.id === XR_DEVICE_SCREEN_ID);

    // Fallbacks (defensive)
    if (!match) {
      match = screens.find(s => (s.screen_name || '').toLowerCase() === 'xr device');
    }
    if (!match) {
      match = screens.find(s => (s.route_path || '').toLowerCase() === '/device');
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

    console.log('[XRDEVICE] Permissions:', xrDevicePermissions);
  } catch (err) {
    console.warn('[XRDEVICE] Failed to load my-screens:', err);
    xrDevicePermissions = null; // fail-open
  }
}

function hasDeviceWritePermission() {
  // If we couldn't load permissions, do not block anything (preserve existing behaviour)
  if (!xrDevicePermissions) return true;
  return !!xrDevicePermissions.write;
}

function notifyReadOnlyDevice() {
  const msg = 'You only have READ permission for XR Device. Streaming is not allowed.';
  // Prefer global showToast if the UI defines it
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(msg, 'error');
  } else if (typeof alert === 'function') {
    alert(msg);
  } else {
    console.warn(msg);
  }
}


export class WebRtcStreamer {
  /**
   * @param {Object} opts
   * @param {SignalingClient} opts.signaling  - instance from signaling.js
   * @param {string} [opts.androidXrId] - sender id (optional)
   * @param {Object} [opts.mediaConstraints]  - optional override of getUserMedia constraints
   */
  constructor({ signaling, androidXrId = null, mediaConstraints, iceServers } = {}) {

    if (!signaling) throw new Error('signaling is required');
    this.signaling = signaling;

    // ✅ Option B: default to the ID that this client identified as
    this.ANDROID_XR_ID = String(androidXrId || signaling.xrId || '').toUpperCase();

    // Local media
    this._localStream = null;

    this._videoEl = null;
    // Track all streams we create/bind so Stop can kill every track
    this._allStreams = new Set();
    this._cameraTrack = null; // optional: remember active camera track
    // PWA mic-swap helpers (keep RTP alive with silence while freeing hardware)
    this._audioContext = null;   // owns the silent track
    this._silentTrack = null;    // cached synthetic silence (MediaStreamTrack)


    // Peer connections by targetId
    /** @type {Map<string, RTCPeerConnection>} */
    this._pcs = new Map();

    // Streaming/quality state
    this._isStreaming = false;
    this._qualityTimer = null;
    this._qLastTs = 0;
    this._qLastBytes = 0;
    this._qLastPackets = 0;
    this._qLastPacketsLost = 0;

    // ICE: prefer injected config → ctor override → fallback to your current defaults
    this._iceServers = (iceServers
      || (typeof window !== 'undefined' && window.ICE_SERVERS)
      || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        {
          urls: [
            'turns:relay1.expressturn.com:5349',
            'turn:relay1.expressturn.com:3478?transport=tcp'
          ],
          username: '000000002071025048',
          credential: 'kRyX+FubO3gpvRDgS3MaPgf03Y='
        }
      ]);


    // Default media settings (parity with 640x480@30, env camera)
    this._constraints = mediaConstraints || {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
        facingMode: { ideal: 'environment' }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
  }

  // ---------------- Public API (parity with Android) ----------------

  /** Start streaming to a list of desktop XR IDs. */
  async startStreaming(targetIds = []) {
    if (this._isStreaming) return;

    // ===== Permission guard: XR Device READ vs WRITE =====
    try {
      // Only enforce in browser; skip in tests / non-browser contexts
      if (typeof window !== 'undefined') {
        await loadDevicePermissionsOnce();
        if (!hasDeviceWritePermission()) {
          notifyReadOnlyDevice();
          return; // do not start media or create peer connections
        }
      }
    } catch (e) {
      // Never break streaming if permission check itself fails
      console.warn('[XRDEVICE] Permission check failed, falling back to default behaviour:', e);
    }

    // 1) Capture media
    await this._ensureMedia();

    // 2) Create PCs, add tracks, and send offers
    for (const targetId of targetIds) {
      const pc = this._ensurePc(targetId);
      this._addLocalTracks(pc);
      await this._createAndSendOffer(targetId);
    }

    this._isStreaming = true;
  }


  /** Stop streaming to everyone and free resources. */
  async stopStreaming() {
    if (!this._isStreaming) return;

    // stop quality sampler
    this._stopQualitySampling();

    // close PCs
    // close PCs (stop + detach all sending tracks first → instant LED off)
    for (const pc of this._pcs.values()) {
      try {
        pc.getSenders().forEach((s) => {
          if (s.track) {
            try { s.track.stop(); } catch { }
            try { pc.removeTrack(s); } catch { }
          }
        });
      } catch { }
      try { pc.close(); } catch { }
    }
    this._pcs.clear();

    // stop local tracks
    if (this._localStream) {
      for (const t of this._localStream.getTracks()) try { t.stop(); } catch { }
      this._localStream = null;
    }

    // stop ANY remaining tracks we've ever created/bound
    try {
      for (const s of this._allStreams) {
        try { s.getTracks().forEach(t => { try { t.stop(); } catch { } }); } catch { }
      }
      this._allStreams.clear();
      this._cameraTrack = null;
    } catch { }



    // NEW: also stop any tracks bound directly to the preview element
    try {
      if (this._videoEl && this._videoEl.srcObject instanceof MediaStream) {
        this._videoEl.srcObject.getTracks().forEach(t => { try { t.stop(); } catch { } });
      }
    } catch { }

    // detach preview (pause + null + load to fully release element)
    if (this._videoEl) {
      try { this._videoEl.pause && this._videoEl.pause(); } catch { }
      try { this._videoEl.srcObject = null; } catch { }
      try { this._videoEl.load && this._videoEl.load(); } catch { }
    }

    this._isStreaming = false;
  }

  /** Force-stop local camera/mic and blank the preview (used by UI on Stop/Disconnect). */
  stopCamera() {
    try {
      if (this._localStream) {
        try { this._localStream.getTracks().forEach(t => t.stop && t.stop()); } catch { }
        this._localStream = null;
      }
    } catch { }

    try {
      if (this._videoEl) {
        try { this._videoEl.pause && this._videoEl.pause(); } catch { }
        this._videoEl.srcObject = null;
        try { this._videoEl.load && this._videoEl.load(); } catch { }
      }
    } catch { }
  }


  /** Desktop answered our offer. */
  async onRemoteAnswerReceived(answer, fromId) {
    const pc = this._pcs.get(fromId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer.sdp }));
    } catch (e) {
      console.error(`setRemoteDescription(answer) failed for ${fromId}`, e);
    }
  }

  /** Desktop sent us a remote offer (rare in your flow). */
  async onRemoteOfferReceived(offer, fromId) {
    let pc = this._pcs.get(fromId);
    if (!pc) {
      pc = this._ensurePc(fromId);
      this._addLocalTracks(pc);
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.sdp }));
      const desc = await pc.createAnswer();
      await pc.setLocalDescription(desc);
      this.signaling.sendAnswer({ type: 'answer', sdp: desc.sdp }, this.ANDROID_XR_ID, fromId);
    } catch (e) {
      console.error(`Answer flow failed for ${fromId}`, e);
    }
  }

  /** Desktop sent us a remote ICE candidate. */
  async onRemoteIceCandidate(candidate, fromId) {
    const pc = this._pcs.get(fromId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate({
        candidate: candidate.candidate,
        sdpMLineIndex: candidate.sdpMLineIndex,
        sdpMid: candidate.sdpMid
      }));
    } catch (e) {
      console.error(`addIceCandidate failed for ${fromId}`, e);
    }
  }

  /** Send a new SDP offer to a specific target (used when Dock sends control: request_offer). */
  async sendOfferTo(targetId) {
    await this._ensureMedia();
    const pc = this._ensurePc(targetId);
    this._addLocalTracks(pc);
    await this._createAndSendOffer(targetId);
  }

  // --- Mic swap strategy: free mic hardware while keeping RTP alive (Android-parity) ---
  _getSilentTrack() {
    // Reuse cached silent track if still live
    if (this._silentTrack && this._silentTrack.readyState === 'live') return this._silentTrack;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this._audioContext) this._audioContext = new AC();
    // Some Androids suspend AudioContext until a user gesture; resume defensively
    try { if (this._audioContext.state === 'suspended') this._audioContext.resume?.(); } catch { }

    const dest = this._audioContext.createMediaStreamDestination();
    this._silentTrack = dest.stream.getAudioTracks()[0];
    return this._silentTrack;
  }



  async _replaceSenderTrackOnAllPcs(trackOrNull) {
    for (const pc of this._pcs.values()) {
      const s = this._getAudioSender(pc);
      if (!s) continue;
      // Keep m=audio alive even when we free the mic
      const t = trackOrNull || this._getSilentTrack();
      try { await s.replaceTrack(t); } catch { }
    }
  }

  _stopLocalMicTracks() {
    if (!this._localStream) return;
    try {
      this._localStream.getAudioTracks().forEach(t => { try { t.stop(); } catch { } });
    } catch { }
  }


  /** Mute/unmute audio (same semantics as Android). */
  // Back-compat public APIs (buttons/voice may call these)
  mute() { this.muteMic(); }
  unmute() { return this.unmuteMic(); }

  // New robust mic controls
  async unmuteMic() {
    const track = await this._ensureMicTrack();
    if (!track) return;
    try { track.enabled = true; } catch { }

    // Attach/replace on every active PC
    for (const pc of this._pcs.values()) {
      const s = this._getAudioSender(pc);
      if (s) {
        try { await s.replaceTrack(track); } catch { }
      } else {
        try { pc.addTrack(track, this._localStream || new MediaStream([track])); } catch { }
      }
    }
  }

  muteMic() {
    // 1) Free the mic hardware so SpeechRecognition can use it while video keeps streaming
    this._stopLocalMicTracks();

    // 2) Keep RTP m=audio alive (no renegotiation / no UI flap) by sending silence
    this._replaceSenderTrackOnAllPcs(null).catch(() => { });

    // 3) Belt-and-suspenders: disable any residual audio tracks still hanging off localStream
    if (this._localStream) {
      try {
        this._localStream.getAudioTracks().forEach(t => { try { t.enabled = false; } catch { } });
      } catch { }
    }
  }


  hideVideo() { this._setVideoEnabled(false); }
  showVideo() {
    this._setVideoEnabled(true);
    // Ask for a fresh IDR so the remote can render immediately
    for (const pc of this._pcs.values()) this._requestKeyFrame(pc);
  }

  /** Attach/detach the local preview video element (SurfaceViewRenderer parity). */
  attachVideo(videoEl) {
    this._videoEl = videoEl || null;
    if (this._videoEl && this._localStream) {
      this._videoEl.playsInline = true;
      this._videoEl.muted = true; // local preview
      this._videoEl.srcObject = this._localStream;
      this._videoEl.onloadedmetadata = () => this._videoEl.play().catch(() => { });
      // ensure preview stream is tracked (Set prevents duplicates)
      this._allStreams.add(this._videoEl.srcObject);
    }
  }
  detachVideo() {
    if (this._videoEl) { try { this._videoEl.srcObject = null; } catch { } }
    this._videoEl = null;
  }

  // ----------------------- Internals -----------------------

  async _ensureMedia() {
    if (this._localStream) return;
    try {
      this._localStream = await navigator.mediaDevices.getUserMedia(this._constraints);
      if (this._videoEl) this.attachVideo(this._videoEl); // refresh preview binding
      // remember this stream/track for hard stop
      this._allStreams.add(this._localStream);
      this._cameraTrack = this._localStream.getVideoTracks()[0] || null;
      // iOS/Safari: help the encoder pick a sensible mode
      try {
        const v = this._cameraTrack;
        if (v && 'contentHint' in v && !v.contentHint) {
          v.contentHint = 'motion'; // good default for live camera
        }
      } catch { }


    } catch (e) {
      console.error('getUserMedia failed', e);
      throw e;
    }
  }

  _ensurePc(targetId) {
    let pc = this._pcs.get(targetId);
    if (pc) return pc;

    pc = new RTCPeerConnection({ iceServers: this._iceServers /* unified plan is default */ });

    // Logging parity (PeerConnectionObserver)
    pc.onicegatheringstatechange = () =>
      console.debug(`[${targetId}] iceGatheringState=${pc.iceGatheringState}`);
    pc.oniceconnectionstatechange = () =>
      console.debug(`[${targetId}] iceConnectionState=${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      console.debug(`[${targetId}] connectionState=${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        // Start sampling once when the first connection is active
        if (!this._qualityTimer) this._startQualitySampling(pc);
        this._requestKeyFrame(pc);          // <— ADD THIS LINE
      } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        if (!this._anyPcConnected()) this._stopQualitySampling();
      }
    };
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c) return;
      this.signaling.sendIceCandidate(
        { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex },
        this.ANDROID_XR_ID,
        targetId
      );
    };
    // (Receiver-side events not used on the sender; kept for completeness)
    pc.ontrack = (ev) => console.debug(`[${targetId}] ontrack`, ev.streams?.[0]);


    // Ensure the initial offer contains an m=audio section so first Unmute works without renegotiation.
    try {
      const hasAudio = typeof pc.getTransceivers === 'function'
        && pc.getTransceivers().some(t => t?.receiver?.track?.kind === 'audio');

      if (!hasAudio && typeof pc.addTransceiver === 'function') {
        pc.addTransceiver('audio', { direction: 'sendonly' });
      }
    } catch { }


    this._pcs.set(targetId, pc);
    console.debug(`[${targetId}] RTCPeerConnection created with TURN/STUN config`);
    return pc;
  }

  _addLocalTracks(pc) {
    const stream = this._localStream;
    if (!pc || !stream) return;

    // Clean up any empty senders (no track) that can accumulate after restart
    try {
      pc.getSenders()
        .filter(s => !s.track)
        .forEach(s => { try { pc.removeTrack(s); } catch { } });
    } catch { }

    const senders = pc.getSenders();

    stream.getTracks().forEach(track => {
      // 1) Already sending this exact track? → no-op
      if (senders.some(s => s.track === track)) return;

      // 2) Already sending a track of the same kind (audio/video)? → replace it
      const sameKind = senders.find(s => s.track && s.track.kind === track.kind);
      if (sameKind && typeof sameKind.replaceTrack === 'function') {
        sameKind.replaceTrack(track).catch(e => {
          console.warn('[RTC] replaceTrack failed, trying addTrack', e);
          try { pc.addTrack(track, stream); } catch (e2) { console.warn('[RTC] addTrack fallback failed', e2); }
        });
        return;
      }

      // 3) Otherwise add as new sender
      try {
        pc.addTrack(track, stream);
      } catch (e) {
        // Swallow "A sender already exists for the track" in edge cases
        console.warn('[RTC] addTrack failed (possibly duplicate)', e);
      }
    });

    this._requestKeyFrame(pc); // ← ADDED LINE: ask for an immediate keyframe
  }


  async _createAndSendOffer(targetId) {
    const pc = this._pcs.get(targetId);
    if (!pc) return;
    try {
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      this.signaling.sendOffer({ type: 'offer', sdp: offer.sdp }, this.ANDROID_XR_ID, targetId);
    } catch (e) {
      console.error(`create/send offer failed for ${targetId}`, e);
    }
  }

  _setAudioEnabled(enabled) {
    if (!this._localStream) return;
    this._localStream.getAudioTracks().forEach(t => (t.enabled = !!enabled));
  }
  _setVideoEnabled(enabled) {
    if (!this._localStream) return;
    this._localStream.getVideoTracks().forEach(t => (t.enabled = !!enabled));
  }

  // NEW: real mic state used by the button logic
  isMicMuted() {
    const t = this._localStream?.getAudioTracks?.()[0] || null;
    return !t || !t.enabled;
  }
  // ----- Mic helpers -----
  _getAudioSender(pc) {
    try {
      // Prefer an existing sender already carrying an audio track
      const withTrack = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (withTrack) return withTrack;

      // Otherwise, use the audio transceiver's sender even if it has no track yet
      if (typeof pc.getTransceivers === 'function') {
        const tr = pc.getTransceivers().find(t => t?.receiver?.track?.kind === 'audio');
        if (tr?.sender) return tr.sender;
      }
      return null;
    } catch { return null; }
  }

  // Request an immediate keyframe from the encoder (no renegotiation)
  _requestKeyFrame(pc) {
    try {
      const s = pc.getSenders().find(x => x.track && x.track.kind === 'video');
      if (s && typeof s.requestKeyFrame === 'function') s.requestKeyFrame();
    } catch { }
  }


  // Ensure we have a live audio track; reacquire if missing/ended
  async _ensureMicTrack() {
    // try existing
    let t = null;
    if (this._localStream) {
      t = this._localStream.getAudioTracks()[0] || null;
      if (t && t.readyState === 'live') return t;
    }

    // need a fresh audio-only stream
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._allStreams?.add?.(mic); // harmless if Set not present
    const track = mic.getAudioTracks()[0] || null;
    if (!track) return null;

    // make sure localStream exists and includes this audio track
    if (!this._localStream) this._localStream = new MediaStream();
    if (!this._localStream.getAudioTracks().length) {
      try { this._localStream.addTrack(track); } catch { }
    }
    return track;
  }


  _anyPcConnected() {
    for (const pc of this._pcs.values()) if (pc.connectionState === 'connected') return true;
    return false;
  }

  // -------- Quality sampler (3s cadence, mirrors Kotlin sendRaw payload) --------
  _startQualitySampling(pc) {
    if (this._qualityTimer) return;
    this._qLastTs = 0; this._qLastBytes = 0; this._qLastPackets = 0; this._qLastPacketsLost = 0;

    this._qualityTimer = setInterval(async () => {
      const now = Date.now();
      try {
        const stats = await pc.getStats();
        let bytesNow = 0, packetsNow = 0, packetsLostNow = 0;
        let jitterMs = 0.0, rttMs = 0.0;
        let remoteInboundId = null;

        stats.forEach(s => {
          if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video') && !s.isRemote) {
            bytesNow = (s.bytesSent ?? bytesNow);
            packetsNow = (s.packetsSent ?? packetsNow);
            remoteInboundId = s.remoteId ?? remoteInboundId;
          }
        });

        if (remoteInboundId && stats.has(remoteInboundId)) {
          const r = stats.get(remoteInboundId);
          const jitterSec = Number(r.jitter ?? 0);
          jitterMs = jitterSec * 1000.0;
          packetsLostNow = Number(r.packetsLost ?? 0);
          const rttSec = r.roundTripTime != null ? Number(r.roundTripTime) : null;
          if (rttSec != null) rttMs = rttSec * 1000.0;
        }

        // Fallback RTT from candidate-pair
        if (rttMs <= 0) {
          stats.forEach(p => {
            if (p.type === 'candidate-pair' && p.state === 'succeeded') {
              const rttSec = Number(p.currentRoundTripTime ?? 0);
              if (rttSec) rttMs = rttSec * 1000.0;
            }
          });
        }

        const dtSec = Math.max(1, (now - this._qLastTs)) / 1000.0;
        const kbps = this._qLastTs === 0 ? 0
          : (((bytesNow - this._qLastBytes) * 8.0 / 1000.0) / dtSec);
        const dSent = Math.max(0, packetsNow - this._qLastPackets);
        const dLost = Math.max(0, packetsLostNow - this._qLastPacketsLost);
        const lossPct = (dSent + dLost) > 0 ? (dLost * 100.0 / (dSent + dLost)) : 0.0;

        this._qLastTs = now;
        this._qLastBytes = bytesNow;
        this._qLastPackets = packetsNow;
        this._qLastPacketsLost = packetsLostNow;

        // Emit same JSON via signaling.sendRaw()
        const payload = {
          type: 'webrtc_quality_update',
          deviceId: this.ANDROID_XR_ID,
          samples: [{
            ts: now,
            jitterMs: Number(jitterMs.toFixed(1)),
            rttMs: Number(rttMs.toFixed(1)),
            lossPct: Number(lossPct.toFixed(2)),
            bitrateKbps: Math.round(kbps)
          }]
        };
        this.signaling.sendRaw(JSON.stringify(payload));
      } catch {
        // never crash; skip this tick
      }
    }, 3000);
  }

  _stopQualitySampling() {
    if (this._qualityTimer) {
      clearInterval(this._qualityTimer);
      this._qualityTimer = null;
    }
    this._qLastTs = this._qLastBytes = this._qLastPackets = this._qLastPacketsLost = 0;
  }
}

export default WebRtcStreamer;
