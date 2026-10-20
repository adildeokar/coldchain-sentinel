/* Tiny DOM toolkit: element builders, toasts, modal, tooltip, downloads, SVG export. */
(function (CS) {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function apply(el, attrs) {
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
  }
  function add(el, kids) {
    kids.flat(Infinity).forEach((c) => { if (c == null || c === false) return; el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); });
  }
  function h(tag, attrs, ...kids) { const el = document.createElement(tag); apply(el, attrs); add(el, kids); return el; }
  function s(tag, attrs, ...kids) { const el = document.createElementNS(SVGNS, tag); apply(el, attrs); add(el, kids); return el; }

  function toast(title, text = '', kind = 'info', ms = 4200) {
    const box = $('#toasts');
    if (!box) return;
    const t = h('div', { class: `toast ${kind}` }, h('b', null, title), text ? h('div', { class: 'muted' }, text) : null);
    box.appendChild(t);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => t.remove(), ms);
  }

  function modal(title, body) {
    const m = $('#modal');
    $('.m-title', m).textContent = title;
    const b = $('.m-body', m);
    b.innerHTML = '';
    if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
    m.hidden = false;
    const close = () => (m.hidden = true);
    $('.m-close', m).onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
    return close;
  }

  const tip = {
    show(e, html) {
      const t = $('#tip');
      t.innerHTML = html; t.hidden = false;
      const x = Math.min(window.innerWidth - t.offsetWidth - 12, e.clientX + 14);
      const y = Math.min(window.innerHeight - t.offsetHeight - 12, e.clientY + 14);
      t.style.left = x + 'px'; t.style.top = y + 'px';
    },
    hide() { $('#tip').hidden = true; },
  };

  function download(name, text, mime = 'text/plain') {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Inline computed styles so an exported SVG looks the same outside the app
  const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity'];
  function exportSvg(svgEl, name) {
    const clone = svgEl.cloneNode(true);
    const src = [svgEl, ...svgEl.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((el, i) => {
      const cs = getComputedStyle(el);
      const st = PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
      dst[i].setAttribute('style', st);
      dst[i].removeAttribute('class');
    });
    clone.setAttribute('xmlns', SVGNS);
    const bg = getComputedStyle(document.body).getPropertyValue('--panel').trim() || '#fff';
    const vb = (svgEl.getAttribute('viewBox') || '0 0 100 100').split(/\s+/);
    clone.insertBefore(s('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: bg }), clone.firstChild);
    download(name, '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone), 'image/svg+xml');
  }

  function json(obj) { return CS.highlight ? CS.highlight(JSON.stringify(obj, null, 2), 'json') : esc(JSON.stringify(obj, null, 2)); }

  function badge(text, kind = '') { return `<span class="badge ${kind}">${esc(text)}</span>`; }

  function statusKind(s) { return { OK: 'ok', WARN: 'warn', ALARM: 'err', FAULT: 'err' }[s] || ''; }

  CS.dom = { $, $$, h, s, esc, toast, modal, tip, download, exportSvg, json, badge, statusKind };
})(window.CS = window.CS || {});
