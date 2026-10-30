// Hash router: #/<page> drives which page section is visible. Routes are
// registered by the shell with a loader callback (and optionally a nav
// button); rendering a route runs its loader and toggles the active state on
// the registered nav buttons. Unknown routes fall back to the default route.
//
// The hash is the single source of truth — the browser's back/forward buttons
// work and every page is deep-linkable.

const routes = [];
let defaultRoute = '';

export function register(route, loader, navBtn) {
  routes.push({ route, loader, navBtn: navBtn || null });
}

export function setDefault(route) {
  defaultRoute = route;
}

export function currentRoute() {
  return readHash().path;
}

export function currentParams() {
  return readHash().params;
}

function readHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  return { path: path.replace(/\/+$/, ''), params: new URLSearchParams(query || '') };
}

// navigate changes the hash; the hashchange listener does the rest. When the
// hash is already the target (repeat click / no event environment) render()
// runs directly so the page still loads/reloads.
export function navigate(path, params) {
  const qs = params && params.toString ? params.toString() : (params || '');
  const target = `#/${path}${qs ? `?${qs}` : ''}`;
  if (String(location.hash) === target) render();
  else location.hash = target;
}

// render routes the current hash: the matching page's loader runs (defaulting
// to defaultRoute for unknown hashes) and nav buttons get their active state.
export function render() {
  const { path } = readHash();
  let match = routes.find((r) => r.route === path);
  if (!match) {
    match = routes.find((r) => r.route === defaultRoute);
  }
  if (!match) return;
  for (const r of routes) {
    if (r.navBtn) r.navBtn.classList.toggle('active', r === match);
  }
  match.loader(readHash().params);
}

// install wires the hashchange handler (browser boot; tests decide when).
export function install() {
  window.addEventListener('hashchange', () => render());
}
