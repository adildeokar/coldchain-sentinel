/* Source Code view — every file of the project (server, engine, UI, firmware, cloud, docs),
 * read live from disk by the server (GET /api/sources). */
(function (CS) {
  'use strict';
  const { h, esc } = CS.dom;

  const GROUPS = [
    ['Application server (Node.js)', (p) => p.startsWith('server/') || p === 'package.json' || p === 'start.bat'],
    ['Simulation engine — runs on the server', (p) => p.startsWith('engine/')],
    ['Raspberry Pi firmware (Python)', (p) => p.startsWith('firmware/')],
    ['Azure cloud (Functions · ASA · CLI)', (p) => p.startsWith('cloud/')],
    ['Web UI — browser', (p) => p.startsWith('public/')],
    ['Tools & docs', () => true],
  ];

  // Keep a span open across line breaks so multi-line strings/comments stay coloured per row
  function splitLines(html) {
    const out = [];
    let open = null;
    html.split('\n').forEach((line) => {
      let l = (open ? `<span class="${open}">` : '') + line;
      const re = /<span class="([^"]+)">|<\/span>/g;
      let m, cur = open;
      while ((m = re.exec(line))) cur = m[1] ? m[1] : null;
      if (cur) l += '</span>';
      open = cur;
      out.push(l);
    });
    return out;
  }

  const src = {
    init(app, el) {
      this.app = app;
      this.files = Object.keys(window.CS_SOURCES || {});
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'view-h' }, h('div', null, h('h2', null, 'Source code'),
        h('div', { class: 'desc' }, `All ${this.files.length} project files, read live from disk by the server (GET /api/sources). server/ + engine/ run the whole simulation; public/ is only the display. firmware/ and cloud/ are the real deployable Raspberry Pi and Azure code; the engine's rule engine and store-and-forward logic are line-for-line ports of that Python.`)),
        h('div', { class: 'tools' }, this.search = h('input', { type: 'text', placeholder: 'search in all files…', style: 'width:260px', oninput: () => this.doSearch() }))));
      const lay = h('div', { class: 'src-layout' });
      el.appendChild(lay);
      this.tree = h('div', { class: 'card src-tree' });
      this.view = h('div', { class: 'card src-view' },
        h('div', { class: 'card-h' }, this.title = h('h3', { class: 'mono' }, ''), this.meta = h('span', { class: 'sub' }, ''),
          h('div', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => this.copy() }, '⧉ Copy'), h('button', { class: 'btn sm', onclick: () => CS.dom.download(this.cur.split('/').pop(), window.CS_SOURCES[this.cur]) }, '⤓ Download'))),
        this.code = h('div', { class: 'src-code' }));
      lay.append(this.tree, this.view);
      this.buildTree();
      if (!this.files.length) {
        this.code.innerHTML = '<div style="padding:16px" class="muted">Could not load sources from the server (GET /api/sources).</div>';
        return;
      }
      this.open(window.CS_SOURCES['server/host.js'] ? 'server/host.js' : 'firmware/main.py');
    },

    buildTree(filter) {
      this.tree.innerHTML = '';
      const used = new Set();
      GROUPS.forEach(([title, test]) => {
        const list = this.files.filter((f) => !used.has(f) && test(f));
        list.forEach((f) => used.add(f));
        const shown = filter ? list.filter((f) => filter.has(f)) : list;
        if (!shown.length) return;
        this.tree.appendChild(h('div', { class: 'dir' }, title));
        shown.forEach((f) => {
          const ext = f.split('.').pop();
          const lines = window.CS_SOURCES[f].split('\n').length;
          this.tree.appendChild(h('div', { class: 'file' + (f === this.cur ? ' on' : ''), title: `${f} · ${lines} lines`, 'data-f': f, onclick: () => this.open(f) }, h('span', { class: 'ext' }, ext), f.replace(/^(firmware|cloud|engine|server|public|tools)\//, '')));
        });
      });
    },

    open(path, anchor) {
      const text = (window.CS_SOURCES || {})[path];
      if (text == null) { this.app.toast('File not in bundle', path, 'err'); return; }
      this.cur = path;
      [...this.tree.querySelectorAll('.file')].forEach((f) => f.classList.toggle('on', f.dataset.f === path));
      const lang = CS.highlight.langOf(path);
      const lines = splitLines(CS.highlight(text, lang));
      this.title.textContent = path;
      this.meta.textContent = `${lines.length} lines · ${lang} · ${CS.util.fmt.bytes(new Blob([text]).size)}`;
      this.code.innerHTML = `<table><tbody>${lines.map((l, i) => `<tr id="L${i + 1}"><td class="ln">${i + 1}</td><td class="lc">${l || ' '}</td></tr>`).join('')}</tbody></table>`;
      this.code.scrollTop = 0;
      if (anchor) {
        const raw = text.split('\n');
        const idx = typeof anchor === 'number' ? anchor - 1 : raw.findIndex((l) => l.includes(anchor));
        if (idx >= 0) {
          const row = this.code.querySelector(`#L${idx + 1}`);
          requestAnimationFrame(() => { this.code.scrollTop = Math.max(0, row.offsetTop - 80); });
          for (let i = idx; i < Math.min(raw.length, idx + 6); i++) this.code.querySelector(`#L${i + 1}`).classList.add('flash');
        }
      }
    },

    doSearch() {
      const q = this.search.value.trim().toLowerCase();
      if (q.length < 2) { this.buildTree(); return; }
      const hits = new Set(this.files.filter((f) => f.toLowerCase().includes(q) || window.CS_SOURCES[f].toLowerCase().includes(q)));
      this.buildTree(hits);
      const first = [...hits][0];
      if (first && !hits.has(this.cur)) this.open(first, window.CS_SOURCES[first].toLowerCase().includes(q) ? window.CS_SOURCES[first].split('\n').findIndex((l) => l.toLowerCase().includes(q)) + 1 : null);
      else if (hits.has(this.cur)) {
        const idx = window.CS_SOURCES[this.cur].split('\n').findIndex((l) => l.toLowerCase().includes(q));
        if (idx >= 0) this.open(this.cur, idx + 1);
      }
    },

    copy() {
      navigator.clipboard && navigator.clipboard.writeText(window.CS_SOURCES[this.cur]).then(() => this.app.toast('Copied', this.cur, 'ok'), () => this.app.toast('Copy blocked by the browser', 'Use Download instead.', 'warn'));
    },

    render() {},
  };

  CS.views.source = src;
})(window.CS = window.CS || {});
