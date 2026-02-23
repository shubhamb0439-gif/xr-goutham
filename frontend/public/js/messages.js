// public/js/messages.js
// Port of Android data class `Message` to browser/PWA,
// with small helpers for validation, (de)serialization, and safe rendering.
//
// Fields preserved 1:1: sender, text, timestamp, xrId, urgent (default false).

/** @typedef {{
 *   sender: string,
 *   text: string,
 *   timestamp: string, // ISO string
 *   xrId: string,
 *   urgent?: boolean
 * }} MessageShape */

/** Simple Message model mirroring Android data class. */
export class Message {
  /** @param {MessageShape} m */
  constructor(m) {
    this.sender = String(m?.sender ?? '');
    this.text = String(m?.text ?? '');
    this.timestamp = String(m?.timestamp ?? '');
    this.xrId = String(m?.xrId ?? '');
    this.urgent = Boolean(m?.urgent ?? false);
  }

  /** @param {unknown} any */
  static from(any) {
    const m = typeof any === 'string' ? JSON.parse(any) : any || {};
    return new Message(m);
  }

  /** @returns {MessageShape} */
  toJSON() {
    return {
      sender: this.sender,
      text: this.text,
      timestamp: this.timestamp,
      xrId: this.xrId,
      urgent: this.urgent
    };
  }

  /** Validate minimal requirements; throws with a clear message on problems. */
  validate() {
    if (!this.sender) throw new Error('Message.sender is required');
    if (!this.text) throw new Error('Message.text is required');
    if (!this.xrId) throw new Error('Message.xrId is required');
    if (!isValidIso(this.timestamp)) throw new Error('Message.timestamp must be an ISO string');
    return true;
  }

  /** Format timestamp for local display. */
  formatTime(opts) {
    try {
      const d = new Date(this.timestamp);
      if (Number.isNaN(d.getTime())) return this.timestamp;
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        ...opts
      }).format(d);
    } catch { return this.timestamp; }
  }

  /** Create a DOM element representing the message (no framework needed). */
  toElement() {
    const root = document.createElement('div');
    root.className = `msg ${this.urgent ? 'msg-urgent' : ''}`;

    const header = document.createElement('div');
    header.className = 'msg-header';
    header.textContent = `${this.sender} [${this.xrId}]`;

    const ts = document.createElement('div');
    ts.className = 'msg-timestamp';
    ts.textContent = this.formatTime();

    const body = document.createElement('div');
    body.className = 'msg-text';
    body.innerHTML = escapeHTML(this.text);

    root.appendChild(header);
    root.appendChild(ts);
    root.appendChild(body);

    if (this.urgent) {
      const badge = document.createElement('span');
      badge.className = 'msg-badge-urgent';
      badge.textContent = 'URGENT';
      header.appendChild(document.createTextNode(' '));
      header.appendChild(badge);
    }
    return root;
  }

  /** Render as safe HTML string (if you prefer string templating). */
  toHTML() {
    const cls = this.urgent ? 'msg msg-urgent' : 'msg';
    return (
      `<div class="${cls}">` +
        `<div class="msg-header">${escapeHTML(this.sender)} [${escapeHTML(this.xrId)}]` +
          (this.urgent ? ` <span class="msg-badge-urgent">URGENT</span>` : '') +
        `</div>` +
        `<div class="msg-timestamp">${escapeHTML(this.formatTime())}</div>` +
        `<div class="msg-text">${escapeHTML(this.text)}</div>` +
      `</div>`
    );
  }
}

/** Append a message element to a container. */
export function appendMessage(container, msgLike) {
  const msg = msgLike instanceof Message ? msgLike : Message.from(msgLike);
  container.appendChild(msg.toElement());
}

/** Sort newest → oldest by timestamp. */
export function sortByNewest(messages) {
  return [...messages].sort((a, b) => {
    const da = new Date(a.timestamp).getTime();
    const db = new Date(b.timestamp).getTime();
    return (db || 0) - (da || 0);
  });
}

// ---------- utils ----------
function isValidIso(s) {
  if (typeof s !== 'string' || !s) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function escapeHTML(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
