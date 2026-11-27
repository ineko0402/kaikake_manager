import { api } from './api.js';
import { esc, invoiceReferenceRate, money, table, td } from './presenter.js';

function presentWorksheet(month, payments) {
  const methods = { transfer: '通常送金', advance: '前払', offset: '売掛相殺' };
  const totals = new Map();
  const rows = payments.map((payment) => {
    const amount = (minor) => money(minor, payment.currency);
    totals.set(payment.currency, (totals.get(payment.currency) ?? 0) + payment.amount_minor);
    const purchasesByInvoice = new Map();
    const allocations = payment.allocations.map((row) => {
      if (row.invoice_jpy != null) purchasesByInvoice.set(row.invoice_id, row.invoice_jpy);
      const rate = invoiceReferenceRate(row.invoice_jpy, row.invoice_total_minor, row.invoice_currency);
      return `<div>${esc(row.invoice_number)}　${esc(row.allocation_date)}　${esc(amount(row.amount_minor))}${
        rate ? `<small class="voucher-rate">参考 ${esc(rate)}</small>` : ''
      }</div>`;
    });
    const expenses = payment.expenses.map(
      (row) => `<div>費用処理　${esc(row.reason)}　${esc(amount(row.amount_minor))}</div>`,
    );
    const remaining =
      payment.method === 'advance' ? `<div>未充当　${esc(amount(payment.remaining_minor))}</div>` : '';
    const details = allocations.concat(expenses).join('') || '充当明細なし';
    const payee =
      payment.payee_name !== payment.supplier_name
        ? `<small class="voucher-rate">支払先 ${esc(payment.payee_name)}</small>`
        : '';
    const note = payment.note ? `<small class="voucher-rate voucher-note">${esc(payment.note)}</small>` : '';
    const purchaseAmount = purchasesByInvoice.size
      ? money(
          [...purchasesByInvoice.values()].reduce((sum, yen) => sum + yen, 0),
          'JPY',
        )
      : '—';
    return `<tr>
      <td>${esc(payment.payment_date)}<small class="voucher-rate">#${payment.id}</small></td>
      <td>${esc(payment.supplier_code)} ${esc(payment.supplier_name)}${payee}${note}</td>
      <td class="voucher-nowrap">${esc(methods[payment.method])}</td>
      <td class="voucher-nowrap voucher-amount">${esc(amount(payment.amount_minor))}</td>
      <td class="voucher-nowrap voucher-amount">${esc(purchaseAmount)}</td>
      <td>${details}${remaining}</td>
    </tr>`;
  });
  const totalText = [...totals].map(([currency, total]) => money(total, currency)).join(' ／ ');
  const [year, mm] = month.split('-');
  return `
    <h1 id="voucherTitle">振替伝票 月別転記用紙</h1>
    <p>${esc(year)}年${Number(mm)}月　決済 ${payments.length}件</p>
    <p>記録通貨別の決済額合計（相殺を含む）　${esc(totalText)}</p>
    ${table(['決済日・ID', '仕入先', '方法', '決済額', '仕入額（円）', 'INVOICE・充当額'], rows)}
    <p>仕入額は充当先のINVOICEに紐付く円合計です。分割決済では同じ仕入額が別の決済行にも載ります。</p>
    <h2>手書き欄</h2>
    ${table(
      ['決済ID', '伝票番号', '借方科目・円金額', '貸方科目・円金額', '摘要・レート'],
      payments.map((payment) => td('#' + payment.id, '', '', '', '')),
    )}`;
}

export function voucherWorksheet(component, today) {
  const dialog = component.view.find('voucherDialog');
  const sheet = component.child('voucherWorksheet', dialog);
  const view = sheet.view;
  const month = component.view.find('voucherMonth');
  const open = component.view.find('openVoucher');
  month.value = today.slice(0, 7);

  sheet.on(open, 'click', 'openVoucher', async () => {
    const targetMonth = month.value;
    if (!targetMonth) return sheet.emit('status', { text: '対象月を指定してください', error: true });
    open.disabled = true;
    try {
      const payments = await api('/api/payments/worksheet?month=' + encodeURIComponent(targetMonth));
      if (targetMonth !== month.value || !open.getClientRects().length) return;
      if (!payments.length) {
        sheet.emit('status', { text: '対象月に有効な決済はありません' });
        return;
      }
      view.render({ voucherSheet: { html: presentWorksheet(targetMonth, payments) } });
      dialog.showModal();
    } finally {
      open.disabled = false;
    }
  });
  sheet.on(view.find('closeVoucher'), 'click', 'closeVoucher', () => dialog.close());
  sheet.on(view.find('printVoucher'), 'click', 'printVoucher', () => view.print());
}
