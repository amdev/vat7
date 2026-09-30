/* VAT7 ครู – แอพคำนวณภาษีมูลค่าเพิ่ม 7% (SPA + PWA, ไม่ต้อง build) */
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const KEYS = {
    settings: 'vat7:settings',
    history: 'vat7:history',
    quick: 'vat7:quick',
    items: 'vat7:items',
    installDismissed: 'vat7:installDismissed',
  };
  const DEFAULTS = { vatRate: 7, whtRate: 1, whtThreshold: true, thresholdAmount: 10000, theme: 'auto' };
  const MAX_HISTORY = 100;

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ } }

  const round2 = x => Math.round(Number((x * 100).toPrecision(12))) / 100;
  const fmt = n => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQty = n => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const pct = r => `${+r}%`;
  const thaiDigits = s => String(s).replace(/[๐-๙]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0E50 + 48));
  function parseNum(s) {
    if (typeof s === 'number') return Number.isFinite(s) ? s : 0;
    const n = parseFloat(thaiDigits(s ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // อ่านจำนวนเงินเป็นตัวอักษรไทย เช่น 1,070.50 → หนึ่งพันเจ็ดสิบบาทห้าสิบสตางค์
  function bahtText(amount) {
    const NUM = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
    const POS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
    function group(n, hasHigher) { // 0 – 999,999
      if (n === 0) return '';
      const s = String(n), len = s.length;
      let out = '';
      for (let i = 0; i < len; i++) {
        const d = +s[i], p = len - 1 - i;
        if (d === 0) continue;
        if (p === 0) out += (d === 1 && (len > 1 || hasHigher)) ? 'เอ็ด' : NUM[d];
        else if (p === 1) out += (d === 1 ? '' : d === 2 ? 'ยี่' : NUM[d]) + 'สิบ';
        else out += NUM[d] + POS[p];
      }
      return out;
    }
    function integer(n, hasHigher = false) {
      if (n < 1e6) return group(n, hasHigher);
      return integer(Math.floor(n / 1e6), hasHigher) + 'ล้าน' + group(n % 1e6, true);
    }
    const satangTotal = Math.round(round2(Math.abs(amount || 0)) * 100);
    const baht = Math.floor(satangTotal / 100), st = satangTotal % 100;
    if (baht === 0 && st === 0) return 'ศูนย์บาทถ้วน';
    let out = baht > 0 ? integer(baht) + 'บาท' : '';
    out += st > 0 ? group(st, false) + 'สตางค์' : 'ถ้วน';
    return out;
  }

  // ---------- core calculation ----------
  function calc({ amount, inclusive, vatRate, whtRate, applyThreshold, thresholdAmount }) {
    amount = round2(Math.max(0, amount || 0));
    vatRate = Math.max(0, +vatRate || 0);
    whtRate = Math.max(0, +whtRate || 0);
    let base, vat, total;
    if (inclusive) {
      total = amount;
      base = round2(total * 100 / (100 + vatRate));
      vat = round2(total - base);
    } else {
      base = amount;
      vat = round2(base * vatRate / 100);
      total = round2(base + vat);
    }
    const whtApplies = whtRate > 0 && (!applyThreshold || base >= (+thresholdAmount || 0));
    const wht = whtApplies ? round2(base * whtRate / 100) : 0;
    const net = round2(total - wht);
    return { amount, base, vat, total, wht, net, whtApplies, vatRate, whtRate, inclusive };
  }

  // ---------- state ----------
  let settings = Object.assign({}, DEFAULTS, load(KEYS.settings, {}));
  let quick = Object.assign({ amount: '', inclusive: true, whtRate: null }, load(KEYS.quick, {}));
  let items = Object.assign({ title: '', inclusive: true, whtRate: null, rows: [] }, load(KEYS.items, {}));
  let history = load(KEYS.history, []);
  if (!Array.isArray(history)) history = [];
  if (!Array.isArray(items.rows)) items.rows = [];
  if (items.rows.length === 0) items.rows.push({ name: '', qty: '', price: '' });

  const settingsFor = (whtRate) => ({
    vatRate: settings.vatRate,
    whtRate: whtRate == null ? settings.whtRate : whtRate,
    applyThreshold: settings.whtThreshold,
    thresholdAmount: settings.thresholdAmount,
  });

  // ---------- UI: toast ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }
  async function shareText(title, text) {
    if (navigator.share) {
      try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (await copyText(text)) toast('อุปกรณ์นี้แชร์ตรงไม่ได้ คัดลอกข้อความให้แล้ว');
    else toast('ไม่สามารถแชร์ได้');
  }

  // ---------- theme ----------
  function applyTheme() {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f1418' : '#0f766e');
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  // ---------- router ----------
  const VIEWS = ['quick', 'items', 'history', 'settings'];
  function currentView() {
    const v = (location.hash || '#/quick').replace(/^#\/?/, '').split('?')[0];
    return VIEWS.includes(v) ? v : 'quick';
  }
  function route() {
    const v = currentView();
    VIEWS.forEach(id => { $('#view-' + id).hidden = id !== v; });
    $$('.tabbar a').forEach(a => a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false'));
    if (v === 'history') renderHistory();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);

  // ---------- Quick view ----------
  const q = {
    amount: $('#q-amount'), label: $('#q-amount-label'), base: $('#q-base'), vat: $('#q-vat'), vatLabel: $('#q-vat-label'),
    total: $('#q-total'), text: $('#q-text'), wht: $('#q-wht'), whtBox: $('#q-wht-box'), whtLabel: $('#q-wht-label'),
    whtAmt: $('#q-wht-amt'), net: $('#q-net'), whtNote: $('#q-wht-note'),
  };

  function quickResult() {
    return calc({ amount: parseNum(quick.amount), inclusive: quick.inclusive, ...settingsFor(quick.whtRate) });
  }

  function renderQuick() {
    const r = quickResult();
    $$('#view-quick .seg-btn').forEach(b => b.setAttribute('aria-checked', String((b.dataset.inclusive === '1') === quick.inclusive)));
    q.label.textContent = quick.inclusive ? 'ยอดเงินรวม VAT แล้ว (บาท)' : 'ยอดเงินยังไม่รวม VAT (บาท)';
    if (document.activeElement !== q.amount) q.amount.value = quick.amount;
    q.base.textContent = fmt(r.base);
    q.vatLabel.textContent = `VAT ${pct(r.vatRate)}`;
    q.vat.textContent = fmt(r.vat);
    q.total.textContent = fmt(r.total);
    q.text.textContent = bahtText(r.total);
    q.wht.value = String(r.whtRate);
    renderWht(q, r);
    save(KEYS.quick, quick);
  }

  function renderWht(el, r) {
    const show = r.whtRate > 0;
    el.whtBox.hidden = !show;
    if (!show) return;
    el.whtLabel.textContent = `หัก ณ ที่จ่าย ${pct(r.whtRate)}`;
    el.whtAmt.textContent = fmt(r.wht);
    el.net.textContent = fmt(r.net);
    const showNote = !r.whtApplies && r.amount > 0;
    el.whtNote.hidden = !showNote;
    if (showNote) el.whtNote.textContent = `ราคาก่อน VAT ต่ำกว่า ${fmt(settings.thresholdAmount)} บาท จึงยังไม่หัก ณ ที่จ่าย (ปรับเกณฑ์ได้ในหน้าตั้งค่า)`;
  }

  function quickText() {
    const r = quickResult();
    const lines = [
      `ยอดที่กรอก: ${fmt(r.amount)} บาท (${r.inclusive ? 'รวม VAT แล้ว' : 'ยังไม่รวม VAT'})`,
      `ราคาก่อน VAT: ${fmt(r.base)}`,
      `VAT ${pct(r.vatRate)}: ${fmt(r.vat)}`,
      `รวมทั้งสิ้น: ${fmt(r.total)} (${bahtText(r.total)})`,
    ];
    if (r.whtRate > 0 && r.whtApplies) {
      lines.push(`หัก ณ ที่จ่าย ${pct(r.whtRate)}: ${fmt(r.wht)}`);
      lines.push(`ยอดจ่ายสุทธิ: ${fmt(r.net)} (${bahtText(r.net)})`);
    }
    return lines.join('\n');
  }

  $$('#view-quick .seg-btn').forEach(b => b.addEventListener('click', () => {
    quick.inclusive = b.dataset.inclusive === '1';
    renderQuick();
  }));
  q.amount.addEventListener('input', () => { quick.amount = q.amount.value; renderQuick(); });
  q.amount.addEventListener('blur', () => {
    const n = parseNum(quick.amount);
    quick.amount = n > 0 ? fmt(n) : '';
    renderQuick();
  });
  q.amount.addEventListener('keydown', e => { if (e.key === 'Enter') q.amount.blur(); });
  $('#q-chips').addEventListener('click', e => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    if (btn.dataset.add === 'clear') quick.amount = '';
    else quick.amount = fmt(parseNum(quick.amount) + parseNum(btn.dataset.add));
    renderQuick();
  });
  q.wht.addEventListener('change', () => { quick.whtRate = +q.wht.value; renderQuick(); });
  $('#q-copy').addEventListener('click', async () => { toast((await copyText(quickText())) ? 'คัดลอกผลลัพธ์แล้ว' : 'คัดลอกไม่สำเร็จ'); });
  $('#q-share').addEventListener('click', () => shareText('ผลคำนวณ VAT', quickText()));
  $('#q-save').addEventListener('click', () => {
    const r = quickResult();
    if (r.amount <= 0) { toast('กรุณากรอกยอดเงินก่อน'); return; }
    addHistory({
      type: 'quick',
      title: `${r.inclusive ? 'ถอด VAT' : 'บวก VAT'} ${fmt(r.amount)}`,
      data: { amount: quick.amount, inclusive: quick.inclusive, whtRate: r.whtRate },
      summary: { base: r.base, vat: r.vat, total: r.total, net: r.net },
    });
    toast('บันทึกลงประวัติแล้ว');
  });

  // ---------- Items view ----------
  const it = {
    title: $('#it-title'), rows: $('#it-rows'), count: $('#it-count'), base: $('#it-base'), vat: $('#it-vat'), vatLabel: $('#it-vat-label'),
    total: $('#it-total'), text: $('#it-text'), wht: $('#it-wht'), whtBox: $('#it-wht-box'), whtLabel: $('#it-wht-label'),
    whtAmt: $('#it-wht-amt'), net: $('#it-net'), whtNote: $('#it-wht-note'),
  };

  const lineTotal = row => round2(parseNum(row.qty) * parseNum(row.price));
  function itemsResult() {
    const sum = round2(items.rows.reduce((s, r) => s + lineTotal(r), 0));
    const r = calc({ amount: sum, inclusive: items.inclusive, ...settingsFor(items.whtRate) });
    r.count = items.rows.filter(row => lineTotal(row) > 0 || (row.name || '').trim()).length;
    return r;
  }

  function rowHTML(row, i) {
    return `
      <div class="item-row" data-i="${i}">
        <div class="item-row-head">
          <span class="item-no">${i + 1}</span>
          <input class="it-name" type="text" placeholder="ชื่อรายการ เช่น กระดาษ A4" value="${esc(row.name)}" autocomplete="off">
          <button type="button" class="it-del" aria-label="ลบรายการที่ ${i + 1}">✕</button>
        </div>
        <div class="item-nums">
          <label>จำนวน<input class="it-qty" type="text" inputmode="decimal" placeholder="1" value="${esc(row.qty)}" autocomplete="off"></label>
          <span class="item-x">×</span>
          <label>ราคา/หน่วย<input class="it-price" type="text" inputmode="decimal" placeholder="0.00" value="${esc(row.price)}" autocomplete="off" enterkeyhint="next"></label>
          <div class="it-total">= <b>${fmt(lineTotal(row))}</b></div>
        </div>
      </div>`;
  }

  function renderItems() {
    $$('#view-items .seg-btn').forEach(b => b.setAttribute('aria-checked', String((b.dataset.inclusive === '1') === items.inclusive)));
    if (document.activeElement !== it.title) it.title.value = items.title || '';
    it.rows.innerHTML = items.rows.map(rowHTML).join('');
    renderItemTotals();
  }

  function renderItemTotals() {
    const r = itemsResult();
    it.count.textContent = String(r.count);
    it.base.textContent = fmt(r.base);
    it.vatLabel.textContent = `VAT ${pct(r.vatRate)}`;
    it.vat.textContent = fmt(r.vat);
    it.total.textContent = fmt(r.total);
    it.text.textContent = bahtText(r.total);
    it.wht.value = String(r.whtRate);
    renderWht(it, r);
    save(KEYS.items, items);
  }

  $$('#view-items .seg-btn').forEach(b => b.addEventListener('click', () => {
    items.inclusive = b.dataset.inclusive === '1';
    renderItems();
  }));
  it.title.addEventListener('input', () => { items.title = it.title.value; save(KEYS.items, items); });

  it.rows.addEventListener('input', e => {
    const rowEl = e.target.closest('.item-row'); if (!rowEl) return;
    const row = items.rows[+rowEl.dataset.i]; if (!row) return;
    if (e.target.classList.contains('it-name')) row.name = e.target.value;
    else if (e.target.classList.contains('it-qty')) row.qty = e.target.value;
    else if (e.target.classList.contains('it-price')) row.price = e.target.value;
    $('.it-total b', rowEl).textContent = fmt(lineTotal(row));
    renderItemTotals();
  });
  it.rows.addEventListener('focusout', e => {
    const rowEl = e.target.closest('.item-row'); if (!rowEl) return;
    const row = items.rows[+rowEl.dataset.i]; if (!row) return;
    if (e.target.classList.contains('it-price')) {
      const n = parseNum(row.price); row.price = n > 0 ? fmt(n) : ''; e.target.value = row.price;
    } else if (e.target.classList.contains('it-qty')) {
      const n = parseNum(row.qty); row.qty = n > 0 ? fmtQty(n) : ''; e.target.value = row.qty;
    }
    save(KEYS.items, items);
  });
  it.rows.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.classList.contains('it-price')) return;
    e.preventDefault();
    const rowEl = e.target.closest('.item-row');
    const i = +rowEl.dataset.i;
    if (i === items.rows.length - 1) addRow(); else $$('.it-name', it.rows)[i + 1]?.focus();
  });
  it.rows.addEventListener('click', e => {
    const del = e.target.closest('.it-del'); if (!del) return;
    const i = +del.closest('.item-row').dataset.i;
    items.rows.splice(i, 1);
    if (items.rows.length === 0) items.rows.push({ name: '', qty: '', price: '' });
    renderItems();
  });
  function addRow() {
    items.rows.push({ name: '', qty: '', price: '' });
    renderItems();
    const inputs = $$('.it-name', it.rows);
    inputs[inputs.length - 1]?.focus();
  }
  $('#it-add').addEventListener('click', addRow);
  it.wht.addEventListener('change', () => { items.whtRate = +it.wht.value; renderItemTotals(); });

  function itemsText() {
    const r = itemsResult();
    const lines = [];
    if ((items.title || '').trim()) lines.push(items.title.trim());
    lines.push(`(ราคาต่อหน่วย${items.inclusive ? 'รวม VAT แล้ว' : 'ยังไม่รวม VAT'})`);
    items.rows.forEach((row, i) => {
      const lt = lineTotal(row);
      if (lt <= 0 && !(row.name || '').trim()) return;
      lines.push(`${i + 1}. ${(row.name || '').trim() || '-'} ${fmtQty(parseNum(row.qty))} × ${fmt(parseNum(row.price))} = ${fmt(lt)}`);
    });
    lines.push(`รวมก่อน VAT: ${fmt(r.base)}`);
    lines.push(`VAT ${pct(r.vatRate)}: ${fmt(r.vat)}`);
    lines.push(`รวมทั้งสิ้น: ${fmt(r.total)} (${bahtText(r.total)})`);
    if (r.whtRate > 0 && r.whtApplies) {
      lines.push(`หัก ณ ที่จ่าย ${pct(r.whtRate)}: ${fmt(r.wht)}`);
      lines.push(`ยอดจ่ายสุทธิ: ${fmt(r.net)} (${bahtText(r.net)})`);
    }
    return lines.join('\n');
  }

  function buildPrintSheet() {
    const r = itemsResult();
    const rows = items.rows.filter(row => lineTotal(row) > 0 || (row.name || '').trim());
    const date = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
    let html = `<h2>${esc((items.title || '').trim() || 'รายการสินค้า')}</h2>`;
    html += `<div class="print-meta">วันที่พิมพ์ ${esc(date)} · ราคาต่อหน่วย${items.inclusive ? 'รวม VAT แล้ว' : 'ยังไม่รวม VAT'}</div>`;
    html += `<table><thead><tr><th>ลำดับ</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ราคา/หน่วย</th><th class="num">จำนวนเงิน</th></tr></thead><tbody>`;
    rows.forEach((row, i) => {
      html += `<tr><td class="c">${i + 1}</td><td>${esc((row.name || '').trim() || '-')}</td><td class="num">${fmtQty(parseNum(row.qty))}</td><td class="num">${fmt(parseNum(row.price))}</td><td class="num">${fmt(lineTotal(row))}</td></tr>`;
    });
    html += `</tbody><tfoot>`;
    html += `<tr><td colspan="4" class="num">รวมก่อน VAT</td><td class="num">${fmt(r.base)}</td></tr>`;
    html += `<tr><td colspan="4" class="num">VAT ${pct(r.vatRate)}</td><td class="num">${fmt(r.vat)}</td></tr>`;
    html += `<tr><td colspan="4" class="num">รวมทั้งสิ้น</td><td class="num">${fmt(r.total)}</td></tr>`;
    if (r.whtRate > 0 && r.whtApplies) {
      html += `<tr><td colspan="4" class="num">หัก ณ ที่จ่าย ${pct(r.whtRate)}</td><td class="num">${fmt(r.wht)}</td></tr>`;
      html += `<tr><td colspan="4" class="num">ยอดจ่ายสุทธิ</td><td class="num">${fmt(r.net)}</td></tr>`;
    }
    html += `</tfoot></table>`;
    html += `<div class="print-text">ตัวอักษร: (${esc(bahtText(r.total))})</div>`;
    $('#print-sheet').innerHTML = html;
  }
  window.addEventListener('beforeprint', buildPrintSheet);

  $('#it-copy').addEventListener('click', async () => { toast((await copyText(itemsText())) ? 'คัดลอกสรุปแล้ว' : 'คัดลอกไม่สำเร็จ'); });
  $('#it-share').addEventListener('click', () => shareText('สรุปรายการสินค้า', itemsText()));
  $('#it-print').addEventListener('click', () => { buildPrintSheet(); window.print(); });
  $('#it-save').addEventListener('click', () => {
    const r = itemsResult();
    if (r.total <= 0) { toast('กรุณากรอกรายการก่อน'); return; }
    addHistory({
      type: 'items',
      title: (items.title || '').trim() || `รายการสินค้า ${r.count} รายการ`,
      data: JSON.parse(JSON.stringify({ title: items.title, inclusive: items.inclusive, whtRate: r.whtRate, rows: items.rows })),
      summary: { base: r.base, vat: r.vat, total: r.total, net: r.net, count: r.count },
    });
    toast('บันทึกลงประวัติแล้ว');
  });
  $('#it-clear').addEventListener('click', () => {
    if (!confirm('ล้างรายการทั้งหมดในหน้านี้?')) return;
    items = { title: '', inclusive: items.inclusive, whtRate: items.whtRate, rows: [{ name: '', qty: '', price: '' }] };
    renderItems();
  });

  // ---------- History ----------
  function addHistory(entry) {
    history.unshift(Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now() }, entry));
    history = history.slice(0, MAX_HISTORY);
    save(KEYS.history, history);
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return new Date(ts).toLocaleString(); }
  }
  function renderHistory() {
    const list = $('#hist-list');
    $('#hist-empty').hidden = history.length > 0;
    list.innerHTML = history.map(h => `
      <div class="hist-item" data-id="${esc(h.id)}">
        <div class="hist-main">
          <div class="hist-title">${esc(h.title)}</div>
          <div class="hist-sub">${h.type === 'items' ? 'รายการสินค้า' : 'คำนวณเร็ว'} · ${esc(fmtDate(h.ts))} · VAT ${fmt(h.summary?.vat)}</div>
        </div>
        <div class="hist-amt">${fmt(h.summary?.total)}</div>
        <div class="hist-actions">
          <button type="button" class="btn btn-small hist-open">เปิด</button>
          <button type="button" class="btn btn-small btn-ghost hist-del" aria-label="ลบ">✕</button>
        </div>
      </div>`).join('');
  }
  $('#hist-list').addEventListener('click', e => {
    const item = e.target.closest('.hist-item'); if (!item) return;
    const idx = history.findIndex(h => h.id === item.dataset.id); if (idx < 0) return;
    const h = history[idx];
    if (e.target.closest('.hist-del')) {
      history.splice(idx, 1); save(KEYS.history, history); renderHistory(); return;
    }
    if (e.target.closest('.hist-open')) {
      if (h.type === 'items') {
        items = Object.assign({ title: '', inclusive: true, whtRate: null, rows: [] }, JSON.parse(JSON.stringify(h.data)));
        if (!items.rows.length) items.rows.push({ name: '', qty: '', price: '' });
        renderItems();
        location.hash = '#/items';
      } else {
        quick = Object.assign({ amount: '', inclusive: true, whtRate: null }, h.data);
        renderQuick();
        location.hash = '#/quick';
      }
      toast('เปิดรายการจากประวัติแล้ว');
    }
  });
  $('#hist-clear').addEventListener('click', () => {
    if (!history.length) return;
    if (!confirm('ลบประวัติทั้งหมด?')) return;
    history = []; save(KEYS.history, history); renderHistory();
  });

  // ---------- Settings ----------
  const s = { vat: $('#s-vat'), wht: $('#s-wht'), threshold: $('#s-threshold'), thresholdAmt: $('#s-threshold-amt'), theme: $('#s-theme') };
  function renderSettings() {
    s.vat.value = settings.vatRate;
    s.wht.value = String(settings.whtRate);
    s.threshold.checked = !!settings.whtThreshold;
    s.thresholdAmt.value = settings.thresholdAmount;
    s.thresholdAmt.disabled = !settings.whtThreshold;
    s.theme.value = settings.theme;
    $('#topbar-rate').textContent = `VAT ${pct(settings.vatRate)}`;
    $('#app-version').textContent = APP_VERSION;
  }
  function commitSettings() {
    save(KEYS.settings, settings);
    applyTheme();
    renderSettings();
    renderQuick();
    renderItemTotals();
  }
  s.vat.addEventListener('change', () => { const v = parseNum(s.vat.value); settings.vatRate = Math.min(100, Math.max(0, v)); commitSettings(); });
  s.wht.addEventListener('change', () => { settings.whtRate = +s.wht.value; commitSettings(); });
  s.threshold.addEventListener('change', () => { settings.whtThreshold = s.threshold.checked; commitSettings(); });
  s.thresholdAmt.addEventListener('change', () => { settings.thresholdAmount = Math.max(0, parseNum(s.thresholdAmt.value)); commitSettings(); });
  s.theme.addEventListener('change', () => { settings.theme = s.theme.value; commitSettings(); });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('ล้างข้อมูล ประวัติ และการตั้งค่าทั้งหมด?')) return;
    Object.values(KEYS).forEach(k => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
    location.reload();
  });

  // ---------- Install (PWA) ----------
  let deferredPrompt = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  function renderInstall() {
    const installed = isStandalone();
    $('#install-done').hidden = !installed;
    $('#btn-install').hidden = installed || !deferredPrompt;
    $('#install-ios').hidden = installed || !isIOS();
    $('#install-banner').hidden = installed || !deferredPrompt || load(KEYS.installDismissed, false) === true;
  }
  async function promptInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch { /* ignore */ }
    deferredPrompt = null;
    renderInstall();
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; toast('ติดตั้งแอพแล้ว'); renderInstall(); });
  $('#btn-install').addEventListener('click', promptInstall);
  $('#btn-install-banner').addEventListener('click', promptInstall);
  $('#btn-install-dismiss').addEventListener('click', () => { save(KEYS.installDismissed, true); renderInstall(); });

  // ---------- Service worker ----------
  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        const showUpdate = () => {
          const banner = $('#update-banner');
          banner.hidden = false;
          $('#btn-update').onclick = () => { reg.waiting?.postMessage({ type: 'SKIP_WAITING' }); banner.hidden = true; };
        };
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing; if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate();
          });
        });
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshing) return; refreshing = true; location.reload();
        });
      } catch { /* offline or unsupported */ }
    });
  }

  // ---------- init ----------
  applyTheme();
  renderSettings();
  renderQuick();
  renderItems();
  renderInstall();
  route();
  setupServiceWorker();
})();
