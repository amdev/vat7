/* VAT7 ครู – แอพคำนวณภาษีมูลค่าเพิ่ม 7% ตามแบบฎีกาเบิกจ่าย (SPA + PWA, ไม่ต้อง build) */
(() => {
  'use strict';

  const APP_VERSION = '1.1.0';
  const KEYS = {
    settings: 'vat7:settings',
    history: 'vat7:history',
    quick: 'vat7:quick',
    items: 'vat7:items',
    installDismissed: 'vat7:installDismissed',
  };
  const DEFAULTS = {
    vatRate: 7, whtRate: 1, payeeType: 'juristic', thresholdAmount: 10000, theme: 'auto',
    agency: { name: '', taxId: '', address: '', phone: '', signer: '' },
  };
  const PAYEE_LABEL = { juristic: 'นิติบุคคล (บริษัท/หจก.)', individual: 'บุคคลธรรมดา' };
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
  const nl2br = s => esc(s).replace(/\n/g, '<br>');
  const dots = (n = 20) => '.'.repeat(n);
  const thaiDate = (d = new Date()) => d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  // ปีงบประมาณ พ.ศ. (เริ่ม 1 ตุลาคม)
  const fiscalYearBE = (d = new Date()) => d.getFullYear() + 543 + (d.getMonth() >= 9 ? 1 : 0);

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

  // ---------- core calculation (ตามแบบแนบฎีกาแสดงรายการภาษี) ----------
  // amount       ยอดที่กรอก (รวม VAT หรือยังไม่รวม ตาม inclusive)
  // base         ค่าสินค้าหรือบริการ (ก่อน VAT)
  // vat          ภาษีมูลค่าเพิ่ม
  // total        จำนวนเงินที่เบิกตามฎีกา (รวม VAT)
  // wht          เงินหักผลักส่งภาษีเงินได้ (หัก ณ ที่จ่าย) คิดจาก base
  // penalty      ค่าปรับ
  // net          จำนวนเงินขอรับ = total − wht − penalty
  function calc({ amount, inclusive, vatRate, whtRate, payeeType, thresholdAmount, penalty }) {
    amount = round2(Math.max(0, amount || 0));
    vatRate = Math.max(0, +vatRate || 0);
    whtRate = Math.max(0, +whtRate || 0);
    penalty = round2(Math.max(0, penalty || 0));
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
    // นิติบุคคล: หักทุกจำนวน (ม.69 ทวิ) / บุคคลธรรมดา: หักเมื่อถึงเกณฑ์ขั้นต่ำ (ม.50(4))
    const whtApplies = whtRate > 0 && (payeeType !== 'individual' || base >= (+thresholdAmount || 0));
    const wht = whtApplies ? round2(base * whtRate / 100) : 0;
    const net = round2(total - wht - penalty);
    return { amount, base, vat, total, wht, penalty, net, whtApplies, vatRate, whtRate, inclusive, payeeType };
  }

  // ---------- state ----------
  let settings = Object.assign({}, DEFAULTS, load(KEYS.settings, {}));
  settings.agency = Object.assign({}, DEFAULTS.agency, settings.agency || {});
  if (!PAYEE_LABEL[settings.payeeType]) settings.payeeType = 'juristic';

  const QUICK_DEFAULT = { amount: '', inclusive: true, whtRate: null, payeeType: null, penalty: '' };
  const ITEMS_DEFAULT = {
    docNo: '', fy: '', title: '', vendor: '', vendorTaxId: '', vendorAddress: '',
    inclusive: true, whtRate: null, payeeType: null, penalty: '', rows: [],
  };
  const newRow = () => ({ name: '', qty: '', price: '' });

  let quick = Object.assign({}, QUICK_DEFAULT, load(KEYS.quick, {}));
  let items = Object.assign({}, ITEMS_DEFAULT, load(KEYS.items, {}));
  let history = load(KEYS.history, []);
  if (!Array.isArray(history)) history = [];
  if (!Array.isArray(items.rows)) items.rows = [];
  if (items.rows.length === 0) items.rows.push(newRow());

  const paramsFor = st => ({
    vatRate: settings.vatRate,
    whtRate: st.whtRate == null ? settings.whtRate : st.whtRate,
    payeeType: st.payeeType || settings.payeeType,
    thresholdAmount: settings.thresholdAmount,
    penalty: parseNum(st.penalty),
  });

  // ---------- UI: toast / clipboard / share ----------
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

  // ---------- shared result block ----------
  function resultEls(p) {
    return {
      total: $(`#${p}-total`), textTotal: $(`#${p}-text-total`), vat: $(`#${p}-vat`), vatLabel: $(`#${p}-vat-label`),
      base: $(`#${p}-base`), whtRow: $(`#${p}-wht-row`), whtLabel: $(`#${p}-wht-label`), whtAmt: $(`#${p}-wht-amt`),
      penaltyRow: $(`#${p}-penalty-row`), penaltyAmt: $(`#${p}-penalty-amt`), net: $(`#${p}-net`),
      textNet: $(`#${p}-text-net`), whtNote: $(`#${p}-wht-note`),
      wht: $(`#${p}-wht`), payee: $(`#${p}-payee`), penalty: $(`#${p}-penalty`),
    };
  }
  function renderResult(el, r, st) {
    el.total.textContent = fmt(r.total);
    el.textTotal.textContent = bahtText(r.total);
    el.vatLabel.textContent = `ภาษีมูลค่าเพิ่ม ${pct(r.vatRate)}`;
    el.vat.textContent = fmt(r.vat);
    el.base.textContent = fmt(r.base);
    el.whtRow.hidden = r.whtRate === 0;
    el.whtLabel.textContent = `ภาษีเงินได้หัก ณ ที่จ่าย ${pct(r.whtRate)}`;
    el.whtAmt.textContent = fmt(r.wht);
    el.penaltyRow.hidden = r.penalty === 0;
    el.penaltyAmt.textContent = fmt(r.penalty);
    el.net.textContent = fmt(r.net);
    el.textNet.textContent = bahtText(r.net);
    const showNote = r.whtRate > 0 && !r.whtApplies && r.amount > 0;
    el.whtNote.hidden = !showNote;
    if (showNote) el.whtNote.textContent = `บุคคลธรรมดา: ค่าสินค้า/บริการต่ำกว่า ${fmt(settings.thresholdAmount)} บาท จึงไม่หักภาษี ณ ที่จ่าย (ม.50(4))`;
    el.wht.value = String(r.whtRate);
    el.payee.value = r.payeeType;
    if (document.activeElement !== el.penalty) el.penalty.value = st.penalty || '';
  }
  function resultLines(r) {
    const lines = [
      `จำนวนเงินที่เบิก (รวม VAT): ${fmt(r.total)} บาท (${bahtText(r.total)})`,
      `ภาษีมูลค่าเพิ่ม ${pct(r.vatRate)}: ${fmt(r.vat)}`,
      `ค่าสินค้าหรือบริการ (ก่อน VAT): ${fmt(r.base)}`,
    ];
    if (r.whtRate > 0) lines.push(`ภาษีเงินได้หัก ณ ที่จ่าย ${pct(r.whtRate)} (${PAYEE_LABEL[r.payeeType]}): ${fmt(r.wht)}`);
    if (r.penalty > 0) lines.push(`หัก ค่าปรับ: ${fmt(r.penalty)}`);
    lines.push(`จำนวนเงินขอรับ (สุทธิ): ${fmt(r.net)} บาท (${bahtText(r.net)})`);
    return lines;
  }
  function bindResultInputs(el, st, rerender) {
    el.wht.addEventListener('change', () => { st.whtRate = +el.wht.value; rerender(); });
    el.payee.addEventListener('change', () => { st.payeeType = el.payee.value; rerender(); });
    el.penalty.addEventListener('input', () => { st.penalty = el.penalty.value; rerender(); });
    el.penalty.addEventListener('blur', () => { const n = parseNum(st.penalty); st.penalty = n > 0 ? fmt(n) : ''; rerender(); });
  }

  // ---------- Quick view ----------
  const q = resultEls('q');
  q.amount = $('#q-amount'); q.label = $('#q-amount-label');

  const quickResult = () => calc({ amount: parseNum(quick.amount), inclusive: quick.inclusive, ...paramsFor(quick) });

  function renderQuick() {
    const r = quickResult();
    $$('#view-quick .seg-btn').forEach(b => b.setAttribute('aria-checked', String((b.dataset.inclusive === '1') === quick.inclusive)));
    q.label.textContent = quick.inclusive ? 'จำนวนเงินที่ขอเบิก รวม VAT แล้ว (บาท)' : 'ค่าสินค้าหรือบริการ ยังไม่รวม VAT (บาท)';
    if (document.activeElement !== q.amount) q.amount.value = quick.amount;
    renderResult(q, r, quick);
    save(KEYS.quick, quick);
  }
  function quickText() {
    const r = quickResult();
    return [`ยอดที่กรอก: ${fmt(r.amount)} บาท (${r.inclusive ? 'รวม VAT แล้ว' : 'ยังไม่รวม VAT'})`, ...resultLines(r)].join('\n');
  }

  $$('#view-quick .seg-btn').forEach(b => b.addEventListener('click', () => { quick.inclusive = b.dataset.inclusive === '1'; renderQuick(); }));
  q.amount.addEventListener('input', () => { quick.amount = q.amount.value; renderQuick(); });
  q.amount.addEventListener('blur', () => { const n = parseNum(quick.amount); quick.amount = n > 0 ? fmt(n) : ''; renderQuick(); });
  q.amount.addEventListener('keydown', e => { if (e.key === 'Enter') q.amount.blur(); });
  $('#q-chips').addEventListener('click', e => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    if (btn.dataset.add === 'clear') { quick.amount = ''; quick.penalty = ''; }
    else quick.amount = fmt(parseNum(quick.amount) + parseNum(btn.dataset.add));
    renderQuick();
  });
  bindResultInputs(q, quick, renderQuick);
  $('#q-copy').addEventListener('click', async () => { toast((await copyText(quickText())) ? 'คัดลอกผลลัพธ์แล้ว' : 'คัดลอกไม่สำเร็จ'); });
  $('#q-share').addEventListener('click', () => shareText('ผลคำนวณ VAT', quickText()));
  $('#q-save').addEventListener('click', () => {
    const r = quickResult();
    if (r.amount <= 0) { toast('กรุณากรอกยอดเงินก่อน'); return; }
    addHistory({
      type: 'quick',
      title: `${r.inclusive ? 'ถอด VAT' : 'บวก VAT'} ${fmt(r.amount)}`,
      data: { amount: quick.amount, inclusive: quick.inclusive, whtRate: r.whtRate, payeeType: r.payeeType, penalty: quick.penalty },
      summary: { base: r.base, vat: r.vat, total: r.total, net: r.net },
    });
    toast('บันทึกลงประวัติแล้ว');
  });

  // ---------- Items / ฎีกา view ----------
  const it = resultEls('it');
  Object.assign(it, {
    docNo: $('#it-docno'), fy: $('#it-fy'), title: $('#it-title'), vendor: $('#it-vendor'), taxId: $('#it-taxid'),
    address: $('#it-address'), rows: $('#it-rows'), count: $('#it-count'),
  });
  const TEXT_FIELDS = [['docNo', 'docNo'], ['fy', 'fy'], ['title', 'title'], ['vendor', 'vendor'], ['taxId', 'vendorTaxId'], ['address', 'vendorAddress']];

  const lineTotal = row => round2(parseNum(row.qty) * parseNum(row.price));
  const activeRows = () => items.rows.filter(row => lineTotal(row) > 0 || (row.name || '').trim());
  function itemsResult() {
    const sum = round2(items.rows.reduce((s, r) => s + lineTotal(r), 0));
    const r = calc({ amount: sum, inclusive: items.inclusive, ...paramsFor(items) });
    r.count = activeRows().length;
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
    TEXT_FIELDS.forEach(([el, key]) => { if (document.activeElement !== it[el]) it[el].value = items[key] || ''; });
    if (!items.fy && document.activeElement !== it.fy) it.fy.placeholder = String(fiscalYearBE());
    it.rows.innerHTML = items.rows.map(rowHTML).join('');
    renderItemTotals();
  }
  function renderItemTotals() {
    const r = itemsResult();
    it.count.textContent = String(r.count);
    renderResult(it, r, items);
    save(KEYS.items, items);
  }

  $$('#view-items .seg-btn').forEach(b => b.addEventListener('click', () => { items.inclusive = b.dataset.inclusive === '1'; renderItems(); }));
  TEXT_FIELDS.forEach(([el, key]) => it[el].addEventListener('input', () => { items[key] = it[el].value; save(KEYS.items, items); }));
  bindResultInputs(it, items, renderItemTotals);

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
    const i = +e.target.closest('.item-row').dataset.i;
    if (i === items.rows.length - 1) addRow(); else $$('.it-name', it.rows)[i + 1]?.focus();
  });
  it.rows.addEventListener('click', e => {
    const del = e.target.closest('.it-del'); if (!del) return;
    items.rows.splice(+del.closest('.item-row').dataset.i, 1);
    if (items.rows.length === 0) items.rows.push(newRow());
    renderItems();
  });
  function addRow() {
    items.rows.push(newRow());
    renderItems();
    const inputs = $$('.it-name', it.rows);
    inputs[inputs.length - 1]?.focus();
  }
  $('#it-add').addEventListener('click', addRow);

  function itemsText() {
    const r = itemsResult();
    const lines = [];
    if (items.docNo) lines.push(`ฎีกาที่ ${items.docNo}/${items.fy || fiscalYearBE()}`);
    if ((items.title || '').trim()) lines.push(`รายการ: ${items.title.trim()}`);
    if ((items.vendor || '').trim()) lines.push(`ผู้ขาย: ${items.vendor.trim()}${items.vendorTaxId ? ' เลขผู้เสียภาษี ' + items.vendorTaxId : ''}`);
    lines.push(`(ราคาต่อหน่วย${items.inclusive ? 'รวม VAT แล้ว' : 'ยังไม่รวม VAT'})`);
    activeRows().forEach((row, i) => {
      lines.push(`${i + 1}. ${(row.name || '').trim() || '-'} ${fmtQty(parseNum(row.qty))} × ${fmt(parseNum(row.price))} = ${fmt(lineTotal(row))}`);
    });
    return lines.concat(resultLines(r)).join('\n');
  }

  $('#it-copy').addEventListener('click', async () => { toast((await copyText(itemsText())) ? 'คัดลอกสรุปแล้ว' : 'คัดลอกไม่สำเร็จ'); });
  $('#it-share').addEventListener('click', () => shareText('สรุปฎีกา', itemsText()));
  $('#it-save').addEventListener('click', () => {
    const r = itemsResult();
    if (r.total <= 0) { toast('กรุณากรอกรายการก่อน'); return; }
    const title = (items.title || '').trim() || (items.vendor || '').trim() || `รายการสินค้า ${r.count} รายการ`;
    addHistory({
      type: 'items',
      title: items.docNo ? `ฎีกาที่ ${items.docNo} – ${title}` : title,
      data: JSON.parse(JSON.stringify({ ...items, whtRate: r.whtRate, payeeType: r.payeeType })),
      summary: { base: r.base, vat: r.vat, total: r.total, net: r.net, count: r.count },
    });
    toast('บันทึกลงประวัติแล้ว');
  });
  $('#it-clear').addEventListener('click', () => {
    if (!confirm('ล้างข้อมูลฎีกาและรายการทั้งหมดในหน้านี้?')) return;
    items = Object.assign({}, ITEMS_DEFAULT, { inclusive: items.inclusive, whtRate: items.whtRate, payeeType: items.payeeType, rows: [newRow()] });
    renderItems();
  });

  // ---------- Print documents ----------
  function agencyLine() {
    const a = settings.agency;
    return {
      name: a.name || dots(40), taxId: a.taxId || dots(16), address: a.address || dots(60),
      phone: a.phone || dots(12), signer: a.signer || dots(30),
    };
  }
  function docHeader() {
    return { docNo: items.docNo || dots(12), fy: items.fy || String(fiscalYearBE()) };
  }
  function checkbox(on) { return `<span class="pf-box">${on ? '✓' : '&nbsp;'}</span>`; }

  function sheetItems() {
    const r = itemsResult(), rows = activeRows(), h = docHeader();
    let html = `<div class="pf pf-portrait">`;
    html += `<h2 class="pf-center">${esc((items.title || '').trim() || 'รายการสินค้า')}</h2>`;
    html += `<div class="pf-meta">`;
    if (items.docNo) html += `ฎีกาที่ ${esc(h.docNo)}/${esc(h.fy)} · `;
    if (items.vendor) html += `ผู้ขาย ${esc(items.vendor)} · `;
    html += `ราคาต่อหน่วย${items.inclusive ? 'รวม VAT แล้ว' : 'ยังไม่รวม VAT'} · พิมพ์เมื่อ ${esc(thaiDate())}</div>`;
    html += `<table class="pf-table"><thead><tr><th>ลำดับ</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ราคา/หน่วย</th><th class="num">จำนวนเงิน</th></tr></thead><tbody>`;
    rows.forEach((row, i) => {
      html += `<tr><td class="c">${i + 1}</td><td>${esc((row.name || '').trim() || '-')}</td><td class="num">${fmtQty(parseNum(row.qty))}</td><td class="num">${fmt(parseNum(row.price))}</td><td class="num">${fmt(lineTotal(row))}</td></tr>`;
    });
    html += `</tbody><tfoot>`;
    const foot = (label, v) => `<tr><td colspan="4" class="num">${label}</td><td class="num">${fmt(v)}</td></tr>`;
    html += foot('จำนวนเงินที่เบิกตามฎีกา (รวม VAT)', r.total);
    html += foot(`ภาษีมูลค่าเพิ่ม ${pct(r.vatRate)}`, r.vat);
    html += foot('ค่าสินค้าหรือบริการ', r.base);
    if (r.whtRate > 0) html += foot(`ภาษีเงินได้หัก ณ ที่จ่าย ${pct(r.whtRate)}`, r.wht);
    if (r.penalty > 0) html += foot('หัก ค่าปรับ', r.penalty);
    html += foot('จำนวนเงินขอรับ', r.net);
    html += `</tfoot></table>`;
    html += `<div class="pf-text">จำนวนเงินขอรับ (ตัวอักษร): ${esc(bahtText(r.net))}</div></div>`;
    return html;
  }

  // แบบแนบฎีกาแสดงรายการภาษี
  function sheetAttach() {
    const r = itemsResult(), a = agencyLine(), h = docHeader();
    const payee = items.payeeType || settings.payeeType;
    let html = `<div class="pf pf-landscape">`;
    html += `<h2 class="pf-center">แบบแนบฎีกาแสดงรายการภาษี</h2>`;
    html += `<div class="pf-line pf-center">สำหรับ ${checkbox(payee === 'juristic')} บริษัท ห้างหุ้นส่วนนิติบุคคล &nbsp;&nbsp; ${checkbox(payee === 'individual')} บุคคลธรรมดา</div>`;
    html += `<div class="pf-line">ฎีกาที่ ${esc(h.docNo)}/${esc(h.fy)} &nbsp; ลงวันที่ ${dots(12)} เดือน ${dots(24)} พ.ศ. ${dots(10)}</div>`;
    html += `<div class="pf-line">ส่วนราชการ ${esc(a.name)} &nbsp; เลขประจำตัวผู้เสียภาษีอากร ${esc(a.taxId)}</div>`;
    html += `<div class="pf-line">ที่ตั้งส่วนราชการ ${esc(a.address)} &nbsp; โทรศัพท์ ${esc(a.phone)}</div>`;
    html += `<table class="pf-table pf-small"><thead><tr>
      <th>ลำดับที่</th><th>ชื่อผู้ประกอบการ<br>และเลขประจำตัวผู้เสียภาษี</th><th>เลขทะเบียนภาษีมูลค่าเพิ่ม<br>และที่อยู่</th><th>รายการซื้อ/จ้าง</th>
      <th class="num">จำนวนเงิน<br>ที่เบิกตามฎีกา</th><th class="num">ภาษีมูลค่าเพิ่ม</th><th class="num">ค่าสินค้า<br>หรือบริการ</th>
      <th class="num">เงินหักผลักส่ง<br>ภาษีเงินได้</th><th class="num">ค่าปรับ</th><th class="num">จำนวนเงิน<br>ขอรับ</th></tr></thead><tbody>`;
    html += `<tr><td class="c">1</td><td>${esc(items.vendor || dots(20))}<br>${esc(items.vendorTaxId || '')}</td><td>${nl2br(items.vendorAddress || '')}</td><td>${esc(items.title || '')}</td>
      <td class="num">${fmt(r.total)}</td><td class="num">${fmt(r.vat)}</td><td class="num">${fmt(r.base)}</td><td class="num">${fmt(r.wht)}</td><td class="num">${fmt(r.penalty)}</td><td class="num">${fmt(r.net)}</td></tr>`;
    html += `<tr class="pf-spacer"><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
    html += `</tbody><tfoot><tr><td colspan="4" class="c">รวม</td>
      <td class="num">${fmt(r.total)}</td><td class="num">${fmt(r.vat)}</td><td class="num">${fmt(r.base)}</td><td class="num">${fmt(r.wht)}</td><td class="num">${fmt(r.penalty)}</td><td class="num">${fmt(r.net)}</td></tr></tfoot></table>`;
    html += `<div class="pf-sign"><div>ลงชื่อ ${dots(40)}</div><div>ตำแหน่ง ${esc(a.signer)}</div></div>`;
    html += `<div class="pf-foot"><span>กรมบัญชีกลาง เลขที่รับ ${dots(20)}</span><span>ส่งกรมสรรพากร หรือสรรพากรจังหวัด</span></div></div>`;
    return html;
  }

  // ใบรับรองการหักภาษี ณ ที่จ่าย (แบบ บก.28)
  function sheetCert() {
    const r = itemsResult(), a = agencyLine(), h = docHeader();
    const payee = items.payeeType || settings.payeeType;
    let html = `<div class="pf pf-portrait">`;
    html += `<h2 class="pf-center">ใบรับรองการหักภาษี ณ ที่จ่าย (แบบ บก.28)</h2>`;
    html += `<div class="pf-line">ส่วนราชการ ${esc(a.name)} &nbsp; เลขประจำตัวผู้เสียภาษี ${esc(a.taxId)}</div>`;
    html += `<div class="pf-line">ที่อยู่ ${esc(a.address)}</div>`;
    html += `<div class="pf-line pf-indent">ขอรับรองว่าได้หักภาษี ณ ที่จ่าย ตามฎีกาเงินจากคลังที่ ${esc(h.docNo)}/${esc(h.fy)}</div>`;
    html += `<div class="pf-line">ลงวันที่ ${dots(14)} เดือน ${dots(28)} พ.ศ. ${dots(10)}</div>`;
    html += `<div class="pf-line">ชื่อผู้ถูกหักภาษี ${esc(items.vendor || dots(40))} &nbsp; เลขประจำตัวผู้เสียภาษี ${esc(items.vendorTaxId || dots(16))}</div>`;
    html += `<div class="pf-line">ที่อยู่ ${esc((items.vendorAddress || dots(60)).replace(/\n/g, ' '))}</div>`;
    html += `<table class="pf-table"><thead><tr><th>รายการ</th><th>ประเภทเงินได้ที่จ่าย</th><th>วันเดือนปีที่จ่ายเงิน</th><th class="num">จำนวนเงินได้</th><th class="num">ภาษี</th></tr></thead><tbody>`;
    html += `<tr><td class="pf-nowrap">${checkbox(payee === 'juristic')} ภาษีเงินได้นิติบุคคล<br>${checkbox(payee === 'individual')} ภาษีเงินได้บุคคลธรรมดา<br>${checkbox(r.penalty > 0)} ค่าปรับ</td>
      <td>${esc(items.title || '')}</td><td></td><td class="num">${fmt(r.base)}</td><td class="num">${fmt(r.wht)}</td></tr>`;
    if (r.penalty > 0) html += `<tr><td></td><td>ค่าปรับ</td><td></td><td class="num"></td><td class="num">${fmt(r.penalty)}</td></tr>`;
    html += `<tr class="pf-spacer"><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>`;
    html += `</tbody><tfoot><tr><td colspan="3" class="c">รวม</td><td class="num">${fmt(r.base)}</td><td class="num">${fmt(round2(r.wht + r.penalty))}</td></tr></tfoot></table>`;
    html += `<div class="pf-text">รวมเป็นเงิน (${esc(bahtText(round2(r.wht + r.penalty)))})</div>`;
    html += `<div class="pf-sign"><div>(ลงชื่อ) ${dots(40)}</div><div>${esc(a.signer)}</div><div>วันที่ ${dots(30)}</div></div></div>`;
    return html;
  }

  function sheetQuick() {
    const r = quickResult();
    let html = `<div class="pf pf-portrait"><h2 class="pf-center">ผลคำนวณภาษีมูลค่าเพิ่ม</h2><div class="pf-meta">พิมพ์เมื่อ ${esc(thaiDate())}</div><table class="pf-table"><tbody>`;
    resultLines(r).forEach(l => { const [k, v] = l.split(/:\s(.+)/); html += `<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`; });
    return html + `</tbody></table></div>`;
  }

  const SHEETS = { items: sheetItems, attach: sheetAttach, cert: sheetCert, quick: sheetQuick };
  let pendingPrint = null;
  function buildPrintSheet(kind) {
    const fn = SHEETS[kind] || sheetItems;
    $('#print-sheet').innerHTML = fn();
    let style = $('#print-page-style');
    if (!style) { style = document.createElement('style'); style.id = 'print-page-style'; document.head.appendChild(style); }
    style.textContent = `@page { size: A4 ${kind === 'attach' ? 'landscape' : 'portrait'}; margin: 12mm; }`;
  }
  function printDoc(kind) {
    pendingPrint = kind;
    buildPrintSheet(kind);
    window.print();
  }
  window.addEventListener('beforeprint', () => {
    if (!pendingPrint) buildPrintSheet(currentView() === 'quick' ? 'quick' : 'items');
  });
  window.addEventListener('afterprint', () => { pendingPrint = null; });
  $$('#view-items [data-print]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.print !== 'items' && !settings.agency.name) toast('แนะนำให้กรอกข้อมูลส่วนราชการในหน้าตั้งค่าก่อน');
    printDoc(b.dataset.print);
  }));

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
          <div class="hist-sub">${h.type === 'items' ? 'ฎีกา/รายการ' : 'คำนวณเร็ว'} · ${esc(fmtDate(h.ts))} · VAT ${fmt(h.summary?.vat)} · ขอรับ ${fmt(h.summary?.net)}</div>
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
    if (e.target.closest('.hist-del')) { history.splice(idx, 1); save(KEYS.history, history); renderHistory(); return; }
    if (e.target.closest('.hist-open')) {
      if (h.type === 'items') {
        items = Object.assign({}, ITEMS_DEFAULT, JSON.parse(JSON.stringify(h.data)));
        if (!Array.isArray(items.rows) || !items.rows.length) items.rows = [newRow()];
        renderItems();
        location.hash = '#/items';
      } else {
        quick = Object.assign({}, QUICK_DEFAULT, h.data);
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
  const s = {
    vat: $('#s-vat'), wht: $('#s-wht'), payee: $('#s-payee'), thresholdAmt: $('#s-threshold-amt'), theme: $('#s-theme'),
    agencyName: $('#s-agency-name'), agencyTaxId: $('#s-agency-taxid'), agencyPhone: $('#s-agency-phone'),
    agencyAddress: $('#s-agency-address'), agencySigner: $('#s-agency-signer'),
  };
  const AGENCY_FIELDS = [['agencyName', 'name'], ['agencyTaxId', 'taxId'], ['agencyPhone', 'phone'], ['agencyAddress', 'address'], ['agencySigner', 'signer']];
  function renderSettings() {
    s.vat.value = settings.vatRate;
    s.wht.value = String(settings.whtRate);
    s.payee.value = settings.payeeType;
    s.thresholdAmt.value = settings.thresholdAmount;
    s.theme.value = settings.theme;
    AGENCY_FIELDS.forEach(([el, key]) => { if (document.activeElement !== s[el]) s[el].value = settings.agency[key] || ''; });
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
  s.vat.addEventListener('change', () => { settings.vatRate = Math.min(100, Math.max(0, parseNum(s.vat.value))); commitSettings(); });
  s.wht.addEventListener('change', () => { settings.whtRate = +s.wht.value; commitSettings(); });
  s.payee.addEventListener('change', () => { settings.payeeType = s.payee.value; commitSettings(); });
  s.thresholdAmt.addEventListener('change', () => { settings.thresholdAmount = Math.max(0, parseNum(s.thresholdAmt.value)); commitSettings(); });
  s.theme.addEventListener('change', () => { settings.theme = s.theme.value; commitSettings(); });
  AGENCY_FIELDS.forEach(([el, key]) => s[el].addEventListener('input', () => { settings.agency[key] = s[el].value; save(KEYS.settings, settings); }));
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
