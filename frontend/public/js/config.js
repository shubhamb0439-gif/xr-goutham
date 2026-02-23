// /public/js/config.js
(function () {
  const qp = new URLSearchParams(location.search);
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '') ?? null;
  const up = v => (v ? String(v).trim().toUpperCase() : v);

  // SIGNAL URL priority: ?signal → injected → stored → same-origin → ngrok fallback
  const override = qp.get('signal');
  const injected = (typeof window !== 'undefined' && window.__SIGNAL_URL__) || null;
  let stored = null; try { stored = localStorage.getItem('signal_url') || null; } catch { }
  const sameOrigin = (location && location.origin) || null;


  // New priority (first non-null wins):
  // 1) ?signal=... (explicit override)
  // 2) stored (remembered override)
  // 3) same-origin (localhost:8080, ngrok domain, or production URL)
  // 4) injected (kept for backward compatibility/tools)
  window.SIGNAL_URL = pick(override, stored, sameOrigin, injected);

  // Persist explicit override for next loads
  if (override) { try { localStorage.setItem('signal_url', window.SIGNAL_URL); } catch { } }

  // (Optional but helpful) expose a unified name other files can reuse
  window.__HUB_URL__ = window.SIGNAL_URL;
  window.__SIGNAL_URL__ = window.SIGNAL_URL;

  // --- TURN / ICE inputs (from query or injected globals) ---
  // If you already pass full "turns:host:port?transport=tcp" URLs, we use them as-is.
  // Otherwise, we'll synthesize a set that includes TLS on 443.
  const injectedIce = (typeof window !== 'undefined' && window.__ICE_SERVERS__) || null;

  // Allow override via query (?turn, ?turnUser, ?turnCred) or injected globals
  const turnUrl = pick(
    qp.get('turn'),
    (typeof window !== 'undefined' && window.__TURN_URL__) || null
  );
  const turnUser = pick(
    qp.get('turnUser'), qp.get('turnUsername'),
    (typeof window !== 'undefined' && window.__TURN_USERNAME__) || null
  );
  const turnCred = pick(
    qp.get('turnCred'), qp.get('turnPassword'), qp.get('turnCredential'),
    (typeof window !== 'undefined' && window.__TURN_CREDENTIAL__) || null
  );


  // Build TURN urls that cover iOS/corporate networks (must include TLS 443)
  const buildTurnUrls = (base) => {
    if (!base) return [];
    if (Array.isArray(base)) return base;                     // already an array
    if (/^turns?:/i.test(base)) return [base];                // already a turn/turns URL
    // If user gave just a host (e.g., "turn.example.com"), synthesize common variants:
    const host = String(base).replace(/^https?:\/\//, '').replace(/^\/\//, '');
    return [
      `turns:${host}:443?transport=tcp`,   // <- critical for iOS/captive networks
      `turns:${host}:5349?transport=tcp`,
      `turn:${host}:3478?transport=tcp`,
      `turn:${host}:3478?transport=udp`
    ];
  };

  const defaultIce = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrls = buildTurnUrls(turnUrl);
  const maybeTurn = (turnUrls.length && turnUser && turnCred)
    ? [{ urls: turnUrls, username: turnUser, credential: turnCred }]
    : [];

  window.ICE_SERVERS = injectedIce || defaultIce.concat(maybeTurn);

  // XR IDs (overrideable via query or injection)
  const injectedDevice = (typeof window !== 'undefined' && window.__XR_DEVICE_ID__) || null;
  const injectedOperator = (typeof window !== 'undefined' && window.__XR_OPERATOR_ID__) || null;
  const qpDevice = qp.get('device') || qp.get('deviceId') || qp.get('xr_device');
  const qpOperator = qp.get('operator') || qp.get('operatorId') || qp.get('xr_operator');
  window.XR_DEVICE_ID = up(pick(qpDevice, injectedDevice, 'XR-1234'));
  window.XR_OPERATOR_ID = up(pick(qpOperator, injectedOperator, 'XR-1238'));

  console.log('[CONFIG] SIGNAL:', window.SIGNAL_URL);
  console.log('[CONFIG] ICE_SERVERS:', window.ICE_SERVERS);
  console.log('[CONFIG] XR IDs:', { device: window.XR_DEVICE_ID, operator: window.XR_OPERATOR_ID });
})();
