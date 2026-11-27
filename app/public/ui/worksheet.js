import { api } from './api.js';
import { esc, invoiceReferenceRate, money, table } from './presenter.js';

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
      <td class="voucher-nowrap">${Number(payment.payment_date.slice(-2))}日<small class="voucher-rate">#${payment.id}</small></td>
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
    <p>${esc(year)}年${Number(mm)}月　決済 ${payments.length}件</p>
    <p>記録通貨別の決済額合計（相殺を含む）　${esc(totalText)}</p>
    ${table(['決済日・ID', '仕入先', '方法', '決済額', '仕入額（円）', 'INVOICE・充当額'], rows)}
    <p>仕入額は充当先のINVOICEに紐付く円合計です。分割決済では同じ仕入額が別の決済行にも載ります。</p>
`;
}

export function voucherWorksheet(root, today) {
  const dialog = root.view.find('voucherDialog');
  const sheet = root.child('voucherWorksheet', dialog);
  const view = sheet.view;
  const month = view.find('voucherPreviewMonth');
  const print = view.find('printVoucher');
  const currentMonth = today.slice(0, 7);
  root.view.find('voucherMonth').value = currentMonth;
  let request = 0;

  async function loadMonth() {
    const current = ++request;
    const targetMonth = month.value;
    print.disabled = true;
    view.render({ voucherSheet: { text: targetMonth ? '読み込み中…' : '対象月を指定してください' } });
    if (!targetMonth) return;
    try {
      const payments = await api('/api/payments/worksheet?month=' + encodeURIComponent(targetMonth));
      if (request !== current || !dialog.open) return;
      if (!payments.length) {
        view.render({ voucherSheet: { text: '対象月に有効な決済はありません' } });
        return;
      }
      view.render({ voucherSheet: { html: presentWorksheet(targetMonth, payments) } });
      print.disabled = false;
    } catch (error) {
      if (request === current && dialog.open) view.render({ voucherSheet: { text: error.message } });
    }
  }

  for (const open of root.view.all('[data-voucher]')) {
    sheet.on(open, 'click', 'openVoucher', () => {
      const monthSource = open.dataset.voucher;
      month.value = (monthSource && root.view.find(monthSource).value) || currentMonth;
      dialog.showModal();
      return loadMonth();
    });
  }
  sheet.on(month, 'change', 'changeVoucherMonth', loadMonth);
  sheet.on(view.find('closeVoucher'), 'click', 'closeVoucher', () => dialog.close());
  sheet.on(print, 'click', 'printVoucher', () => view.print());
}
