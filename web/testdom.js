// Minimal DOM for running the real web/js ES modules + web/index.html under
// `node --test` (no npm dependencies). It implements only what the modules
// use.
//
// innerHTML is parsed into real nodes, and every element the parser creates
// is recorded in `parsedElements`, so a test can prove that API data never
// became markup (e.g. no <img onerror> was created from a payload).
//
// Since CONSOLE-V2 item 1 the frontend is native ES modules under web/js/:
// loadApp() installs the module globals (document, sessionStorage, a
// location whose hash setter fires hashchange like a real browser) and
// returns a context of the real functions. main.js is wired explicitly;
// module state resets between tests via resetSessionState().

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', larr: '←', rarr: '→', times: '×' };

function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }
  // contains reports whether the node is this node or one of its descendants
  // (the toast host checks it before reusing the cached host element).
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.childNodes.some((c) => (c instanceof Element ? c.contains(node) : false));
  }
  // remove detaches the node from its parent (toast auto-dismiss).
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren();
    if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.data = data;
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

const BOOL_ATTRS = ['hidden', 'disabled', 'required', 'checked', 'open'];

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.listeners = {};
    this.style = {};
    this._value = undefined;
    this._checked = undefined;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.files = null;
    this.onclick = null;
  }
  get children() { return this.childNodes.filter((c) => c instanceof Element); }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; }
  setAttribute(n, v) { this.attributes.set(n.toLowerCase(), String(v)); }
  hasAttribute(n) { return this.attributes.has(n); }
  removeAttribute(n) { this.attributes.delete(n); }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get name() { return this.getAttribute('name') || ''; }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get alt() { return this.getAttribute('alt') || ''; }
  set alt(v) { this.setAttribute('alt', v); }
  get src() { return this.getAttribute('src') || ''; }
  set src(v) { this.setAttribute('src', v); }
  get href() { return this.getAttribute('href') || ''; }
  set href(v) { this.setAttribute('href', v); }
  get target() { return this.getAttribute('target') || ''; }
  set target(v) { this.setAttribute('target', v); }
  get rel() { return this.getAttribute('rel') || ''; }
  set rel(v) { this.setAttribute('rel', v); }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(v) { this.setAttribute('placeholder', v); }
  get colSpan() { return Number(this.getAttribute('colspan') || 1); }
  set colSpan(v) { this.setAttribute('colspan', v); }

  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'TEXTAREA') return this.textContent;
    if (this.tagName === 'SELECT') {
      const opts = this.querySelectorAll('option');
      const sel = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      return sel ? sel.value : '';
    }
    if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent;
    return this.getAttribute('value') || '';
  }
  set value(v) { this._value = String(v); }

  get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(v) {
    if (v && this.type === 'radio' && this.name) {
      for (const r of this.ownerDocument.querySelectorAll(`input[name="${this.name}"]`)) r._checked = false;
    }
    this._checked = !!v;
  }

  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(...c) { self.className = [...new Set([...list(), ...c])].join(' '); },
      remove(...c) { self.className = list().filter((x) => !c.includes(x)).join(' '); },
      contains(c) { return list().includes(c); },
      toggle(c, force) {
        const on = force === undefined ? !list().includes(c) : force;
        if (on) this.add(c); else this.remove(c);
        return on;
      },
    };
  }

  // dataset proxies data-* attributes (e.g. el.dataset.theme = 'dark').
  get dataset() {
    const self = this;
    const key = (prop) => 'data-' + prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    return new Proxy({}, {
      get(_, prop) { return self.getAttribute(key(prop)); },
      set(_, prop, v) {
        if (v === null || v === undefined || v === '') self.removeAttribute(key(prop));
        else self.setAttribute(key(prop), String(v));
        return true;
      },
      deleteProperty(_, prop) { self.removeAttribute(key(prop)); return true; },
    });
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    ev.target ||= this;
    for (const fn of this.listeners[ev.type] || []) fn(ev);
    if (ev.type === 'click' && this.onclick) this.onclick(ev);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click', preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }

  get innerHTML() {
    return this.childNodes.map(serialize).join('');
  }
  set innerHTML(html) {
    this.replaceChildren();
    parseInto(this, String(html));
  }

  querySelectorAll(sel) {
    const groups = sel.split(',').map((g) => g.trim().split(/\s+/).map(parseCompound));
    const out = [];
    walk(this, (n) => {
      if (n !== this && groups.some((g) => matchesChain(n, g, this))) out.push(n);
    });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

for (const a of BOOL_ATTRS) {
  if (a === 'checked') continue;
  Object.defineProperty(Element.prototype, a, {
    get() { return this.hasAttribute(a); },
    set(v) { if (v) this.attributes.set(a, ''); else this.attributes.delete(a); },
  });
}

function walk(node, fn) {
  for (const c of node.childNodes) {
    if (c instanceof Element) {
      fn(c);
      walk(c, fn);
    }
  }
}

function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [], checked: false };
  const re = /^([a-z][a-z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|(:checked)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push([m[4], m[5]]);
    else if (m[6]) c.checked = true;
  }
  return c;
}

function matchesCompound(n, c) {
  if (c.tag && n.tagName !== c.tag) return false;
  if (c.id && n.id !== c.id) return false;
  if (c.classes.some((k) => !n.classList.contains(k))) return false;
  if (c.attrs.some(([k, v]) => (v === undefined ? !n.hasAttribute(k) : (k === 'value' ? n.value : n.getAttribute(k)) !== v))) return false;
  if (c.checked && !n.checked) return false;
  return true;
}

function matchesChain(n, chain, root) {
  if (!matchesCompound(n, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let p = n.parentNode;
  while (i >= 0 && p && p !== root.parentNode) {
    if (p instanceof Element && matchesCompound(p, chain[i])) i--;
    p = p.parentNode;
  }
  return i < 0;
}

function serialize(n) {
  if (n instanceof Text) return escapeText(n.data);
  const attrs = [...n.attributes].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v.replace(/"/g, '&quot;')}"`)).join('');
  const tag = n.tagName.toLowerCase();
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${n.childNodes.map(serialize).join('')}</${tag}>`;
}

function parseInto(root, html) {
  const doc = root.ownerDocument;
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][a-z0-9-]*)\s*>|<([a-z][a-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>|([^<]+|<)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
    } else if (m[2]) {
      const elx = doc.createElement(m[2]);
      doc.parsedElements.push(elx);
      const attrRe = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let a;
      while ((a = attrRe.exec(m[3])) !== null) {
        elx.attributes.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      top().appendChild(elx);
      if (!VOID.has(m[2].toLowerCase())) stack.push(elx);
    } else if (m[4] !== undefined) {
      top().appendChild(doc.createTextNode(decode(m[4])));
    }
  }
}

class Document extends Element {
  constructor() {
    super(null, '#document');
    this.ownerDocument = this;
    this.parsedElements = [];
  }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(data) { return new Text(this, String(data)); }
  getElementById(id) { return this.querySelector(`#${id}`); }
  get body() { return this.querySelector('body'); }
}

// Globals previously only the vm sandbox saw; modules read them off
// globalThis at call time.
function makeFakeLocation(winListeners) {
  // Hash assignment fires hashchange like a real browser, so router logic
  // behaves identically in tests.
  const loc = {
    _hash: '',
    protocol: 'http:',
    host: 'console.test',
    get href() { return `http://console.test/${this._hash ? `#${this._hash}` : ''}`; },
    set href(_) { /* no-op */ },
    get hash() { return this._hash; },
    set hash(v) {
      this._hash = String(v);
      for (const fn of winListeners.hashchange || []) fn({ type: 'hashchange' });
    },
  };
  return loc;
}

class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
  }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
}
FakeWebSocket.OPEN = 1;

const opened = [];

// loadApp parses index.html, installs the module environment and wires the
// real main.js against it, then resumes any existing session (page-load
// semantics). Returns the DOM, storage and the real module namespace as ctx.
async function loadApp({ fetch, storage } = {}) {
  const doc = new Document();
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  parseInto(doc, html);
  doc.parsedElements = [];
  // The <html> child acts as documentElement (dir/lang/data-theme writes).
  doc.documentElement = doc.querySelector('html') || doc;

  const store = storage || new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear()  { store.clear(); },
  };

  const winListeners = {};
  const sockets = [];
  const FakeWS = class extends FakeWebSocket {
    constructor(...args) {
      super(...args);
      sockets.push(this);
    }
  };

  // URL with just enough shape (searchParams, createObjectURL) for the
  // modules; tests can override globalThis.URL.createObjectURL to observe
  // the blob type the document viewer forces to application/octet-stream.
  const URLLike = Object.assign(function (u, b) {
    const real = {};
    real.searchParams = new URLSearchParams(String(u).split('?')[1] || '');
    return real;
  }, {
    createObjectURL: (blob) => { opened.push(blob); return 'blob:http://console.test/fake'; },
    revokeObjectURL: () => {},
  });

  const location = makeFakeLocation(winListeners);

  installGlobals({
    document: doc,
    sessionStorage,
    location,
    fetch: fetch || (async () => ({ status: 200, ok: true, json: async () => ({}) })),
    WebSocket: FakeWS,
    URL: URLLike,
    URLSearchParams,
    Blob,
    FormData,
    console,
    alert: () => {},
    open: (...a) => { opened.push(a); return null; },
    setTimeout: (fn, ms) => { const t = realTimers.setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout: realTimers.clearTimeout,
    setInterval: (fn, ms) => { const t = realTimers.setInterval(fn, ms); if (t.unref) t.unref(); return t; },
    clearInterval: realTimers.clearInterval,
  });

  const winCbs = {
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn); },
  };
  const prevWindow = globalThis.window;
  globalThis.window = new Proxy(globalThis, {
    get(target, prop) {
      if (prop === 'addEventListener') return winCbs.addEventListener;
      if (prop === 'removeEventListener') return winCbs.removeEventListener;
      if (prop === 'open') return globalThis.open;
      if (prop === 'location') return location;
      return target[prop];
    },
  });

  const { resetSessionState } = await import('./js/core/state.js');
  const session = await import('./js/core/session.js');
  const app = await import('./js/app.js');
  const main = await import('./js/main.js');
  resetSessionState();
  session.wireActivityListeners();
  main.wireAll();
  main.bootstrapSession();

  return { doc, store, opened, sockets, winListeners, ctx: app, main, location, fakeURL: URLLike };
}

const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

// installRevert handles test isolation between loadApp calls.
const defaults = new Map();
function installGlobals(map) {
  for (const [k, v] of Object.entries(map)) {
    if (!defaults.has(k)) defaults.set(k, globalThis[k]);
    globalThis[k] = v;
  }
  globalThis.window = globalThis.window; // overwritten per-load below
}

// jsonResponse builds the subset of a fetch Response that the modules read.
function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)], { type: 'application/json' }),
  };
}

// hostileNodes lists every element/attribute that could only have come from
// a payload being parsed as HTML.
function hostileNodes(doc) {
  const found = [];
  for (const e of doc.parsedElements) {
    if (e.tagName === 'IMG' || e.tagName === 'SCRIPT') found.push(`<${e.tagName.toLowerCase()}> from innerHTML`);
  }
  walk(doc, (e) => {
    for (const k of e.attributes.keys()) {
      if (k.startsWith('on')) found.push(`${e.tagName.toLowerCase()}[${k}]`);
    }
    if (e.tagName === 'IMG' && e.src === 'x') found.push('img[src=x]');
  });
  return found;
}

module.exports = { loadApp, jsonResponse, hostileNodes, Element };
