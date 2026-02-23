// frontend/webrtc-quality.js
// Exposes window.startWebRtcQualityMonitor (no modules needed)
(function () {
  function start(pc, { intervalMs = 3000, onSample = () => { } } = {}) {
    if (!pc || typeof pc.getStats !== 'function') {
      console.warn('[QUALITY] No RTCPeerConnection/getStats');
      return () => { };
    }

    // interval handle (fixed: no re-declare)
    let intervalId = null;

    // Last-sample snapshot for deltas
    let last = {
      ts: 0,
      lost: 0,
      recv: 0,
      bytes: 0,
      nack: 0,
      framesDecoded: 0,
      framesDropped: 0,
    };

    async function sample() {
      try {
        const report = await pc.getStats(null);

        let inboundVideo = null;
        let selectedPair = null;
        let remoteTrack = null;
        let nackCount = 0;

        report.forEach((r) => {
          // Receiver stats (video)
          if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
            inboundVideo = r;
            if (typeof r.nackCount === 'number') nackCount += r.nackCount;
          }

          // Selected candidate pair via transport or direct
          if (r.type === 'transport' && r.selectedCandidatePairId && report.get(r.selectedCandidatePairId)) {
            selectedPair = report.get(r.selectedCandidatePairId);
          } else if (r.type === 'candidate-pair' && r.nominated && (r.state === 'succeeded' || r.state === 'in-use')) {
            selectedPair = r;
          }

          // Remote track (video)
          if (r.type === 'track' && (r.kind === 'video' || r.trackIdentifier) && r.remoteSource === true) {
            remoteTrack = r;
          }
        });

        // ---- Cumulative metrics ----
        const jitterMs =
          inboundVideo && typeof inboundVideo.jitter === 'number'
            ? inboundVideo.jitter * 1000
            : null;

        const lost = inboundVideo?.packetsLost ?? 0;
        const recv = inboundVideo?.packetsReceived ?? 0;
        const total = lost + recv;
        const lossPct = total > 0 ? (lost / total) * 100 : null;

        // RTT: prefer currentRoundTripTime; fallback to roundTripTime (sec -> ms)
        let rttMs = null;
        if (selectedPair) {
          const sec =
            typeof selectedPair.currentRoundTripTime === 'number'
              ? selectedPair.currentRoundTripTime
              : typeof selectedPair.roundTripTime === 'number'
                ? selectedPair.roundTripTime
                : null;
          if (typeof sec === 'number') rttMs = sec * 1000;
        }

        // FPS / dropped fallback
        const framesPerSecond =
          (remoteTrack && typeof remoteTrack.framesPerSecond === 'number')
            ? remoteTrack.framesPerSecond
            : (inboundVideo && typeof inboundVideo.framesPerSecond === 'number')
              ? inboundVideo.framesPerSecond
              : null;

        const framesDropped =
          (remoteTrack && typeof remoteTrack.framesDropped === 'number')
            ? remoteTrack.framesDropped
            : (inboundVideo && typeof inboundVideo.framesDropped === 'number')
              ? inboundVideo.framesDropped
              : null;

        // ---- Interval (delta) metrics ----
        const now = Date.now();
        const dtSec = last.ts ? (now - last.ts) / 1000 : 0;

        const bytes = inboundVideo?.bytesReceived ?? 0;
        const framesDecoded = inboundVideo?.framesDecoded ?? 0;

        const dLost = Math.max(0, lost - last.lost);
        const dRecv = Math.max(0, recv - last.recv);
        const dBytes = Math.max(0, bytes - last.bytes);
        const dNack = Math.max(0, nackCount - last.nack);
        const dFrames = Math.max(0, framesDecoded - last.framesDecoded);
        const dDrop = Math.max(0, (framesDropped ?? 0) - (last.framesDropped ?? 0));

        const lossPctNow = (dLost + dRecv) > 0 ? (dLost / (dLost + dRecv)) * 100 : null;
        const bitrateKbps = dtSec > 0 ? (dBytes * 8) / 1000 / dtSec : null; // kbps
        const fpsNow = dtSec > 0 ? (dFrames / dtSec) : (framesPerSecond ?? null);

        // Update last snapshot
        last = {
          ts: now,
          lost,
          recv,
          bytes,
          nack: nackCount,
          framesDecoded,
          framesDropped: framesDropped ?? last.framesDropped,
        };

        // Emit
        onSample({
          // cumulative (back-compat)
          jitterMs,
          lossPct,
          rttMs,
          fps: framesPerSecond,
          dropped: framesDropped,
          nackCount,

          // interval (new)
          lossPctNow,
          bitrateKbps,
          nackNow: dNack,
          fpsNow,
          droppedNow: dDrop,
        });
      } catch (e) {
        console.warn('[QUALITY] getStats failed:', e);
      }
    }

    // Start
    intervalId = setInterval(sample, intervalMs);
    sample();

    // Disposer
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  }

  window.startWebRtcQualityMonitor = start;
})();
