/*!
 * Duplicate Cleaner v2.0
 * Finds byte-identical files in a folder, shows a visual preview of every copy,
 * and deletes only the copies you select. Runs entirely in this browser tab:
 * nothing is uploaded.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const PAGE_SIZE = 20;
  const SAMPLE_BYTES = 64 * 1024;          // quick-check slice size (start, middle, end)
  const CHUNK_BYTES = 8 * 1024 * 1024;     // full-hash read size
  const THUMB_PX = 256;                    // list / gallery / filmstrip thumbnails
  const MEDIUM_PX = 960;                   // side-by-side compare previews
  const TEXT_PREVIEW_BYTES = 96 * 1024;    // text shown in the large preview
  const THUMB_CONCURRENCY = 3;

  const EXT = {
    image: ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'bmp', 'dib', 'ico', 'cur', 'avif', 'apng', 'svg'],
    video: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv'],
    audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'],
    pdf: ['pdf'],
    text: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'geojson', 'xml', 'yml', 'yaml', 'log', 'ini', 'cfg', 'conf', 'toml', 'env',
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc',
      'cs', 'go', 'rs', 'rb', 'php', 'swift', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'sql', 'srt', 'vtt', 'tex', 'r', 'lua', 'pl', 'dart',
      'vue', 'svelte', 'properties', 'gradle', 'rtf', 'nfo'],
  };
  const KIND_BY_EXT = new Map();
  for (const [kind, list] of Object.entries(EXT)) for (const e of list) KIND_BY_EXT.set(e, kind);

  const TYPE_FILTERS = {
    all: null,
    images: new Set([...EXT.image, 'heic', 'heif', 'tif', 'tiff', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'raf', 'psd', 'jxl', 'svgz']),
    videos: new Set([...EXT.video, 'avi', 'wmv', 'flv', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg', 'vob', 'ts']),
    audio: new Set([...EXT.audio, 'wma', 'aiff', 'aif', 'mid', 'midi', 'amr']),
    documents: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv', 'tsv',
      'pages', 'numbers', 'key', 'epub', 'mobi']),
    archives: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'dmg', 'cab']),
  };

  const SYSTEM_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'ehthumbs.db', 'ehthumbs_vista.db', 'icon\r', '.localized', '.directory']);
  const SYSTEM_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '$recycle.bin', 'system volume information',
    '.trash', '.trashes', '.spotlight-v100', '.fseventsd', '.temporaryitems', '$windows.~bt', '$windows.~ws']);

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const nf = new Intl.NumberFormat('en-US');
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const dateTimeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

  const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtDate = (t) => (t ? dateFmt.format(new Date(t)) : 'Unknown date');
  const fmtDateTime = (t) => (t ? dateTimeFmt.format(new Date(t)) : 'Unknown');

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const s = v >= 100 ? v.toFixed(0) : v.toFixed(1);
    return `${s.replace(/\.0$/, '')} ${units[i]}`;
  }

  function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
  }
  const kindOf = (ext) => KIND_BY_EXT.get(ext) || 'other';
  const extLabel = (f) => (f.ext ? f.ext.slice(0, 5).toUpperCase() : 'FILE');

  function typeLabel(f) {
    const E = f.ext ? f.ext.toUpperCase() : '';
    switch (f.kind) {
      case 'image': return `${E} image`;
      case 'video': return `${E} video`;
      case 'audio': return `${E} audio`;
      case 'pdf': return 'PDF document';
      case 'text': return `${E} text file`;
      default: return E ? `${E} file` : 'File';
    }
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    let lastArgs = null;
    return (...args) => {
      lastArgs = args;
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn(...args);
      } else if (!timer) {
        timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs); }, ms - (now - last));
      }
    };
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  // Patterns that usually mean "this is a copy": " - Copy", " (1)", "Copy of …", "_copy".
  const COPY_PATTERNS = [/\s*-\s*copy(\s*\(\d+\))?$/i, /^copy of\s+/i, /\s*\(\d+\)$/, /[\s_-]copy\d*$/i, /\s*\(copy(\s*\d+)?\)$/i];
  function nameNoise(name) {
    let base = name.replace(/\.[^.]+$/, '');
    let n = 0;
    for (let guard = 0; guard < 6; guard++) {
      let changed = false;
      for (const re of COPY_PATTERNS) {
        if (re.test(base)) { base = base.replace(re, ''); n++; changed = true; }
      }
      if (!changed) break;
    }
    return n;
  }

  class CancelledError extends Error {
    constructor() { super('Scan cancelled'); this.name = 'CancelledError'; }
  }

  // ---------------------------------------------------------------------------
  // Icons (inline SVG, inherit currentColor)
  // ---------------------------------------------------------------------------
  const svg = (body, vb = '0 0 16 16') => `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICON = {
    check: svg('<path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
    zoom: svg('<circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m10.3 10.3 3.2 3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'),
    compare: svg('<rect x="1.75" y="3" width="5.5" height="10" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="8.75" y="3" width="5.5" height="10" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
    close: svg('<path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
    left: svg('<path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    right: svg('<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    play: svg('<path d="M5 3.5v9l7.5-4.5Z"/>'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c.1.7.6 1.3 1.4 1.3h3c.8 0 1.3-.6 1.4-1.3l.6-8.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
    warn: svg('<path d="M12 3.5 21.5 20h-19Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>', '0 0 24 24'),
    expand: svg('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
    fit: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
  };
  const KIND_ICON = {
    image: svg('<rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="9.5" r="1.8" fill="currentColor"/><path d="m4 18 5.5-5.5 4 4 2.5-2.5L20 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>', '0 0 24 24'),
    video: svg('<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9.2v5.6l4.6-2.8Z" fill="currentColor"/>', '0 0 24 24'),
    audio: svg('<path d="M9 17.5V6.5l10-2v11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.5" cy="17.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16.5" cy="15.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>', '0 0 24 24'),
    pdf: svg('<path d="M6 3h8l4 4v14H6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v4h4M9 13h6M9 16.5h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', '0 0 24 24'),
    text: svg('<path d="M6 3h8l4 4v14H6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v4h4M9 11h6M9 14h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', '0 0 24 24'),
    other: svg('<path d="M6 3h8l4 4v14H6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6"/>', '0 0 24 24'),
  };

  // ---------------------------------------------------------------------------
  // Preferences (remembered in this browser)
  // ---------------------------------------------------------------------------
  const PREF_KEY = 'duplicate-cleaner:prefs:v2';
  const DEFAULT_PREFS = {
    includeSubfolders: true, skipHidden: true, skipSystemDirs: true, types: 'all', minSize: 1, exclude: '',
    protectRule: 'shortest', sort: 'space', view: 'list',
  };
  function loadPrefs() {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage may be unavailable on file:// */ }
  }
  const prefs = loadPrefs();

  // ---------------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------------
  const state = {
    source: null,          // { kind: 'fsa' | 'input' | 'sample', name, root?, entries?, canDelete }
    scanning: false,
    scanToken: 0,
    cancelRequested: false,
    hasResults: false,
    recs: new Map(),       // id -> file record (files that belong to a duplicate group)
    groups: [],
    groupById: new Map(),
    selected: new Set(),
    stats: null,           // { checked, excluded, skippedDirs, unreadable }
    query: '',
    page: 0,
    lastScanAt: null,
    notice: null,          // { kind: 'success' | 'info' | 'warn' | 'error', text }
    freedBytes: 0,
    deletedCount: 0,
  };
  let recSeq = 0;

  const el = {
    main: $('#main'),
    folderName: $('#folderName'), folderMeta: $('#folderMeta'), pickLabel: $('#pickLabel'), pickBtn: $('#pickBtn'),
    sampleBtn: $('#sampleBtn'), scanBtn: $('#scanBtn'), modeNote: $('#modeNote'),
    optSubfolders: $('#optSubfolders'), optSkipHidden: $('#optSkipHidden'), optSkipSystemDirs: $('#optSkipSystemDirs'),
    optTypes: $('#optTypes'), optMinSize: $('#optMinSize'), optExclude: $('#optExclude'),
    statFiles: $('#statFiles'), statGroups: $('#statGroups'), statSpace: $('#statSpace'),
    banner: $('#banner'), introCard: $('#introCard'),
    progressCard: $('#progressCard'), progressPhase: $('#progressPhase'), progressTitle: $('#progressTitle'),
    progressDetail: $('#progressDetail'), progressBar: $('#progressBar'), progressFill: $('#progressFill'),
    reviewCard: $('#reviewCard'), groupsTitle: $('#groupsTitle'), search: $('#search'), sort: $('#sort'),
    protectRule: $('#protectRule'), groups: $('#groups'), pager: $('#pager'),
    actionBar: $('#actionBar'), selCount: $('#selCount'), selSize: $('#selSize'), actionNote: $('#actionNote'),
    actionThumbs: $('#actionThumbs'), reviewBtn: $('#reviewBtn'),
    toast: $('#toast'), compareDialog: $('#compareDialog'), reviewDialog: $('#reviewDialog'), dirInput: $('#dirInput'),
  };

  const canPickDirectory = typeof window.showDirectoryPicker === 'function';
  const hasSubtle = !!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function');

  // ---------------------------------------------------------------------------
  // Hashing. Files up to 8 MB get a plain SHA-256 of their bytes (matches
  // `certutil -hashfile <file> SHA256`). Bigger files are hashed in 8 MB chunks
  // and the chunk hashes are hashed again, so memory use stays small.
  // ---------------------------------------------------------------------------
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  // Pure-JS SHA-256, used only when crypto.subtle is unavailable.
  function sha256js(bytes) {
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const padded = new Uint8Array(total);
    padded.set(bytes);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000));
    dv.setUint32(total - 4, (len * 8) >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15];
        const b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  async function sha256(data) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (hasSubtle) {
      try { return new Uint8Array(await crypto.subtle.digest('SHA-256', view)); } catch { /* fall back below */ }
    }
    return sha256js(view);
  }

  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  // Quick check: hash the first, middle and last 64 KB. Small files are hashed whole.
  async function quickKey(file) {
    const size = file.size;
    if (size <= SAMPLE_BYTES * 3) {
      return { key: toHex(await sha256(await file.arrayBuffer())), complete: true };
    }
    const mid = Math.floor(size / 2 - SAMPLE_BYTES / 2);
    const parts = await Promise.all([
      file.slice(0, SAMPLE_BYTES).arrayBuffer(),
      file.slice(mid, mid + SAMPLE_BYTES).arrayBuffer(),
      file.slice(size - SAMPLE_BYTES, size).arrayBuffer(),
    ]);
    const joined = new Uint8Array(SAMPLE_BYTES * 3);
    parts.forEach((p, i) => joined.set(new Uint8Array(p), i * SAMPLE_BYTES));
    return { key: toHex(await sha256(joined)), complete: false };
  }

  async function fullKey(file, onBytes, check) {
    const size = file.size;
    if (size <= CHUNK_BYTES) {
      const buf = await file.arrayBuffer();
      onBytes(size);
      return toHex(await sha256(buf));
    }
    const digests = [];
    for (let off = 0; off < size; off += CHUNK_BYTES) {
      check();
      const buf = await file.slice(off, Math.min(off + CHUNK_BYTES, size)).arrayBuffer();
      digests.push(await sha256(buf));
      onBytes(buf.byteLength);
    }
    const all = new Uint8Array(digests.length * 32);
    digests.forEach((d, i) => all.set(d, i * 32));
    return toHex(await sha256(all));
  }

  async function runPool(items, limit, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    });
    await Promise.all(lanes);
  }

  // ---------------------------------------------------------------------------
  // Listing files
  // ---------------------------------------------------------------------------
  function readScanOptions() {
    const exclude = el.optExclude.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return {
      includeSubfolders: el.optSubfolders.checked,
      skipHidden: el.optSkipHidden.checked,
      skipSystemDirs: el.optSkipSystemDirs.checked,
      types: TYPE_FILTERS[el.optTypes.value] || null,
      minSize: Number(el.optMinSize.value) || 0,
      exclude: new Set(exclude),
    };
  }

  function skipDir(name, o) {
    const n = name.toLowerCase();
    if (o.skipHidden && n.startsWith('.')) return true;
    if (o.skipSystemDirs && SYSTEM_DIRS.has(n)) return true;
    return o.exclude.has(n);
  }

  function skipFileByName(name, o) {
    const n = name.toLowerCase();
    if (o.skipHidden && (n.startsWith('.') || n.startsWith('~$') || SYSTEM_FILES.has(n))) return true;
    return !!(o.types && !o.types.has(extOf(name)));
  }

  function makeRec(p) {
    const ext = extOf(p.name);
    const id = `f${++recSeq}`;
    return {
      id, name: p.name, path: p.path, dir: p.path.slice(0, Math.max(0, p.path.length - p.name.length - 1)),
      size: p.size, lastModified: p.lastModified, ext, kind: kindOf(ext), noise: nameNoise(p.name),
      depth: p.depth, order: recSeq, handle: p.handle || null, parent: p.parent || null, entry: p.entry || null,
      file: p.file || null, hash: null, groupId: null, w: 0, h: 0, dur: 0,
    };
  }

  async function fileOf(rec) {
    if (rec.file) return rec.file;
    return rec.handle.getFile();
  }

  // Chrome / Edge: File System Access API (can delete).
  async function listFromHandle(root, o, ctx) {
    const out = { recs: [], excluded: 0, skippedDirs: 0, unreadable: 0 };
    async function walk(dir, rel, depth) {
      ctx.check();
      const entries = [];
      try {
        for await (const h of dir.values()) entries.push(h);
      } catch {
        out.unreadable++;
        return;
      }
      entries.sort((a, b) => collator.compare(a.name, b.name));
      const subdirs = [];
      const files = [];
      for (const h of entries) {
        if (h.kind === 'directory') {
          if (!o.includeSubfolders || skipDir(h.name, o)) out.skippedDirs++;
          else subdirs.push(h);
        } else if (skipFileByName(h.name, o)) {
          out.excluded++;
        } else {
          files.push(h);
        }
      }
      for (let i = 0; i < files.length; i += 24) {
        ctx.check();
        const batch = files.slice(i, i + 24);
        const got = await Promise.all(batch.map((h) => h.getFile().then((f) => f, () => null)));
        got.forEach((file, j) => {
          if (!file) { out.unreadable++; return; }
          if (file.size < o.minSize) { out.excluded++; return; }
          const h = batch[j];
          out.recs.push(makeRec({ name: h.name, path: rel + h.name, size: file.size, lastModified: file.lastModified, handle: h, parent: dir, depth }));
        });
        ctx.listed(out.recs.length);
      }
      for (const d of subdirs) await walk(d, `${rel}${d.name}/`, depth + 1);
    }
    await walk(root, `${root.name}/`, 0);
    return out;
  }

  // Read-only fallback (folder upload input) and the sample folder.
  function listFromEntries(entries, o) {
    const out = { recs: [], excluded: 0, skippedDirs: 0, unreadable: 0 };
    const skipped = new Set();
    const sorted = entries.slice().sort((a, b) => collator.compare(a.path, b.path));
    for (const entry of sorted) {
      const parts = entry.path.split('/');
      const dirs = parts.slice(1, -1);
      let skip = false;
      for (let i = 0; i < dirs.length; i++) {
        if (!o.includeSubfolders || skipDir(dirs[i], o)) {
          skipped.add(parts.slice(0, i + 2).join('/'));
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const f = entry.file;
      if (skipFileByName(f.name, o) || f.size < o.minSize) { out.excluded++; continue; }
      out.recs.push(makeRec({ name: f.name, path: entry.path, size: f.size, lastModified: f.lastModified, file: f, entry, depth: dirs.length }));
    }
    out.skippedDirs = skipped.size;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Duplicate detection: same size -> same quick hash -> same full hash
  // ---------------------------------------------------------------------------
  async function findDuplicates(recs, ctx) {
    const bySize = new Map();
    for (const r of recs) {
      const list = bySize.get(r.size);
      if (list) list.push(r); else bySize.set(r.size, [r]);
    }
    const candidates = [];
    for (const list of bySize.values()) if (list.length > 1) candidates.push(...list);

    const unreadable = new Set();
    let quickDone = 0;
    const quickProgress = throttle(() => {
      ctx.progress('Comparing', 'Quick check of same-size files…', `${nf.format(quickDone)} of ${plural(candidates.length, 'file')}`, candidates.length ? quickDone / candidates.length : 1);
    }, 100);
    quickProgress();
    await runPool(candidates, 4, async (r) => {
      ctx.check();
      try {
        const q = await quickKey(await fileOf(r));
        r.quick = q.key;
        r.complete = q.complete;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        unreadable.add(r);
      }
      quickDone++;
      quickProgress();
    });

    const quickBuckets = new Map();
    for (const r of candidates) {
      if (unreadable.has(r)) continue;
      const k = `${r.size}:${r.quick}`;
      const list = quickBuckets.get(k);
      if (list) list.push(r); else quickBuckets.set(k, [r]);
    }

    const finalBuckets = [];
    const needFull = [];
    for (const list of quickBuckets.values()) {
      if (list.length < 2) continue;
      if (list[0].complete) {
        for (const r of list) r.hash = r.quick;
        finalBuckets.push(list);
      } else {
        needFull.push(...list);
      }
    }

    const fullTotal = needFull.reduce((s, r) => s + r.size, 0);
    let fullDone = 0;
    const fullProgress = throttle(() => {
      ctx.progress('Verifying', 'Confirming identical contents…', `${fmtBytes(fullDone)} of ${fmtBytes(fullTotal)} read`, fullTotal ? fullDone / fullTotal : 1);
    }, 100);
    if (needFull.length) fullProgress();
    await runPool(needFull, 2, async (r) => {
      ctx.check();
      try {
        r.hash = await fullKey(await fileOf(r), (n) => { fullDone += n; fullProgress(); }, ctx.check);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        unreadable.add(r);
      }
    });

    const fullBuckets = new Map();
    for (const r of needFull) {
      if (unreadable.has(r) || !r.hash) continue;
      const k = `${r.size}:${r.hash}`;
      const list = fullBuckets.get(k);
      if (list) list.push(r); else fullBuckets.set(k, [r]);
    }
    for (const list of fullBuckets.values()) if (list.length > 1) finalBuckets.push(list);
    return { buckets: finalBuckets, unreadable: unreadable.size };
  }

  // ---------------------------------------------------------------------------
  // Which copy to keep
  // ---------------------------------------------------------------------------
  const byPath = (a, b) => collator.compare(a.path, b.path);
  const KEEP_RULES = {
    shortest: (a, b) => a.path.length - b.path.length || a.noise - b.noise || a.lastModified - b.lastModified || byPath(a, b),
    clean: (a, b) => a.noise - b.noise || a.name.length - b.name.length || a.path.length - b.path.length || byPath(a, b),
    oldest: (a, b) => a.lastModified - b.lastModified || a.noise - b.noise || a.path.length - b.path.length || byPath(a, b),
    newest: (a, b) => b.lastModified - a.lastModified || a.noise - b.noise || a.path.length - b.path.length || byPath(a, b),
    shallow: (a, b) => a.depth - b.depth || a.noise - b.noise || a.path.length - b.path.length || byPath(a, b),
  };
  function pickKeep(files, rule) {
    return files.slice().sort(KEEP_RULES[rule] || KEEP_RULES.shortest)[0];
  }

  function buildGroups(buckets) {
    state.recs.clear();
    state.groups = [];
    state.groupById.clear();
    state.selected.clear();
    let n = 0;
    for (const list of buckets) {
      const keep = pickKeep(list, prefs.protectRule);
      const rest = list.filter((f) => f !== keep).sort(byPath);
      const g = {
        id: `g${++n}`, hash: keep.hash, size: keep.size, files: [keep, ...rest], keepId: keep.id,
        title: keep.name,
      };
      for (const f of g.files) { f.groupId = g.id; state.recs.set(f.id, f); }
      state.groups.push(g);
      state.groupById.set(g.id, g);
    }
  }

  const keepOf = (g) => g.files.find((f) => f.id === g.keepId) || g.files[0];
  const extraBytes = (g) => g.size * (g.files.length - 1);

  // ---------------------------------------------------------------------------
  // Sample folder (generated in this tab, nothing touches the disk)
  // ---------------------------------------------------------------------------
  function seeded(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  const SCENES = {
    sunset(ctx, w, h) {
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
      sky.addColorStop(0, '#3d2c5c'); sky.addColorStop(0.45, '#c9607a'); sky.addColorStop(1, '#f7b36b');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffe3a3'; ctx.beginPath(); ctx.arc(w * 0.62, h * 0.6, h * 0.13, 0, Math.PI * 2); ctx.fill();
      const sea = ctx.createLinearGradient(0, h * 0.64, 0, h);
      sea.addColorStop(0, '#d9876e'); sea.addColorStop(1, '#3b2747');
      ctx.fillStyle = sea; ctx.fillRect(0, h * 0.64, w, h * 0.36);
      ctx.fillStyle = 'rgba(255, 227, 163, .55)';
      for (let i = 0; i < 9; i++) { const y = h * 0.68 + i * h * 0.03; const half = (w * 0.1) / (1 + i * 0.25); ctx.fillRect(w * 0.62 - half, y, half * 2, 3); }
      ctx.fillStyle = '#4a2f4f';
      ctx.beginPath(); ctx.moveTo(0, h * 0.66); ctx.lineTo(w * 0.18, h * 0.5); ctx.lineTo(w * 0.3, h * 0.58); ctx.lineTo(w * 0.42, h * 0.52); ctx.lineTo(w * 0.5, h * 0.66); ctx.closePath(); ctx.fill();
    },
    ocean(ctx, w, h) {
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.5);
      sky.addColorStop(0, '#9fd3f2'); sky.addColorStop(1, '#e3f3fb');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      const sea = ctx.createLinearGradient(0, h * 0.5, 0, h);
      sea.addColorStop(0, '#2f8fc9'); sea.addColorStop(1, '#0d3f6e');
      ctx.fillStyle = sea; ctx.fillRect(0, h * 0.5, w, h * 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 4;
      for (let row = 0; row < 7; row++) {
        const y0 = h * 0.56 + row * h * 0.065;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) { const y = y0 + Math.sin(x / (40 + row * 6) + row) * (5 + row * 1.6); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(w * 0.3, h * 0.47); ctx.lineTo(w * 0.3, h * 0.27); ctx.lineTo(w * 0.37, h * 0.47); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#5a3d2b'; ctx.fillRect(w * 0.26, h * 0.47, w * 0.13, h * 0.03);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      [[0.72, 0.16, 70], [0.8, 0.13, 50], [0.15, 0.12, 55]].forEach(([x, y, r]) => { ctx.beginPath(); ctx.ellipse(w * x, h * y, r * 1.8, r * 0.6, 0, 0, Math.PI * 2); ctx.fill(); });
    },
    forest(ctx, w, h) {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#e6f2d9'); sky.addColorStop(1, '#b8d9a8');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      const rnd = seeded(7);
      const rows = [['#7fb27a', 0.55, 0.5], ['#4f8d57', 0.7, 0.7], ['#2f6a45', 0.86, 0.95]];
      for (const [color, base, scale] of rows) {
        ctx.fillStyle = color;
        for (let x = -40; x < w + 40; x += 55 * scale + rnd() * 30) {
          const th = (140 + rnd() * 120) * scale;
          ctx.beginPath(); ctx.moveTo(x, h * base); ctx.lineTo(x + 32 * scale, h * base - th); ctx.lineTo(x + 64 * scale, h * base); ctx.closePath(); ctx.fill();
        }
        ctx.fillRect(0, h * base - 2, w, h - h * base + 2);
      }
      ctx.fillStyle = '#e8d3a8';
      ctx.beginPath(); ctx.moveTo(w * 0.42, h); ctx.quadraticCurveTo(w * 0.5, h * 0.9, w * 0.47, h * 0.86); ctx.lineTo(w * 0.53, h * 0.86); ctx.quadraticCurveTo(w * 0.6, h * 0.92, w * 0.7, h); ctx.closePath(); ctx.fill();
    },
    city(ctx, w, h) {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#0b1633'); sky.addColorStop(1, '#2a2f63');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f4f1d9'; ctx.beginPath(); ctx.arc(w * 0.8, h * 0.2, h * 0.07, 0, Math.PI * 2); ctx.fill();
      const rnd = seeded(42);
      for (let x = 0; x < w;) {
        const bw = 60 + rnd() * 90;
        const bh = h * (0.25 + rnd() * 0.45);
        ctx.fillStyle = rnd() > 0.5 ? '#151d3d' : '#1c2550';
        ctx.fillRect(x, h - bh, bw - 6, bh);
        for (let wy = h - bh + 14; wy < h - 16; wy += 22) {
          for (let wx = x + 10; wx < x + bw - 20; wx += 18) {
            if (rnd() > 0.45) { ctx.fillStyle = rnd() > 0.3 ? '#ffd76e' : '#9fd8ff'; ctx.fillRect(wx, wy, 8, 11); }
          }
        }
        x += bw;
      }
    },
    lake(ctx, w, h) {
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
      sky.addColorStop(0, '#7fb3e0'); sky.addColorStop(1, '#e8f1f7');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      const peak = (x, base, height, width, color) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x - width / 2, base); ctx.lineTo(x, base - height); ctx.lineTo(x + width / 2, base); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(x - width * 0.12, base - height * 0.76); ctx.lineTo(x, base - height); ctx.lineTo(x + width * 0.12, base - height * 0.76); ctx.closePath(); ctx.fill();
      };
      peak(w * 0.3, h * 0.58, h * 0.42, w * 0.55, '#5d7186');
      peak(w * 0.62, h * 0.58, h * 0.5, w * 0.6, '#475a6e');
      peak(w * 0.9, h * 0.58, h * 0.3, w * 0.4, '#6b8095');
      const water = ctx.createLinearGradient(0, h * 0.58, 0, h);
      water.addColorStop(0, '#5a8fb8'); water.addColorStop(1, '#1f4a6b');
      ctx.fillStyle = water; ctx.fillRect(0, h * 0.58, w, h * 0.42);
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      for (let i = 0; i < 12; i++) ctx.fillRect(w * (0.1 + (i * 0.071) % 0.8), h * (0.63 + i * 0.028), w * 0.12, 2);
    },
    logo(ctx, w, h, variant) {
      ctx.fillStyle = variant === 2 ? '#192c2c' : '#f4f5f0'; ctx.fillRect(0, 0, w, h);
      const s = Math.min(w, h) * 0.36;
      const x = w / 2 - s * 0.7;
      const y = h / 2 - s * 0.62;
      ctx.lineWidth = s * 0.07;
      ctx.strokeStyle = variant === 2 ? '#d7ef86' : '#192c2c';
      ctx.fillStyle = variant === 2 ? '#2e4a48' : '#d7ef86';
      ctx.beginPath(); ctx.roundRect(x, y + s * 0.35, s, s, s * 0.2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = variant === 2 ? '#d7ef86' : '#ffffff';
      ctx.beginPath(); ctx.roundRect(x + s * 0.42, y, s, s, s * 0.2); ctx.fill(); ctx.stroke();
    },
  };

  async function buildSampleEntries() {
    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 800;
    const ctx = canvas.getContext('2d');
    if (!ctx.roundRect) ctx.roundRect = function roundRect(x, y, w, h) { this.rect(x, y, w, h); };
    const toBlob = (type, q) => new Promise((res) => canvas.toBlob(res, type, q));
    const art = {};
    const draw = async (key, fn, type, variant) => {
      ctx.save(); ctx.clearRect(0, 0, canvas.width, canvas.height); fn(ctx, canvas.width, canvas.height, variant); ctx.restore();
      art[key] = await toBlob(type, 0.9);
    };
    await draw('sunset', SCENES.sunset, 'image/png');
    await draw('ocean', SCENES.ocean, 'image/jpeg');
    await draw('forest', SCENES.forest, 'image/jpeg');
    await draw('city', SCENES.city, 'image/png');
    await draw('lake', SCENES.lake, 'image/jpeg');
    canvas.width = 800; canvas.height = 800;
    await draw('logo', SCENES.logo, 'image/png', 1);
    await draw('logo2', SCENES.logo, 'image/png', 2);

    const text = (s, type = 'text/plain') => new Blob([s], { type });
    art.notes = text('Team sync - notes\n\n1. Ship the visual preview update\n2. Clean up duplicate photos in Backup 2025\n3. Keep originals in Photos\n4. Check every copy before deleting\n\nNext meeting: Friday 11:00\n');
    art.budget = text('Month,Category,Amount\nJanuary,Design,1200\nFebruary,Hosting,240\nMarch,Software,560\nApril,Design,980\nMay,Marketing,1500\n', 'text/csv');
    art.readme = text('This sample folder was generated in your browser so you can try Duplicate Cleaner safely.\nDeleting here is only a simulation.\n');

    const day = 86400000;
    const now = Date.now();
    const plan = [
      ['Photos/Sunset over the bay.png', 'sunset', 41], ['Photos/Sunset over the bay - Copy.png', 'sunset', 12], ['Downloads/Sunset over the bay (1).png', 'sunset', 3],
      ['Photos/Ocean waves.jpg', 'ocean', 64], ['Backup 2025/Ocean waves.jpg', 'ocean', 20],
      ['Photos/Forest trail.jpg', 'forest', 90], ['Desktop/Forest trail - Copy.jpg', 'forest', 30], ['Backup 2025/IMG_4021.jpg', 'forest', 22],
      ['Photos/Night city.png', 'city', 15], ['WhatsApp Images/IMG-20260914-WA0007.png', 'city', 9],
      ['Photos/Mountain lake.jpg', 'lake', 50],
      ['Design/Logo.png', 'logo', 120], ['Design/Logo final.png', 'logo', 110], ['Design/Logo dark.png', 'logo2', 100],
      ['Docs/Meeting notes.txt', 'notes', 8], ['Docs/Meeting notes - Copy.txt', 'notes', 2],
      ['Docs/Budget 2026.csv', 'budget', 33], ['Downloads/Budget 2026 (1).csv', 'budget', 5],
      ['Docs/Readme.txt', 'readme', 60],
    ];
    return plan.map(([rel, key, age], i) => {
      const name = rel.split('/').pop();
      const blob = art[key];
      return { path: `Sample folder/${rel}`, file: new File([blob], name, { type: blob.type, lastModified: now - age * day - i * 61000 }) };
    });
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------
  async function ensurePermission(handle, mode) {
    if (!handle || typeof handle.queryPermission !== 'function') return true;
    try {
      if ((await handle.queryPermission({ mode })) === 'granted') return true;
      return (await handle.requestPermission({ mode })) === 'granted';
    } catch {
      return false;
    }
  }

  function resetResults() {
    revokeAllPreviews();
    state.recs.clear();
    state.groups = [];
    state.groupById.clear();
    state.selected.clear();
    state.stats = null;
    state.hasResults = false;
    state.notice = null;
    state.page = 0;
    state.freedBytes = 0;
    state.deletedCount = 0;
  }

  async function startScan() {
    const src = state.source;
    if (!src || state.scanning) return;
    const token = ++state.scanToken;
    state.scanning = true;
    state.cancelRequested = false;
    closeDialogs();
    resetResults();
    const opts = readScanOptions();
    setProgress('Scanning', 'Looking for files…', 'Starting', null);
    renderAll();

    const ctx = {
      check() { if (state.cancelRequested || token !== state.scanToken) throw new CancelledError(); },
      listed: throttle((n) => { if (token === state.scanToken && state.scanning) setProgress('Listing', 'Looking for files…', `Found ${plural(n, 'file')} so far`, null); }, 120),
      progress(phase, title, detail, fraction) { if (token === state.scanToken && state.scanning) setProgress(phase, title, detail, fraction); },
    };

    try {
      let listing;
      if (src.kind === 'fsa') {
        if (!(await ensurePermission(src.root, 'read'))) throw new Error('Permission to read this folder was not granted. Choose the folder again.');
        listing = await listFromHandle(src.root, opts, ctx);
      } else {
        if (src.kind === 'sample' && !src.entries) src.entries = await buildSampleEntries();
        listing = listFromEntries(src.entries, opts);
      }
      ctx.check();
      const found = await findDuplicates(listing.recs, ctx);
      ctx.check();
      buildGroups(found.buckets);
      state.stats = {
        checked: listing.recs.length, excluded: listing.excluded, skippedDirs: listing.skippedDirs,
        unreadable: listing.unreadable + found.unreadable,
      };
      state.hasResults = true;
      state.lastScanAt = new Date();
    } catch (err) {
      if (token !== state.scanToken) return;
      resetResults();
      if (err instanceof CancelledError) state.notice = { kind: 'info', text: 'Scan cancelled. Nothing was changed.' };
      else {
        console.error(err);
        state.notice = { kind: 'error', text: `The scan stopped: ${err && err.message ? err.message : err}` };
      }
    } finally {
      if (token === state.scanToken) {
        state.scanning = false;
        renderAll();
        if (state.hasResults) el.main.focus({ preventScroll: true });
      }
    }
  }

  function cancelScan() {
    if (!state.scanning) return;
    state.cancelRequested = true;
    setProgress('Cancelling', 'Stopping the scan…', 'Nothing has been changed', null);
  }

  async function pickFolder() {
    if (state.scanning) return;
    if (!canPickDirectory) {
      el.dirInput.value = '';
      el.dirInput.click();
      return;
    }
    let root;
    try {
      root = await window.showDirectoryPicker({ id: 'duplicate-cleaner', mode: 'read' });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      state.notice = { kind: 'error', text: `That folder couldn’t be opened${err && err.message ? `: ${err.message}` : '.'}` };
      renderBanner();
      return;
    }
    state.source = { kind: 'fsa', name: root.name, root, canDelete: true };
    state.lastScanAt = null;
    startScan();
  }

  function onDirInput() {
    const files = Array.from(el.dirInput.files || []);
    if (!files.length) return;
    const first = files[0].webkitRelativePath || files[0].name;
    const name = first.includes('/') ? first.split('/')[0] : 'Selected folder';
    const entries = files.map((f) => ({ file: f, path: f.webkitRelativePath || `${name}/${f.name}` }));
    state.source = { kind: 'input', name, entries, canDelete: false };
    state.lastScanAt = null;
    startScan();
  }

  function startSample() {
    if (state.scanning) return;
    state.source = { kind: 'sample', name: 'Sample folder', entries: null, canDelete: true };
    state.lastScanAt = null;
    startScan();
  }

  // ---------------------------------------------------------------------------
  // Previews and thumbnails. Every preview is decoded from that exact file, in
  // this tab. Thumbnails are small WebP copies so long lists stay light.
  // ---------------------------------------------------------------------------
  const thumbCache = new Map();    // `${id}:${size}` -> { url, w, h, dur, text, none, error }
  const thumbPending = new Map();
  const liveUrls = new Set();
  const jobQueue = [];
  let jobsRunning = 0;

  const trackUrl = (u) => { liveUrls.add(u); return u; };

  function revokeAllPreviews() {
    for (const u of liveUrls) URL.revokeObjectURL(u);
    liveUrls.clear();
    thumbCache.clear();
    thumbPending.clear();
    jobQueue.length = 0;
  }

  function schedule(fn) {
    return new Promise((resolve, reject) => {
      jobQueue.push({ fn, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (jobsRunning < THUMB_CONCURRENCY && jobQueue.length) {
      const job = jobQueue.pop(); // newest first: whatever just scrolled into view
      jobsRunning++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { jobsRunning--; pump(); });
    }
  }

  const canThumb = (f) => f.kind === 'image' || f.kind === 'video' || f.kind === 'text';
  const cachedThumb = (f, size) => thumbCache.get(`${f.id}:${size}`);

  function ensureThumb(f, size) {
    const key = `${f.id}:${size}`;
    if (thumbCache.has(key)) return Promise.resolve(thumbCache.get(key));
    if (thumbPending.has(key)) return thumbPending.get(key);
    const p = schedule(async () => {
      if (state.recs.get(f.id) !== f) return { none: true, stale: true };
      return makeThumb(f, size);
    }).catch((err) => ({ error: (err && err.message) || 'Preview failed' }))
      .then((t) => {
        thumbPending.delete(key);
        if (t.stale || state.recs.get(f.id) !== f) return t;
        thumbCache.set(key, t);
        onThumbReady(f, size, t);
        return t;
      });
    thumbPending.set(key, p);
    return p;
  }

  async function makeThumb(f, size) {
    const max = size === 'medium' ? MEDIUM_PX : THUMB_PX;
    const file = await fileOf(f);
    if (f.kind === 'image') {
      if (f.ext === 'svg') {
        const url = trackUrl(URL.createObjectURL(file.type ? file : new Blob([file], { type: 'image/svg+xml' })));
        await imageSize(url); // throws if the SVG can't be drawn
        return { url, w: 0, h: 0, svg: true }; // vector: no fixed pixel size
      }
      return rasterThumb(file, max);
    }
    if (f.kind === 'video') return videoThumb(file, max);
    if (f.kind === 'text') return textSnippet(file, size === 'medium' ? 4096 : 1400, size === 'medium' ? 40 : 14);
    return { none: true };
  }

  function imageSize(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('Image could not be read'));
      img.src = url;
    });
  }

  async function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* try without options */ }
      try { return await createImageBitmap(file); } catch { /* try an <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error('This browser can’t display this image format');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      try { canvas.toBlob(resolve, type, quality); } catch { resolve(null); }
    });
  }

  async function rasterThumb(file, max) {
    const src = await decodeImage(file);
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) throw new Error('Empty image');
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    if (typeof src.close === 'function') src.close();
    const blob = (await canvasBlob(canvas, 'image/webp', 0.86)) || (await canvasBlob(canvas, 'image/png'));
    if (!blob) throw new Error('Preview could not be drawn');
    return { url: trackUrl(URL.createObjectURL(blob)), w, h };
  }

  function videoThumb(file, max) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      let settled = false;
      const finish = (val, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeAttribute('src');
        try { v.load(); } catch { /* ignore */ }
        URL.revokeObjectURL(url);
        if (err) reject(err); else resolve(val);
      };
      const timer = setTimeout(() => finish(null, new Error('Video preview timed out')), 12000);
      v.addEventListener('error', () => finish(null, new Error('This browser can’t play this video format')), { once: true });
      v.addEventListener('loadedmetadata', () => {
        const d = v.duration;
        const t = Number.isFinite(d) && d > 0 ? Math.min(d * 0.1, 2) : 0;
        if (!v.videoWidth) { finish({ none: true, dur: Number.isFinite(d) ? d : 0 }); return; }
        try { v.currentTime = t > 0 ? t : 0.001; } catch { finish(null, new Error('Video frame unavailable')); }
      }, { once: true });
      v.addEventListener('seeked', async () => {
        try {
          const w = v.videoWidth;
          const h = v.videoHeight;
          const scale = Math.min(1, max / Math.max(w, h));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
          const blob = await canvasBlob(canvas, 'image/jpeg', 0.84);
          if (!blob) throw new Error('Video frame unavailable');
          finish({ url: trackUrl(URL.createObjectURL(blob)), w, h, dur: v.duration, video: true });
        } catch (err) {
          finish(null, err);
        }
      }, { once: true });
      v.src = url;
    });
  }

  function looksBinary(u8) {
    const n = Math.min(u8.length, 4096);
    let zeros = 0;
    for (let i = 0; i < n; i++) if (u8[i] === 0) zeros++;
    return zeros > 0;
  }

  async function readText(file, maxBytes) {
    const u8 = new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
    if (looksBinary(u8)) return { binary: true, text: '' };
    let text = new TextDecoder('utf-8').decode(u8);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text: text.replace(/\r\n?/g, '\n'), truncated: file.size > maxBytes };
  }

  async function textSnippet(file, bytes, lines) {
    const t = await readText(file, bytes);
    if (t.binary) return { none: true };
    return { text: t.text.split('\n').slice(0, lines).map((l) => l.slice(0, 140)).join('\n') || ' ' };
  }

  // Markup for a preview slot. Pending slots carry data-slot so they can be
  // lazily filled when they scroll into view.
  function placeholderHTML(f, note) {
    return `<span class="ph"><span class="ph-icon">${KIND_ICON[f.kind] || KIND_ICON.other}</span><span>${esc(extLabel(f))}</span>${note ? `<span class="ph-sub">${esc(note)}</span>` : ''}</span>`;
  }

  function slotContentHTML(f, t, size) {
    if (t && t.url) {
      return `<img src="${t.url}" alt="" draggable="false" decoding="async">${t.video ? `<span class="badge-play">${ICON.play}</span>` : ''}`;
    }
    if (t && typeof t.text === 'string') return `<span class="txt-thumb">${esc(t.text)}</span>`;
    return placeholderHTML(f, t && t.error && size !== 'thumb' ? 'No preview' : '');
  }

  function slotHTML(f, size = 'thumb') {
    const t = cachedThumb(f, size);
    if (t) return slotContentHTML(f, t, size);
    if (!canThumb(f)) return placeholderHTML(f);
    return `<span class="ph is-loading" data-slot="${f.id}" data-size="${size}"><span class="ph-icon">${KIND_ICON[f.kind] || KIND_ICON.other}</span><span>${esc(extLabel(f))}</span></span>`;
  }

  const slotObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        slotObserver.unobserve(entry.target);
        const f = state.recs.get(entry.target.dataset.slot);
        if (f) ensureThumb(f, entry.target.dataset.size || 'thumb');
      }
    }, { rootMargin: '600px 0px' })
    : null;

  function observeSlots(root) {
    for (const node of $$('.ph.is-loading[data-slot]', root)) {
      if (slotObserver) slotObserver.observe(node);
      else { const f = state.recs.get(node.dataset.slot); if (f) ensureThumb(f, node.dataset.size || 'thumb'); }
    }
  }

  function onThumbReady(f, size, t) {
    if (t.w && !f.w) { f.w = t.w; f.h = t.h; }
    if (t.dur && !f.dur) f.dur = t.dur;
    for (const node of $$(`[data-slot="${f.id}"][data-size="${size}"]`)) {
      const holder = node.parentElement;
      node.outerHTML = slotContentHTML(f, t, size);
      if (holder && t.url) holder.classList.add('has-img');
    }
    for (const node of $$(`[data-dims-for="${f.id}"]`)) node.innerHTML = dimsText(f);
    if (f.w || t.error) updateFacts(f);
    if (state.selected.has(f.id)) renderActionThumbs();
  }

  function dimsText(f) {
    const bits = [];
    if (f.w && f.h) bits.push(`${nf.format(f.w)} × ${nf.format(f.h)}`);
    if (f.dur) bits.push(fmtDuration(f.dur));
    return bits.map((b) => ` · ${b}`).join('');
  }

  // ---------------------------------------------------------------------------
  // Rendering: page
  // ---------------------------------------------------------------------------
  function setProgress(phase, title, detail, fraction) {
    el.progressPhase.textContent = phase;
    el.progressTitle.textContent = title;
    el.progressDetail.textContent = detail || '';
    if (fraction == null) {
      el.progressBar.classList.add('is-indeterminate');
      el.progressBar.removeAttribute('aria-valuenow');
      el.progressFill.style.width = '';
    } else {
      const pct = Math.round(clamp(fraction, 0, 1) * 100);
      el.progressBar.classList.remove('is-indeterminate');
      el.progressFill.style.width = `${pct}%`;
      el.progressBar.setAttribute('aria-valuenow', String(pct));
    }
  }

  function renderAll() {
    renderSidebar();
    renderStats();
    renderBanner();
    const scanning = state.scanning;
    el.progressCard.hidden = !scanning;
    el.introCard.hidden = scanning || state.hasResults;
    el.reviewCard.hidden = scanning || !state.hasResults;
    renderGroups();
    updateSelectionUI();
  }

  function renderSidebar() {
    const src = state.source;
    const busy = state.scanning;
    if (!src) {
      el.folderName.textContent = 'No folder yet';
      el.folderMeta.textContent = 'Pick a folder to find identical files. Nothing is uploaded.';
      el.pickLabel.textContent = 'Choose folder';
      el.scanBtn.textContent = 'Scan folder';
      el.scanBtn.disabled = true;
    } else {
      el.folderName.textContent = src.name;
      const where = src.kind === 'sample' ? 'Sample files made in this tab.' : 'Nothing is uploaded.';
      el.folderMeta.textContent = busy ? 'Scanning now…' : state.lastScanAt ? `Last scanned ${timeFmt.format(state.lastScanAt)}. ${where}` : `Ready to scan. ${where}`;
      el.pickLabel.textContent = src.kind === 'sample' ? 'Choose a real folder' : 'Change folder';
      el.scanBtn.textContent = state.lastScanAt ? (src.kind === 'sample' ? 'Scan sample again' : 'Scan folder again') : 'Scan folder';
      el.scanBtn.disabled = busy;
    }
    el.pickBtn.disabled = busy;
    el.sampleBtn.disabled = busy;
    el.sampleBtn.hidden = !!(src && src.kind === 'sample');

    let note = '';
    if (src && src.kind === 'input') note = 'Read-only mode. This browser can preview and report, but it can’t delete files. Open this page in Chrome or Edge to delete.';
    else if (!src && !canPickDirectory) note = 'This browser can preview copies and save a report, but it can’t delete files. Use Chrome or Edge to delete.';
    else if (src && src.kind === 'sample') note = 'Sample mode. Deleting here is a simulation; nothing on your computer is touched.';
    el.modeNote.textContent = note;
    el.modeNote.hidden = !note;
  }

  function renderStats() {
    if (!state.hasResults) {
      el.statFiles.textContent = '-';
      el.statGroups.textContent = '-';
      el.statSpace.textContent = '-';
      return;
    }
    el.statFiles.textContent = nf.format(state.stats.checked);
    el.statGroups.textContent = nf.format(state.groups.length);
    el.statSpace.textContent = fmtBytes(state.groups.reduce((s, g) => s + (g.stale ? 0 : extraBytes(g)), 0));
  }

  function renderBanner() {
    const parts = [];
    let kind = 'success';
    if (state.notice) {
      parts.push(state.notice.text);
      kind = state.notice.kind;
    }
    if (state.hasResults && !state.scanning) {
      const s = state.stats;
      if (!state.notice) {
        let line = `Scan complete. ${plural(s.checked, 'file')} checked · ${plural(s.excluded, 'file')} excluded · ${plural(s.skippedDirs, 'folder')} skipped by your options.`;
        if (s.unreadable) line += ` ${plural(s.unreadable, 'item')} couldn’t be read.`;
        parts.push(line);
      }
      const n = state.selected.size;
      if (state.groups.length) parts.push(n ? `${plural(n, 'file')} selected for deletion.` : 'Nothing is selected for deletion.');
    }
    el.banner.textContent = parts.join(' ');
    el.banner.className = `banner${kind === 'success' ? '' : ` is-${kind}`}`;
    el.banner.hidden = !parts.length || state.scanning;
  }

  // ---------------------------------------------------------------------------
  // Rendering: groups
  // ---------------------------------------------------------------------------
  function visibleGroups() {
    const q = state.query.trim().toLowerCase();
    let list = state.groups;
    if (q) list = list.filter((g) => g.files.some((f) => f.path.toLowerCase().includes(q)));
    const sorters = {
      space: (a, b) => extraBytes(b) - extraBytes(a) || b.files.length - a.files.length || collator.compare(a.title, b.title),
      copies: (a, b) => b.files.length - a.files.length || extraBytes(b) - extraBytes(a) || collator.compare(a.title, b.title),
      size: (a, b) => b.size - a.size || b.files.length - a.files.length || collator.compare(a.title, b.title),
      name: (a, b) => collator.compare(a.title, b.title) || extraBytes(b) - extraBytes(a),
      folder: (a, b) => collator.compare(keepOf(a).dir, keepOf(b).dir) || collator.compare(a.title, b.title),
    };
    return list.slice().sort(sorters[prefs.sort] || sorters.space);
  }

  function metaHTML(f) {
    return `${fmtBytes(f.size)}<span data-dims-for="${f.id}">${dimsText(f)}</span> · Modified ${esc(fmtDate(f.lastModified))}`;
  }

  function thumbButtonHTML(f, origin = '') {
    const t = cachedThumb(f, 'thumb');
    return `<button type="button" class="thumb${t && t.url ? ' has-img' : ''}" data-action="preview" data-file-id="${f.id}"${origin ? ` data-origin="${origin}"` : ''} aria-label="Preview ${esc(f.name)}" title="Preview and compare">${slotHTML(f, 'thumb')}<span class="zoom" aria-hidden="true">${ICON.zoom}</span></button>`;
  }

  function rowHTML(f, g) {
    const keep = g.keepId === f.id;
    const sel = state.selected.has(f.id);
    const check = keep
      ? `<span class="keep-tick" title="Protected copy">${ICON.check}</span>`
      : `<input type="checkbox" id="chk-${f.id}" data-action="toggle" data-file-id="${f.id}"${sel ? ' checked' : ''}${g.stale ? ' disabled' : ''} aria-label="Delete ${esc(f.path)}">`;
    const infoTag = keep ? 'div' : 'label';
    return `<div class="row${keep ? ' is-keep' : ''}${sel ? ' is-selected' : ''}" data-file-id="${f.id}">
      <div class="row-check">${check}</div>
      ${thumbButtonHTML(f)}
      <${infoTag} class="row-info"${keep ? '' : ` for="chk-${f.id}"`}>
        <span class="fname">${esc(f.name)}<span class="tag-del">Delete</span></span>
        <span class="fpath">${esc(f.path)}</span>
        <span class="fmeta">${metaHTML(f)}</span>
      </${infoTag}>
      <div class="row-actions">${keep
        ? `<span class="keep-label">${ICON.check} Keep</span>`
        : `<button type="button" class="btn btn-outline btn-sm" data-action="keep" data-file-id="${f.id}">Keep this</button>`}</div>
    </div>`;
  }

  function cardHTML(f, g) {
    const keep = g.keepId === f.id;
    const sel = state.selected.has(f.id);
    const flag = keep
      ? `<span class="fcard-flag keep">${ICON.check} Keep</span>`
      : `<label class="fcard-flag"><input type="checkbox" id="chk-${f.id}" data-action="toggle" data-file-id="${f.id}"${sel ? ' checked' : ''}${g.stale ? ' disabled' : ''} aria-label="Delete ${esc(f.path)}"> Delete</label>`;
    return `<article class="fcard${keep ? ' is-keep' : ''}${sel ? ' is-selected' : ''}" data-file-id="${f.id}">
      ${flag}
      ${thumbButtonHTML(f)}
      <div class="fcard-body">
        <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="fpath" title="${esc(f.path)}">${esc(f.path)}</span>
        <span class="fmeta">${fmtBytes(f.size)}<span data-dims-for="${f.id}">${dimsText(f)}</span></span>
        <span class="fmeta">Modified ${esc(fmtDate(f.lastModified))}</span>
      </div>
      <div class="fcard-foot">${keep
        ? '<span class="keep-label">Kept copy</span>'
        : `<button type="button" class="btn btn-outline btn-sm" data-action="keep" data-file-id="${f.id}">Keep this</button>`}</div>
    </article>`;
  }

  function groupSubHTML(g) {
    const n = g.files.length;
    const sel = g.files.filter((f) => state.selected.has(f.id)).length;
    return `${n} copies · ${fmtBytes(g.size)} each · ${fmtBytes(extraBytes(g))} extra${sel ? ` · <span class="sel">${sel} selected</span>` : ''}`;
  }

  function groupHTML(g) {
    const body = prefs.view === 'gallery'
      ? `<div class="cards">${g.files.map((f) => cardHTML(f, g)).join('')}</div>`
      : g.files.map((f) => rowHTML(f, g)).join('');
    return `<section class="group" data-group-id="${g.id}" aria-label="${esc(g.title)}">
      <div class="group-head">
        <div class="group-info">
          <div class="group-title">${esc(g.title)}</div>
          <div class="group-sub">${groupSubHTML(g)}</div>
        </div>
        <div class="group-tools">
          ${g.stale
            ? '<span class="badge badge-warn" title="A copy in this group changed after the scan. Scan again before deleting from it.">Changed since scan</span>'
            : `<span class="badge" title="Every copy has the same bytes. Fingerprint ${esc(g.hash.slice(0, 16))}…">Content matched</span>`}
          <button type="button" class="btn btn-outline btn-sm" data-action="compare" data-group-id="${g.id}">${ICON.compare} Compare</button>
        </div>
      </div>
      ${body}
    </section>`;
  }

  function doneHTML() {
    const freed = state.freedBytes;
    if (state.deletedCount) {
      return `<div class="done-card"><div class="done-icon">${ICON.check}</div><h3>All clear</h3><p>No duplicate groups are left. You deleted ${plural(state.deletedCount, 'file')} and freed ${fmtBytes(freed)}.</p></div>`;
    }
    const s = state.stats;
    return `<div class="done-card"><div class="done-icon">${ICON.check}</div><h3>No duplicates found</h3><p>${plural(s.checked, 'file')} checked and every one is unique. Try including subfolders or changing the scan options if you expected copies.</p></div>`;
  }

  function renderGroups() {
    if (!state.hasResults) {
      el.groups.innerHTML = '';
      el.pager.innerHTML = '';
      return;
    }
    const empty = !state.groups.length;
    el.reviewCard.classList.toggle('is-empty', empty);
    el.groupsTitle.textContent = empty ? 'Nothing to review' : `${plural(state.groups.length, 'group')} to review`;
    if (empty) {
      el.groups.innerHTML = doneHTML();
      el.pager.innerHTML = '';
      return;
    }
    const list = visibleGroups();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = clamp(state.page, 0, pages - 1);
    const slice = list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    el.groups.innerHTML = slice.length
      ? slice.map(groupHTML).join('')
      : `<div class="no-match">No groups match “${esc(state.query)}”. <button type="button" class="btn btn-ghost btn-sm" data-action="clear-search">Clear search</button></div>`;
    el.pager.innerHTML = list.length > PAGE_SIZE
      ? `<span>Showing groups ${nf.format(state.page * PAGE_SIZE + 1)}–${nf.format(Math.min(list.length, (state.page + 1) * PAGE_SIZE))} of ${nf.format(list.length)}</span>
         <div class="pager-btns">
           <button type="button" class="btn btn-outline btn-sm" data-action="page" data-dir="-1"${state.page === 0 ? ' disabled' : ''}>${ICON.left} Previous</button>
           <span class="pager-num">Page ${state.page + 1} of ${pages}</span>
           <button type="button" class="btn btn-outline btn-sm" data-action="page" data-dir="1"${state.page >= pages - 1 ? ' disabled' : ''}>Next ${ICON.right}</button>
         </div>`
      : (state.query ? `<span>${plural(list.length, 'group')} match your search</span>` : '');
    observeSlots(el.groups);
  }

  // Re-render one group in place (keeps scroll position and focus).
  function refreshGroup(g) {
    const node = el.groups.querySelector(`.group[data-group-id="${g.id}"]`);
    if (node) {
      node.outerHTML = groupHTML(g);
      observeSlots(el.groups);
    }
  }

  function focusKey(node) {
    if (!node || node === document.body || node === document.documentElement) return null;
    const scope = node.closest('dialog');
    if (node.id) return { scope, sel: `#${CSS.escape(node.id)}` };
    const d = node.dataset || {};
    if (d.action) {
      let sel = `[data-action="${CSS.escape(d.action)}"]`;
      for (const [k, attr] of [['fileId', 'file-id'], ['groupId', 'group-id'], ['mode', 'mode'], ['dir', 'dir'], ['index', 'index'], ['view', 'view']]) {
        if (d[k] != null) sel += `[data-${attr}="${CSS.escape(d[k])}"]`;
      }
      return { scope, sel };
    }
    return scope ? { scope, sel: null } : null;
  }
  // Put focus back on the same control after a re-render. Inside a dialog, fall
  // back to the dialog itself so keyboard shortcuts and Tab keep working.
  function restoreFocus(key) {
    if (!key) return false;
    const root = key.scope || document;
    const node = key.sel ? root.querySelector(key.sel) : null;
    if (node && !node.disabled && node.getClientRects().length) {
      if (node !== document.activeElement) node.focus({ preventScroll: true });
      return true;
    }
    if (key.scope && key.scope.open) {
      const box = key.scope.querySelector('.dlg');
      if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  function selectionTotals() {
    let n = 0;
    let bytes = 0;
    for (const id of state.selected) {
      const f = state.recs.get(id);
      if (f) { n++; bytes += f.size; }
    }
    return { n, bytes };
  }

  function updateSelectionUI() {
    const show = state.hasResults && !state.scanning && state.groups.length > 0;
    el.actionBar.hidden = !show;
    const { n, bytes } = selectionTotals();
    el.selCount.textContent = n ? `${plural(n, 'file')} selected` : '0 files selected';
    el.selSize.textContent = fmtBytes(bytes);
    el.reviewBtn.disabled = n === 0;
    const src = state.source;
    el.actionNote.textContent = src && src.kind === 'sample'
      ? 'Sample mode · Nothing on your computer is touched'
      : src && !src.canDelete ? 'Read-only mode · Review and save a report' : 'Permanent deletion · No Recycle Bin';
    renderBanner();
    renderStats();
    renderActionThumbs();
  }

  function renderActionThumbs() {
    const ids = Array.from(state.selected).slice(0, 4);
    const more = state.selected.size - ids.length;
    el.actionThumbs.innerHTML = ids.map((id) => {
      const f = state.recs.get(id);
      if (!f) return '';
      const t = cachedThumb(f, 'thumb');
      if (!t && canThumb(f)) ensureThumb(f, 'thumb');
      return `<span class="mini">${t && t.url ? `<img src="${t.url}" alt="">` : esc(extLabel(f))}</span>`;
    }).join('') + (more > 0 ? `<span class="mini more">+${more > 99 ? '99' : more}</span>` : '');
  }

  function afterSelectionChange(g) {
    const fk = focusKey(document.activeElement);
    if (g) refreshGroup(g); else renderGroups();
    updateSelectionUI();
    if (cmp.open) refreshCompare();
    if (rev.open && rev.phase === 'confirm') { rev.confirmed = false; renderReview(); }
    restoreFocus(fk);
  }

  function setSelected(id, on) {
    const f = state.recs.get(id);
    if (!f) return;
    const g = state.groupById.get(f.groupId);
    if (!g) return;
    if (on && g.keepId === id) return; // the kept copy can never be selected
    if (on && g.stale) {
      toast('This group changed after the scan. Scan again before deleting from it.');
      afterSelectionChange(g);
      return;
    }
    if (on) state.selected.add(id); else state.selected.delete(id);
    afterSelectionChange(g);
  }

  function setKeep(id) {
    const f = state.recs.get(id);
    if (!f) return;
    const g = state.groupById.get(f.groupId);
    if (!g || g.keepId === id) return;
    g.keepId = id;
    state.selected.delete(id);
    const inDialog = document.activeElement && document.activeElement.closest('dialog');
    afterSelectionChange(g);
    if (!inDialog) {
      const thumb = el.groups.querySelector(`[data-action="preview"][data-file-id="${id}"]`);
      if (thumb) thumb.focus({ preventScroll: true });
    }
  }

  function applyRuleToAll() {
    prefs.protectRule = el.protectRule.value;
    savePrefs();
    let changed = 0;
    for (const g of state.groups) {
      const k = pickKeep(g.files, prefs.protectRule);
      if (k.id !== g.keepId) { g.keepId = k.id; changed++; }
      state.selected.delete(k.id);
    }
    afterSelectionChange(null);
    toast(changed ? `Now keeping a different copy in ${plural(changed, 'group')}.` : 'Every group already keeps the copy this rule picks.');
  }

  function selectMatchingExtras() {
    const list = visibleGroups();
    let added = 0;
    let stale = 0;
    for (const g of list) {
      if (g.stale) { stale++; continue; } // changed since the scan: needs a fresh scan first
      for (const f of g.files) {
        if (f.id !== g.keepId && !state.selected.has(f.id)) { state.selected.add(f.id); added++; }
      }
    }
    afterSelectionChange(null);
    const skipped = stale ? ` Skipped ${plural(stale, 'group')} that changed after the scan.` : '';
    if (added) toast(`Selected ${plural(added, 'extra copy', 'extra copies')} in ${plural(list.length - stale, 'group')}. Kept copies stay protected.${skipped}`);
    else if (stale === list.length) toast('These groups changed after the scan. Scan again before selecting copies.');
    else toast(`Every extra copy in these groups is already selected.${skipped}`);
  }

  function clearSelection() {
    const had = state.selected.size;
    state.selected.clear();
    afterSelectionChange(null);
    toast(had ? 'Selection cleared. Nothing will be deleted.' : 'Nothing was selected.');
  }

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }

  // ---------------------------------------------------------------------------
  // Compare dialog: "Side by side" grid, or "One at a time" with a filmstrip
  // ---------------------------------------------------------------------------
  const cmp = { open: false, groupId: null, index: 0, mode: 'grid', origin: 'list', zoomed: false, stageUrl: null, stageToken: 0, returnFocus: null, returnKey: null };

  function syncScrollLock() {
    document.documentElement.classList.toggle('modal-open', cmp.open || rev.open);
  }

  function openPreview(fileId, origin) {
    const f = state.recs.get(fileId);
    if (f) openCompare(f.groupId, fileId, 'single', origin);
  }

  function openCompare(groupId, fileId, mode, origin) {
    const g = state.groupById.get(groupId);
    if (!g) return;
    cmp.groupId = groupId;
    cmp.mode = mode || 'grid';
    cmp.origin = origin || 'list';
    cmp.zoomed = false;
    cmp.index = fileId ? Math.max(0, g.files.findIndex((f) => f.id === fileId)) : 0;
    if (!cmp.open) {
      cmp.returnFocus = document.activeElement;
      cmp.returnKey = focusKey(document.activeElement);
      el.compareDialog.showModal();
      cmp.open = true;
      syncScrollLock();
    }
    renderCompare();
  }

  function closeCompareCleanup() {
    revokeStage();
    cmp.open = false;
    el.compareDialog.innerHTML = '';
    syncScrollLock();
    const back = cmp.returnFocus;
    const backKey = cmp.returnKey;
    cmp.returnFocus = null;
    cmp.returnKey = null;
    if (rev.open && rev.phase === 'confirm') renderReview();
    if (back && back.isConnected && !back.disabled) back.focus({ preventScroll: true });
    else if (backKey && restoreFocus(backKey)) { /* focus restored to the re-rendered control */ }
    else if (rev.open) restoreFocus({ scope: el.reviewDialog, sel: null });
    else {
      const f = state.recs.get(state.lastPreviewId || '');
      const node = f && el.groups.querySelector(`[data-action="preview"][data-file-id="${f.id}"]`);
      if (node) node.focus({ preventScroll: true });
    }
  }

  function revokeStage() {
    cmp.stageToken++;
    if (cmp.stageUrl) { URL.revokeObjectURL(cmp.stageUrl); cmp.stageUrl = null; }
  }

  function statusHTML(g, f) {
    if (g.keepId === f.id) return `<span class="status keep">${ICON.check} Keep</span>`;
    if (state.selected.has(f.id)) return '<span class="status del">Delete</span>';
    return '<span class="status none">Not selected</span>';
  }

  function deleteToggleHTML(f, label, prefix) {
    const sel = state.selected.has(f.id);
    const g = state.groupById.get(f.groupId);
    const off = g && g.stale;
    return `<label class="del-toggle${sel ? ' on' : ''}${off ? ' is-disabled' : ''}"${off ? ' title="Changed since the scan. Scan again first."' : ''}><input type="checkbox" id="${prefix}-${f.id}" data-action="toggle" data-file-id="${f.id}"${sel ? ' checked' : ''}${off ? ' disabled' : ''}> ${label}</label>`;
  }

  function compareSummaryHTML(g) {
    const del = g.files.filter((f) => state.selected.has(f.id)).length;
    const none = g.files.length - 1 - del;
    return `<span class="keep">1 kept</span> · <span class="del">${del} to delete</span>${none ? ` · ${none} not selected` : ''}`;
  }

  function renderCompare() {
    const g = state.groupById.get(cmp.groupId);
    if (!g) { el.compareDialog.close(); return; }
    revokeStage();
    cmp.index = clamp(cmp.index, 0, g.files.length - 1);
    const list = visibleGroups();
    const gi = list.indexOf(g);
    const showGroupNav = cmp.origin !== 'review' && gi >= 0 && list.length > 1;
    state.lastPreviewId = g.files[cmp.index].id;
    const fk = focusKey(document.activeElement);
    el.compareDialog.classList.toggle('is-grid', cmp.mode === 'grid');
    el.compareDialog.innerHTML = `<div class="dlg" tabindex="-1">
      <header class="dlg-head">
        <div class="dlg-titles">
          <div class="eyebrow">Compare copies${gi >= 0 && cmp.origin !== 'review' ? ` · Group ${gi + 1} of ${list.length}` : ''}</div>
          <h2 id="cmpTitle">${esc(g.title)}</h2>
          <p>${g.files.length} copies · identical content · ${fmtBytes(g.size)} each <span class="fp">· fingerprint <span class="mono" title="SHA-256 of the contents (files over 8 MB are hashed in 8 MB pieces)">${esc(g.hash.slice(0, 12))}…</span></span></p>
        </div>
        <div class="dlg-tools">
          <div class="seg" role="group" aria-label="Compare layout">
            <button type="button" data-action="cmp-mode" data-mode="grid" aria-pressed="${cmp.mode === 'grid'}">${ICON.compare}<span>Side by side</span></button>
            <button type="button" data-action="cmp-mode" data-mode="single" aria-pressed="${cmp.mode === 'single'}">${ICON.expand}<span>One at a time</span></button>
          </div>
          <button type="button" class="icon-btn" data-action="cmp-close" aria-label="Close preview">${ICON.close}</button>
        </div>
      </header>
      <div class="dlg-body" id="cmpBody">${cmp.mode === 'grid' ? compareGridHTML(g) : compareSingleHTML(g)}</div>
      <footer class="dlg-foot">
        ${showGroupNav ? `<div class="pager-btns">
          <button type="button" class="btn btn-outline btn-sm" data-action="cmp-group" data-dir="-1"${gi <= 0 ? ' disabled' : ''}>${ICON.left} Previous group</button>
          <button type="button" class="btn btn-outline btn-sm" data-action="cmp-group" data-dir="1"${gi >= list.length - 1 ? ' disabled' : ''}>Next group ${ICON.right}</button>
        </div>` : ''}
        <div class="cmp-summary" id="cmpSummary">${compareSummaryHTML(g)}</div>
        <div class="spacer"></div>
        <div class="kbd-hint">${cmp.mode === 'single' ? '<kbd>←</kbd> <kbd>→</kbd> copies · <kbd>K</kbd> keep · <kbd>D</kbd> delete · ' : ''}${showGroupNav ? '<kbd>[</kbd> <kbd>]</kbd> groups · ' : ''}<kbd>Esc</kbd> close</div>
        <button type="button" class="btn btn-dark btn-sm" data-action="cmp-close">Done</button>
      </footer>
    </div>`;
    observeSlots(el.compareDialog);
    restoreFocus(fk && fk.scope === el.compareDialog ? fk : { scope: el.compareDialog, sel: null });
    if (cmp.mode === 'single') loadStage(g, g.files[cmp.index]);
  }

  function compareGridHTML(g) {
    return `<div class="cmp-grid${g.files.length === 2 ? ' n2' : ''}">${g.files.map((f, i) => {
      const keep = g.keepId === f.id;
      const sel = state.selected.has(f.id);
      return `<article class="panel${keep ? ' is-keep' : ''}${sel ? ' is-selected' : ''}" data-file-id="${f.id}">
        <button type="button" class="panel-media" data-action="cmp-open" data-index="${i}" aria-label="View ${esc(f.name)} large">${slotHTML(f, 'medium')}</button>
        <div class="panel-body">
          ${statusHTML(g, f)}
          <span class="fname">${esc(f.name)}</span>
          <span class="fpath">${esc(f.path)}</span>
          <span class="fmeta">${metaHTML(f)}</span>
          <div class="panel-actions">${keep
            ? '<span class="keep-label">Kept copy</span>'
            : `${deleteToggleHTML(f, 'Delete', 'cmpg')}<button type="button" class="btn btn-outline btn-sm" data-action="keep" data-file-id="${f.id}">Keep this</button>`}</div>
        </div>
      </article>`;
    }).join('')}</div>`;
  }

  function filmHTML(g) {
    return g.files.map((f, i) => {
      const keep = g.keepId === f.id;
      const sel = state.selected.has(f.id);
      const cur = i === cmp.index;
      const t = cachedThumb(f, 'thumb');
      return `<button type="button" class="film${keep ? ' is-keep' : ''}${sel ? ' is-selected' : ''}${cur ? ' is-current' : ''}" data-action="cmp-goto" data-index="${i}" aria-label="Copy ${i + 1}: ${esc(f.path)}"${cur ? ' aria-current="true"' : ''}>
        <span class="thumb${t && t.url ? ' has-img' : ''}">${slotHTML(f, 'thumb')}</span>
        <span class="film-label">${keep ? 'Keep' : sel ? 'Delete' : `Copy ${i + 1}`}</span>
      </button>`;
    }).join('');
  }

  function singleInfoHTML(g, f) {
    const keep = g.keepId === f.id;
    const visual = (f.kind === 'image' && f.ext !== 'svg') || f.kind === 'video';
    return `${statusHTML(g, f)}
      <div>
        <span class="fname">${esc(f.name)}</span>
        <span class="fpath">${esc(f.path)}</span>
      </div>
      <dl class="facts">
        <dt>Size</dt><dd>${fmtBytes(f.size)} <span class="muted">(${nf.format(f.size)} bytes)</span></dd>
        ${visual ? `<dt>${f.kind === 'video' ? 'Resolution' : 'Dimensions'}</dt><dd data-fact-dims="${f.id}">${f.w ? `${nf.format(f.w)} × ${nf.format(f.h)}` : 'Reading…'}</dd>` : ''}
        ${f.kind === 'video' || f.kind === 'audio' ? `<dt>Length</dt><dd data-fact-dur="${f.id}">${f.dur ? fmtDuration(f.dur) : '-'}</dd>` : ''}
        <dt>Modified</dt><dd>${esc(fmtDateTime(f.lastModified))}</dd>
        <dt>Type</dt><dd>${esc(typeLabel(f))}</dd>
      </dl>
      <div class="info-actions">${keep
        ? `<span class="keep-label">${ICON.check} This copy is kept</span>`
        : `${deleteToggleHTML(f, 'Delete this copy', 'cmps')}<button type="button" class="btn btn-outline" data-action="keep" data-file-id="${f.id}">Keep this copy instead</button>`}</div>
      <p class="info-note">All ${g.files.length} copies have the same content, byte for byte. Keeping any one of them keeps the file.</p>`;
  }

  function compareSingleHTML(g) {
    const f = g.files[cmp.index];
    const many = g.files.length > 1;
    return `<div class="single">
      <div class="stage-col">
        <div class="stage${cmp.zoomed ? ' zoomed' : ''}${f.kind === 'video' ? ' dark' : ''}${f.kind === 'pdf' || f.kind === 'text' ? ' doc' : ''}" id="cmpStage">
          <div class="stage-chip"><span class="chip">Copy ${cmp.index + 1} of ${g.files.length}</span></div>
          <div class="stage-slot" id="cmpStageSlot"><span class="ph is-loading stage-loading"><span class="ph-icon">${KIND_ICON[f.kind] || KIND_ICON.other}</span><span>Loading preview…</span></span></div>
          ${f.kind === 'image' && f.ext !== 'svg' ? `<button type="button" class="btn btn-outline btn-sm stage-zoom" data-action="cmp-zoom">${cmp.zoomed ? `${ICON.fit} Fit to screen` : `${ICON.expand} Actual size`}</button>` : ''}
          <button type="button" class="stage-nav prev" data-action="cmp-step" data-dir="-1"${many ? '' : ' disabled'} aria-label="Previous copy">${ICON.left}</button>
          <button type="button" class="stage-nav next" data-action="cmp-step" data-dir="1"${many ? '' : ' disabled'} aria-label="Next copy">${ICON.right}</button>
        </div>
        <div class="filmstrip" id="cmpFilm">${filmHTML(g)}</div>
      </div>
      <aside class="single-info" id="cmpInfo">${singleInfoHTML(g, f)}</aside>
    </div>`;
  }

  function stageMessageHTML(f, title, body) {
    return `<div class="stage-empty">${placeholderHTML(f)}<strong>${esc(title)}</strong><span>${esc(body)}</span></div>`;
  }

  async function loadStage(g, f) {
    const token = cmp.stageToken;
    const slotEl = () => (token === cmp.stageToken ? $('#cmpStageSlot', el.compareDialog) : null);
    let html;
    try {
      if (f.kind === 'other') {
        html = stageMessageHTML(f, `No preview for .${f.ext || 'unknown'} files`, 'The copies in this group are byte-for-byte identical, so any one of them is the same file.');
      } else {
        const file = await fileOf(f);
        if (!slotEl()) return;
        if (f.kind === 'text') {
          const t = await readText(file, TEXT_PREVIEW_BYTES);
          html = t.binary
            ? stageMessageHTML(f, 'This file isn’t plain text', 'It can’t be shown here, but every copy has identical content.')
            : `<pre class="stage-text">${esc(t.text)}${t.truncated ? '\n\n… Showing the first 96 KB.' : ''}</pre>`;
        } else {
          const url = URL.createObjectURL(file);
          if (!slotEl()) { URL.revokeObjectURL(url); return; }
          cmp.stageUrl = url;
          if (f.kind === 'image' && f.ext === 'svg') html = `<img class="stage-media is-vector" id="cmpStageImg" src="${url}" alt="${esc(f.name)}" draggable="false">`;
          else if (f.kind === 'image') html = `<img class="stage-media" id="cmpStageImg" src="${url}" alt="${esc(f.name)}" data-action="cmp-zoom" draggable="false">`;
          else if (f.kind === 'video') html = `<video class="stage-media" id="cmpStageVideo" src="${url}" controls preload="metadata" playsinline></video>`;
          else if (f.kind === 'audio') html = `<div class="stage-empty">${placeholderHTML(f)}<strong>${esc(f.name)}</strong><audio id="cmpStageAudio" src="${url}" controls preload="metadata"></audio></div>`;
          else html = `<iframe class="stage-pdf" src="${url}" title="PDF preview of ${esc(f.name)}"></iframe>`;
        }
      }
    } catch (err) {
      html = stageMessageHTML(f, 'This copy can’t be opened right now', `${(err && err.message) || 'It may have been moved, renamed or deleted since the scan.'} Scan again to refresh.`);
    }
    const slot = slotEl();
    if (!slot) return;
    slot.innerHTML = html;
    const img = $('#cmpStageImg', slot);
    if (img) {
      img.addEventListener('load', () => {
        if (!f.w && img.naturalWidth) { f.w = img.naturalWidth; f.h = img.naturalHeight; updateFacts(f); }
      }, { once: true });
      img.addEventListener('error', () => {
        slot.innerHTML = stageMessageHTML(f, 'This image can’t be shown here', `It may be damaged, or saved in a format this browser can’t open. Every copy is still byte-for-byte identical, so the choice of which one to keep doesn’t change the file.`);
        updateFacts(f);
        const zb = $('.stage-zoom', el.compareDialog);
        if (zb) zb.hidden = true;
      }, { once: true });
    }
    const media = $('#cmpStageVideo', slot) || $('#cmpStageAudio', slot);
    if (media) {
      media.addEventListener('loadedmetadata', () => {
        if (!f.dur && Number.isFinite(media.duration)) f.dur = media.duration;
        if (!f.w && media.videoWidth) { f.w = media.videoWidth; f.h = media.videoHeight; }
        updateFacts(f);
      }, { once: true });
      media.addEventListener('error', () => {
        slot.innerHTML = stageMessageHTML(f, 'This browser can’t play this file', 'Every copy has identical content. Open it in a media player to check it.');
      }, { once: true });
    }
  }

  function updateFacts(f) {
    for (const n of $$(`[data-fact-dims="${f.id}"]`)) n.textContent = f.w ? `${nf.format(f.w)} × ${nf.format(f.h)}` : '-';
    for (const n of $$(`[data-fact-dur="${f.id}"]`)) n.textContent = f.dur ? fmtDuration(f.dur) : '-';
    for (const n of $$(`[data-dims-for="${f.id}"]`)) n.innerHTML = dimsText(f);
  }

  // Refresh after a keep/delete change without reloading the large preview.
  function refreshCompare() {
    const g = state.groupById.get(cmp.groupId);
    if (!g) { el.compareDialog.close(); return; }
    const summary = $('#cmpSummary', el.compareDialog);
    if (summary) summary.innerHTML = compareSummaryHTML(g);
    if (cmp.mode === 'grid') {
      const body = $('#cmpBody', el.compareDialog);
      if (body) {
        const top = body.scrollTop;
        body.innerHTML = compareGridHTML(g);
        body.scrollTop = top;
        observeSlots(body);
      }
    } else {
      const f = g.files[cmp.index];
      const info = $('#cmpInfo', el.compareDialog);
      if (info) info.innerHTML = singleInfoHTML(g, f);
      const film = $('#cmpFilm', el.compareDialog);
      if (film) { const left = film.scrollLeft; film.innerHTML = filmHTML(g); film.scrollLeft = left; observeSlots(film); }
    }
  }

  function stepCopy(dir) {
    const g = state.groupById.get(cmp.groupId);
    if (!g || g.files.length < 2) return;
    cmp.index = (cmp.index + dir + g.files.length) % g.files.length;
    gotoCopy(cmp.index);
  }

  function gotoCopy(index) {
    const g = state.groupById.get(cmp.groupId);
    if (!g) return;
    cmp.index = clamp(index, 0, g.files.length - 1);
    if (cmp.mode !== 'single') { cmp.mode = 'single'; renderCompare(); return; }
    // Keep zoom state while flipping so the same spot can be compared copy to copy.
    const body = $('#cmpBody', el.compareDialog);
    const stage = $('#cmpStage', el.compareDialog);
    const slot = stage && $('#cmpStageSlot', stage);
    const scroll = slot ? [slot.scrollLeft, slot.scrollTop] : null;
    revokeStage();
    body.innerHTML = compareSingleHTML(g);
    observeSlots(body);
    state.lastPreviewId = g.files[cmp.index].id;
    const film = $('#cmpFilm', el.compareDialog);
    const cur = film && film.querySelector('.film.is-current');
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    loadStage(g, g.files[cmp.index]).then(() => {
      const s = $('#cmpStageSlot', el.compareDialog);
      if (s && scroll && cmp.zoomed) { s.scrollLeft = scroll[0]; s.scrollTop = scroll[1]; }
    });
  }

  function stepGroup(dir) {
    const list = visibleGroups();
    const g = state.groupById.get(cmp.groupId);
    const i = list.indexOf(g);
    const next = list[i + dir];
    if (!next) return;
    cmp.groupId = next.id;
    cmp.index = 0;
    cmp.zoomed = false;
    const pos = list.indexOf(next);
    const page = Math.floor(pos / PAGE_SIZE);
    if (page !== state.page) { state.page = page; renderGroups(); }
    renderCompare();
  }

  function toggleZoom() {
    cmp.zoomed = !cmp.zoomed;
    const stage = $('#cmpStage', el.compareDialog);
    if (stage) stage.classList.toggle('zoomed', cmp.zoomed);
    const btn = $('.stage-zoom', el.compareDialog);
    if (btn) btn.innerHTML = cmp.zoomed ? `${ICON.fit} Fit to screen` : `${ICON.expand} Actual size`;
  }

  function onCompareKey(e) {
    if (!cmp.open || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.matches('input[type="text"], input[type="search"], select, textarea') || t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) return;
    const g = state.groupById.get(cmp.groupId);
    if (!g) return;
    const f = g.files[cmp.index];
    const key = e.key;
    if (cmp.mode === 'single' && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      e.preventDefault();
      stepCopy(key === 'ArrowLeft' ? -1 : 1);
    } else if ((key === '[' || key === ']' || key === 'PageUp' || key === 'PageDown') && cmp.origin !== 'review') {
      e.preventDefault();
      stepGroup(key === '[' || key === 'PageUp' ? -1 : 1);
    } else if (cmp.mode === 'single' && (key === 'k' || key === 'K')) {
      e.preventDefault();
      setKeep(f.id);
    } else if (cmp.mode === 'single' && (key === 'd' || key === 'D')) {
      e.preventDefault();
      if (g.keepId === f.id) toastInDialog('The kept copy can’t be deleted. Keep another copy first.');
      else setSelected(f.id, !state.selected.has(f.id));
    }
  }

  function toastInDialog(msg) {
    const s = $('#cmpSummary', el.compareDialog);
    if (!s) return;
    s.textContent = msg;
    setTimeout(() => {
      const g = state.groupById.get(cmp.groupId);
      if (g && cmp.open) { const n = $('#cmpSummary', el.compareDialog); if (n) n.innerHTML = compareSummaryHTML(g); }
    }, 2200);
  }

  // ---------------------------------------------------------------------------
  // Review & delete dialog
  // ---------------------------------------------------------------------------
  const rev = { open: false, phase: 'confirm', confirmed: false, results: null, returnFocus: null, done: 0, total: 0 };

  function selectedByGroup() {
    const out = [];
    for (const g of visibleGroupsAll()) {
      const del = g.files.filter((f) => state.selected.has(f.id));
      if (del.length) out.push({ g, del, keep: keepOf(g) });
    }
    return out;
  }
  // Every group, in the current sort order (search does not hide selected files here).
  function visibleGroupsAll() {
    const q = state.query;
    state.query = '';
    const list = visibleGroups();
    state.query = q;
    return list;
  }

  function openReview() {
    if (!state.selected.size) return;
    rev.phase = 'confirm';
    rev.confirmed = false;
    rev.results = null;
    if (!rev.open) {
      rev.returnFocus = document.activeElement;
      el.reviewDialog.showModal();
      rev.open = true;
      syncScrollLock();
    }
    renderReview();
  }

  function closeReviewCleanup() {
    rev.open = false;
    el.reviewDialog.innerHTML = '';
    syncScrollLock();
    const back = rev.returnFocus;
    rev.returnFocus = null;
    if (back && back.isConnected && !back.disabled) back.focus({ preventScroll: true });
  }

  function revRowHTML(f, type) {
    return `<div class="rev-row ${type}" data-file-id="${f.id}">
      <span class="status ${type === 'keep' ? 'keep' : 'del'}">${type === 'keep' ? `${ICON.check} Keep` : 'Delete'}</span>
      ${thumbButtonHTML(f, 'review')}
      <div class="rev-file">
        <span class="fpath">${esc(f.path)}</span>
        <span class="fmeta">${fmtBytes(f.size)} · Modified ${esc(fmtDate(f.lastModified))}</span>
      </div>
      ${type === 'del' ? `<button type="button" class="btn btn-ghost btn-sm" data-action="rev-unselect" data-file-id="${f.id}">Don’t delete</button>` : '<span></span>'}
    </div>`;
  }

  function renderReview() {
    if (!rev.open) return;
    if (rev.phase === 'done') { renderReviewDone(); return; }
    const items = selectedByGroup();
    const count = items.reduce((s, x) => s + x.del.length, 0);
    const bytes = items.reduce((s, x) => s + x.del.length * x.g.size, 0);
    if (!count && rev.phase === 'confirm') { el.reviewDialog.close(); return; }
    const src = state.source;
    const sample = src.kind === 'sample';
    const readOnly = !src.canDelete;
    const busy = rev.phase === 'deleting';
    const body = el.reviewDialog.querySelector('.rev-body');
    const top = body ? body.scrollTop : 0;
    const fk = focusKey(document.activeElement);
    let foot;
    if (busy) {
      const pct = rev.total ? Math.round((rev.done / rev.total) * 100) : 0;
      foot = `<div class="rev-progress" aria-live="polite"><span>Deleting ${nf.format(Math.min(rev.done + 1, rev.total))} of ${plural(rev.total, 'file')}…</span><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div></div>`;
    } else if (readOnly) {
      foot = `<div class="spacer"></div><button type="button" class="btn btn-outline" data-action="report">Save report</button><button type="button" class="btn btn-dark" data-action="rev-close">Close</button>`;
    } else {
      foot = `<label class="check rev-foot-confirm"><input type="checkbox" id="revConfirm"${rev.confirmed ? ' checked' : ''}> <span>${sample ? `I’ve checked the previews. Delete these ${plural(count, 'sample file')} (simulation).` : `I’ve checked the previews. Delete these ${plural(count, 'file')} permanently.`}</span></label>
        <button type="button" class="btn btn-outline" data-action="rev-close">Cancel</button>
        <button type="button" class="btn btn-danger" data-action="rev-delete"${rev.confirmed ? '' : ' disabled'}>${ICON.trash} Delete ${plural(count, 'file')}</button>`;
    }
    el.reviewDialog.innerHTML = `<div class="dlg" tabindex="-1">
      <header class="dlg-head">
        <div class="dlg-titles">
          <div class="eyebrow">Review deletion</div>
          <h2 id="revTitle">${readOnly ? `${plural(count, 'file')} selected` : `Delete ${plural(count, 'file')}`} · ${fmtBytes(bytes)}</h2>
          <p>${sample ? 'Sample mode. Nothing on your computer will be touched.' : `From “${esc(src.name)}”. One copy in every group is kept.`} Click a preview to see it large.</p>
        </div>
        <button type="button" class="icon-btn" data-action="rev-close" aria-label="Close"${busy ? ' disabled' : ''}>${ICON.close}</button>
      </header>
      <div class="dlg-body rev-body">
        ${readOnly
          ? '<div class="rev-info">This folder was opened in read-only mode, so these files can’t be deleted from here. Open Duplicate Cleaner in Chrome or Edge to delete them, or save a report and delete them yourself.</div>'
          : sample ? '' : `<div class="rev-warning">${ICON.warn}<span><strong>Permanent deletion.</strong> These files won’t go to the Recycle Bin. Before deleting, each file is checked again and skipped if it changed since the scan.</span></div>`}
        ${items.map(({ g, del, keep }) => `<section class="rev-group" data-group-id="${g.id}">
          <div class="rev-group-head">
            <span class="t">${esc(g.title)}</span>
            <span class="s">${del.length} of ${g.files.length} copies · ${fmtBytes(g.size * del.length)}</span>
            <button type="button" class="btn btn-ghost btn-sm" data-action="compare" data-group-id="${g.id}" data-origin="review"${busy ? ' disabled' : ''}>${ICON.compare} Compare</button>
          </div>
          ${revRowHTML(keep, 'keep')}
          ${del.map((f) => revRowHTML(f, 'del')).join('')}
        </section>`).join('')}
      </div>
      <footer class="dlg-foot">${foot}</footer>
    </div>`;
    const nb = el.reviewDialog.querySelector('.rev-body');
    if (nb) nb.scrollTop = top;
    if (busy) for (const b of $$('button', el.reviewDialog)) b.disabled = true;
    observeSlots(el.reviewDialog);
    // Keep focus inside the dialog after a re-render (unless Compare is open on top).
    if (!cmp.open && !busy) restoreFocus(fk && fk.scope === el.reviewDialog ? fk : { scope: el.reviewDialog, sel: null });
  }

  function updateDeleteProgress() {
    const wrap = el.reviewDialog.querySelector('.rev-progress');
    if (!wrap) return;
    const pct = rev.total ? Math.round((rev.done / rev.total) * 100) : 0;
    wrap.querySelector('span').textContent = rev.done >= rev.total ? 'Finishing…' : `Deleting ${nf.format(rev.done + 1)} of ${plural(rev.total, 'file')}…`;
    wrap.querySelector('.progress-fill').style.width = `${pct}%`;
  }

  function renderReviewDone() {
    const r = rev.results;
    const sample = state.source && state.source.kind === 'sample';
    const ok = r.deleted.length;
    const failed = r.failed.length;
    el.reviewDialog.innerHTML = `<div class="dlg" tabindex="-1">
      <header class="dlg-head">
        <div class="dlg-titles"><div class="eyebrow">Review deletion</div><h2 id="revTitle">${r.stopped ? 'Deletion stopped' : failed ? 'Deletion finished with problems' : 'Deletion complete'}</h2></div>
        <button type="button" class="icon-btn" data-action="rev-close" aria-label="Close">${ICON.close}</button>
      </header>
      <div class="dlg-body rev-body">
        <div class="rev-result">
          <div class="done-icon">${failed ? ICON.warn : ICON.check}</div>
          <h3>${ok ? `${sample ? 'Removed' : 'Deleted'} ${plural(ok, 'file')} · freed ${fmtBytes(r.bytes)}` : 'Nothing was deleted'}</h3>
          <p>${sample ? 'This was a simulation. Nothing on your computer was touched.' : 'Every group still has its kept copy.'}${failed ? ` ${plural(failed, 'file')} couldn’t be deleted and ${failed === 1 ? 'was' : 'were'} left in place.` : ''}</p>
          ${r.stopped ? `<div class="rev-warning">${ICON.warn}<span>${esc(r.stopped)}</span></div>` : ''}
        </div>
        ${failed ? `<section class="rev-group"><div class="rev-group-head"><span class="t">Not deleted</span><span class="s">${plural(failed, 'file')}</span></div>
          ${r.failed.map(({ f, reason }) => `<div class="rev-row is-failed"><span class="status del">Skipped</span><span class="thumb">${slotHTML(f, 'thumb')}</span><div class="rev-file"><span class="fpath">${esc(f.path)}</span><span class="err">${esc(reason)}</span></div><span></span></div>`).join('')}
        </section>` : ''}
      </div>
      <footer class="dlg-foot"><div class="spacer"></div><button type="button" class="btn btn-dark" data-action="rev-close">Done</button></footer>
    </div>`;
    observeSlots(el.reviewDialog);
    const done = el.reviewDialog.querySelector('.dlg-foot [data-action="rev-close"]');
    if (done) done.focus({ preventScroll: true });
  }

  function deletionReason(err) {
    const name = err && err.name;
    if (err && err.code === 'changed') return 'Changed since the scan. Scan again before deleting it.';
    if (name === 'NotFoundError') return 'Already gone. It was moved, renamed or deleted outside Duplicate Cleaner.';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permission denied.';
    if (name === 'NoModificationAllowedError' || name === 'InvalidModificationError' || name === 'InvalidStateError') return 'The file is in use or locked by another app.';
    return (err && err.message) || 'Unknown error.';
  }

  async function verifyUnchanged(f) {
    const file = await f.handle.getFile(); // throws NotFoundError if it is gone
    if (file.size !== f.size || file.lastModified !== f.lastModified) {
      const e = new Error('changed');
      e.code = 'changed';
      throw e;
    }
  }

  async function performDeletion() {
    const src = state.source;
    if (!src || !src.canDelete || rev.phase !== 'confirm' || !rev.confirmed) return;
    // Ask for write access first, while the click still counts as a user action.
    if (src.kind === 'fsa') {
      let granted = false;
      try {
        granted = typeof src.root.requestPermission !== 'function' || (await src.root.requestPermission({ mode: 'readwrite' })) === 'granted';
      } catch { granted = false; }
      if (!granted) {
        const foot = el.reviewDialog.querySelector('.dlg-foot');
        if (foot && !foot.querySelector('.err')) foot.insertAdjacentHTML('afterbegin', '<span class="err" role="alert">Permission to delete wasn’t granted. Nothing was deleted.</span>');
        return;
      }
    }

    const items = selectedByGroup();
    rev.phase = 'deleting';
    rev.total = items.reduce((s, x) => s + x.del.length, 0);
    rev.done = 0;
    renderReview();

    const results = { deleted: [], failed: [], gone: [], bytes: 0, stopped: null, stale: new Set() };
    outer:
    for (const { g, del, keep } of items) {
      if (src.kind === 'fsa') {
        try {
          await verifyUnchanged(keep);
        } catch (err) {
          results.stale.add(g.id);
          const why = err && err.code === 'changed' ? 'changed since the scan' : 'is missing';
          for (const f of del) results.failed.push({ f, reason: `Left alone because the kept copy (${keep.name}) ${why}.` });
          rev.done += del.length;
          updateDeleteProgress();
          continue;
        }
      }
      for (const f of del) {
        try {
          if (f.id === g.keepId) throw new Error('This is the kept copy.');
          if (src.kind === 'fsa') {
            await verifyUnchanged(f);
            await f.parent.removeEntry(f.name);
          } else if (src.kind === 'sample') {
            src.entries = src.entries.filter((e) => e !== f.entry);
            await new Promise((r) => setTimeout(r, 25));
          }
          results.deleted.push(f);
          results.bytes += f.size;
        } catch (err) {
          if (err && err.code === 'changed') results.stale.add(g.id);
          results.failed.push({ f, reason: deletionReason(err) });
          if (err && err.name === 'NotFoundError') results.gone.push(f);
        }
        rev.done++;
        updateDeleteProgress();
        if (src.kind === 'fsa') {
          try {
            await keep.handle.getFile();
          } catch {
            results.stopped = `Stopped early: the kept copy “${keep.path}” could no longer be read after deleting “${f.path}”. They may be the same file reached through a shortcut or link. Nothing else was deleted. Scan again before continuing.`;
            break outer;
          }
        }
      }
    }

    applyDeletionResults(results);
    rev.phase = 'done';
    rev.results = results;
    renderReview();
  }

  function applyDeletionResults(results) {
    // Files that couldn't be deleted are unselected, so nothing stays queued by surprise.
    for (const { f } of results.failed) state.selected.delete(f.id);
    const gone = new Set([...results.deleted, ...results.gone].map((f) => f.id));
    for (const id of gone) {
      state.selected.delete(id);
      state.recs.delete(id);
    }
    const kept = [];
    for (const g of state.groups) {
      g.files = g.files.filter((f) => !gone.has(f.id));
      if (!g.files.some((f) => f.id === g.keepId) && g.files.length) g.keepId = pickKeep(g.files, prefs.protectRule).id;
      if (g.files.length > 1) kept.push(g);
      else for (const f of g.files) { state.selected.delete(f.id); state.recs.delete(f.id); }
    }
    for (const g of kept) {
      if (!results.stale.has(g.id)) continue;
      g.stale = true; // a copy changed after the scan, so the match can't be trusted until a new scan
      for (const f of g.files) state.selected.delete(f.id);
    }
    state.groups = kept;
    state.groupById = new Map(kept.map((g) => [g.id, g]));
    state.freedBytes += results.bytes;
    state.deletedCount += results.deleted.length;
    const sample = state.source.kind === 'sample';
    const verb = sample ? 'Removed' : 'Deleted';
    let text = results.deleted.length
      ? `${verb} ${plural(results.deleted.length, 'file')} and freed ${fmtBytes(results.bytes)}${sample ? ' (simulation)' : ''}. Freed so far: ${fmtBytes(state.freedBytes)}.`
      : 'Nothing was deleted.';
    if (results.failed.length) text += ` ${plural(results.failed.length, 'file')} couldn’t be deleted.`;
    if (results.stale.size) text += ' Some files changed after the scan. Scan again to refresh those groups.';
    state.notice = { kind: results.failed.length || results.stopped ? 'warn' : 'success', text };
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheet apps from running it as a formula
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function stamp(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`; }
  function isoLocal(t) { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function saveReport() {
    if (!state.hasResults) return;
    const rows = [['Group', 'Action', 'File name', 'Path', 'Size (bytes)', 'Size', 'Modified', 'Content fingerprint (SHA-256)']];
    visibleGroupsAll().forEach((g, i) => {
      for (const f of g.files) {
        const action = g.keepId === f.id ? 'Keep' : state.selected.has(f.id) ? 'Delete' : 'Not selected';
        rows.push([i + 1, action, f.name, f.path, f.size, fmtBytes(f.size), isoLocal(f.lastModified), g.hash]);
      }
    });
    const csv = `\ufeff${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
    const base = (state.source ? state.source.name : 'folder').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'folder';
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `duplicate-report_${base}_${stamp()}.csv`);
    if (!el.reviewDialog.open) toast(`Report saved with ${plural(rows.length - 1, 'file')} in ${plural(state.groups.length, 'group')}.`);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function closeDialogs() {
    if (el.compareDialog.open) el.compareDialog.close();
    if (el.reviewDialog.open && rev.phase !== 'deleting') el.reviewDialog.close();
  }

  function setView(view) {
    prefs.view = view === 'gallery' ? 'gallery' : 'list';
    savePrefs();
    for (const b of $$('[data-action="view"]')) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view));
    renderGroups();
  }

  function onClick(e) {
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled) return;
    const id = t.dataset.fileId;
    switch (t.dataset.action) {
      case 'pick': pickFolder(); break;
      case 'sample': startSample(); break;
      case 'scan': startScan(); break;
      case 'cancel-scan': cancelScan(); break;
      case 'keep': setKeep(id); break;
      case 'preview': openPreview(id, t.dataset.origin); break;
      case 'compare': openCompare(t.dataset.groupId, null, 'grid', t.dataset.origin); break;
      case 'apply-rule': applyRuleToAll(); break;
      case 'select-extras': selectMatchingExtras(); break;
      case 'clear': clearSelection(); break;
      case 'report': saveReport(); break;
      case 'view': setView(t.dataset.view); break;
      case 'clear-search': el.search.value = ''; state.query = ''; state.page = 0; renderGroups(); el.search.focus(); break;
      case 'page':
        state.page += Number(t.dataset.dir) || 0;
        renderGroups();
        el.reviewCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
        break;
      case 'review': openReview(); break;
      case 'cmp-close': el.compareDialog.close(); break;
      case 'cmp-mode':
        if (cmp.mode !== t.dataset.mode) { cmp.mode = t.dataset.mode; cmp.zoomed = false; renderCompare(); }
        break;
      case 'cmp-step': stepCopy(Number(t.dataset.dir)); break;
      case 'cmp-goto': gotoCopy(Number(t.dataset.index)); break;
      case 'cmp-open': cmp.mode = 'single'; cmp.zoomed = false; cmp.index = Number(t.dataset.index); renderCompare(); break;
      case 'cmp-group': stepGroup(Number(t.dataset.dir)); break;
      case 'cmp-zoom': toggleZoom(); break;
      case 'rev-close': if (rev.phase !== 'deleting') el.reviewDialog.close(); break;
      case 'rev-unselect': setSelected(id, false); break;
      case 'rev-delete': performDeletion(); break;
      default: break;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.matches('input[data-action="toggle"]')) { setSelected(t.dataset.fileId, t.checked); return; }
    if (t.id === 'revConfirm') {
      rev.confirmed = t.checked;
      const btn = el.reviewDialog.querySelector('[data-action="rev-delete"]');
      if (btn) btn.disabled = !t.checked;
      return;
    }
    if (t.closest('.folder-card')) {
      prefs.includeSubfolders = el.optSubfolders.checked;
      prefs.skipHidden = el.optSkipHidden.checked;
      prefs.skipSystemDirs = el.optSkipSystemDirs.checked;
      prefs.types = el.optTypes.value;
      prefs.minSize = Number(el.optMinSize.value);
      prefs.exclude = el.optExclude.value;
      savePrefs();
      if (state.hasResults && !state.scanning) toast('Options changed. Scan again to apply them.');
    }
  }

  function applyPrefsToControls() {
    el.optSubfolders.checked = !!prefs.includeSubfolders;
    el.optSkipHidden.checked = !!prefs.skipHidden;
    el.optSkipSystemDirs.checked = !!prefs.skipSystemDirs;
    if (TYPE_FILTERS[prefs.types] !== undefined) el.optTypes.value = prefs.types;
    if ($(`option[value="${Number(prefs.minSize)}"]`, el.optMinSize)) el.optMinSize.value = String(Number(prefs.minSize));
    el.optExclude.value = prefs.exclude || '';
    el.sort.value = prefs.sort;
    if (!el.sort.value) { el.sort.value = 'space'; prefs.sort = 'space'; }
    el.protectRule.value = prefs.protectRule;
    if (!el.protectRule.value) { el.protectRule.value = 'shortest'; prefs.protectRule = 'shortest'; }
    for (const b of $$('[data-action="view"]')) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view));
  }

  function init() {
    applyPrefsToControls();
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    el.search.addEventListener('input', debounce(() => { state.query = el.search.value; state.page = 0; renderGroups(); }, 140));
    el.sort.addEventListener('change', () => { prefs.sort = el.sort.value; savePrefs(); state.page = 0; renderGroups(); });
    el.protectRule.addEventListener('change', () => { prefs.protectRule = el.protectRule.value; savePrefs(); });
    el.optExclude.addEventListener('keydown', (e) => { if (e.key === 'Enter' && state.source) { e.preventDefault(); startScan(); } });
    el.dirInput.addEventListener('change', onDirInput);

    el.compareDialog.addEventListener('close', closeCompareCleanup);
    document.addEventListener('keydown', onCompareKey);
    el.compareDialog.addEventListener('click', (e) => { if (e.target === el.compareDialog) el.compareDialog.close(); });
    el.reviewDialog.addEventListener('cancel', (e) => { if (rev.phase === 'deleting') e.preventDefault(); });
    el.reviewDialog.addEventListener('close', closeReviewCleanup);
    el.reviewDialog.addEventListener('click', (e) => { if (e.target === el.reviewDialog && rev.phase !== 'deleting') el.reviewDialog.close(); });
    window.addEventListener('beforeunload', (e) => {
      if (rev.phase === 'deleting' && rev.open) { e.preventDefault(); e.returnValue = ''; }
    });

    if (!hasSubtle) console.info('Duplicate Cleaner: using the built-in SHA-256 fallback.');
    renderAll();

    // Debug handle for automated checks. Only exposed when the page is opened as index.html#debug.
    if (location.hash === '#debug') window.__dc = { state, prefs, version: '2.0.0' };
  }

  init();
})();
