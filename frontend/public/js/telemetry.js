// public/js/telemetry.js
// Browser/PWA port of TelemetryNetReporter.kt.
// Sends the same "telemetry" payload every ~12s.
// Fields that browsers can't access are kept but set to null for parity.

export class TelemetryReporter {
  /**
   * @param {Object} opts
   * @param {string} opts.xrId                         - e.g. "XR-1234"
   * @param {(event:string, payload:Object)=>void} opts.sendJson
   *        Function used to emit (event, payload) to the server.
   *        Example: (e,p)=>signaling.socket.emit(e,p)
   * @param {RTCPeerConnection} [opts.pc]              - optional; used to add netRttMs from ICE stats
   * @param {number} [opts.periodMs=12000]             - cadence (ms)
   */
  constructor({ xrId, sendJson, pc = null, periodMs = 12000 }) {
    if (!xrId) throw new Error('xrId required');
    if (!sendJson) throw new Error('sendJson(event,payload) required');
    this.xrId = xrId;
    this.sendJson = sendJson;
    this.pc = pc;
    this.periodMs = periodMs;

    this._timer = null;
    this._batteryMgr = null;
    this._conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection || null;

    // Try to warm up BatteryManager once (not supported everywhere)
    if (navigator.getBattery) {
      navigator.getBattery().then(b => (this._batteryMgr = b)).catch(() => { });
    }
  }

  start() {
    if (this._timer) return;
    // first tick immediately, then cadence
    this._tick().finally(() => {
      this._timer = setInterval(() => this._tick(), this.periodMs);
    });
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---------------- internals ----------------

  async _tick() {
    try {
      const payload = await this._collectOnce();
      this.sendJson('telemetry', payload);
    } catch (_) {
      // never throw
    }
  }

  async _collectOnce() {
    const now = Date.now();

    // ---- Connection type (mirror: wifi/cellular/ethernet/other/none) ----
    const online = navigator.onLine !== false;
    const c = this._conn;
    const type = !online
      ? 'none'
      : (
        (c && typeof c.type === 'string' && c.type.toLowerCase()) // explicit browser type if available
        || this._inferTypeFromEffective(c?.effectiveType)         // infer from effectiveType (4g/5g → wifi)
        || 'wifi'                                                 // sensible default on laptops/tablets
      );


    // ---- Battery / Temperature (browser can't read temp; keep key as null) ----
    const batteryLevel = await this._batteryLevel();
    const deviceTempC = null; // parity key, not available on web

    // ---- Memory (JS heap only; may be undefined on some browsers) ----
    let memUsedMb = null, memTotalMb = null;
    // Chrome-only performance.memory; numbers are JS heap, not device RAM
    const pm = performance && performance.memory ? performance.memory : null;
    if (pm) {
      memUsedMb = Math.round((pm.usedJSHeapSize || 0) / 1048576);
      memTotalMb = Math.round((pm.jsHeapSizeLimit || 0) / 1048576);
    }

    // For browser clients we don't want to render RAM pills → keep them null
    memUsedMb = null;
    memTotalMb = null;


    // ---- Network bandwidth (like linkDown/Up Mbps on Android) ----
    let netDownMbps = null, netUpMbps = null;
    if (c && typeof c.downlink === 'number') netDownMbps = Math.round(c.downlink); // Mbps
    // Uplink is not standardized; leave null to preserve schema
    if (c && typeof c.rtt === 'number') {
      // optional: you can also expose c.rtt as a separate field if desired
    }

    // Prefer real throughput from WebRTC stats (set by webrtc-quality.js), if present
    // window.__lastAvBr = { outKbps, inKbps }
    const br = window.__lastAvBr;
    if (br && typeof br.outKbps === 'number') {
      // true UL Mbps from outbound SRTP
      netUpMbps = Math.round((br.outKbps / 1000) * 10) / 10;
    }
    if (br && typeof br.inKbps === 'number') {
      // true DL Mbps from inbound SRTP
      netDownMbps = Math.round((br.inKbps / 1000) * 10) / 10;
    }


    // ---- Wi-Fi / Cellular details (not exposed to web; keep keys null) ----
    let wifiDbm = null, wifiMbps = null, wifiBars = null, cellBars = null, cellDbm = null;
    if (type === 'wifi') {
      wifiMbps = netDownMbps;
    }

    // ---- Optional: pull RTT from ICE stats if pc provided ----
    let netRttMs = null;
    if (this.pc) {
      try {
        const stats = await this.pc.getStats();
        stats.forEach(s => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded') {
            const rttSec = Number(s.currentRoundTripTime ?? 0);
            if (rttSec) netRttMs = Math.round(rttSec * 1000);
          }
        });
      } catch { }
    }

    const out = {
      xrId: this.xrId,
      connType: type || 'other',
      ts: now,
      // parity metrics
      cpuPct: null,                 // not accessible in browser
      memUsedMb,
      memTotalMb,
      deviceTempC,
      netDownMbps,
      netUpMbps,
      wifiDbm,
      wifiMbps,
      wifiBars,
      cellBars,
      cellDbm
    };

    // If you want to forward netRttMs alongside (doesn't exist in the Android JSON),
    // add it optionally; otherwise omit to keep payload identical:
    // out.netRttMs = netRttMs;

    // Also include battery level only if you want (Android reporter didn't send it explicitly):
    if (batteryLevel != null) out.batteryLevel = batteryLevel;

    return out;
  }

  _inferTypeFromEffective(effectiveType) {
    // Chrome often reports '4g/5g' over Wi-Fi; treat 4g/5g as Wi-Fi.
    const et = (effectiveType || '').toLowerCase();
    if (!et) return null; // unknown → let caller decide fallback
    if (et.includes('slow-2g') || et.includes('2g') || et.includes('3g')) return 'cellular';
    if (et.includes('4g') || et.includes('5g')) return 'wifi';
    return null; // unknown/new labels → let caller decide fallback
  }


  async _batteryLevel() {
    try {
      if (this._batteryMgr) return clamp01(this._batteryMgr.level);
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        this._batteryMgr = b;
        return clamp01(b.level);
      }
    } catch { }
    return null;
  }
}

function clamp01(x) {
  const n = Number(x);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export default TelemetryReporter;
