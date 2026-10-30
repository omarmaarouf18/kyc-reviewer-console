#!/usr/bin/env node
// Browser smoke test for the reviewer console (CONSOLE-V2 item 12).
//
// It boots the REAL console server (the Go binary) against a stub of the
// internal services, drives a headless Chrome over the DevTools protocol
// (no npm dependency: Node's global WebSocket talks CDP directly) and
// asserts that the shell boots, renders every page and logs no error.
//
// It also writes the reference screenshots into docs/screens/:
//   console-ar-light.png — Arabic (RTL), light theme
//   console-en-dark.png  — English (LTR), dark theme
//
// Usage: node scripts/smoke.mjs [--screens <dir>] [--headful]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const screensDir = path.resolve(repoRoot, argValue('--screens') || 'docs/screens');
const headful = args.includes('--headful');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Stub of the internal services (auth / user / chat / notification / gateway).
// The console proxies every browser call here, so the smoke test exercises
// the real routes, the real two-token contract and the real JSON shapes.
// ---------------------------------------------------------------------------

const STUB_ROUTES = {
  '/auth/reviewer/verify': { id: 'rev-smoke-1', name: 'Smoke Reviewer' },
  // The exact field names of ADMIN_API § 2 (GET /admin/overview).
  '/admin/overview': {
    pending_kyb_kye: 14,
    pending_payment_subscriptions: 3,
    open_tickets: 7,
    assigned_tickets: 3,
    gps_disputes: 2,
    stuck_cod_jobs: 5,
    new_accounts_today: 9,
    new_accounts_7d: 41,
    suspended_accounts: 2,
    jobs_today: { pending_dispatch: 18, active: 12, completed: 64, cancelled: 3 },
  },
  '/auth/kyb-kye/pending': [],
  '/admin/jobs': { jobs: [], total: 0, page: 1, limit: 20 },
  '/admin/reconciliation/queue': { disputes: [], total: 0 },
  '/admin/subscriptions/queue': { queue: [], total: 0 },
  '/admin/subscriptions': { subscriptions: [], total: 0 },
  '/admin/services': { services: [], total: 0 },
  '/admin/accounts': { accounts: [], total: 0 },
  '/admin/tickets': { tickets: [], total: 0 },
  '/admin/payouts': { payouts: [], total: 0 },
  '/admin/audit': {
    entries: [
      {
        id: 'audit-1',
        source: 'user-service',
        actor_id: 'rev-smoke-1',
        action: 'job.cancel',
        target_type: 'job',
        target_id: 'job-1234',
        reason: 'Smoke test record',
        details: 'audience=role size=1 test=false',
        request_id: 'req-smoke',
        created_at: '2026-10-30T08:00:00Z',
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
    sources: { 'auth-service': 'ok', 'user-service': 'ok', 'chat-service': 'ok', 'notification-service': 'ok', 'api-gateway': 'ok' },
  },
  '/admin/version': {
    id: 'global',
    latest_version: '1.5.2',
    minimum_supported_version: '1.4.0',
    enforce_minimum_version: false,
    download_url: 'https://play.google.com/store/apps/details?id=tech.logiclinkeg.app',
    revision: 7,
    updated_at: '2026-10-30T08:00:00Z',
  },
  '/admin/notifications/sends': { sends: [], total: 0, page: 1, limit: 20 },
};

function startStub() {
  const server = http.createServer((req, res) => {
    const pathOnly = req.url.split('?')[0];
    const body = STUB_ROUTES[pathOnly];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body === undefined ? {} : body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// Chrome + DevTools protocol
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Chrome binary found (set CHROME_PATH)');
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    this.ws.addEventListener('message', (event) => this.#onMessage(String(event.data)));
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${entry.method})`));
      else entry.resolve(msg.result);
      return;
    }
    const list = this.handlers.get(msg.method);
    if (list) for (const fn of list) fn(msg.params);
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function launchChrome(profileDir) {
  const chrome = findChrome();
  const args = [
    headful ? '--headless=false' : '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,960',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  // Chrome writes the chosen port into DevToolsActivePort.
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const content = fs.readFileSync(portFile, 'utf8').split('\n');
      const port = Number(content[0]);
      if (port > 0) return { proc, port, stderr: () => stderr };
    }
    if (proc.exitCode !== null) {
      throw new Error(`chrome exited early (${proc.exitCode}): ${stderr.slice(-400)}`);
    }
    await sleep(100);
  }
  throw new Error(`chrome did not expose a devtools port: ${stderr.slice(-400)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

// ---------------------------------------------------------------------------
// The smoke checks
// ---------------------------------------------------------------------------

const failures = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) {
    notes.push(`ok   ${name}`);
  } else {
    failures.push(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
  }
  return result.result.value;
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-smoke-'));
  const stub = await startStub();
  const stubURL = `http://127.0.0.1:${stub.port}`;

  // Build and start the real console server.
  const bin = path.join(tmp, 'console');
  const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: repoRoot, encoding: 'utf8' });
  if (build.status !== 0) {
    throw new Error(`go build failed: ${build.stderr}`);
  }

  const consolePort = 18090 + (process.pid % 500);
  const consoleProc = spawn(bin, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(consolePort),
      INTERNAL_SERVICE_TOKEN: 'smoke-internal-token',
      AUTH_SERVICE_URL: stubURL,
      USER_SERVICE_URL: stubURL,
      CHAT_SERVICE_URL: stubURL,
      NOTIFICATION_SERVICE_URL: stubURL,
      GATEWAY_INTERNAL_URL: stubURL,
      APP_ENV: 'local',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let consoleErr = '';
  consoleProc.stderr.on('data', (chunk) => {
    consoleErr += String(chunk);
  });

  // Wait for the server.
  const healthURL = `http://127.0.0.1:${consolePort}/healthz`;
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthURL);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  if (!up) throw new Error(`the console server did not start: ${consoleErr.slice(-400)}`);

  const profileDir = path.join(tmp, 'chrome-profile');
  await fsp.mkdir(profileDir, { recursive: true });
  const chrome = await launchChrome(profileDir);

  let cdp;
  let arPath = '';
  let enPath = '';
  try {
    const version = await fetchJSON(`http://127.0.0.1:${chrome.port}/json/version`);
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.connect();

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const consoleErrors = [];
    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(`exception: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`);
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'assert') {
        consoleErrors.push(`console.${params.type}: ${(params.args || []).map((a) => a.value ?? a.description).join(' ')}`);
      }
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry;
      if (entry.level !== 'error') return;
      if (String(entry.url || '').endsWith('/favicon.ico')) return;
      consoleErrors.push(`log: ${entry.text} ${entry.url || ''}`.trim());
    });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);

    // Sign in before the app boots: the token lives in sessionStorage and the
    // language/theme in localStorage.
    const initScript = `
      sessionStorage.setItem('reviewer_token', 'smoke-reviewer-token');
      sessionStorage.setItem('reviewer_last_activity', String(Date.now()));
      localStorage.setItem('console_lang', 'ar');
      localStorage.setItem('console_theme', 'light');
    `;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript }, sessionId);

    const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${consolePort}/` }, sessionId);
    await loaded;
    await sleep(1200); // let the overview counters and the badges settle

    // --- structural checks -------------------------------------------------
    const shell = await evaluate(cdp, sessionId, `(() => {
      const app = document.getElementById('app-view');
      const login = document.getElementById('login-view');
      return {
        appVisible: !!app && !app.hidden,
        loginHidden: !!login && login.hidden,
        navItems: document.querySelectorAll('#console-nav .nav-item').length,
        dir: document.documentElement.getAttribute('dir'),
        lang: document.documentElement.getAttribute('lang'),
        theme: document.documentElement.getAttribute('data-theme'),
        firstNav: document.querySelector('#console-nav .nav-item span')?.textContent || '',
        overviewVisible: !document.getElementById('overview-section').hidden,
        cards: document.querySelectorAll('#overview-grid .stat-card').length,
        overviewText: (document.getElementById('overview-grid')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      };
    })()`);

    check('the app view is shown after the session bootstrap', shell.appVisible === true && shell.loginHidden === true);
    check('the sidebar lists every page', shell.navItems === 12, `got ${shell.navItems}`);
    check('the default page is the overview', shell.overviewVisible === true);
    check('the overview renders its counters', shell.cards >= 9, `got ${shell.cards} cards`);
    check('Arabic is the default language (RTL)', shell.lang === 'ar' && shell.dir === 'rtl', JSON.stringify(shell));
    check('the light theme is applied', shell.theme === 'light', String(shell.theme));
    check('the overview shows the stubbed figures', /14/.test(shell.overviewText), shell.overviewText.slice(0, 120));

    // --- screenshots: Arabic, light ---------------------------------------
    await fsp.mkdir(screensDir, { recursive: true });
    const arShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    arPath = path.join(screensDir, 'console-ar-light.png');
    await fsp.writeFile(arPath, Buffer.from(arShot.data, 'base64'));

    // --- switch to English + dark -----------------------------------------
    await evaluate(cdp, sessionId, `(() => {
      document.getElementById('lang-toggle-btn').click();
      document.getElementById('theme-toggle-btn').click();
      return true;
    })()`);
    await sleep(400);

    const switched = await evaluate(cdp, sessionId, `(() => ({
      lang: document.documentElement.getAttribute('lang'),
      dir: document.documentElement.getAttribute('dir'),
      theme: document.documentElement.getAttribute('data-theme'),
      firstNav: document.querySelector('#console-nav .nav-item span')?.textContent || '',
      overviewText: (document.getElementById('overview-grid')?.textContent || '').replace(/\s+/g, ' ').trim(),
    }))()`);
    check('the language toggle switches to English (LTR)', switched.lang === 'en' && switched.dir === 'ltr', JSON.stringify(switched));
    check('the theme toggle switches to dark', switched.theme === 'dark', String(switched.theme));
    check('the nav is translated', switched.firstNav === 'Overview', switched.firstNav);
    check(
      'the rendered page follows the language switch',
      /Pending KYB\/KYE review/.test(switched.overviewText),
      switched.overviewText.slice(0, 120),
    );

    const enShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    enPath = path.join(screensDir, 'console-en-dark.png');
    await fsp.writeFile(enPath, Buffer.from(enShot.data, 'base64'));

    // --- every page renders ------------------------------------------------
    const routes = ['queue', 'accounts', 'jobs', 'reconciliation', 'subscriptions', 'services', 'tickets', 'payouts', 'audit', 'versions', 'notifications'];
    for (const route of routes) {
      const rendered = await evaluate(cdp, sessionId, `(async () => {
        location.hash = '#/${route}';
        await new Promise((r) => setTimeout(r, 250));
        const section = document.querySelector('section[id$="-section"]:not([hidden])');
        return { visible: !!section, id: section ? section.id : '' };
      })()`);
      check(`the ${route} page renders`, rendered.visible === true, JSON.stringify(rendered));
    }

    // --- the API path was proxied -----------------------------------------
    const proxied = await evaluate(cdp, sessionId, `(async () => {
      const res = await fetch('/api/overview', { headers: { 'X-Reviewer-Token': sessionStorage.getItem('reviewer_token') } });
      return { status: res.status, body: await res.json() };
    })()`);
    check('the console proxies the API to the internal services', proxied.status === 200 && proxied.body.pending_kyb_kye === 14, JSON.stringify(proxied).slice(0, 160));

    check('no console error, exception or CSP violation was logged', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    if (cdp) cdp.close();
    chrome.proc.kill('SIGKILL');
    consoleProc.kill('SIGKILL');
    stub.server.close();
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  for (const note of notes) console.log(note);
  for (const failure of failures) console.log(failure);
  console.log(`\n${notes.length} checks passed, ${failures.length} failed`);
  console.log(`screenshots: ${path.relative(repoRoot, arPath)}, ${path.relative(repoRoot, enPath)}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`smoke test failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
