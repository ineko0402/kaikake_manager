const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function table(headers, rows) {
  return (
    '<table><thead><tr>' +
    headers.map((x) => '<th>' + esc(x) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.join('') +
    '</tbody></table>'
  );
}
function td(...vals) {
  return '<tr>' + vals.map((x) => '<td>' + esc(x) + '</td>').join('') + '</tr>';
}
function money(n, c) {
  return (
    (Number(n) / (c === 'JPY' ? 1 : 100)).toLocaleString('ja-JP', {
      minimumFractionDigits: c === 'JPY' ? 0 : 2,
      maximumFractionDigits: c === 'JPY' ? 0 : 2,
    }) +
    ' ' +
    c
  );
}
function minorText(n, c) {
  if (n == null) return '';
  return c === 'JPY' ? String(n) : (n / 100).toFixed(2);
}

export { esc, table, td, money, minorText };

export function purchaseTable(rows) {
  return table(
    ['ID', '仕入先', '発注番号', '枝番', '仕入日', '金額', 'INVOICE', '操作'],
    rows.map(
      (p) =>
        `<tr><td>${p.id}</td><td>${esc(p.supplier_code)}</td><td>${esc(p.order_number)}</td><td>${p.branch_number}</td><td>${p.purchase_date}</td><td>${money(p.amount_jpy, 'JPY')}</td><td>${esc(p.invoice_number || '未紐付け')}</td><td><button class="editPurchase" data-id="${p.id}">編集</button>${!p.invoice_id ? `<button class="cancelPurchase" data-id="${p.id}">取消</button>` : ''}</td></tr>`,
    ),
  );
}

export function invoiceTable(rows) {
  return table(
    ['ID', '仕入先', '番号', '仕入の紐付け', '請求日', '総額', '残高', '予定日', '操作'],
    rows.map(
      (i) =>
        `<tr><td>${i.id}</td><td>${esc(i.supplier_name)}</td><td>${esc(i.invoice_number)}</td><td>${i.purchase_count ? `${i.purchase_count}件` : '<strong class="pill">未紐付け</strong>'}</td><td>${i.invoice_date}</td><td>${money(i.total_minor, i.currency)}${i.difference_reason ? '<small style="display:block">' + esc(i.difference_reason) + '</small>' : ''}</td><td>${money(i.remaining_minor, i.currency)}</td><td>${i.due_date || '未設定'}</td><td><button class="editInvoice" data-id="${i.id}">編集</button><button class="cancelInvoice" data-id="${i.id}">取消</button></td></tr>`,
    ),
  );
}

export function paymentTable(rows) {
  return table(
    ['ID', '仕入先', '方法', '決済日', '金額', '未充当', '状態', '操作'],
    rows.map(
      (p) =>
        `<tr><td>${p.id}</td><td>${esc(p.supplier_name)}</td><td>${esc(p.method)}</td><td>${p.payment_date}</td><td>${money(p.amount_minor, p.currency)}</td><td>${money(p.remaining_minor, p.currency)}</td><td>${p.status}</td><td>${p.status === 'active' ? `<button class="cancelPayment" data-id="${p.id}">取消</button>` : ''}</td></tr>`,
    ),
  );
}

export function adjustmentTable(rows) {
  return table(
    ['ID', 'INVOICE', '調整額', '理由', '状態', '操作'],
    rows.map(
      (a) =>
        `<tr><td>${a.id}</td><td>${esc(a.invoice_number)}</td><td>${money(a.amount_minor, a.currency)}</td><td>${esc(a.reason)}</td><td>${esc(a.status)}</td><td>${a.status === 'active' ? `<button class="cancelAdjustment" data-id="${a.id}">取消</button>` : ''}</td></tr>`,
    ),
  );
}

export function dashboardTable(rows) {
  return table(
    ['ID', '仕入先', '番号', '支払予定日', '残高'],
    rows.map((i) =>
      td(i.id, i.supplier_name, i.invoice_number, i.due_date, money(i.remaining_minor, i.currency)),
    ),
  );
}

export function feedbackTable(rows) {
  return table(
    ['日時', '分類', '画面', '内容', '版', '対応'],
    rows.map(
      (x) =>
        `<tr><td>${esc(x.created_at)}</td><td>${esc(x.category)}</td><td>${esc(x.page)}</td><td style="white-space:pre-wrap">${esc(x.content)}</td><td>${esc(x.version)}</td><td><input type="checkbox" data-feedback="${x.id}" ${x.done ? 'checked' : ''}></td></tr>`,
    ),
  );
}

export function transferTable(rows) {
  let groups = new Map();
  for (const x of rows) {
    const key = JSON.stringify([x.payee_name, x.bank_beneficiary_code || '', x.currency]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  let html = '';
  for (const [key, items] of groups) {
    const [payee, bank, currency] = JSON.parse(key);
    const total = items.reduce((n, x) => n + x.remaining_minor, 0);
    html += `<tr style="background:#eef3f9"><td><input type="checkbox" class="groupCheck" data-ids="${items.map((x) => x.id).join(',')}"></td><td><strong>${esc(payee)}</strong></td><td>${esc(bank)}</td><td>${esc(currency)}</td><td>${money(total, currency)}</td></tr>`;
    for (const i of items)
      html += `<tr><td><input type="checkbox" class="transferCheck" data-id="${i.id}"></td><td>　${esc(i.invoice_number)}</td><td>${esc(i.supplier_name)}</td><td>${i.due_date || '未設定'}</td><td>${money(i.remaining_minor, i.currency)} <input class="transferAmount compact" data-id="${i.id}" aria-label="${esc(i.invoice_number)}の送金額" placeholder="全額（変更可）" style="width:115px"></td></tr>`;
  }
  return table(['選択', '支払先・INVOICE', '受取人コード／仕入先', '通貨／予定日', '残高'], [html]);
}

export function transferHistory(actualRows) {
  const totals = new Map();
  for (const r of actualRows) totals.set(r.currency, (totals.get(r.currency) || 0) + r.amount_minor);
  const text = actualRows.length + '件 ／ ' + [...totals].map(([c, n]) => money(n, c)).join(' ／ ');
  const html = actualRows.length
    ? table(
        ['送金日', '支払先', '仕入先', '区分', '通貨', '送金額', 'INVOICE明細', '送金メッセージ'],
        actualRows.map(
          (r) =>
            `<tr><td>${esc(r.payment_date)}</td><td>${esc(r.payee_name)}</td><td>${esc(r.supplier_name)}</td><td>${r.method === 'advance' ? '前払' : '通常送金'}</td><td>${esc(r.currency)}</td><td>${money(r.amount_minor, r.currency)}</td><td><details><summary>${r.allocations.length}件</summary>${r.allocations.map((a) => `<div>${esc(a.invoice_number)}：${money(a.amount_minor, r.currency)}</div>`).join('') || '未充当'}</details></td><td>${r.remittance_message == null ? '未記録' : `<details><summary>表示</summary><pre style="white-space:pre-wrap">${esc(r.remittance_message)}</pre></details>`}</td></tr>`,
        ),
      )
    : '対象月の送金実績はありません。';
  return {
    actualTotals: { text },
    actualTable: { html },
    copyActual: { disabled: !actualRows.length },
  };
}

export function invoiceReferenceRate(yen, totalMinor, currency) {
  if (
    currency === 'JPY' ||
    !Number.isSafeInteger(yen) ||
    !Number.isSafeInteger(totalMinor) ||
    !yen ||
    !totalMinor ||
    Math.sign(yen) !== Math.sign(totalMinor)
  )
    return '';
  const rate = yen / (totalMinor / 100);
  return new Intl.NumberFormat('ja-JP', { maximumSignificantDigits: 8 }).format(rate) + ' 円 / ' + currency;
}
