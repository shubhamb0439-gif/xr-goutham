(() => {
  'use strict';

  // =====================================================================================
  // DOM ELEMENTS
  // =====================================================================================
  const dom = {
    // cockpit header/panels
    statusPill: document.getElementById('statusPill'),
    deviceList: document.getElementById('deviceList'),
    transcript: document.getElementById('liveTranscript'),
    templateSelect: document.getElementById('templateSelect'),
    soapHost: document.getElementById('soapNotePanel'),

    // cockpit buttons
    btnClear: document.getElementById('_scribe_clear'),
    btnSave: document.getElementById('_scribe_save'),
    btnAddEhr: document.getElementById('_scribe_add_ehr'),

    // AI Diagnosis pane (RIGHT-BOTTOM or embedded)
    aiPane: document.getElementById('aiPane'),
    aiDiagnosisBody: document.getElementById('aiDiagnosisBody'),

    // EHR sidebar
    ehrButton: document.getElementById('ehrButton'),
    ehrSidebar: document.getElementById('ehrSidebar'),
    ehrOverlay: document.getElementById('ehrOverlay'),
    ehrCloseButton: document.getElementById('ehrCloseButton'),
    mrnInput: document.getElementById('mrnInput'),
    mrnSearchButton: document.getElementById('mrnSearchButton'),
    ehrError: document.getElementById('ehrError'),
    ehrInitialState: document.getElementById('ehrInitialState'),
    ehrPatientState: document.getElementById('ehrPatientState'),
    patientNameDisplay: document.getElementById('patientNameDisplay'),
    patientMRNDisplay: document.getElementById('patientMRNDisplay'),
    patientEmailDisplay: document.getElementById('patientEmailDisplay'),
    patientMobileDisplay: document.getElementById('patientMobileDisplay'),
    notesList: document.getElementById('notesList'),
    noteDetail: document.getElementById('noteDetail'),
  };

  // Ensure SOAP host exists
  if (!dom.soapHost) {
    console.warn('[SCRIBE] soapNotePanel not found, creating dynamically');
    dom.soapHost = document.createElement('div');
    dom.soapHost.id = 'soapNotePanel';
    dom.soapHost.className = 'flex-1 min-h-0';
    document.body.appendChild(dom.soapHost);
  }

  // =====================================================================================
  //  CONSTANTS + RUNTIME STATE
  // =====================================================================================
  const CONFIG = {
    PLACEHOLDER_ID: 'scribe-transcript-placeholder',
    MAX_TRANSCRIPT_LINES: 300,

    // endpoints
    LOCAL_DEFAULT: 'http://localhost:8080',
    PROD_DEFAULT: 'https://xr-messaging-geexbheshbghhab7.centralindia-01.azurewebsites.net',

    // timers
    DEVICE_LIST_POLL_MS: 1500,
    DEVICE_LIST_THROTTLE_ROOM_MS: 250,
    DEVICE_LIST_THROTTLE_NO_ROOM_MS: 1200,
    TRANSCRIPT_FLUSH_MS: 800,
    EMPTY_DEVICE_DELAY_MS: 800,

    // diff
    MAX_DELTA_CELLS: 20000,

    // EHR
    EHR_STORAGE_KEY: 'ehr_state_v1',
    SUMMARY_NOTE_ID: 'summary',

    // Templates
    SOAP_NOTE_TEMPLATE_ID: '20',

    // AI Diagnosis
    AI_DIAGNOSIS_ENDPOINT: '/ehr/ai/diagnosis',
  };

  const state = {
    // room/session
    currentRoom: null,
    COCKPIT_FOR_XR_ID: null,

    // socket
    SERVER_URL: null,
    socket: null,

    // transcript incremental state
    transcriptState: { byKey: {} },

    // active transcript
    currentActiveItemId: null,

    // soap note
    latestSoapNote: {},
    soapGenerating: false,
    soapNoteTimer: null,
    soapNoteStartTime: null,

    // Summary timer (NEW)
    summaryGenerating: false,
    summaryTimer: null,
    summaryStartTime: null,
    summaryRefreshDebounce: null,


    // FIFO queue: soap_note_console -> transcript item
    pendingSoapItemQueue: [],

    // total edits badge
    totalEditsBadgeEl: null,

    // per-textarea diff state
    editStateMap: new WeakMap(),

    // add-to-EHR guard
    addEhrInFlight: false,

    // device list throttling
    reqListTimer: null,
    lastReqListAt: 0,
    deviceListPollTimer: null,
    pendingEmptyDeviceListTimer: null,
    lastRenderedDeviceKey: '',

    // medication availability
    medAvailability: new Map(),
    medicationValidationPending: false,
    medicationDebounceTimer: null,

    // EHR sidebar state
    currentPatient: null,
    currentNotes: [],
    noteCache: new Map(),
    me: null, // cached /api/platform/me
    summaryCacheByMrn: new Map(), // mrn -> { text, template_title, fetchedAt, raw }
    patientCacheByMrn: new Map(), // mrn -> { patientId, patient }

    // AI diagnosis state
    aiDiagnosisInFlight: false,
    aiDiagnosisInFlightFor: null,
    aiDiagnosisLastError: null,
    aiDiagnosisTimer: null,
    aiDiagnosisStartTime: null,

    // Template selection requirement
    templateSelected: false,
    templateSelectionModal: null,

    // Summary cache invalidation on note edits
    noteTouchedAtByMrn: new Map(),
    lastNoteTouchedAt: 0,
  };

  // =============================================================================
  //  STORAGE KEYS (room-scoped + legacy fallback)
  // =============================================================================
  const LEGACY_KEYS = {
    HISTORY: 'scribe.history',
    LATEST_SOAP: 'scribe.latestSoap',
    ACTIVE_ITEM_ID: 'scribe.activeItem',
    MED_AVAIL: 'scribe.medAvailability',
  };

  function roomLS(base) {
    const r = state.currentRoom || '__noroom__';
    return `scribe:${r}:${base}`;
  }

  const LS_KEYS = {
    HISTORY: () => (state.currentRoom ? roomLS('history') : LEGACY_KEYS.HISTORY),
    LATEST_SOAP: () => (state.currentRoom ? roomLS('latestSoap') : LEGACY_KEYS.LATEST_SOAP),
    ACTIVE_ITEM_ID: () => (state.currentRoom ? roomLS('activeItem') : LEGACY_KEYS.ACTIVE_ITEM_ID),
    MED_AVAIL: () => (state.currentRoom ? roomLS('medAvailability') : LEGACY_KEYS.MED_AVAIL),
  };

  // =============================================================================
  //  UTILS
  // =============================================================================
  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function safeJsonParse(raw, fallback) {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function lsSafeParse(key, fallback) {
    try {
      return safeJsonParse(localStorage.getItem(key), fallback);
    } catch {
      return fallback;
    }
  }

  function clampNumber(n, fallback = 0) {
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  }

  function normalizeTextBlock(v) {
    return String(v ?? '').replace(/\r\n/g, '\n').trim();
  }

  function normalizeTemplateId(v) {
    const s = String(v ?? '').trim();
    return s ? s : CONFIG.SOAP_NOTE_TEMPLATE_ID;
  }

  function templateIdToApiValue(v) {
    const n = Number(normalizeTemplateId(v));
    return Number.isFinite(n) && n > 0 ? n : Number(CONFIG.SOAP_NOTE_TEMPLATE_ID);
  }

  async function apiGetJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  // =============================================================================
  //  ENDPOINT SELECTION
  // =============================================================================
  const OVERRIDES = Array.isArray(window.SCRIBE_PUBLIC_ENDPOINTS)
    ? window.SCRIBE_PUBLIC_ENDPOINTS
    : null;

  const LOCAL = (OVERRIDES?.[0] || CONFIG.LOCAL_DEFAULT).replace(/\/$/, '');
  const PRODUCTION = (OVERRIDES?.[1] || CONFIG.PROD_DEFAULT).replace(/\/$/, '');

  const host = location.hostname;
  const isLocal =
    location.protocol === 'file:' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local') ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

  const preferredEndpoint = isLocal ? LOCAL : PRODUCTION;
  const fallbackEndpoint = isLocal ? PRODUCTION : LOCAL;

  // =============================================================================
  //  STYLES
  // =============================================================================
  function createTemplateSelectionModal() {
    const modal = document.createElement('div');
    modal.id = 'templateSelectionModal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      backdrop-filter: blur(4px);
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      background: #1f2937;
      padding: 32px;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      max-width: 500px;
      width: 90%;
      text-align: center;
    `;

    const title = document.createElement('h2');
    title.textContent = 'Select Note Template';
    title.style.cssText = `
      font-size: 24px;
      font-weight: bold;
      margin-bottom: 12px;
      color: #fff;
    `;

    const desc = document.createElement('p');
    desc.textContent = 'Please select a template before starting transcription';
    desc.style.cssText = `
      font-size: 14px;
      color: #9ca3af;
      margin-bottom: 24px;
    `;

    const select = document.createElement('select');
    select.id = 'modalTemplateSelect';
    select.style.cssText = `
      width: 100%;
      padding: 12px 16px;
      font-size: 16px;
      border: 2px solid #374151;
      border-radius: 10px;
      background: #111827;
      color: #fff;
      margin-bottom: 24px;
      cursor: pointer;
    `;

    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `
      display: flex;
      gap: 12px;
      width: 100%;
    `;

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Confirm Selection';
    confirmBtn.style.cssText = `
      flex: 1;
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 700;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.2s;
    `;
    confirmBtn.onmouseover = () => confirmBtn.style.background = '#4f46e5';
    confirmBtn.onmouseout = () => confirmBtn.style.background = '#6366f1';

    confirmBtn.onclick = () => {
      const selectedValue = select.value;
      if (selectedValue) {
        state.templateSelected = true;
        if (dom.templateSelect) {
          dom.templateSelect.value = selectedValue;
        }
        modal.remove();
        state.templateSelectionModal = null;
      }
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      flex: 1;
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 700;
      background: #374151;
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.2s;
    `;
    cancelBtn.onmouseover = () => cancelBtn.style.background = '#4b5563';
    cancelBtn.onmouseout = () => cancelBtn.style.background = '#374151';

    cancelBtn.onclick = () => {
      modal.remove();
      state.templateSelectionModal = null;
    };

    buttonContainer.appendChild(confirmBtn);
    buttonContainer.appendChild(cancelBtn);

    content.appendChild(title);
    content.appendChild(desc);
    content.appendChild(select);
    content.appendChild(buttonContainer);
    modal.appendChild(content);

    document.body.appendChild(modal);
    state.templateSelectionModal = modal;

    return { modal, select };
  }

  function showTemplateSelectionModal() {
    if (state.templateSelectionModal) return;
    if (state.templateSelected) return;

    const { modal, select } = createTemplateSelectionModal();

    if (dom.templateSelect) {
      Array.from(dom.templateSelect.options).forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.textContent;
        select.appendChild(option);
      });
      select.value = dom.templateSelect.value;
    }
  }

  function ensureUiStyles() {
    if (document.getElementById('scribe-ui-css')) return;

    const MAIN_BG = '#0b1220';
    const BOX_BG = '#111827';
    const TEXT = '#e5e7eb';
    const MUTED = '#94a3b8';
    const BORDER = 'rgba(148,163,184,0.25)';

    const s = document.createElement('style');
    s.id = 'scribe-ui-css';
    s.textContent = `
      #templateSelect {
        background: #0f1724 !important;
        color: #ffffff !important;
        border: 1px solid rgba(255,255,255,0.12) !important;
        border-radius: 8px;
        padding: 8px 10px;
        outline: none;
        width: 320px;
        max-width: 48vw;
        min-width: 220px;
        box-sizing: border-box;
        font-size: 14px;
        appearance: auto;
      }
      #templateSelect:hover { background: rgba(55, 65, 81, 0.75) !important; }
      #templateSelect:focus { box-shadow: 0 0 0 2px rgba(96,165,250,0.35); }
      #templateSelect option { background: ${MAIN_BG} !important; color: #fff !important; padding: 6px 10px; }

      #soapNotePanel, #soapScroller { background: ${MAIN_BG} !important; color: ${TEXT} !important; }
      .scribe-soap-scroll {
        padding: 10px 12px;
        height: 100%;
        overflow: auto;
        background: ${MAIN_BG} !important;
        border-radius: 6px;
      }
      .scribe-section {
        margin: 10px 0;
        border: 1px solid ${BORDER};
        border-radius: 10px;
        overflow: hidden;
        background: ${BOX_BG} !important;
      }
      .scribe-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        background: ${MAIN_BG} !important;
        color: ${TEXT} !important;
        border-bottom: 1px solid ${BORDER};
      }
      .scribe-section-head h3 { margin: 0; font-size: 14px; font-weight: 700; color: ${TEXT} !important; }
      .scribe-section-meta { font-size: 12px; color: ${MUTED} !important; white-space: nowrap; opacity: 0.95; }

      .scribe-textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border: none;
        outline: none;
        resize: none;
        background: ${BOX_BG} !important;
        color: ${TEXT} !important;
        font-size: 14px;
        line-height: 1.45;
        min-height: 80px;
      }

      /* Clamp textarea height to enable inner scroll (stable layout) */
      .scribe-textarea { max-height: 220px; overflow-y: auto; }


      ._scribe_total_edits {
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:6px 10px;
        border-radius:999px;
        background: rgba(255,255,255,0.08);
        color: ${TEXT};
        font-weight: 700;
        font-size: 12px;
        white-space: nowrap;
      }

      /* Auto-save only */
      #_scribe_save { display:none !important; }

      /* AI Diagnosis button states */
      .scribe-ai-btn{
        border: 0;
        border-radius: 10px;
        padding: 0 16px;
        height: 36px;
        min-width: 132px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        color: #ffffff;
        transition: background .15s ease, border-color .15s ease, opacity .15s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .scribe-ai-btn.scribe-ai-btn--generate{
       background: #0F4D0F !important;
       border: 1px solid rgba(15, 77, 15, 0.85) !important;
       color: #ffffff !important;
      }
       .scribe-ai-btn.scribe-ai-btn--generate:hover{
       background: #0c3f0c !important;
       border-color: rgba(15, 77, 15, 1) !important;
      }

      .scribe-ai-btn.scribe-ai-btn--generating{
        background: rgba(245,158,11,0.18);
        border: 1px solid rgba(245,158,11,0.55);
        cursor: not-allowed;
      }
      .scribe-ai-btn.scribe-ai-btn--generated{
        background: rgba(148,163,184,0.12);
        border: 1px solid rgba(148,163,184,0.35);
        color: rgba(255,255,255,0.75);
        cursor: not-allowed;
      }
      .scribe-ai-btn:disabled{ opacity: 1; }

      /* AI Diagnosis button in section head: ensure it stays on same line */
      .scribe-section-head .scribe-ai-btn {
        flex-shrink: 0;
        margin-left: auto;
      }

      /* AI Diagnosis header: title left, button right aligned on same line */
      .scribe-ai-pane-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        gap: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .scribe-ai-pane-title {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
        color: #ffffff;
        flex: 0 0 auto;
      }

      .scribe-ai-body { padding: 12px 14px; color: #ffffff; height: 100%; box-sizing: border-box; }
      .scribe-ai-body-inner {
        max-width: 900px;
        margin: 0 auto;
        font-size: 14px;
        line-height: 1.8;
        word-break: break-word;
        text-align: justify;
        text-justify: inter-word;
      }

      .scribe-ai-center {
        min-height: 160px;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      .scribe-ai-empty { color: rgba(255,255,255,0.65); font-weight: 700; }
      .scribe-ai-loading { color:#ffffff; font-weight: 800; }
      .scribe-ai-error { color:#f87171; font-weight: 800; }

.scribe-ai-comp { margin: 12px 0 18px 0; }
.scribe-ai-comp-box {
  border: 1px solid rgba(148,163,184,0.25);
  border-radius: 10px;
  overflow: hidden;
  background: #111827 !important;
}
.scribe-ai-comp-box-head {
  display:flex; align-items:center; justify-content:space-between;
  padding: 10px 12px;
  background: #0b1220 !important;
  border-bottom: 1px solid rgba(148,163,184,0.25);
  font-weight: 900;
}
.scribe-ai-comp-box-body {
  padding: 10px 12px;
  max-height: 220px;
  overflow: auto;
  color: rgba(255,255,255,0.92);
  line-height: 1.7;
  word-break: break-word;
  text-align: justify;
  text-justify: inter-word;
}

      .scribe-ai-comp-title { font-weight: 900; color: #ffffff; margin: 0 0 8px 0; }
      .scribe-ai-comp-text {
        text-align: justify;
        text-justify: inter-word;
      }
      .scribe-ai-comp-text p {
        margin: 0 0 12px 0;
        color: rgba(255,255,255,0.92);
        text-align: justify;
        text-justify: inter-word;
        hyphens: auto;
      }
    
/* === AI Diagnosis: match SOAP note section look + scrolling === */
.scribe-ai-pane-scroll{
  height: 100%;
  overflow: auto;
  padding-right: 6px;
}
.scribe-ai-sections{
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 12px 0 18px 0;
}
.scribe-ai-section .scribe-section-head{
  background: #0b1220 !important;
}
.scribe-ai-comp-scroll{
  padding: 10px 12px;
  max-height: 240px;
  overflow: auto;
  color: rgba(255,255,255,0.92);
  line-height: 1.7;
  word-break: break-word;
}
.scribe-ai-comp-scroll::-webkit-scrollbar{
  width: 8px;
}
.scribe-ai-comp-scroll::-webkit-scrollbar-thumb{
  background: rgba(148,163,184,0.35);
  border-radius: 10px;
}
.scribe-ai-pane-scroll::-webkit-scrollbar{
  width: 10px;
}
.scribe-ai-pane-scroll::-webkit-scrollbar-thumb{
  background: rgba(148,163,184,0.35);
  border-radius: 10px;
}

`;
    document.head.appendChild(s);
  }

  function ensureMedStyles() {
    if (document.getElementById('med-inline-css')) return;
    const s = document.createElement('style');
    s.id = 'med-inline-css';
    s.textContent = `
      .med-line { display:flex; align-items:center; gap:8px; }
      .med-emoji { font-weight: 800; display:inline-block; transform-origin:center; }
      .med-wrap { position: relative; }
      .med-overlay {
        position:absolute;
        inset:0;
        pointer-events:none;
        white-space: pre-wrap;
        overflow:hidden;
        font: inherit;
        line-height: inherit;
        color: inherit;
        z-index:2;
      }
      @keyframes pulse { 0%,100% { transform:scale(1); opacity:1; } 50% { transform:scale(.9); opacity:.7; } }
      .med-pending { animation: pulse 1.2s ease-in-out infinite; }
    `;
    document.head.appendChild(s);
  }

  // =============================================================================
  //  STATUS PILL
  // =============================================================================
  function setStatus(text) {
    if (!dom.statusPill) return;
    dom.statusPill.textContent = text;
    dom.statusPill.setAttribute('aria-label', `Connection status: ${text}`);

    dom.statusPill.classList.remove('bg-yellow-500', 'bg-green-500', 'bg-red-600');
    switch (String(text || '').toLowerCase()) {
      case 'connected':
        dom.statusPill.classList.add('bg-green-500');
        break;
      case 'disconnected':
        dom.statusPill.classList.add('bg-red-600');
        break;
      default:
        dom.statusPill.classList.add('bg-yellow-500');
        break;
    }
  }

  function updateConnectionStatus(_src, devices = []) {
    const connected = !!(state.socket && state.socket.connected);
    const count = Array.isArray(devices) ? devices.length : 0;

    if (!connected) return setStatus('Disconnected');
    const status = count === 0 ? 'Disconnected' : count === 1 ? 'Connecting' : 'Connected';
    setStatus(status);
  }

  // =============================================================================
  //  HISTORY STORAGE
  // =============================================================================
  function saveHistory(arr) {
    localStorage.setItem(LS_KEYS.HISTORY(), JSON.stringify(arr || []));
  }
  function loadHistory() {
    return lsSafeParse(LS_KEYS.HISTORY(), []);
  }
  function saveLatestSoap(soap) {
    localStorage.setItem(LS_KEYS.LATEST_SOAP(), JSON.stringify(soap || {}));
  }
  function loadLatestSoap() {
    return lsSafeParse(LS_KEYS.LATEST_SOAP(), {});
  }
  function saveActiveItemId(id) {
    localStorage.setItem(LS_KEYS.ACTIVE_ITEM_ID(), id || '');
  }
  function loadActiveItemId() {
    return localStorage.getItem(LS_KEYS.ACTIVE_ITEM_ID()) || '';
  }

  // =============================================================================
  //  HISTORY NORMALIZATION (migration)
  // =============================================================================
  function normalizeHistoryItems(hist) {
    let changed = false;

    for (const item of hist) {
      if (!item.note) {
        if (item.notes?.default || item.soap) {
          item.note = {
            templateId: CONFIG.SOAP_NOTE_TEMPLATE_ID,
            data: item.notes?.default || item.soap || {},
          };
          changed = true;
        } else if (item.notes?.templates && Object.keys(item.notes.templates).length) {
          const firstKey = Object.keys(item.notes.templates)[0];
          item.note = { templateId: String(firstKey), data: item.notes.templates[firstKey] || {} };
          changed = true;
        } else {
          item.note = { templateId: CONFIG.SOAP_NOTE_TEMPLATE_ID, data: {} };
          changed = true;
        }
      }

      if (item.note) {
        const tid = String(item.note.templateId ?? '').trim();
        if (!tid || tid === 'default') {
          item.note.templateId = CONFIG.SOAP_NOTE_TEMPLATE_ID;
          changed = true;
        }
      }

      if (item.notes || item.soap || item.activeTemplateId) {
        delete item.notes;
        delete item.soap;
        delete item.activeTemplateId;
        changed = true;
      }

      if (item.aiDiagnosis && !item.aiDiagnosisByTemplate) {
        item.aiDiagnosisByTemplate = item.aiDiagnosisByTemplate || {};
        changed = true;
      }
    }

    if (changed) saveHistory(hist);
    return hist;
  }

  function getActiveHistoryContext() {
    const hist = normalizeHistoryItems(loadHistory());
    const activeId = loadActiveItemId();
    const idx = activeId ? hist.findIndex((x) => x.id === activeId) : -1;
    const i = idx !== -1 ? idx : hist.length ? hist.length - 1 : -1;
    return { hist, index: i, item: i !== -1 ? hist[i] : null };
  }

  function getActiveNoteForItem(item) {
    return item?.note?.data || {};
  }

  function getActiveTemplateIdForItem(item) {
    return normalizeTemplateId(item?.note?.templateId);
  }

  function setActiveTemplateIdForItem(item, templateId) {
    item.note = item.note || { templateId: CONFIG.SOAP_NOTE_TEMPLATE_ID, data: {} };
    item.note.templateId = normalizeTemplateId(templateId);
  }

  function setActiveNoteDataForItem(item, noteObj) {
    item.note = item.note || { templateId: CONFIG.SOAP_NOTE_TEMPLATE_ID, data: {} };
    item.note.data = noteObj || {};
  }

  function setTemplateSelectValue(value) {
    if (!dom.templateSelect) return;
    const v = normalizeTemplateId(value);
    const has = Array.from(dom.templateSelect.options || []).some((o) => o.value === v);
    dom.templateSelect.value = has ? v : CONFIG.SOAP_NOTE_TEMPLATE_ID;
  }

  function syncDropdownToActiveTranscript() {
    if (!dom.templateSelect) return;
    const { item } = getActiveHistoryContext();
    setTemplateSelectValue(getActiveTemplateIdForItem(item));
  }

  // =============================================================================
  //  TRANSCRIPT UI
  // =============================================================================
  function ensureTranscriptPlaceholder() {
    if (!dom.transcript) return;
    if (!document.getElementById(CONFIG.PLACEHOLDER_ID)) {
      const ph = document.createElement('p');
      ph.id = CONFIG.PLACEHOLDER_ID;
      ph.className = 'text-gray-400 italic';
      ph.textContent = 'No transcript yet…';
      dom.transcript.appendChild(ph);
    }
  }

  function removeTranscriptPlaceholder() {
    const ph = document.getElementById(CONFIG.PLACEHOLDER_ID);
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
  }

  function applyClamp(el, collapse = true) {
    if (collapse) {
      el.dataset.collapsed = 'true';
      el.style.display = '-webkit-box';
      el.style.webkitBoxOrient = 'vertical';
      el.style.webkitLineClamp = '4';
      el.style.overflow = 'hidden';
    } else {
      el.dataset.collapsed = 'false';
      el.style.display = '';
      el.style.webkitBoxOrient = '';
      el.style.webkitLineClamp = '';
      el.style.overflow = '';
      el.style.maxHeight = 'none';
    }
  }

  function highlightActiveCard() {
    if (!dom.transcript) return;
    dom.transcript.querySelectorAll('.scribe-card').forEach((c) => c.classList.remove('scribe-card-active'));

    const active = dom.transcript.querySelector(`.scribe-card[data-id="${CSS.escape(loadActiveItemId())}"]`);
    if (active) active.classList.add('scribe-card-active');
  }

  function trimTranscriptIfNeeded() {
    if (!dom.transcript) return;
    const cards = dom.transcript.querySelectorAll('.scribe-card');
    if (cards.length <= CONFIG.MAX_TRANSCRIPT_LINES) return;

    const excess = cards.length - CONFIG.MAX_TRANSCRIPT_LINES;
    for (let i = 0; i < excess; i++) {
      const first = dom.transcript.querySelector('.scribe-card');
      if (first) dom.transcript.removeChild(first);
    }
  }

  function deleteTranscriptItem(id) {
    const hist = normalizeHistoryItems(loadHistory());
    const idx = hist.findIndex((x) => x.id === id);
    if (idx === -1) return;

    hist.splice(idx, 1);
    saveHistory(hist);

    const node = dom.transcript?.querySelector(`.scribe-card[data-id="${CSS.escape(id)}"]`);
    if (node) node.remove();

    const qIdx = state.pendingSoapItemQueue.indexOf(id);
    if (qIdx !== -1) state.pendingSoapItemQueue.splice(qIdx, 1);

    const remaining = dom.transcript?.querySelectorAll('.scribe-card') || [];
    if (remaining.length === 0) {
      ensureTranscriptPlaceholder();
      state.latestSoapNote = {};
      saveLatestSoap(state.latestSoapNote);
      saveActiveItemId('');
      state.soapGenerating = false;
      stopSoapGenerationTimer();
      renderSoapBlank();
      if (dom.templateSelect) setTemplateSelectValue(CONFIG.SOAP_NOTE_TEMPLATE_ID);
      clearAiDiagnosisPaneUi();
      return;
    }

    const activeId = loadActiveItemId();
    if (activeId === id) {
      const newActive = hist.length ? hist[hist.length - 1].id : '';
      if (newActive) setActiveTranscriptId(newActive);
    } else {
      highlightActiveCard();
      renderAiDiagnosisUi(null);
    }
  }

  function createTranscriptCard(item) {
    const { id, from, to, text, timestamp } = item;

    const card = document.createElement('div');
    card.className = 'scribe-card';
    card.dataset.id = id;

    const header = document.createElement('div');
    header.className = 'text-sm mb-1';
    const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    header.innerHTML = `🗣️ <span class="font-bold">${escapeHtml(from || 'Unknown')}</span>
      <span class="opacity-60">→ ${escapeHtml(to || 'Unknown')}</span>
      <span class="opacity-60">(${escapeHtml(time)})</span>`;
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'text-sm leading-6 text-gray-100';
    body.style.textAlign = 'justify';
    body.textContent = text || '';
    applyClamp(body, true);
    card.appendChild(body);

    const del = document.createElement('button');
    del.setAttribute('data-action', 'delete');
    del.className = 'scribe-delete';
    del.title = 'Delete this transcript & linked notes';
    del.innerHTML = '🗑️';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTranscriptItem(id);
    });
    card.appendChild(del);

    card.addEventListener('click', (e) => {
      if (e.target.closest('button[data-action="delete"]')) return;
      setActiveTranscriptId(id);
      const collapsed = body.dataset.collapsed === 'true';
      applyClamp(body, !collapsed);
    });

    if (id === loadActiveItemId()) card.classList.add('scribe-card-active');
    return card;
  }

  function setActiveTranscriptId(id) {
    state.currentActiveItemId = id;
    saveActiveItemId(id);
    highlightActiveCard();

    // clear cross-item error so it doesn't block viewing cached results elsewhere
    state.aiDiagnosisLastError = null;

    const ctx = getActiveHistoryContext();
    state.latestSoapNote = getActiveNoteForItem(ctx.item) || loadLatestSoap() || {};
    if (!state.soapGenerating) renderSoapNote(state.latestSoapNote);

    syncDropdownToActiveTranscript();
    renderAiDiagnosisUi(null);
  }

  function appendTranscriptItem({ from, to, text, timestamp }) {
    if (!dom.transcript || !text) return;

    removeTranscriptPlaceholder();

    // Use the currently selected template ID from the dropdown
    const selectedTemplateId = dom.templateSelect?.value || CONFIG.SOAP_NOTE_TEMPLATE_ID;

    const item = {
      id: uid(),
      from: from || 'Unknown',
      to: to || 'Unknown',
      text: String(text || '').trim(),
      timestamp: timestamp || Date.now(),
      note: { templateId: selectedTemplateId, data: {} },
    };

    const hist = normalizeHistoryItems(loadHistory());
    hist.push(item);
    saveHistory(hist);

    dom.transcript.appendChild(createTranscriptCard(item));
    trimTranscriptIfNeeded();
    dom.transcript.scrollTop = dom.transcript.scrollHeight;

    setActiveTranscriptId(item.id);

    // Automatically generate note using the selected template
    requestNoteGenerationForActiveTranscript(selectedTemplateId);
  }

  // =============================================================================
  //  SOAP SECTIONS ORDERING
  // =============================================================================
  function getSoapSections(soap) {
    const defaultSections = [
      'Chief Complaints',
      'History of Present Illness',
      'Subjective',
      'Objective',
      'Assessment',
      'Plan',
      'Medication',
    ];

    const comps = soap?._templateMeta?.components;
    if (Array.isArray(comps) && comps.length) {
      const ordered = comps
        .slice()
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
        .map((x) => String(x.name || '').trim())
        .filter(Boolean);
      if (ordered.length) return ordered;
    }

    const keys = Object.keys(soap || {}).filter((k) => !k.startsWith('_'));
    if (keys.length) {
      const hasAnyDefault = defaultSections.some((s) => keys.includes(s));
      if (!hasAnyDefault) return keys;
    }

    return defaultSections;
  }

  // =============================================================================
  //  SOAP CONTAINER + TIMER UI
  // =============================================================================
  function soapContainerEnsure() {
    let scroller = document.getElementById('soapScroller');
    if (!scroller) {
      scroller = document.createElement('div');
      scroller.id = 'soapScroller';
      scroller.className = 'scribe-soap-scroll scribe-scroll';
      dom.soapHost.appendChild(scroller);
    }
    return scroller;
  }

  function renderSoapBlank() {
    soapContainerEnsure().innerHTML = '';
  }

  function ensureTopHeadingBadge() {
    const slot = document.getElementById('totalEditsSlot');
    if (!slot) return null;

    if (!state.totalEditsBadgeEl || !slot.contains(state.totalEditsBadgeEl)) {
      state.totalEditsBadgeEl = document.createElement('span');
      state.totalEditsBadgeEl.id = '_scribe_total_edits';
      state.totalEditsBadgeEl.className = '_scribe_total_edits';
      state.totalEditsBadgeEl.textContent = 'Total Edits: 0';
      slot.replaceChildren(state.totalEditsBadgeEl);
    }
    return state.totalEditsBadgeEl;
  }

  function stopSoapGenerationTimer() {
    if (state.soapNoteTimer) {
      clearInterval(state.soapNoteTimer);
      state.soapNoteTimer = null;
    }
    state.soapNoteStartTime = null;
  }

  function renderSoapNoteGenerating(elapsedSec) {
    const scroller = soapContainerEnsure();
    scroller.innerHTML = `
      <div class="scribe-section" style="text-align:center; color:#f59e0b; padding:16px;">
        Please wait, AI is generating the note… ${elapsedSec}s
      </div>
    `;
    ensureTopHeadingBadge();
    renderAiDiagnosisUi(null);
  }

  function renderSoapNoteError(msg) {
    const scroller = soapContainerEnsure();
    scroller.innerHTML = `
      <div class="scribe-section" style="text-align:center; color:#f87171; padding:16px;">
        Error generating note: ${escapeHtml(String(msg || 'Unknown error'))}
      </div>
    `;
    ensureTopHeadingBadge();
    renderAiDiagnosisUi(null);
  }

  function startSoapGenerationTimer() {
    stopSoapGenerationTimer();
    state.soapGenerating = true;
    state.soapNoteStartTime = Date.now();
    renderSoapNoteGenerating(0);

    state.soapNoteTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - state.soapNoteStartTime) / 1000);
      renderSoapNoteGenerating(elapsedSec);
    }, 1000);
  }

  // =============================================================================
  // SUMMARY TIMER (simple, same pattern as SOAP)
  // =============================================================================
  function stopSummaryTimer() {
    if (state.summaryTimer) {
      clearInterval(state.summaryTimer);
      state.summaryTimer = null;
    }
    state.summaryStartTime = null;
    state.summaryGenerating = false;
  }

  function stopAiDiagnosisTimer() {
    if (state.aiDiagnosisTimer) {
      clearInterval(state.aiDiagnosisTimer);
      state.aiDiagnosisTimer = null;
    }
    state.aiDiagnosisStartTime = null;
  }

  function startAiDiagnosisTimer() {
    stopAiDiagnosisTimer();
    state.aiDiagnosisStartTime = Date.now();

    state.aiDiagnosisTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - state.aiDiagnosisStartTime) / 1000);
      updateAiDiagnosisTimerDisplay(elapsedSec);
    }, 1000);
  }

  function updateAiDiagnosisTimerDisplay(elapsedSec) {
    let timerDisplay = null;

    if (dom.aiDiagnosisBody) {
      timerDisplay = dom.aiDiagnosisBody.querySelector('.scribe-ai-timer');
    }

    if (!timerDisplay) {
      const fallbackBox = document.querySelector('[data-section="__ai_diagnosis__"] .scribe-ai-timer');
      if (fallbackBox) timerDisplay = fallbackBox;
    }

    if (timerDisplay) {
      timerDisplay.textContent = `${elapsedSec}s`;
    }
  }

  function renderSummaryGenerating(elapsedSec) {
    if (!dom.noteDetail) return;
    dom.noteDetail.innerHTML = `<div class="text-gray-400 text-sm">Generating summary... ${elapsedSec}s</div>`;
  }

  function startSummaryTimer() {
    stopSummaryTimer();
    state.summaryGenerating = true;
    state.summaryStartTime = Date.now();
    renderSummaryGenerating(0);
    state.summaryTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - state.summaryStartTime) / 1000);
      renderSummaryGenerating(elapsedSec);
    }, 1000);
  }

  function autoExpandTextarea(el) {
    // Clamp height so each textarea has an internal scrollbar (stable UI)
    try {
      el.style.height = 'auto';
      const maxH = Number(CONFIG.MAX_TEXTAREA_HEIGHT) || 220;
      const next = Math.min(el.scrollHeight, maxH);
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
    } catch {
      // ignore
    }
  }

  // =============================================================================
  //  EDIT TRACKING (incremental diff, same algorithm)
  // =============================================================================
  function rleEncodeTags(tags) {
    if (!tags || !tags.length) return [];
    const out = [];
    let last = tags[0];
    let count = 1;
    for (let i = 1; i < tags.length; i++) {
      if (tags[i] === last) count++;
      else {
        out.push([last, count]);
        last = tags[i];
        count = 1;
      }
    }
    out.push([last, count]);
    return out;
  }

  function rleDecodeToTags(rle, targetLen) {
    if (!Array.isArray(rle) || rle.length === 0) return new Array(targetLen).fill('B');
    const tags = [];
    for (const [tag, cnt] of rle) {
      for (let i = 0; i < cnt && tags.length < targetLen; i++) tags.push(tag === 'U' ? 'U' : 'B');
      if (tags.length >= targetLen) break;
    }
    while (tags.length < targetLen) tags.push('B');
    if (tags.length > targetLen) tags.length = targetLen;
    return tags;
  }

  function buildLcsTable(prevArr, nextArr) {
    const n = prevArr.length;
    const m = nextArr.length;
    const rows = n + 1;
    const cols = m + 1;

    const table = new Array(rows);
    table[0] = new Uint16Array(cols);

    for (let i = 1; i < rows; i++) {
      const row = new Uint16Array(cols);
      const pi = prevArr[i - 1];
      for (let j = 1; j < cols; j++) {
        if (pi === nextArr[j - 1]) row[j] = table[i - 1][j - 1] + 1;
        else row[j] = table[i - 1][j] > row[j - 1] ? table[i - 1][j] : row[j - 1];
      }
      table[i] = row;
    }
    return table;
  }

  function fastGreedyDelta(prevAnn, nextText, st) {
    const prevChars = prevAnn.map((x) => x.ch);
    const nextChars = Array.from(nextText);

    let p = 0;
    while (p < prevChars.length && p < nextChars.length && prevChars[p] === nextChars[p]) p++;

    let s = 0;
    while (
      s < prevChars.length - p &&
      s < nextChars.length - p &&
      prevChars[prevChars.length - 1 - s] === nextChars[nextChars.length - 1 - s]
    ) s++;

    for (let i = p; i < prevChars.length - s; i++) {
      const removed = prevAnn[i];
      if (removed.tag === 'U') st.ins = Math.max(0, st.ins - 1);
      else st.del += 1;
    }

    const inserted = [];
    for (let j = p; j < nextChars.length - s; j++) {
      inserted.push({ ch: nextChars[j], tag: 'U' });
      st.ins += 1;
    }

    const prefix = prevAnn.slice(0, p);
    const suffix = prevAnn.slice(prevChars.length - s);
    return [...prefix, ...inserted, ...suffix];
  }

  function exactDeltaViaLcs(prevAnn, nextText, st) {
    const prevChars = prevAnn.map((x) => x.ch);
    const nextChars = Array.from(nextText);
    const table = buildLcsTable(prevChars, nextChars);

    let i = prevChars.length;
    let j = nextChars.length;
    const newAnnRev = [];

    while (i > 0 && j > 0) {
      if (prevChars[i - 1] === nextChars[j - 1]) {
        newAnnRev.push({ ch: nextChars[j - 1], tag: prevAnn[i - 1].tag });
        i--;
        j--;
      } else if (table[i - 1][j] >= table[i][j - 1]) {
        const removed = prevAnn[i - 1];
        if (removed.tag === 'U') st.ins = Math.max(0, st.ins - 1);
        else st.del += 1;
        i--;
      } else {
        newAnnRev.push({ ch: nextChars[j - 1], tag: 'U' });
        st.ins += 1;
        j--;
      }
    }

    while (i > 0) {
      const removed = prevAnn[i - 1];
      if (removed.tag === 'U') st.ins = Math.max(0, st.ins - 1);
      else st.del += 1;
      i--;
    }
    while (j > 0) {
      newAnnRev.push({ ch: nextChars[j - 1], tag: 'U' });
      st.ins += 1;
      j--;
    }

    newAnnRev.reverse();
    return newAnnRev;
  }

  function applyIncrementalDiff(box, newText) {
    let st = state.editStateMap.get(box);
    if (!st) {
      st = { ann: Array.from(newText).map((ch) => ({ ch, tag: 'B' })), ins: 0, del: 0 };
      state.editStateMap.set(box, st);
      return 0;
    }

    const prevAnn = st.ann;
    const n = prevAnn.length;
    const m = newText.length;

    let newAnn;
    if ((n + 1) * (m + 1) > CONFIG.MAX_DELTA_CELLS) newAnn = fastGreedyDelta(prevAnn, newText, st);
    else newAnn = exactDeltaViaLcs(prevAnn, newText, st);

    st.ann = newAnn;
    return Math.max(0, st.ins) + Math.max(0, st.del);
  }

  function persistSectionState(section, st) {
    state.latestSoapNote._editMeta = state.latestSoapNote._editMeta || {};
    const tags = st.ann.map((x) => x.tag);
    state.latestSoapNote._editMeta[section] = {
      edits: Math.max(0, st.ins) + Math.max(0, st.del),
      ins: st.ins,
      del: st.del,
      provRLE: rleEncodeTags(tags),
    };
    saveLatestSoap(state.latestSoapNote);

    // Mark note as touched so Summary regenerates when note changes
    markNoteTouchedForCurrentMrn();
  }

  function restoreSectionState(section, contentText) {
    const meta = state.latestSoapNote?._editMeta?.[section];
    if (!meta) {
      return { ann: Array.from(contentText).map((ch) => ({ ch, tag: 'B' })), ins: 0, del: 0, edits: 0 };
    }
    const tags = rleDecodeToTags(meta.provRLE, contentText.length);
    const ann = Array.from(contentText).map((ch, i) => ({ ch, tag: tags[i] === 'U' ? 'U' : 'B' }));
    const ins = Number.isFinite(meta.ins) ? meta.ins : 0;
    const del = Number.isFinite(meta.del) ? meta.del : 0;
    const edits = Number.isFinite(meta.edits) ? meta.edits : Math.max(0, ins) + Math.max(0, del);
    return { ann, ins, del, edits };
  }

  function rebaseBoxStateToCurrent(box) {
    const current = box.value || '';
    const st = state.editStateMap.get(box) || { ann: [], ins: 0, del: 0 };
    st.ann = Array.from(current).map((ch) => ({ ch, tag: 'B' }));
    st.ins = 0;
    st.del = 0;
    state.editStateMap.set(box, st);
    persistSectionState(box.dataset.section, st);
  }

  function initializeEditMetaForSoap(soap) {
    soap._aiMeta = soap._aiMeta || {};
    soap._editMeta = soap._editMeta || {};
    const sections = getSoapSections(soap);

    sections.forEach((section) => {
      const val = soap?.[section] || '';
      const textBlock = Array.isArray(val) ? val.join('\n') : String(val || '');
      soap._aiMeta[section] = { text: textBlock };
      soap._editMeta[section] = {
        edits: 0,
        ins: 0,
        del: 0,
        provRLE: rleEncodeTags(new Array(textBlock.length).fill('B')),
      };
    });
  }

  // =============================================================================
  //  TEMPLATE → ROWS SYNC (edit_count per section)
  // =============================================================================
  function syncTemplateRowsFromSections(note) {
    try {
      if (!note) return note;
      const comps = Array.isArray(note?._templateMeta?.components) ? note._templateMeta.components : [];
      if (!comps.length) return note;

      const byName = new Map();
      comps.forEach((c) => {
        const name = String(c?.name || '').trim();
        if (!name) return;

        const mappingId =
          c?.mapping_id ??
          c?.template_component_mapping_id ??
          c?.templateComponentMappingId ??
          c?.mappingId ??
          c?.id ??
          null;

        if (mappingId != null) byName.set(name, mappingId);
      });

      if (!byName.size) return note;

      const rows = [];
      for (const [sectionName, mappingId] of byName.entries()) {
        const v = note?.[sectionName];
        const text = Array.isArray(v) ? v.join('\n') : String(v ?? '');

        const editCount = clampNumber(note?._editMeta?.[sectionName]?.edits ?? 0, 0);

        rows.push({
          template_component_mapping_id: mappingId,
          section: sectionName,
          text,
          edit_count: editCount,
        });
      }

      note._rowsForPatientNoteInsert = rows;
      return note;
    } catch {
      return note;
    }
  }

  function isTemplateDrivenNoteEligible(note) {
    try {
      if (!note || !note._templateMeta) return false;
      syncTemplateRowsFromSections(note);
      return Array.isArray(note._rowsForPatientNoteInsert) && note._rowsForPatientNoteInsert.length > 0;
    } catch {
      return false;
    }
  }

  function getTotalEditsFromNote(note) {
    try {
      const meta = note?._editMeta || {};
      let total = 0;
      Object.values(meta).forEach((v) => {
        const n = Number(v?.edits ?? 0);
        if (Number.isFinite(n)) total += n;
      });
      return total;
    } catch {
      return 0;
    }
  }

  // =============================================================================
  //  MEDICATION INLINE AVAILABILITY
  // =============================================================================
  function saveMedStatus(byName, lastText) {
    localStorage.setItem(
      LS_KEYS.MED_AVAIL(),
      JSON.stringify({ byName: byName || {}, lastText: lastText || '' })
    );
  }

  function loadMedStatus() {
    const { byName = {}, lastText = '' } = lsSafeParse(LS_KEYS.MED_AVAIL(), { byName: {}, lastText: '' }) || {};
    return { byName, lastText };
  }

  function normalizeDrugKey(str) {
    if (!str) return '';
    let s = String(str).trim();
    s = s.replace(/\s+for\s+.+$/i, '');
    s = s.replace(/\s*[\(\[\{].*?[\)\]\}]\s*$/g, '');
    s = s.split(/\s*[-,:@|]\s*/)[0];
    s = s.replace(/\s+/g, ' ').replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
    return s.toLowerCase();
  }

  function isMedicationSectionName(section) {
    const s = String(section || '').trim().toLowerCase();
    return s === 'medication' || s === 'medications' || s.includes('medication');
  }

  function getMedicationTextarea(scroller) {
    if (!scroller) return null;
    const editors = scroller.querySelectorAll('textarea[data-section]');
    for (const t of editors) if (isMedicationSectionName(t.dataset.section)) return t;
    return null;
  }

  function getMedicationSectionElement(scroller) {
    if (!scroller) return null;
    const sections = scroller.querySelectorAll('.scribe-section[data-section]');
    for (const s of sections) if (isMedicationSectionName(s.dataset.section)) return s;
    return null;
  }

  function ensureMedicationWrap(medSection) {
    const textarea = medSection.querySelector('textarea[data-section]');
    if (!textarea) return null;

    let wrap = medSection.querySelector('.med-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'med-wrap';
      textarea.parentNode.insertBefore(wrap, textarea);
      wrap.appendChild(textarea);
    }

    let overlay = wrap.querySelector('.med-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'med-overlay';
      wrap.appendChild(overlay);
      textarea.addEventListener('scroll', () => (overlay.scrollTop = textarea.scrollTop));
    }
    return wrap;
  }

  function normalizedMedicationBlock(textarea) {
    const lines = (textarea?.value || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normalizeDrugKey);
    return lines.join('\n');
  }

  async function checkMedicationsFromTextarea(textarea) {
    if (!textarea || !state.SERVER_URL) return;

    const currentNormalized = normalizedMedicationBlock(textarea);
    const { byName: persistedByName, lastText } = loadMedStatus();

    if (currentNormalized === lastText) {
      state.medAvailability.clear();
      Object.entries(persistedByName).forEach(([k, v]) => state.medAvailability.set(k, !!v));
      state.medicationValidationPending = false;
      renderMedicationInline();
      return;
    }

    const rawLines = (textarea.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!rawLines.length) {
      state.medAvailability.clear();
      saveMedStatus({}, currentNormalized);
      state.medicationValidationPending = false;
      renderMedicationInline();
      return;
    }

    state.medicationValidationPending = true;
    renderMedicationInline();

    try {
      const response = await fetch(`${state.SERVER_URL}/api/medications/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: rawLines }),
      });

      if (!response.ok) {
        state.medicationValidationPending = false;
        renderMedicationInline();
        return;
      }

      const data = await response.json();
      const results = data.results || [];

      state.medAvailability.clear();
      const newByName = {};

      results.forEach((item) => {
        const rawName = (item.name ?? item.query ?? item.drug ?? item.drugName ?? '').toString();
        const key = normalizeDrugKey(rawName);
        if (!key) return;

        const available =
          typeof item.available === 'boolean'
            ? item.available
            : item.status === 'exists' || item.status === 'available' || item.status === true;

        state.medAvailability.set(key, !!available);
        newByName[key] = !!available;
      });

      saveMedStatus(newByName, currentNormalized);
      state.medicationValidationPending = false;
      renderMedicationInline();
    } catch {
      state.medicationValidationPending = false;
      renderMedicationInline();
    }
  }

  function renderMedicationInline() {
    ensureMedStyles();
    const scroller = soapContainerEnsure();
    const medSection = getMedicationSectionElement(scroller);
    if (!medSection) return;

    const wrap = ensureMedicationWrap(medSection);
    const textarea = getMedicationTextarea(scroller);
    const overlay = wrap?.querySelector('.med-overlay');
    if (!wrap || !textarea || !overlay) return;

    const cs = getComputedStyle(textarea);
    overlay.style.padding = cs.padding;
    overlay.style.lineHeight = cs.lineHeight;
    overlay.style.fontSize = cs.fontSize;
    overlay.style.fontFamily = cs.fontFamily;
    overlay.scrollTop = textarea.scrollTop;

    const currentNormalized = normalizedMedicationBlock(textarea);
    const { byName, lastText } = loadMedStatus();
    if (currentNormalized === lastText) {
      state.medAvailability.clear();
      Object.entries(byName).forEach(([k, v]) => state.medAvailability.set(k, !!v));
    }

    const frag = document.createDocumentFragment();
    const lines = (textarea.value || '').split('\n');

    for (const raw of lines) {
      const line = raw.trim();
      const row = document.createElement('div');
      row.className = 'med-line';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = line;
      nameSpan.style.color = 'transparent';
      row.appendChild(nameSpan);

      if (line) {
        const key = normalizeDrugKey(line);
        if (state.medAvailability.has(key)) {
          const ok = !!state.medAvailability.get(key);
          const badge = document.createElement('span');
          badge.className = 'med-emoji';
          badge.textContent = ok ? '✅' : '❌';
          row.appendChild(badge);
        } else if (state.medicationValidationPending) {
          const badge = document.createElement('span');
          badge.className = 'med-emoji med-pending';
          badge.textContent = '⏳';
          row.appendChild(badge);
        }
      }

      frag.appendChild(row);
    }

    overlay.replaceChildren(frag);
  }

  // =============================================================================
  //  NOTE PERSISTENCE (UI → history item.note.data)
  // =============================================================================
  function persistActiveNoteFromUI() {
    const ctx = getActiveHistoryContext();
    if (!ctx.item) return;

    const scroller = soapContainerEnsure();
    const editors = scroller.querySelectorAll('textarea[data-section]');
    const soap = {};

    editors.forEach((t) => {
      soap[t.dataset.section] = t.value || '';
    });

    soap._aiMeta = state.latestSoapNote?._aiMeta || {};
    soap._editMeta = state.latestSoapNote?._editMeta || {};
    if (state.latestSoapNote?._templateMeta) soap._templateMeta = state.latestSoapNote._templateMeta;
    if (Array.isArray(state.latestSoapNote?._rowsForPatientNoteInsert)) {
      soap._rowsForPatientNoteInsert = state.latestSoapNote._rowsForPatientNoteInsert;
    }

    const medTextarea = getMedicationTextarea(scroller);
    if (medTextarea) {
      const medications = (medTextarea.value || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((name) => ({
          name,
          available: state.medAvailability.has(normalizeDrugKey(name))
            ? state.medAvailability.get(normalizeDrugKey(name))
            : null,
        }));
      soap.medications = medications;
    }

    setActiveNoteDataForItem(ctx.item, soap);
    ctx.hist[ctx.index] = ctx.item;
    saveHistory(ctx.hist);

    state.latestSoapNote = soap;
    saveLatestSoap(state.latestSoapNote);
  }

  function attachEditTrackingToTextarea(box, aiText) {
    const section = box.dataset.section;
    const contentText = box.value || '';

    const restored = restoreSectionState(section, contentText);
    state.editStateMap.set(box, { ann: restored.ann, ins: restored.ins, del: restored.del });
    box.dataset.editCount = String(restored.edits);

    const scroller = soapContainerEnsure();
    const headMeta = scroller.querySelector(
      `.scribe-section[data-section="${CSS.escape(section)}"] .scribe-section-meta`
    );
    if (headMeta) headMeta.textContent = `Edits: ${restored.edits}`;

    box.dataset.aiText = aiText || '';

    let rafId = null;
    box.addEventListener('input', () => {
      autoExpandTextarea(box);
      if (rafId) cancelAnimationFrame(rafId);

      rafId = requestAnimationFrame(() => {
        try {
          const now = box.value || '';
          const totalEdits = applyIncrementalDiff(box, now);
          box.dataset.editCount = String(totalEdits);

          const st = state.editStateMap.get(box);
          persistSectionState(section, st);

          updateTotalsAndEhrState();
          persistActiveNoteFromUI();

          if (isMedicationSectionName(section)) {
            state.medAvailability.clear();
            state.medicationValidationPending = true;
            renderMedicationInline();

            if (state.medicationDebounceTimer) clearTimeout(state.medicationDebounceTimer);
            state.medicationDebounceTimer = setTimeout(() => checkMedicationsFromTextarea(box), 600);
          }
        } catch (e) {
          console.warn('[SCRIBE] input handler error', e);
        }
        rafId = null;
      });
    });
  }

  function updateTotalsAndEhrState() {
    const scroller = soapContainerEnsure();
    const editors = scroller.querySelectorAll('textarea[data-section]');
    let total = 0;

    editors.forEach((t) => {
      const n = Number(t.dataset.editCount || 0);
      total += n;

      const headMeta = scroller.querySelector(
        `.scribe-section[data-section="${CSS.escape(t.dataset.section)}"] .scribe-section-meta`
      );
      if (headMeta) headMeta.textContent = `Edits: ${n}`;
    });

    const badge = ensureTopHeadingBadge();
    if (badge) badge.textContent = `Total Edits: ${total}`;

    if (dom.btnAddEhr) {
      const eligible = isTemplateDrivenNoteEligible(state.latestSoapNote);
      const shouldDisable = !eligible || state.addEhrInFlight;

      dom.btnAddEhr.disabled = shouldDisable;
      if (shouldDisable) dom.btnAddEhr.classList.add('scribe-add-ehr-disabled');
      else dom.btnAddEhr.classList.remove('scribe-add-ehr-disabled');
    }
  }

  function resetAllEditCountersToZero() {
    const scroller = soapContainerEnsure();

    scroller.querySelectorAll('textarea[data-section]').forEach((textarea) => {
      rebaseBoxStateToCurrent(textarea);
      textarea.dataset.editCount = '0';

      const headMeta = scroller.querySelector(
        `.scribe-section[data-section="${CSS.escape(textarea.dataset.section)}"] .scribe-section-meta`
      );
      if (headMeta) headMeta.textContent = 'Edits: 0';
    });

    state.latestSoapNote._editMeta = state.latestSoapNote._editMeta || {};
    Object.keys(state.latestSoapNote?._aiMeta || {}).forEach((section) => {
      state.latestSoapNote._editMeta[section] = state.latestSoapNote._editMeta[section] || {};
      state.latestSoapNote._editMeta[section].edits = 0;
      state.latestSoapNote._editMeta[section].ins = 0;
      state.latestSoapNote._editMeta[section].del = 0;
    });

    saveLatestSoap(state.latestSoapNote);
    updateTotalsAndEhrState();
  }

  // =============================================================================
  //  AI DIAGNOSIS (UI + CACHE) — workflow preserved
  // =============================================================================
  function ensureAiDiagnosisPaneHeader() {
    if (!dom.aiPane) return { head: null, btn: null };

    let head = dom.aiPane.querySelector('.scribe-ai-pane-head');
    if (!head) {
      head = document.createElement('div');
      head.className = 'scribe-ai-pane-head';
      head.style.padding = '12px 14px';
      head.style.display = 'flex';
      head.style.justifyContent = 'flex-end';
      dom.aiPane.insertBefore(head, dom.aiPane.firstChild);
    }

    let btn = dom.aiPane.querySelector('#aiDiagnosisGenerateBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'aiDiagnosisGenerateBtn';
      btn.className = 'scribe-ai-btn scribe-ai-btn--generate';
      btn.type = 'button';
      btn.textContent = 'Generate';
      head.appendChild(btn);
    } else if (btn.parentElement !== head) {
      head.appendChild(btn);
    }

    if (!dom.aiDiagnosisBody) {
      const existingBody = dom.aiPane.querySelector('#aiDiagnosisBody');
      if (existingBody) dom.aiDiagnosisBody = existingBody;
    }

    return { head, btn };
  }

  function setAiDiagnosisButtonVisual(btn, mode) {
    if (!btn) return;
    btn.classList.remove('scribe-ai-btn--generate', 'scribe-ai-btn--generating', 'scribe-ai-btn--generated');
    if (mode === 'generating') btn.classList.add('scribe-ai-btn--generating');
    else if (mode === 'generated') btn.classList.add('scribe-ai-btn--generated');
    else btn.classList.add('scribe-ai-btn--generate');
  }

  function getAiDiagnosisForItem(item, templateId) {
    try {
      const tid = normalizeTemplateId(templateId);
      return item?.aiDiagnosisByTemplate?.[tid] || null;
    } catch {
      return null;
    }
  }


  function getAnyAiDiagnosisForItem(item) {
    try {
      const bucket = item?.aiDiagnosisByTemplate;
      if (!bucket || typeof bucket !== 'object') return null;

      const arr = Object.values(bucket).filter((d) => isUsableDiagnosis(d));
      if (!arr.length) return null;

      arr.sort((a, b) => {
        const ta = Date.parse(a?.created_at || a?.createdAt || '') || 0;
        const tb = Date.parse(b?.created_at || b?.createdAt || '') || 0;
        return tb - ta;
      });

      return arr[0] || null;
    } catch {
      return null;
    }
  }


  function saveAiDiagnosisToHistoryItem(itemId, templateId, diagObj) {
    const hist = normalizeHistoryItems(loadHistory());
    const idx = hist.findIndex((x) => x.id === itemId);
    if (idx === -1) return;

    const tid = normalizeTemplateId(templateId);

    const sections =
      Array.isArray(diagObj?.sections)
        ? diagObj.sections
        : Array.isArray(diagObj?.components)
          ? diagObj.components
          : null;

    hist[idx].aiDiagnosisByTemplate = hist[idx].aiDiagnosisByTemplate || {};
    hist[idx].aiDiagnosisByTemplate[tid] = {
      template_title: diagObj?.template_title || diagObj?.title || 'AI Diagnosis',
      text: diagObj?.text || '',
      sections: sections || null,
      created_at: diagObj?.created_at || new Date().toISOString(),
      template_id: tid,
    };
    saveHistory(hist);
  }

  function clearAiDiagnosisForHistoryItem(itemId) {
    const hist = normalizeHistoryItems(loadHistory());
    const idx = hist.findIndex((x) => x.id === itemId);
    if (idx === -1) return;
    delete hist[idx].aiDiagnosisByTemplate;
    saveHistory(hist);
  }

  function clearAiDiagnosisForHistoryItemTemplate(itemId, templateId) {
    const hist = normalizeHistoryItems(loadHistory());
    const idx = hist.findIndex((x) => x.id === itemId);
    if (idx === -1) return;

    const tid = normalizeTemplateId(templateId);
    const bucket = hist[idx].aiDiagnosisByTemplate || null;
    if (!bucket || typeof bucket !== 'object') return;

    delete bucket[tid];
    if (!Object.keys(bucket).length) delete hist[idx].aiDiagnosisByTemplate;
    saveHistory(hist);
  }

  // ---- Bugfix helpers: array response + case-insensitive keys ----
  function unwrapFirstObjectResponse(data) {
    if (Array.isArray(data)) {
      for (const v of data) {
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      }
      return data[0] ?? null;
    }
    return data;
  }

  function coerceToText(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map((x) => String(x ?? '')).join('\n');
    return String(v);
  }

  function getValueCaseInsensitive(obj, wantedKey) {
    if (!obj || typeof obj !== 'object') return undefined;
    const target = String(wantedKey || '').toLowerCase();
    for (const k of Object.keys(obj)) {
      if (String(k).toLowerCase() === target) return obj[k];
    }
    return undefined;
  }

  function pickFirstTextCI(obj, keys) {
    for (const key of keys) {
      const v = getValueCaseInsensitive(obj, key);
      const t = normalizeTextBlock(coerceToText(v));
      if (t) return t;
    }
    return '';
  }

  function normalizeDiagnosisSectionsFromResponse(data) {
    const obj = unwrapFirstObjectResponse(data) || {};

    if (Array.isArray(obj?.sections)) {
      return obj.sections
        .map((s) => ({
          component: String(s?.component ?? s?.title ?? '').trim(),
          text: normalizeTextBlock(s?.text),
        }))
        .filter((x) => x.component && x.text);
    }

    if (Array.isArray(obj?.components)) {
      return obj.components
        .map((s) => ({
          component: String(s?.component ?? s?.title ?? '').trim(),
          text: normalizeTextBlock(s?.text),
        }))
        .filter((x) => x.component && x.text);
    }

    // Supports backend keys: assessment/plan/medications (any case)
    const out = [];

    const assessment = pickFirstTextCI(obj, ['assessment', 'Assessment']);
    if (assessment) out.push({ component: 'Assessment', text: assessment });

    const plan = pickFirstTextCI(obj, ['plan', 'Plan']);
    if (plan) out.push({ component: 'Plan', text: plan });

    const meds = pickFirstTextCI(obj, ['medications', 'medication', 'Medications', 'Medication']);
    if (meds) out.push({ component: 'Medications', text: meds });

    return out;
  }

  function getRenderableDiagnosisSections(diag) {
    const rawSections = Array.isArray(diag?.sections) ? diag.sections : normalizeDiagnosisSectionsFromResponse(diag);

    const normalized = (Array.isArray(rawSections) ? rawSections : [])
      .map((s) => ({
        component: String(s?.component ?? s?.title ?? '').trim(),
        text: normalizeTextBlock(s?.text),
      }))
      .filter((x) => x.component && x.text);

    const fallbackText = normalizeTextBlock(diag?.text);
    if (!normalized.length && fallbackText) return [{ component: 'Diagnosis', text: fallbackText }];

    return normalized;
  }

  function isUsableDiagnosis(diag) {
    if (!diag) return false;
    const secs = getRenderableDiagnosisSections(diag);
    return Array.isArray(secs) && secs.length > 0;
  }
  function renderDiagnosisSectionsHtml(sections) {
    const list = Array.isArray(sections) ? sections : [];
    if (!list.length) return '';

    return `
      <div class="scribe-ai-sections">
        ${list
        .map((sec) => {
          const title = escapeHtml(sec?.component || sec?.title || sec?.name || 'Section');
          const raw = String(sec?.text || sec?.content || '').trim();
          const safe = escapeHtml(raw);
          const body = safe.replace(/\n/g, '<br/>');

          return `
              <div class="scribe-section scribe-ai-section">
                <div class="scribe-section-head">
                  <h3>${title}</h3>
                </div>
                <div class="scribe-ai-comp-scroll">${body || '<span class="scribe-muted">No data</span>'}</div>
              </div>
            `;
        })
        .join('')}
      </div>
    `;
  }

  function clearAiDiagnosisPaneUi() {
    ensureAiDiagnosisPaneHeader();
    if (!dom.aiDiagnosisBody) return;
    dom.aiDiagnosisBody.innerHTML = `
      <div class="scribe-ai-center">
        <div class="scribe-ai-empty">No data available</div>
      </div>
    `;
  }

  function renderAiDiagnosisInPane() {
    const { btn } = ensureAiDiagnosisPaneHeader();
    if (!dom.aiDiagnosisBody) return;

    const ctx = getActiveHistoryContext();
    const item = ctx.item;

    if (!item) {
      if (btn) {
        btn.textContent = 'Generate';
        btn.disabled = true;
        btn.onclick = null;
        setAiDiagnosisButtonVisual(btn, 'generate');
      }
      clearAiDiagnosisPaneUi();
      return;
    }

    const templateId = getActiveTemplateIdForItem(item);

    // Primary = active template; Fallback = any previously generated diagnosis for this transcript
    const diagPrimary = getAiDiagnosisForItem(item, templateId);
    const diagFallback = !isUsableDiagnosis(diagPrimary) ? getAnyAiDiagnosisForItem(item) : null;
    const diag = isUsableDiagnosis(diagPrimary) ? diagPrimary : diagFallback;

    const inFlightForThis =
      state.aiDiagnosisInFlight &&
      state.aiDiagnosisInFlightFor?.itemId === item.id &&
      normalizeTemplateId(state.aiDiagnosisInFlightFor?.templateId) === normalizeTemplateId(templateId);

    const usable = isUsableDiagnosis(diag);

    if (btn) {
      if (inFlightForThis) {
        btn.textContent = 'Generating...';
        btn.disabled = true;
        btn.onclick = null;
        setAiDiagnosisButtonVisual(btn, 'generating');
      } else {
        btn.textContent = 'Generate';
        btn.disabled = false;
        btn.onclick = () => generateAiDiagnosisForActiveTranscript();
        setAiDiagnosisButtonVisual(btn, 'generate');
      }
    }

    if (inFlightForThis) {
      dom.aiDiagnosisBody.innerHTML = `
        <div class="scribe-ai-center">
          <div class="scribe-ai-loading">
            <div class="scribe-spinner"></div>
            <div style="margin-top: 12px;">AI is working in the background...</div>
            <div class="scribe-ai-timer" style="margin-top: 8px; font-size: 18px; font-weight: bold; color: #f59e0b;">0s</div>
          </div>
        </div>
      `;
      return;
    }

    if (!usable) {
      if (state.aiDiagnosisLastError) {
        dom.aiDiagnosisBody.innerHTML = `<div class="scribe-ai-center"><div class="scribe-ai-error" style="color: #f59e0b; font-weight: 500;">${escapeHtml(state.aiDiagnosisLastError)}</div></div>`;
      } else {
        dom.aiDiagnosisBody.innerHTML = `<div class="scribe-ai-center"><div class="scribe-muted">AI diagnosis not available yet.</div></div>`;
      }
      return;
    }

    dom.aiDiagnosisBody.innerHTML = `
      <div class="scribe-ai-pane-scroll">
        ${renderDiagnosisSectionsHtml(diag.sections)}
      </div>
    `;
  }

  // fallback only if aiPane doesn't exist
  function renderAiDiagnosisBox(scroller) {
    const ctx = getActiveHistoryContext();
    const item = ctx.item;
    if (!item) return;

    const templateId = getActiveTemplateIdForItem(item);
    const diag = getAiDiagnosisForItem(item, templateId);

    const wrap = document.createElement('div');
    wrap.className = 'scribe-section';
    wrap.dataset.section = '__ai_diagnosis__';

    const head = document.createElement('div');
    head.className = 'scribe-section-head';

    const h = document.createElement('h3');
    h.textContent = 'AI Diagnosis';

    const btn = document.createElement('button');
    btn.className = 'scribe-ai-btn scribe-ai-btn--generate';

    const inFlightForThis =
      state.aiDiagnosisInFlight &&
      state.aiDiagnosisInFlightFor?.itemId === item.id &&
      normalizeTemplateId(state.aiDiagnosisInFlightFor?.templateId) === normalizeTemplateId(templateId);

    const usable = isUsableDiagnosis(diag);

    if (inFlightForThis) {
      btn.textContent = 'Generating…';
      btn.disabled = true;
      setAiDiagnosisButtonVisual(btn, 'generating');
    } else if (usable) {
      btn.textContent = 'Generated';
      btn.disabled = true;
      setAiDiagnosisButtonVisual(btn, 'generated');
    } else {
      btn.textContent = 'Generate';
      btn.disabled = false;
      setAiDiagnosisButtonVisual(btn, 'generate');
      btn.onclick = () => generateAiDiagnosisForActiveTranscript();
    }

    head.appendChild(h);
    head.appendChild(btn);

    const body = document.createElement('div');
    body.className = 'scribe-ai-body';

    const inner = document.createElement('div');
    inner.className = 'scribe-ai-body-inner';

    if (inFlightForThis) {
      inner.innerHTML = `
        <div class="scribe-ai-center">
          <div class="scribe-ai-loading">
            <div class="scribe-spinner"></div>
            <div style="margin-top: 12px;">AI is working in the background...</div>
            <div class="scribe-ai-timer" style="margin-top: 8px; font-size: 18px; font-weight: bold; color: #f59e0b;">0s</div>
          </div>
        </div>
      `;
    } else if (state.aiDiagnosisLastError && !usable) {
      inner.innerHTML = `<div class="scribe-ai-center"><div class="scribe-ai-error">${escapeHtml(state.aiDiagnosisLastError)}</div></div>`;
    } else if (!usable) {
      inner.innerHTML = `<div class="scribe-ai-center"><div class="scribe-ai-empty">No data available</div></div>`;
    } else {
      inner.innerHTML = renderDiagnosisSectionsHtml(getRenderableDiagnosisSections(diag));
    }

    body.appendChild(inner);
    wrap.appendChild(head);
    wrap.appendChild(body);
    scroller.appendChild(wrap);
  }

  function renderAiDiagnosisUi(scrollerOrNull = null) {
    if (dom.aiPane && dom.aiDiagnosisBody) {
      renderAiDiagnosisInPane();
      return;
    }
    if (scrollerOrNull) renderAiDiagnosisBox(scrollerOrNull);
  }

  function buildNoteSectionsPayload(note) {
    try {
      const sections = getSoapSections(note || {});
      const out = [];

      for (const section of sections) {
        const raw = note?.[section];
        const text = normalizeTextBlock(Array.isArray(raw) ? raw.join('\n') : raw);
        if (!text) continue;
        out.push({ component: section, text });
      }

      return out;
    } catch {
      return [];
    }
  }

  // =============================================================================
  //  SUMMARY API (cached)
  // =============================================================================
  function markNoteTouchedForCurrentMrn() {
    try {
      const mrn = String(state.currentPatient?.mrn_no || '').trim();
      const ts = Date.now();

      state.lastNoteTouchedAt = ts;
      if (mrn) state.noteTouchedAtByMrn.set(mrn, ts);

      // ✅ REMOVED:
      // - Do NOT auto-refresh Summary even if Summary tab is active.
      // - Summary should generate ONLY when user clicks "Summary".
      // (So no debounce + no loadSummary() here)

    } catch {
      // ignore
    }
  }

  function getCachedSummaryTextForMrn(mrn) {
    if (!mrn) return '';
    const cached = state.summaryCacheByMrn.get(String(mrn).trim());
    return cached?.text || '';
  }

  async function generateAiDiagnosisForActiveTranscript() {
    if (!state.SERVER_URL) return;

    const ctx = getActiveHistoryContext();
    const item = ctx.item;
    if (!item) return;

    // persist latest edits
    try { persistActiveNoteFromUI(); } catch { }

    const templateId = getActiveTemplateIdForItem(item);

    // avoid parallel requests
    if (state.aiDiagnosisInFlight) return;

    // Clear any existing diagnosis to allow regeneration
    const existing = getAiDiagnosisForItem(item, templateId);
    if (existing) {
      clearAiDiagnosisForHistoryItemTemplate(item.id, templateId);
    }

    const note = getActiveNoteForItem(item) || {};
    const noteSections = buildNoteSectionsPayload(note);

    const mrn = String(state.currentPatient?.mrn_no || '').trim() || null;
    const summaryText = mrn ? getCachedSummaryTextForMrn(mrn) : '';

    if (!noteSections.length || !summaryText) {
      state.aiDiagnosisLastError = 'AI does not have enough data to provide diagnosis.';
      renderAiDiagnosisUi(null);
      return;
    }

    state.aiDiagnosisInFlight = true;
    state.aiDiagnosisInFlightFor = { itemId: item.id, templateId };
    state.aiDiagnosisLastError = null;
    startAiDiagnosisTimer();
    renderAiDiagnosisUi(null);

    try {

      const res = await fetch(`${state.SERVER_URL}${CONFIG.AI_DIAGNOSIS_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mrn,
          transcript_id: item.id,
          template_id: templateIdToApiValue(templateId),
          note_sections: noteSections,
          summary_text: summaryText || null, // cached only; never triggers summary API
        }),
      });

      const raw = await res.json().catch(() => ({}));
      const data = unwrapFirstObjectResponse(raw) || {};

      if (!res.ok) throw new Error(data?.error || `Failed to generate AI diagnosis (${res.status})`);

      const sections = getRenderableDiagnosisSections(data);
      if (!sections.length) throw new Error('AI diagnosis response was empty. Please try again.');

      const normalized = {
        template_title: data?.template_title || 'AI Diagnosis',
        sections,
        text: data?.text || '',
        created_at: new Date().toISOString(),
      };

      saveAiDiagnosisToHistoryItem(item.id, templateId, normalized);

      stopAiDiagnosisTimer();
      state.aiDiagnosisInFlight = false;
      state.aiDiagnosisInFlightFor = null;
      state.aiDiagnosisLastError = null;

      renderAiDiagnosisUi(null);
    } catch (e) {
      stopAiDiagnosisTimer();
      state.aiDiagnosisInFlight = false;
      state.aiDiagnosisInFlightFor = null;
      state.aiDiagnosisLastError = String(e?.message || e);
      renderAiDiagnosisUi(null);
    }
  }

  // =============================================================================
  //  SOAP RENDER
  // =============================================================================
  function renderSoapNote(soap) {
    if (state.soapGenerating) return;

    const scroller = soapContainerEnsure();
    scroller.innerHTML = '';
    ensureTopHeadingBadge();

    if (soap && Object.keys(soap).length && !soap._aiMeta) {
      initializeEditMetaForSoap(soap);
    }

    state.latestSoapNote = soap || {};

    if (state.latestSoapNote?._templateMeta) syncTemplateRowsFromSections(state.latestSoapNote);

    saveLatestSoap(state.latestSoapNote);

    // AI Diagnosis: in aiPane if present, else fallback inside SOAP
    renderAiDiagnosisUi(scroller);

    const sections = getSoapSections(state.latestSoapNote);
    sections.forEach((section) => {
      const wrap = document.createElement('div');
      wrap.className = 'scribe-section';
      wrap.dataset.section = section;

      const head = document.createElement('div');
      head.className = 'scribe-section-head';

      const h = document.createElement('h3');
      h.textContent = section;

      const metaSpan = document.createElement('div');
      metaSpan.className = 'scribe-section-meta';
      metaSpan.textContent = 'Edits: 0';

      head.appendChild(h);
      head.appendChild(metaSpan);
      wrap.appendChild(head);

      const box = document.createElement('textarea');
      box.className = 'scribe-textarea';
      box.readOnly = false;
      box.dataset.section = section;

      const rawVal = state.latestSoapNote?.[section];
      const contentText = Array.isArray(rawVal)
        ? rawVal.join('\n')
        : typeof rawVal === 'string'
          ? rawVal
          : '';
      box.value = contentText;
      autoExpandTextarea(box);

      const aiText = state.latestSoapNote?._aiMeta?.[section]?.text ?? contentText;
      state.latestSoapNote._aiMeta = state.latestSoapNote._aiMeta || {};
      state.latestSoapNote._aiMeta[section] = state.latestSoapNote._aiMeta[section] || { text: aiText };

      attachEditTrackingToTextarea(box, aiText);

      if (isMedicationSectionName(section)) {
        const w = document.createElement('div');
        w.className = 'med-wrap';
        w.appendChild(box);
        wrap.appendChild(w);
      } else {
        wrap.appendChild(box);
      }

      scroller.appendChild(wrap);
    });

    updateTotalsAndEhrState();
    renderMedicationInline();

    scroller.scrollTop = 0;

    // keep aiPane synced
    renderAiDiagnosisUi(null);
  }

  // =============================================================================
  //  SOAP GENERATION VIA REST (template change)
  // =============================================================================
  async function requestNoteGenerationForActiveTranscript(templateId) {
    if (!state.SERVER_URL) return;

    const ctx = getActiveHistoryContext();
    if (!ctx.item) return;

    const transcript = String(ctx.item.text || '').trim();
    if (!transcript) return;

    const tid = normalizeTemplateId(templateId);

    setActiveTemplateIdForItem(ctx.item, tid);
    ctx.hist[ctx.index] = ctx.item;
    saveHistory(ctx.hist);
    saveActiveItemId(ctx.item.id);

    startSoapGenerationTimer();

    try {
      const resp = await fetch(`${state.SERVER_URL}/api/notes/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, templateId: templateIdToApiValue(tid) }),
      });

      if (!resp.ok) {
        stopSoapGenerationTimer();
        state.soapGenerating = false;
        renderSoapNoteError(`Server returned ${resp.status} ${resp.statusText || ''}`);
        return;
      }

      const data = await resp.json();
      const note = data.note || {};

      initializeEditMetaForSoap(note);
      syncTemplateRowsFromSections(note);

      setActiveNoteDataForItem(ctx.item, note);
      setActiveTemplateIdForItem(ctx.item, tid);

      ctx.hist[ctx.index] = ctx.item;
      saveHistory(ctx.hist);

      stopSoapGenerationTimer();
      state.soapGenerating = false;

      state.latestSoapNote = note;
      saveLatestSoap(state.latestSoapNote);

      // Mark note as touched so Summary regenerates for latest note
      markNoteTouchedForCurrentMrn();

      renderSoapNote(state.latestSoapNote);
      syncDropdownToActiveTranscript();
      renderAiDiagnosisUi(null);
    } catch (e) {
      stopSoapGenerationTimer();
      state.soapGenerating = false;
      renderSoapNoteError(String(e?.message || e));
    }
  }

  async function applyTemplateToActiveTranscript(newTemplateId) {
    const templateId = normalizeTemplateId(newTemplateId);
    setTemplateSelectValue(templateId);

    // Clear old note data immediately to prevent showing wrong template sections
    state.latestSoapNote = {};
    renderSoapBlank();
    clearAiDiagnosisPaneUi();

    await requestNoteGenerationForActiveTranscript(templateId);
  }

  // =============================================================================
  //  TEMPLATE DROPDOWN INIT
  // =============================================================================
  async function initTemplateDropdown() {
    if (!dom.templateSelect || !state.SERVER_URL) return;

    dom.templateSelect.innerHTML = '';

    const optSoap = document.createElement('option');
    optSoap.value = CONFIG.SOAP_NOTE_TEMPLATE_ID;
    optSoap.textContent = 'SOAP Note';
    dom.templateSelect.appendChild(optSoap);

    try {
      const resp = await fetch(`${state.SERVER_URL}/api/templates`);
      if (resp.ok) {
        const data = await resp.json();
        const templates = data.templates || [];
        templates.forEach((t) => {
          const id = String(t.id);
          const exists = Array.from(dom.templateSelect.options).some((o) => o.value === id);
          if (exists) return;

          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = t.name || t.short_name || `Template ${t.id}`;
          dom.templateSelect.appendChild(opt);
        });
      }
    } catch {
      // ignore
    }

    syncDropdownToActiveTranscript();

    dom.templateSelect.onchange = () => {
      state.templateSelected = true;
      applyTemplateToActiveTranscript(dom.templateSelect.value || CONFIG.SOAP_NOTE_TEMPLATE_ID);
    };
  }

  // =============================================================================
  //  DEVICE LIST (throttle + watchdog)
  // =============================================================================
  function showNoDevices() {
    if (!dom.deviceList) return;
    dom.deviceList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'text-gray-400';
    li.textContent = 'No devices online';
    dom.deviceList.appendChild(li);
  }

  function requestDeviceListThrottled() {
    const now = Date.now();
    const minGapMs = state.currentRoom ? CONFIG.DEVICE_LIST_THROTTLE_ROOM_MS : CONFIG.DEVICE_LIST_THROTTLE_NO_ROOM_MS;

    if (now - state.lastReqListAt < minGapMs) return;
    if (state.reqListTimer) return;

    state.reqListTimer = setTimeout(() => {
      state.reqListTimer = null;
      state.lastReqListAt = Date.now();
      if (!state.socket?.connected) return;
      try {
        state.socket.emit('request_device_list');
      } catch {
        // ignore
      }
    }, 50);
  }

  function stopDeviceListWatchdog() {
    if (state.deviceListPollTimer) {
      clearInterval(state.deviceListPollTimer);
      state.deviceListPollTimer = null;
    }
  }

  function startDeviceListWatchdog() {
    stopDeviceListWatchdog();
    state.deviceListPollTimer = setInterval(() => {
      if (!state.socket?.connected) return;
      if (document.visibilityState === 'hidden') return;
      requestDeviceListThrottled();
    }, CONFIG.DEVICE_LIST_POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestDeviceListThrottled();
  });

  function updateDeviceList(payload) {
    let devices = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.devices)
        ? payload.devices
        : [];

    // If room is set, filter device list by room when the payload includes room info
    if (state.currentRoom && Array.isArray(devices) && devices.length) {
      const cr = String(state.currentRoom).trim();
      devices = devices.filter((d) => {
        const r =
          d?.roomId ??
          d?.room ??
          d?.pairId ??
          d?.pair_id ??
          d?.data?.roomId ??
          d?.data?.room ??
          d?.data?.pairId ??
          null;
        if (!r) return true;
        return String(r).trim() === cr;
      });
    }

    if (!dom.deviceList) return;

    if (state.pendingEmptyDeviceListTimer) {
      clearTimeout(state.pendingEmptyDeviceListTimer);
      state.pendingEmptyDeviceListTimer = null;
    }

    const ids = devices
      .map((d) => String(d?.xrId || '').trim().toUpperCase())
      .filter(Boolean)
      .sort();
    const nextKey = ids.join('|');

    if (nextKey && nextKey === state.lastRenderedDeviceKey) {
      updateConnectionStatus('device_list', devices);
      return;
    }

    if (devices.length === 0) {
      state.pendingEmptyDeviceListTimer = setTimeout(() => {
        state.lastRenderedDeviceKey = '';
        showNoDevices();
        updateConnectionStatus('device_list', []);
        state.pendingEmptyDeviceListTimer = null;
      }, CONFIG.EMPTY_DEVICE_DELAY_MS);
      return;
    }

    state.lastRenderedDeviceKey = nextKey;
    dom.deviceList.innerHTML = '';

    const sorted = devices.slice().sort((a, b) => {
      const ax = String(a?.xrId || '').trim().toUpperCase();
      const bx = String(b?.xrId || '').trim().toUpperCase();
      return ax.localeCompare(bx);
    });

    sorted.forEach((d) => {
      const name = d?.deviceName || d?.name || (d?.xrId ? `Device (${d.xrId})` : 'Unknown');
      const li = document.createElement('li');
      li.className = 'text-gray-300';
      li.textContent = d?.xrId ? `${name} (${d.xrId})` : name;
      dom.deviceList.appendChild(li);
    });

    updateConnectionStatus('device_list', devices);
  }

  // =============================================================================
  //  SOCKET SIGNAL HANDLING
  // =============================================================================
  function transcriptKey(from, to) {
    return `${from || 'unknown'}->${to || 'unknown'}`;
  }

  function mergeIncremental(prev, next) {
    if (!prev) return next || '';
    if (!next) return prev;
    if (next.startsWith(prev)) return next;
    if (prev.startsWith(next)) return prev;

    let k = Math.min(prev.length, next.length);
    while (k > 0 && !prev.endsWith(next.slice(0, k))) k--;
    return prev + next.slice(k);
  }

  function ingestDrugAvailabilityPayload(payload) {
    const arr = Array.isArray(payload) ? payload : payload ? [payload] : [];

    state.medAvailability.clear();
    const newByName = {};

    for (const item of arr) {
      const raw = (item?.name ?? item?.query ?? item?.drug ?? item?.drugName ?? '').toString();
      const key = normalizeDrugKey(raw);
      if (!key) continue;

      const available =
        typeof item?.available === 'boolean'
          ? item.available
          : item?.status === 'exists' || item?.status === 'available' || item?.status === true;

      state.medAvailability.set(key, !!available);
      newByName[key] = !!available;
    }

    const scroller = soapContainerEnsure();
    const medTextarea = getMedicationTextarea(scroller);
    saveMedStatus(newByName, normalizedMedicationBlock(medTextarea));
    renderMedicationInline();
  }

  function getPacketRoomId(packet) {
    try {
      const direct =
        packet?.roomId ??
        packet?.room ??
        packet?.pairId ??
        packet?.pair_id ??
        packet?.data?.roomId ??
        packet?.data?.room ??
        packet?.data?.room_id ??
        packet?.data?.pairId ??
        packet?.data?.pair_id ??
        packet?.meta?.roomId ??
        packet?.meta?.room ??
        null;

      if (!direct) return null;
      return String(direct).trim();
    } catch {
      return null;
    }
  }

  function handleSignalMessage(packet) {
    if (!packet?.type) return;

    const msgRoom = getPacketRoomId(packet);

    if (msgRoom) {
      if (state.currentRoom && msgRoom !== state.currentRoom) return;
    } else {
      const t = String(packet.type || '');
      const roomLessAllowed =
        t === 'transcript_console' ||
        t === 'soap_note_console' ||
        t === 'drug_availability' ||
        t === 'drug_availability_console';
      if (!roomLessAllowed) return;
      // IMPORTANT: Do NOT drop transcript packets when roomId is missing; some backends send transcript_console without room metadata.
      // If we are in a room, keep isolation; if not in a room yet, still allow transcript/soap/drug packets to preserve existing workflow.
      if (state.currentRoom && !msgRoom) { /* allow room-less allowed types for active room */ }
      // If currentRoom is null, we still accept these room-less allowed packets (backward compatible).
    }

    if (packet.type === 'drug_availability' || packet.type === 'drug_availability_console') {
      ingestDrugAvailabilityPayload(packet.data);
      return;
    }

    if (packet.type === 'transcript_console') {
      if (!state.templateSelected) {
        showTemplateSelectionModal();
        return;
      }

      const p = packet.data || {};
      const { from, to, text = '', final = false, timestamp } = p;

      const key = transcriptKey(from, to);
      const slot =
        (state.transcriptState.byKey[key] ||= { partial: '', paragraph: '', flushTimer: null });

      if (!final) {
        slot.partial = text;
        return;
      }

      const mergedFinal = mergeIncremental(slot.partial, text);
      slot.partial = '';
      slot.paragraph = mergeIncremental(slot.paragraph ? slot.paragraph + ' ' : '', mergedFinal);

      if (slot.flushTimer) clearTimeout(slot.flushTimer);
      slot.flushTimer = setTimeout(() => {
        if (slot.paragraph) {
          appendTranscriptItem({ from, to, text: slot.paragraph, timestamp });
          slot.paragraph = '';
        }
        slot.flushTimer = null;
      }, CONFIG.TRANSCRIPT_FLUSH_MS);

      return;
    }

    if (packet.type === 'soap_note_console') {
      // Legacy handler - SOAP notes are now generated from frontend using selected template
      // This handler is kept for backward compatibility but should not be used in normal flow
      const soap = packet.data || {};
      initializeEditMetaForSoap(soap);
      syncTemplateRowsFromSections(soap);

      const hist = normalizeHistoryItems(loadHistory());

      const targetId = state.pendingSoapItemQueue.length
        ? state.pendingSoapItemQueue.shift()
        : loadActiveItemId();

      const idx = hist.findIndex((x) => x.id === targetId);
      if (idx !== -1) {
        // Use the template ID from the note data or fall back to dropdown selection
        const templateId = soap?._templateMeta?.id || dom.templateSelect?.value || CONFIG.SOAP_NOTE_TEMPLATE_ID;
        hist[idx].note = hist[idx].note || { templateId: templateId, data: {} };
        hist[idx].note.templateId = templateId;
        hist[idx].note.data = soap;
      }
      saveHistory(hist);

      stopSoapGenerationTimer();
      state.soapGenerating = false;

      const activeId = loadActiveItemId();
      if (activeId === targetId) {
        state.latestSoapNote = soap;
        saveLatestSoap(state.latestSoapNote);
        // Mark note as touched so Summary regenerates for latest note
        markNoteTouchedForCurrentMrn();
        renderSoapNote(state.latestSoapNote);
        // Use the template ID from the note data
        const templateId = soap?._templateMeta?.id || hist[idx]?.note?.templateId || CONFIG.SOAP_NOTE_TEMPLATE_ID;
        setTemplateSelectValue(templateId);
      }

      renderAiDiagnosisUi(null);
      return;
    }
  }

  // =============================================================================
  //  SOCKET.IO CLIENT LOADING + CONNECTION
  // =============================================================================
  function loadScript(src, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        s.remove();
        reject(new Error(`Timeout loading ${src}`));
      }, timeoutMs);

      s.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      s.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(`Failed to load ${src}`));
      };

      document.head.appendChild(s);
    });
  }

  async function loadSocketIoClientFor(endpointBase) {
    if (window.io) return;

    const endpointClient = `${endpointBase}/socket.io/socket.io.js`;
    try {
      await loadScript(endpointClient);
      if (window.io) return;
    } catch {
      // ignore, try CDN
    }

    const CDN = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    await loadScript(CDN);

    if (!window.io) throw new Error('Socket.IO client not available after CDN load.');
  }

  function clearCockpitUiForRoomSwitch(prevRoom, nextRoom) {
    if (prevRoom === nextRoom) return;

    stopSoapGenerationTimer();
    state.soapGenerating = false;

    // clear transcript flush timers
    try {
      Object.values(state.transcriptState.byKey || {}).forEach((slot) => {
        if (slot?.flushTimer) clearTimeout(slot.flushTimer);
      });
    } catch {
      // ignore
    }
    state.transcriptState.byKey = {};

    if (dom.transcript) dom.transcript.innerHTML = '';
    ensureTranscriptPlaceholder();

    state.currentActiveItemId = null;
    state.pendingSoapItemQueue.length = 0;
    state.latestSoapNote = {};

    renderSoapBlank();
    if (dom.templateSelect) setTemplateSelectValue(CONFIG.SOAP_NOTE_TEMPLATE_ID);

    state.medAvailability.clear();
    state.medicationValidationPending = false;

    state.aiDiagnosisInFlight = false;
    state.aiDiagnosisInFlightFor = null;
    state.aiDiagnosisLastError = null;
    clearAiDiagnosisPaneUi();
  }

  function connectTo(endpointBase, onFailover) {
    return new Promise((resolve) => {
      setStatus('Connecting');
      state.SERVER_URL = endpointBase;

      const opts = {
        path: '/socket.io',
        transports: ['websocket'],
        reconnection: true,
        secure: state.SERVER_URL.startsWith('https://'),
      };

      stopDeviceListWatchdog();
      try { state.socket?.close(); } catch { }

      state.socket = window.io(state.SERVER_URL, opts);

      let connected = false;
      const failTimer = setTimeout(() => {
        if (!connected) onFailover?.();
      }, 4000);

      state.socket.on('connect', async () => {
        connected = true;
        clearTimeout(failTimer);

        // reset listeners
        state.socket.off('device_list', updateDeviceList);
        state.socket.off('signal', handleSignalMessage);
        state.socket.off('signal_message');
        state.socket.off('room_joined');
        state.socket.off('peer_left');
        state.socket.off('room_update');
        state.socket.off('telemetry_update');

        state.socket.on('device_list', updateDeviceList);
        state.socket.on('signal', handleSignalMessage);
        // Backward/alternate event name support (some servers emit 'signal_message')
        state.socket.on('signal_message', handleSignalMessage);

        state.socket.on('room_update', ({ pairs } = {}) => {
          try {
            if (!state.COCKPIT_FOR_XR_ID) return;
            const me = String(state.COCKPIT_FOR_XR_ID).trim().toUpperCase();
            const list = Array.isArray(pairs) ? pairs : [];
            const inAnyPair = list.some((p) => {
              const a = String(p?.a || '').trim().toUpperCase();
              const b = String(p?.b || '').trim().toUpperCase();
              return a === me || b === me;
            });
            if (inAnyPair && !state.currentRoom) requestDeviceListThrottled();
          } catch {
            // ignore
          }
        });

        state.socket.on('telemetry_update', (t = {}) => {
          try {
            if (!state.COCKPIT_FOR_XR_ID) return;
            const me = String(state.COCKPIT_FOR_XR_ID).trim().toUpperCase();
            const xr = String(t?.xrId || '').trim().toUpperCase();
            if (!xr || xr !== me) return;
            if (!state.currentRoom) requestDeviceListThrottled();
          } catch {
            // ignore
          }
        });

        state.socket.on('peer_left', ({ roomId } = {}) => {
          if (roomId && state.currentRoom && roomId !== state.currentRoom) return;
          const prevRoom = state.currentRoom;
          state.currentRoom = null;
          clearCockpitUiForRoomSwitch(prevRoom, null);
          updateDeviceList([]);
          updateConnectionStatus('peer_left', []);
          requestDeviceListThrottled();
        });

        state.socket.on('room_joined', ({ roomId } = {}) => {
          const prevRoom = state.currentRoom;
          const nextRoom = roomId || null;
          clearCockpitUiForRoomSwitch(prevRoom, nextRoom);
          state.currentRoom = nextRoom;
          updateConnectionStatus('room_joined', []);
          try { restoreFromLocalStorage(); } catch { }
          if (state.currentRoom) requestDeviceListThrottled();
        });

        // identify cockpit + cache /me
        try {
          const meRes = await fetch('/api/platform/me', { credentials: 'include' });
          const me = await meRes.json();

          state.me = me || null; // NEW: cache /me

          window.COCKPIT_DOCTOR_ID = me?.doctorId ?? null;
          window.COCKPIT_SCRIBE_ID = me?.scribeId ?? null;

          const xrId = (me?.xrId || me?.xr_id || '').toString().trim();
          state.COCKPIT_FOR_XR_ID = xrId || null;

          if (xrId) {
            state.socket.emit('identify', {
              xrId,
              deviceName: 'XR Dock (Scribe Cockpit)',
              clientType: 'cockpit',
            });
          }
        } catch {
          // ignore
        }

        requestDeviceListThrottled();
        startDeviceListWatchdog();
        resolve();
      });

      state.socket.on('disconnect', () => {
        const prevRoom = state.currentRoom;
        state.currentRoom = null;
        state.lastReqListAt = 0;
        stopDeviceListWatchdog();
        clearCockpitUiForRoomSwitch(prevRoom, null);
        updateDeviceList([]);
        updateConnectionStatus('disconnect', []);
      });
    });
  }

  // =============================================================================
  //  RESTORE FROM LOCAL STORAGE
  // =============================================================================
  function restoreFromLocalStorage() {
    if (dom.transcript) dom.transcript.innerHTML = '';
    const hist = normalizeHistoryItems(loadHistory());

    if (!hist.length) ensureTranscriptPlaceholder();
    else {
      removeTranscriptPlaceholder();
      hist.forEach((item) => dom.transcript?.appendChild(createTranscriptCard(item)));
    }

    const activeId = loadActiveItemId();
    if (!activeId && hist.length) saveActiveItemId(hist[hist.length - 1].id);

    highlightActiveCard();
    ensureTopHeadingBadge();

    const ctx = getActiveHistoryContext();
    state.latestSoapNote = getActiveNoteForItem(ctx.item) || loadLatestSoap() || {};

    if (!hist.length) {
      renderSoapBlank();
    } else {
      renderSoapNote(state.latestSoapNote);
      syncDropdownToActiveTranscript();
    }

    const scroller = soapContainerEnsure();
    const medTextarea = getMedicationTextarea(scroller);
    if (medTextarea) {
      const currentNormalized = normalizedMedicationBlock(medTextarea);
      const { byName, lastText } = loadMedStatus();
      if (currentNormalized === lastText) {
        state.medAvailability.clear();
        Object.entries(byName).forEach(([k, v]) => state.medAvailability.set(k, !!v));
      }
    }

    renderMedicationInline();
    renderAiDiagnosisUi(null);
  }

  // =============================================================================
  //  SWEETALERT2 (strict)
  // =============================================================================
  function getSwal() {
    const Swal2 = window.Swal;
    if (!Swal2 || typeof Swal2.fire !== 'function') return null;
    return Swal2;
  }

  function swalConfirmSaveToEhr() {
    const Swal2 = getSwal();
    if (!Swal2) return Promise.resolve({ isConfirmed: false });

    return Swal2.fire({
      title: 'Save to EHR?',
      text: 'This will save the current template note to the patient’s EHR.',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Save',
      cancelButtonText: 'Cancel',
      reverseButtons: true,
      allowOutsideClick: false,
      allowEscapeKey: false,
      allowEnterKey: true,
      focusConfirm: true,
    });
  }

  function swalSuccessSaved(_noteId) {
    const Swal2 = getSwal();
    if (!Swal2) return Promise.resolve({});

    return Swal2.fire({
      title: 'Saved',
      text: 'Template note saved to EHR successfully.',
      icon: 'success',
      confirmButtonText: 'OK',
      allowOutsideClick: false,
      allowEscapeKey: false,
      allowEnterKey: true,
      focusConfirm: true,
    });
  }

  function swalError(msg) {
    const Swal2 = getSwal();
    if (!Swal2) return Promise.resolve({});

    return Swal2.fire({
      title: 'Error',
      text: String(msg || 'Failed to save to EHR.'),
      icon: 'error',
      confirmButtonText: 'OK',
      allowOutsideClick: false,
      allowEscapeKey: false,
      allowEnterKey: true,
      focusConfirm: true,
    });
  }

  // =============================================================================
  //  ADD TO EHR HELPERS (workflow preserved; less redundant API calls)
  // =============================================================================
  function getCurrentMrnForEhrSave() {
    try {
      // NEW: prefer selected EHR patient first (fast + reliable)
      const fromState = String(state.currentPatient?.mrn_no || '').trim();
      if (fromState) return fromState;

      const fromWindow =
        window.CURRENT_MRN ||
        window.COCKPIT_PATIENT_MRN ||
        window.EHR_MRN ||
        window.PATIENT_MRN ||
        null;

      if (fromWindow) {
        const v = String(fromWindow).trim();
        if (v) return v;
      }

      const selectors = [
        '#mrn',
        '#mrnInput',
        '#patientMrn',
        '#patient_mrn',
        '#ehrMrn',
        '#ehr_mrn',
        'input[name="mrn"]',
        'input[name="patient_mrn"]',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const raw = (el.value ?? el.textContent ?? '').toString().trim();
        if (raw) return raw;
      }

      const usp = new URLSearchParams(location.search || '');
      const qp = (usp.get('mrn') || usp.get('MRN') || usp.get('patient_mrn') || '').toString().trim();
      if (qp) return qp;

      return '';
    } catch {
      return '';
    }
  }

  async function fetchMeDoctorAndScribeIds() {
    // NEW: cache-first
    if (state.me?.doctorId && state.me?.scribeId) {
      return { doctorId: state.me.doctorId, scribeId: state.me.scribeId };
    }

    const meRes = await fetch('/api/platform/me', { credentials: 'include' });
    if (!meRes.ok) throw new Error(`Failed to load /api/platform/me (${meRes.status})`);
    const me = await meRes.json();
    state.me = me || null;

    const doctorId = me?.doctorId ?? null;
    const scribeId = me?.scribeId ?? null;

    if (!doctorId || !scribeId) throw new Error('Missing doctorId/scribeId from /api/platform/me');
    return { doctorId, scribeId };
  }

  async function fetchPatientIdByMrn(mrn) {
    const m = String(mrn || '').trim();
    if (!m) throw new Error('MRN is empty');

    // NEW: if already selected in sidebar, reuse
    if (String(state.currentPatient?.mrn_no || '').trim() === m && state.currentPatient?.patient_id) {
      return { patientId: state.currentPatient.patient_id, patient: state.currentPatient };
    }

    // NEW: cache MRN lookups
    if (state.patientCacheByMrn.has(m)) return state.patientCacheByMrn.get(m);

    const url = `/ehr/patient/${encodeURIComponent(m)}`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`Failed to load patient (${resp.status})`);

    const data = await resp.json();
    const p = data?.patient ?? null;

    const patientId = p?.patient_id ?? null;
    if (!patientId) throw new Error('Missing patient.patient_id from /ehr/patient/:mrn');

    const out = { patientId, patient: p };
    state.patientCacheByMrn.set(m, out);
    return out;
  }

  function getTemplateDrivenNoteFromStateOrStorage() {
    const inMem = state.latestSoapNote || {};
    if (isTemplateDrivenNoteEligible(inMem)) return inMem;

    const stored = loadLatestSoap() || {};
    if (isTemplateDrivenNoteEligible(stored)) return stored;

    const ctx = getActiveHistoryContext();
    return getActiveNoteForItem(ctx.item) || {};
  }

  function buildTemplateEhrSavePayload({ patientId, doctorId, scribeId, modifiedBy, timestamp, note }) {
    const patientNoteRow = {
      patient_id: patientId,
      doctor_id: doctorId,
      document_created_date: timestamp,
      created_by: doctorId,
      modified_by: modifiedBy,
      modified_date: timestamp,
      row_status: 1,
    };

    const rows = Array.isArray(note?._rowsForPatientNoteInsert) ? note._rowsForPatientNoteInsert : [];
    const contentRows = rows.map((r) => {
      const sectionName = String(r?.section || '').trim();
      const derivedEditCount = sectionName ? clampNumber(note?._editMeta?.[sectionName]?.edits ?? 0, 0) : 0;

      return {
        template_component_mapping_id: r?.template_component_mapping_id ?? r?.mapping_id ?? r?.mappingId ?? null,
        text: String(r?.text ?? ''),
        edit_count: clampNumber(r?.edit_count ?? derivedEditCount, 0),
        created_by: doctorId,
        modified_by: modifiedBy,
        created_date: timestamp,
        modified_date: timestamp,
        row_status: 1,
      };
    });

    return {
      doctorId,
      scribeId,
      patient_notes: patientNoteRow,
      patient_note_content: contentRows,
      template_meta: note?._templateMeta || null,
    };
  }

  async function saveTemplateNoteToEHR(payload) {
    const resp = await fetch('/ehr/patient_notes/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`EHR save failed (${resp.status}): ${txt || resp.statusText || 'Unknown error'}`);
    }
    return resp.json().catch(() => ({}));
  }

  function notifyEhrSidebarAfterSave(snapshot) {
    try {
      window.dispatchEvent(new CustomEvent('ehr_note_saved', { detail: snapshot || {} }));
    } catch {
      // ignore
    }
  }

  function clearActiveTranscriptCompletelyAfterEhrSave() {
    const activeId = loadActiveItemId();
    if (!activeId) {
      state.latestSoapNote = {};
      saveLatestSoap(state.latestSoapNote);
      renderSoapBlank();
      setTemplateSelectValue(CONFIG.SOAP_NOTE_TEMPLATE_ID);
      clearAiDiagnosisPaneUi();
      return;
    }

    // REQUIRED: clear linked AI diagnosis from UI + localStorage
    try { clearAiDiagnosisForHistoryItem(activeId); } catch { }

    state.latestSoapNote = {};
    saveLatestSoap(state.latestSoapNote);

    saveMedStatus({}, '');
    state.medAvailability.clear();
    state.medicationValidationPending = false;

    deleteTranscriptItem(activeId);

    const ctx = getActiveHistoryContext();
    if (ctx.item) {
      state.latestSoapNote = getActiveNoteForItem(ctx.item) || {};
      saveLatestSoap(state.latestSoapNote);
      renderSoapNote(state.latestSoapNote);
      syncDropdownToActiveTranscript();
    } else {
      renderSoapBlank();
      setTemplateSelectValue(CONFIG.SOAP_NOTE_TEMPLATE_ID);
      clearAiDiagnosisPaneUi();
    }
  }

  // =============================================================================
  //  BUTTON WIRING (CLEAR / ADD TO EHR)
  // =============================================================================
  function wireSoapActionButtons() {
    const scroller = soapContainerEnsure();

    // Save button removed (auto-save)
    if (dom.btnSave) {
      dom.btnSave.disabled = true;
      dom.btnSave.onclick = null;
      dom.btnSave.style.display = 'none';
      dom.btnSave.title = 'Auto-save is enabled';
    }

    if (dom.btnClear) {
      dom.btnClear.onclick = () => {
        scroller.querySelectorAll('textarea[data-section]').forEach((t) => {
          t.value = '';
          autoExpandTextarea(t);
          rebaseBoxStateToCurrent(t);
          t.dataset.editCount = '0';

          const headMeta = scroller.querySelector(
            `.scribe-section[data-section="${CSS.escape(t.dataset.section)}"] .scribe-section-meta`
          );
          if (headMeta) headMeta.textContent = 'Edits: 0';
        });

        persistActiveNoteFromUI();

        saveMedStatus({}, '');
        state.medAvailability.clear();
        state.medicationValidationPending = false;
        renderMedicationInline();

        resetAllEditCountersToZero();
        renderAiDiagnosisUi(null);
      };
    }

    if (dom.btnAddEhr) {
      dom.btnAddEhr.onclick = async () => {
        if (dom.btnAddEhr.disabled || state.addEhrInFlight) return;

        const confirmRes = await swalConfirmSaveToEhr();
        if (!confirmRes?.isConfirmed) return;

        state.addEhrInFlight = true;
        updateTotalsAndEhrState();

        let saveSnapshot = null;

        try {
          persistActiveNoteFromUI();

          const mrn = getCurrentMrnForEhrSave();
          if (!mrn) throw new Error('Missing MRN. Please enter/select a patient MRN before saving to EHR.');

          const { doctorId, scribeId } = await fetchMeDoctorAndScribeIds();
          const { patientId } = await fetchPatientIdByMrn(mrn);

          let note = getTemplateDrivenNoteFromStateOrStorage();
          note = syncTemplateRowsFromSections(note);

          if (!isTemplateDrivenNoteEligible(note)) throw new Error('Template-driven note is not eligible for EHR save.');

          const totalEdits = getTotalEditsFromNote(note);
          const modifiedBy = totalEdits > 0 ? scribeId : doctorId;
          const ts = new Date().toISOString();

          const payload = buildTemplateEhrSavePayload({
            patientId,
            doctorId,
            scribeId,
            modifiedBy,
            timestamp: ts,
            note,
          });

          const saveRes = await saveTemplateNoteToEHR(payload);

          saveSnapshot = {
            mrn: String(mrn).trim(),
            patientId,
            doctorId,
            scribeId,
            modifiedBy,
            timestamp: ts,
            noteId:
              saveRes?.note_id ??
              saveRes?.patient_note_id ??
              saveRes?.patientNoteId ??
              saveRes?.id ??
              null,
          };

          await swalSuccessSaved(saveSnapshot?.noteId);

          // Invalidate summary cache immediately after successful save
          if (saveSnapshot?.mrn && state.summaryCacheByMrn.has(saveSnapshot.mrn)) {
            state.summaryCacheByMrn.delete(saveSnapshot.mrn);
          }

          clearActiveTranscriptCompletelyAfterEhrSave();
          notifyEhrSidebarAfterSave(saveSnapshot);
        } catch (e) {
          await swalError(e?.message || e);
        } finally {
          state.addEhrInFlight = false;
          updateTotalsAndEhrState();
          renderAiDiagnosisUi(null);
        }
      };
    }

    updateTotalsAndEhrState();
  }

  // =============================================================================
  //  EHR SIDEBAR (kept same behavior; Summary now cache-aware)
  // =============================================================================
  function escapeHtmlEhr(str) {
    return String(str ?? 'N/A')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function fmtDate(dt) {
    if (!dt) return 'N/A';
    const d = new Date(dt);
    return isNaN(d.getTime()) ? 'N/A' : d.toLocaleDateString();
  }

  function persistEHRState() {
    try {
      const isSidebarOpen = dom.ehrSidebar?.classList.contains('active') || false;

      if (!state.currentPatient || !isSidebarOpen) {
        sessionStorage.removeItem(CONFIG.EHR_STORAGE_KEY);
        return;
      }

      sessionStorage.setItem(
        CONFIG.EHR_STORAGE_KEY,
        JSON.stringify({
          currentPatient: state.currentPatient,
          currentNotes: state.currentNotes,
          activeNoteId: document.querySelector('.ehr-note-item.active')?.dataset?.noteId || CONFIG.SUMMARY_NOTE_ID,
          noteCache: [...state.noteCache.entries()],
          summaryCache: [...state.summaryCacheByMrn.entries()],
          sidebarOpen: isSidebarOpen,
        })
      );
    } catch {
      // ignore
    }
  }

  function resetEHRState() {
    if (!dom.ehrSidebar || !dom.ehrOverlay) return;

    // stop any running summary UI updates
    try { stopSummaryTimer(); } catch { }
    try {
      if (state.summaryRefreshDebounce) {
        clearTimeout(state.summaryRefreshDebounce);
        state.summaryRefreshDebounce = null;
      }
    } catch { }

    // clear persisted EHR sidebar restore data
    try { sessionStorage.removeItem(CONFIG.EHR_STORAGE_KEY); } catch { }

    // clear runtime caches/state
    state.currentPatient = null;
    state.currentNotes = [];
    state.noteCache.clear();

    // optional but recommended: wipe summary-related caches so it truly starts fresh
    try { state.summaryCacheByMrn.clear(); } catch { }
    try { state.noteTouchedAtByMrn.clear(); } catch { }
    state.lastNoteTouchedAt = 0;

    // close + UI back to "Enter MRN"
    dom.ehrSidebar.classList.remove('active');
    dom.ehrOverlay.classList.remove('active');

    if (dom.ehrInitialState) dom.ehrInitialState.style.display = 'flex';
    if (dom.ehrPatientState) dom.ehrPatientState.style.display = 'none';

    if (dom.mrnInput) dom.mrnInput.value = '';
    if (dom.ehrError) {
      dom.ehrError.textContent = '';
      dom.ehrError.style.display = 'none';
    }
    if (dom.notesList) dom.notesList.innerHTML = '';
    if (dom.noteDetail) dom.noteDetail.innerHTML = '';
  }


  function renderPatient(p) {
    if (dom.ehrInitialState) dom.ehrInitialState.style.display = 'none';
    if (dom.ehrPatientState) dom.ehrPatientState.style.display = 'flex';
    if (dom.patientNameDisplay) dom.patientNameDisplay.textContent = p.full_name || 'N/A';
    if (dom.patientMRNDisplay) dom.patientMRNDisplay.textContent = p.mrn_no || 'N/A';
    if (dom.patientEmailDisplay) dom.patientEmailDisplay.textContent = p.email || 'N/A';
    if (dom.patientMobileDisplay) dom.patientMobileDisplay.textContent = p.contact_no_primary || 'N/A';
  }

  function setActiveNote(noteId) {
    document.querySelectorAll('.ehr-note-item').forEach((el) => el.classList.remove('active'));
    const items = [...document.querySelectorAll('.ehr-note-item')];
    const active = items.find(
      (el) => el.dataset.noteId == noteId || (noteId === CONFIG.SUMMARY_NOTE_ID && el.textContent === 'Summary')
    );
    if (active) active.classList.add('active');
  }

  function renderClinicalNotes(notes) {
    if (!dom.notesList) return;

    dom.notesList.innerHTML = '';
    dom.notesList.classList.add('ehr-notes-scroll');

    const summary = document.createElement('div');
    summary.className = 'ehr-note-item';
    summary.textContent = 'Summary';
    summary.onclick = () => {
      setActiveNote(CONFIG.SUMMARY_NOTE_ID);
      loadSummary();
    };
    dom.notesList.appendChild(summary);

    notes.forEach((note) => {
      const item = document.createElement('div');
      item.className = 'ehr-note-item';
      item.dataset.noteId = note.note_id;

      const fullName = (note.template || note.full_name || note.long_name || note.short_name || 'Clinical Note').toString();
      const dateLine = fmtDate(note.document_created_date);
      item.title = `${fullName}\n${dateLine}`;

      item.textContent = note.short_name || 'Clinical Note';
      item.onclick = () => {
        setActiveNote(note.note_id);
        loadNote(note.note_id);
      };
      dom.notesList.appendChild(item);
    });
  }

  function renderNoteDetail(template, createdDate, sections, isSummary) {
    if (!dom.noteDetail) return;
    let html = '';

    if (!isSummary) {
      html += `<div style="font-size:12px;font-weight:600;margin-bottom:12px;">
        DATE: ${escapeHtmlEhr(fmtDate(createdDate))}
      </div>`;
    }

    html += `<div style="text-align:center;font-size:18px;font-weight:800;margin-top:22px;margin-bottom:20px;">
      ${escapeHtmlEhr(template)}
    </div>`;

    (sections || []).forEach((s) => {
      html += `<div style="margin-bottom:18px;">
        <div style="font-weight:700;margin-bottom:6px;">${escapeHtmlEhr(s.component)}</div>
        <div>${escapeHtmlEhr(s.text || 'N/A')}</div>
      </div>`;
    });

    dom.noteDetail.innerHTML = html;
  }

  async function loadNote(noteId) {
    if (!dom.noteDetail) return;
    dom.noteDetail.innerHTML = `<div class="text-gray-400 text-sm">Loading...</div>`;

    if (state.noteCache.has(noteId)) {
      const cached = state.noteCache.get(noteId);
      renderNoteDetail(cached.note.template, cached.note.document_created_date, cached.sections, false);
      return;
    }

    try {
      const data = await apiGetJson(`${state.SERVER_URL}/ehr/notes/${noteId}`);
      state.noteCache.set(noteId, data);
      renderNoteDetail(
        data.note?.template || 'Clinical Note',
        data.note?.document_created_date,
        data.sections || [],
        false
      );
    } catch {
      dom.noteDetail.innerHTML = `<div class="text-red-500 text-sm">Failed to load note</div>`;
    }
  }

  function renderSummaryDetail(summaryText, title = 'AI Summary Note') {
    if (!dom.noteDetail) return;

    const raw = String(summaryText ?? '').trim();
    const normalized = raw
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const paragraphs = (normalized ? normalized.split(/\n\s*\n/) : [])
      .map((p) => p.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean);

    const bodyHtml = (paragraphs.length ? paragraphs : ['N/A'])
      .map((p) => `<p style="margin:0 0 14px 0;">${escapeHtmlEhr(p)}</p>`)
      .join('');

    dom.noteDetail.innerHTML = `
      <div style="height:100%; display:flex; flex-direction:column;">
        <div style="
          flex:0 0 auto;
          padding:12px 14px;
          text-align:center;
          font-size:18px;
          font-weight:800;
          color:#FFFFFF;
          background:transparent;
          border-bottom:none;
        ">
          ${escapeHtmlEhr(title || 'AI Summary Note')}
        </div>

        <div style="
          flex:1 1 auto;
          min-height:0;
          overflow-y:auto;
          padding:14px;
          color:#FFFFFF;
        ">
          <div style="
            max-width:760px;
            margin:0 auto;
            font-size:14px;
            line-height:1.8;
            text-align:justify;
            text-justify:inter-word;
            hyphens:auto;
            word-break:break-word;
          ">
            ${bodyHtml}
          </div>
        </div>
      </div>
    `;
  }

  async function loadSummary() {
    if (!dom.noteDetail) return;
    if (state.summaryGenerating) return; // prevent double-click spam

    const mrn = String(state.currentPatient?.mrn_no || '').trim();
    if (!mrn) {
      dom.noteDetail.innerHTML = `<div class="text-red-500 text-sm">MRN not selected.</div>`;
      return;
    }

    const cached = state.summaryCacheByMrn.get(mrn);
    if (cached && cached.text) {
      renderSummaryDetail(cached.text, cached.template_title || 'Summary Note');
      return;
    }

    startSummaryTimer();

    try {
      const res = await fetch(`${state.SERVER_URL}/ehr/ai/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mrn, _ts: Date.now() }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || `Failed (${res.status})`);

      stopSummaryTimer();

      state.summaryCacheByMrn.set(mrn, {
        text: data?.text,
        template_title: data?.template_title || 'Summary Note',
        fetchedAt: Date.now()
      });

      renderSummaryDetail(data?.text, data?.template_title || 'Summary Note');
    } catch (e) {
      stopSummaryTimer();
      dom.noteDetail.innerHTML =
        `<div class="text-red-500 text-sm">${escapeHtmlEhr(e?.message || 'Failed to generate summary')}</div>`;
    }
  }


  async function searchMRN() {
    if (!dom.mrnInput || !dom.mrnSearchButton) return;
    const mrn = dom.mrnInput.value.trim();
    if (!mrn) return;

    if (dom.ehrError) dom.ehrError.style.display = 'none';
    dom.mrnSearchButton.disabled = true;
    dom.mrnSearchButton.textContent = 'Searching...';

    state.noteCache.clear();
    sessionStorage.removeItem(CONFIG.EHR_STORAGE_KEY);

    try {
      const data = await apiGetJson(`${state.SERVER_URL}/ehr/patient/${encodeURIComponent(mrn)}`);
      state.currentPatient = data.patient || {};
      state.currentNotes = (data.notes || []).map((n) => ({
        note_id: n.note_id ?? n.patient_note_id,
        short_name: n.short_name,
        template: n.template,
        document_created_date: n.document_created_date,
      }));

      // Keep patient cache warm
      if (state.currentPatient?.mrn_no && state.currentPatient?.patient_id) {
        const m = String(state.currentPatient.mrn_no).trim();
        state.patientCacheByMrn.set(m, { patientId: state.currentPatient.patient_id, patient: state.currentPatient });
      }

      renderPatient(state.currentPatient);
      renderClinicalNotes(state.currentNotes);

      if (dom.noteDetail) dom.noteDetail.innerHTML = `<div class="text-gray-400 text-sm">Select a note to view details</div>`;
    } catch (e) {
      if (dom.ehrError) {
        dom.ehrError.textContent = e.message;
        dom.ehrError.style.display = 'block';
      }
    } finally {
      dom.mrnSearchButton.disabled = false;
      dom.mrnSearchButton.textContent = 'Search';
    }
  }

  function restoreEHRState() {
    try {
      const raw = sessionStorage.getItem(CONFIG.EHR_STORAGE_KEY);
      if (!raw) return;

      const saved = JSON.parse(raw);
      if (!saved.currentPatient || !saved.currentNotes || saved.currentNotes.length === 0) {
        sessionStorage.removeItem(CONFIG.EHR_STORAGE_KEY);
        resetEHRState();
        return;
      }

      state.currentPatient = saved.currentPatient;
      state.currentNotes = saved.currentNotes || [];
      (saved.noteCache || []).forEach(([k, v]) => state.noteCache.set(k, v));
      (saved.summaryCache || []).forEach(([k, v]) => state.summaryCacheByMrn.set(k, v));

      if (state.currentPatient?.mrn_no && state.currentPatient?.patient_id) {
        const m = String(state.currentPatient.mrn_no).trim();
        state.patientCacheByMrn.set(m, { patientId: state.currentPatient.patient_id, patient: state.currentPatient });
      }

      if (saved.sidebarOpen && dom.ehrSidebar && dom.ehrOverlay) {
        dom.ehrSidebar.classList.add('active');
        dom.ehrOverlay.classList.add('active');
      }

      renderPatient(state.currentPatient);
      renderClinicalNotes(state.currentNotes);

      const activeId = saved.activeNoteId || CONFIG.SUMMARY_NOTE_ID;
      setActiveNote(activeId);

      if (activeId === CONFIG.SUMMARY_NOTE_ID) loadSummary();
      else loadNote(activeId);
    } catch (err) {
      console.warn('[EHR] Failed to restore state:', err);
      sessionStorage.removeItem(CONFIG.EHR_STORAGE_KEY);
    }
  }

  async function refreshPatientAndNotes(mrn) {
    state.noteCache.clear();

    // Invalidate summary cache for this MRN since new notes have been added
    const mrnKey = String(mrn).trim();
    if (mrnKey && state.summaryCacheByMrn.has(mrnKey)) {
      state.summaryCacheByMrn.delete(mrnKey);
    }

    const data = await apiGetJson(`${state.SERVER_URL}/ehr/patient/${encodeURIComponent(mrn)}`);
    state.currentPatient = data.patient || {};
    state.currentNotes = (data.notes || []).map((n) => ({
      note_id: n.note_id ?? n.patient_note_id,
      short_name: n.short_name,
      template: n.template,
      document_created_date: n.document_created_date,
    }));

    if (state.currentPatient?.mrn_no && state.currentPatient?.patient_id) {
      const m = String(state.currentPatient.mrn_no).trim();
      state.patientCacheByMrn.set(m, { patientId: state.currentPatient.patient_id, patient: state.currentPatient });
    }

    renderPatient(state.currentPatient);
    renderClinicalNotes(state.currentNotes);
  }

  function pickLatestNoteId(notes) {
    if (!Array.isArray(notes) || notes.length === 0) return null;
    const sorted = notes
      .slice()
      .filter((n) => n && n.note_id != null)
      .sort((a, b) => new Date(b.document_created_date || 0).getTime() - new Date(a.document_created_date || 0).getTime());
    return sorted[0]?.note_id ?? null;
  }

  function wireEhrSidebar() {
    if (dom.ehrButton && dom.ehrSidebar && dom.ehrOverlay) {
      dom.ehrButton.onclick = () => {
        const open = dom.ehrSidebar.classList.contains('active');
        if (open) {
          // close only (do not clear)
          dom.ehrSidebar.classList.remove('active');
          dom.ehrOverlay.classList.remove('active');
        } else {
          dom.ehrSidebar.classList.add('active');
          dom.ehrOverlay.classList.add('active');
        }
      };
    }

    if (dom.ehrOverlay && dom.ehrSidebar) {
      dom.ehrOverlay.onclick = () => {
        // close only (do not clear)
        dom.ehrSidebar.classList.remove('active');
        dom.ehrOverlay.classList.remove('active');
      };
    }

    if (dom.ehrCloseButton && dom.ehrSidebar && dom.ehrOverlay) {
      dom.ehrCloseButton.onclick = () => {
        // ✅ FULL CLEAR + back to "Enter your MRN"
        try { stopSummaryTimer(); } catch { }
        try {
          if (state.summaryRefreshDebounce) {
            clearTimeout(state.summaryRefreshDebounce);
            state.summaryRefreshDebounce = null;
          }
        } catch { }

        // prevent restore bringing back old patient
        try { sessionStorage.removeItem(CONFIG.EHR_STORAGE_KEY); } catch { }

        // clear runtime state
        state.currentPatient = null;
        state.currentNotes = [];
        state.noteCache.clear();

        // optional but recommended: clear summary-related caches too
        try { state.summaryCacheByMrn.clear(); } catch { }
        try { state.noteTouchedAtByMrn.clear(); } catch { }
        state.lastNoteTouchedAt = 0;

        // reset UI to initial MRN screen
        dom.ehrSidebar.classList.remove('active');
        dom.ehrOverlay.classList.remove('active');

        if (dom.ehrInitialState) dom.ehrInitialState.style.display = 'flex';
        if (dom.ehrPatientState) dom.ehrPatientState.style.display = 'none';
        if (dom.mrnInput) dom.mrnInput.value = '';
        if (dom.ehrError) {
          dom.ehrError.textContent = '';
          dom.ehrError.style.display = 'none';
        }
        if (dom.notesList) dom.notesList.innerHTML = '';
        if (dom.noteDetail) dom.noteDetail.innerHTML = '';
      };
    }

    if (dom.mrnSearchButton) dom.mrnSearchButton.onclick = searchMRN;
    if (dom.mrnInput) dom.mrnInput.addEventListener('keypress', (e) => e.key === 'Enter' && searchMRN());

    // keep existing persistence behavior
    window.addEventListener('beforeunload', persistEHRState);
    window.addEventListener('load', restoreEHRState);

    window.addEventListener('ehr_note_saved', async (e) => {
      try {
        const snap = e?.detail || {};
        const mrn = String(snap.mrn || state.currentPatient?.mrn_no || '').trim();
        if (!mrn || !state.SERVER_URL) return;

        if (dom.mrnInput) dom.mrnInput.value = mrn;

        await refreshPatientAndNotes(mrn);

        const preferredId = snap.noteId ?? null;
        const latestId = preferredId || pickLatestNoteId(state.currentNotes);

        if (latestId) {
          setActiveNote(latestId);
          await loadNote(latestId);

          if (dom.ehrSidebar && dom.ehrOverlay) {
            dom.ehrSidebar.classList.add('active');
            dom.ehrOverlay.classList.add('active');
          }
        }
      } catch (err) {
        console.warn('[EHR] ehr_note_saved handler failed:', err);
      }
    });
  }


  // =============================================================================
  //  INIT / BOOT
  // =============================================================================
  async function boot() {
    try {
      ensureUiStyles();
      ensureMedStyles();
      ensureTranscriptPlaceholder();
      showNoDevices();

      ensureAiDiagnosisPaneHeader();
      clearAiDiagnosisPaneUi();

      restoreFromLocalStorage();
      wireSoapActionButtons();
      wireEhrSidebar();

      await loadSocketIoClientFor(preferredEndpoint);
      await connectTo(preferredEndpoint, async () => {
        if (!window.io) await loadSocketIoClientFor(fallbackEndpoint);
        await connectTo(fallbackEndpoint);
      });

      await initTemplateDropdown();
      setTemplateSelectValue(getActiveTemplateIdForItem(getActiveHistoryContext().item));

      showTemplateSelectionModal();

      renderAiDiagnosisUi(null);
    } catch (e) {
      console.error('[SCRIBE] Failed to initialize:', e);
      setStatus('Disconnected');
      if (dom.deviceList) {
        dom.deviceList.innerHTML = `<li class="text-red-400">Could not initialize cockpit. Ensure your signaling server is live.</li>`;
      }
      clearAiDiagnosisPaneUi();
    }
  }

  boot();
})();
