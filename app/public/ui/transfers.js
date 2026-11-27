import { api, post } from './api.js';
import { money, minorText, transferTable, transferHistory } from './presenter.js';
export function transfers(component, model, today) {
  const view = component.view;
  const $ = (id) => view.find(id);
  const values = (form) => view.readForm(form);
  const msg = (text, error = false) => component.emit('status', { text, error });
  const refresh = () => component.emit('refresh');
  let transferRows = [];
  let planRequest = 0;
  const selected = new Set();
  const amounts = new Map();
  function shiftMonth(n) {
    const [y, m] = $('month').value.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    $('month').value = d.toLocaleDateString('sv-SE').slice(0, 7);
    loadTransfers();
  }
  $('month').value = today.slice(0, 7);
  component.on($('prevMonth'), 'click', 'previousPlanMonth', () => shiftMonth(-1));
  component.on($('nextMonth'), 'click', 'nextPlanMonth', () => shiftMonth(1));
  component.on($('month'), 'change', 'changePlanMonth', loadTransfers);
  async function loadTransfers() {
    const request = ++planRequest;
    try {
      const rows = await api('/api/transfers?month=' + encodeURIComponent($('month').value));
      if (request !== planRequest) return;
      transferRows = rows;
      selected.clear();
      amounts.clear();
      remittanceDrafts.clear();
      renderTransfers();
      renderRemittance();
    } catch (e) {
      if (request === planRequest) msg(e.message, true);
    }
  }
  function renderTransfers() {
    view.render({ transferTable: { html: transferTable(transferRows) } });
    for (const checkbox of view.all('.groupCheck')) {
      component.on(checkbox, 'change', 'toggleTransferGroup', () => {
        for (const id of checkbox.dataset.ids.split(',').map(Number)) setSelected(id, checkbox.checked);
        syncSelection();
      });
    }
    for (const checkbox of view.all('.transferCheck')) {
      component.on(checkbox, 'change', 'toggleTransfer', () => {
        setSelected(Number(checkbox.dataset.id), checkbox.checked);
        renderRemittance();
      });
    }
    for (const amount of view.all('.transferAmount')) {
      component.on(amount, 'input', 'editTransferAmount', () => {
        amounts.set(Number(amount.dataset.id), amount.value.trim());
        renderRemittance();
      });
    }
  }
  function setSelected(id, checked) {
    if (checked) selected.add(id);
    else selected.delete(id);
  }
  function syncSelection() {
    for (const checkbox of view.all('.transferCheck'))
      checkbox.checked = selected.has(Number(checkbox.dataset.id));
    renderRemittance();
  }
  $('transferPaymentDate').value = today;
  component.on($('selectAllTransfers'), 'click', 'selectAllTransfers', () => {
    for (const row of transferRows) selected.add(row.id);
    syncSelection();
  });
  component.on($('clearTransfers'), 'click', 'clearTransfers', () => {
    selected.clear();
    for (const checkbox of view.all('.groupCheck')) checkbox.checked = false;
    syncSelection();
  });
  component.on($('confirmTransfers'), 'click', 'confirmTransfers', async () => {
    if (!selected.size) return msg('送金するINVOICEを選択してください', true);
    const items = transferRows
      .filter((row) => selected.has(row.id))
      .map(({ id }) => ({
        invoice_id: id,
        amount: amounts.get(id) || null,
      }));
    const date = $('transferPaymentDate').value;
    if (!date) return msg('実際の送金日を入力してください', true);
    try {
      const groups = remittanceGroups();
      const totals = new Map();
      for (const group of groups) totals.set(group.currency, (totals.get(group.currency) ?? 0) + group.total);
      const lines = groups.map((group) => {
        const returns = group.items.filter((row) => row.amount < 0).reduce((sum, row) => sum + row.amount, 0);
        const deduction = returns ? `（返品 ${money(returns, group.currency)}を含む）` : '';
        return `${group.payee}　${money(group.total, group.currency)}${deduction}`;
      });
      if (
        !view.confirm(
          [
            `${date} 付の送金として確定しますか？`,
            '',
            `対象INVOICE ${items.length}件`,
            ...lines,
            '',
            '通貨別合計　' + [...totals].map(([currency, amount]) => money(amount, currency)).join(' ／ '),
            '',
            '差引0は返品充当のみ記録します。正額の送金は銀行で実施後に確定してください。',
          ].join('\n'),
        )
      )
        return;
      const d = await post('/api/transfers/confirm', {
        payment_date: date,
        items,
        messages: collectRemittance(),
      });
      await refresh();
      await loadTransfers();
      msg(`送金確定: ${d.invoice_count}件、決済履歴 ${d.payments.length}件を登録しました`);
    } catch (e) {
      msg(e.message, true);
    }
  });
  component.on($('copyTransfers'), 'click', 'copyTransfers', async () => {
    let map = new Map(),
      settlementGroups = new Map();
    for (const x of transferRows.filter((x) => selected.has(x.id))) {
      let key = [x.payee_name, x.bank_beneficiary_code || '', x.currency].join('|');
      if (!map.has(key)) map.set(key, { name: x.payee_name, currency: x.currency, amount: 0, count: 0 });
      let a = map.get(key);
      const raw = amounts.get(x.id) ?? '';
      const n =
        raw && /^-?\d+(?:\.\d{1,2})?$/.test(raw.replace(/,/g, ''))
          ? Math.round(Number(raw.replace(/,/g, '')) * (x.currency === 'JPY' ? 1 : 100))
          : raw
            ? NaN
            : x.remaining_minor;
      if (
        !Number.isSafeInteger(n) ||
        !n ||
        Math.sign(n) !== Math.sign(x.remaining_minor) ||
        Math.abs(n) > Math.abs(x.remaining_minor)
      )
        return msg('送金額が不正です', true);
      const g = JSON.stringify([x.supplier_id, x.currency, x.settlement_method]);
      settlementGroups.set(g, (settlementGroups.get(g) || 0) + n);
      a.amount += n;
      a.count++;
    }
    if ([...settlementGroups.values()].some((n) => n < 0))
      return msg('返品超過です。返品の充当額を減らしてください', true);
    if (!map.size) return msg('INVOICEを選択してください', true);
    let text =
      '支払先\t通貨\t金額\t件数\n' +
      Array.from(map.values())
        .filter((x) => x.amount > 0)
        .map((x) =>
          [x.name, x.currency, x.currency === 'JPY' ? x.amount : (x.amount / 100).toFixed(2), x.count].join(
            '\t',
          ),
        )
        .join('\n');
    try {
      await view.copy(text);
      msg('Excel貼付用データをコピーしました');
    } catch (e) {
      msg('コピーできませんでした: ' + e.message, true);
    }
  });
  let transferTab = 0,
    actualRows = [],
    actualRequest = 0;
  function setTransferTab(n, load = true) {
    transferTab = n;
    $('planPanel').hidden = n !== 0;
    $('actualPanel').hidden = n !== 1;
    $('planTab').classList.toggle('active', n === 0);
    $('actualTab').classList.toggle('active', n === 1);
    if (load) {
      component.emit('tabChanged', 'transfers');
      return n === 0 ? loadTransfers() : loadActual();
    }
  }
  component.on($('planTab'), 'click', 'showPlanTab', () => setTransferTab(0));
  component.on($('actualTab'), 'click', 'showActualTab', () => setTransferTab(1));
  $('actualMonth').value = today.slice(0, 7);
  function shiftActual(n) {
    const [y, m] = $('actualMonth').value.split('-').map(Number);
    if (!y || !m) return;
    const d = new Date(y, m - 1 + n, 1);
    $('actualMonth').value = d.toLocaleDateString('sv-SE').slice(0, 7);
    loadActual();
  }
  component.on($('actualPrev'), 'click', 'previousActualMonth', () => shiftActual(-1));
  component.on($('actualNext'), 'click', 'nextActualMonth', () => shiftActual(1));
  component.on($('actualMonth'), 'change', 'changeActualMonth', loadActual);
  async function loadActual() {
    const request = ++actualRequest;
    actualRows = [];
    $('copyActual').disabled = true;
    $('actualTotals').textContent = '';
    $('actualTable').textContent = '読み込み中…';
    try {
      const rows = await api('/api/transfers/history?month=' + encodeURIComponent($('actualMonth').value));
      if (request !== actualRequest) return;
      actualRows = rows;
      renderActual();
    } catch (e) {
      if (request !== actualRequest) return;
      $('actualTable').textContent = '取得できませんでした';
      msg(e.message, true);
    }
  }
  function renderActual() {
    view.render(transferHistory(actualRows));
  }
  function excelCell(v) {
    const s = String(v ?? '').replace(/[\t\r\n]/g, ' ');
    return /^[=+@-]/.test(s) ? "'" + s : s;
  }
  component.on($('copyActual'), 'click', 'copyActual', async () => {
    const text = [
      '送金日\t支払先\t仕入先\t区分\t通貨\t送金額\t決済ID',
      ...actualRows.map((r) =>
        [
          r.payment_date,
          excelCell(r.payee_name),
          excelCell(r.supplier_name),
          r.method === 'advance' ? '前払' : '通常送金',
          r.currency,
          minorText(r.amount_minor, r.currency),
          r.id,
        ].join('\t'),
      ),
    ].join('\n');
    try {
      await view.copy(text);
      msg('送金実績をExcel用にコピーしました');
    } catch (e) {
      msg(e.message, true);
    }
  });
  let remittanceDrafts = new Map();
  function remittanceGroups() {
    const groups = new Map();
    for (const x of transferRows) {
      if (!selected.has(x.id)) continue;
      const raw = (amounts.get(x.id) ?? '').replace(/,/g, '');
      const n = raw ? Number(raw) * (x.currency === 'JPY' ? 1 : 100) : x.remaining_minor;
      const amount = Math.round(n);
      if (
        (raw && (!/^-?\d+(?:\.\d{1,2})?$/.test(raw) || (x.currency === 'JPY' && raw.includes('.')))) ||
        !Number.isSafeInteger(amount) ||
        Math.abs(n - amount) > 1e-7 ||
        !amount ||
        Math.sign(amount) !== Math.sign(x.remaining_minor) ||
        Math.abs(amount) > Math.abs(x.remaining_minor)
      )
        throw Error('充当金額が不正です');
      const key = JSON.stringify([x.payee_name, x.bank_beneficiary_code || '', x.currency]);
      if (!groups.has(key))
        groups.set(key, { key, payee: x.payee_name, currency: x.currency, items: [], total: 0 });
      const g = groups.get(key);
      g.items.push({ ...x, amount });
      g.total += amount;
    }
    return [...groups.values()];
  }
  function generateRemittance(g) {
    const map = new Map();
    for (const x of g.items) {
      if (!map.has(x.supplier_id)) map.set(x.supplier_id, []);
      map.get(x.supplier_id).push(x);
    }
    return [...map]
      .map(([id, items]) => {
        const s = model.suppliers.find((x) => x.id === id) || {};
        const sep = s.message_separator ?? ' ';
        const core = items
          .map(
            (x) =>
              x.invoice_number +
              (s.message_format === 'amount'
                ? '(' + String(x.amount / (x.currency === 'JPY' ? 1 : 100)) + ')'
                : ''),
          )
          .join(sep);
        return [s.message_prefix, core, s.message_suffix].filter(Boolean).join(' ');
      })
      .join(' ');
  }
  function renderRemittance() {
    $('transferReview').hidden = !selected.size;
    const root = $('remittanceCards');
    root.replaceChildren();
    let groups;
    try {
      groups = remittanceGroups();
    } catch (e) {
      root.textContent = e.message;
      return;
    }
    const next = new Map();
    for (const g of groups) {
      const signature = JSON.stringify(g.items.map((x) => [x.id, x.amount]));
      const old = remittanceDrafts.get(g.key);
      const draft = old?.signature === signature ? old : { signature, text: generateRemittance(g) };
      next.set(g.key, draft);
      const box = view.create('div');
      box.className = 'panel';
      const title = view.create('h3');
      title.textContent =
        g.payee + ' / ' + (g.items[0].bank_beneficiary_code || '受取人コード未設定') + ' / ' + g.currency;
      const amount = view.create('span');
      amount.textContent = minorText(g.total, g.currency);
      const copyAmount = view.create('button');
      copyAmount.textContent = '金額コピー';
      copyAmount.disabled = g.total <= 0;
      component.on(copyAmount, 'click', 'copyRemittanceAmount', () =>
        copyRemittance(minorText(g.total, g.currency)),
      );
      const area = view.create('textarea');
      area.rows = 3;
      area.style.width = '100%';
      area.value = draft.text;
      const count = view.create('small');
      count.textContent = area.value.length + '文字';
      component.on(area, 'input', 'editRemittanceText', () => {
        draft.text = area.value;
        count.textContent = area.value.length + '文字';
      });
      const copy = view.create('button');
      copy.textContent = 'メッセージコピー';
      component.on(copy, 'click', 'copyRemittanceText', () => copyRemittance(area.value));
      const reset = view.create('button');
      reset.textContent = '再生成';
      component.on(reset, 'click', 'regenerateRemittance', () => {
        draft.text = generateRemittance(g);
        area.value = draft.text;
        count.textContent = area.value.length + '文字';
      });
      box.append(title, amount, copyAmount, area, count, copy, reset);
      root.append(box);
    }
    remittanceDrafts = next;
  }
  async function copyRemittance(text) {
    try {
      await view.copy(text);
      msg('コピーしました');
    } catch (e) {
      msg(e.message, true);
    }
  }
  function collectRemittance() {
    return remittanceGroups().map((g) => ({
      ids: g.items.map((x) => x.id),
      text: remittanceDrafts.get(g.key)?.text ?? generateRemittance(g),
    }));
  }
  return {
    enter: () => (transferTab === 0 ? loadTransfers() : loadActual()),
    selectedTab: () => transferTab,
    setTab: (tab) => setTransferTab(tab, false),
    plan: (currentMonth) => {
      if (currentMonth) $('month').value = today.slice(0, 7);
      setTransferTab(0, false);
    },
  };
}
