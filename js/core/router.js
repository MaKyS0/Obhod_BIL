// Минимальный hash-маршрутизатор: #/путь/:параметр?запрос
export function createRouter({ view, routes, makeContext, onChange }) {
  let cleanup = null;
  let current = null;

  function parse() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs = ''] = raw.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs));
    return { path: path || '/', query };
  }

  function match(path) {
    const segs = path.split('/').filter(Boolean);
    for (const r of routes) {
      const pat = r.path.split('/').filter(Boolean);
      if (pat.length !== segs.length) continue;
      const params = {};
      let ok = true;
      pat.forEach((p, i) => {
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) ok = false;
      });
      if (ok) return { route: r, params };
    }
    return null;
  }

  async function render() {
    const { path, query } = parse();
    const m = match(path);
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch (e) {
        console.error(e);
      }
    }
    cleanup = null;
    const refreshed = !!current && current.path === path && current.query && JSON.stringify(current.query) === JSON.stringify(query);
    const scrollY = window.scrollY;
    view.replaceChildren();
    const route = m ? m.route : { name: 'notfound', render: (ctx) => ctx.view.append(Object.assign(document.createElement('p'), { textContent: 'Страница не найдена.', className: 'loading' })) };
    current = { name: route.name, path, query, params: m ? m.params : {}, refreshed };
    try {
      const ctx = makeContext({ view, params: current.params, query, route: current });
      cleanup = (await route.render(ctx)) || null;
    } catch (e) {
      console.error(e);
      const box = document.createElement('div');
      box.className = 'notice danger';
      box.textContent = `Ошибка при отображении страницы: ${e.message}`;
      view.replaceChildren(box);
    }
    if (refreshed) window.scrollTo(0, scrollY);
    onChange?.(current);
  }

  return {
    start() {
      window.addEventListener('hashchange', render);
      return render();
    },
    refresh: render,
    get current() {
      return current;
    },
    go(hash, { replace = false } = {}) {
      if (replace) {
        history.replaceState(null, '', hash);
        return render();
      }
      location.hash = hash;
    },
  };
}
