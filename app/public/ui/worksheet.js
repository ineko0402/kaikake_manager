import { api } from './api.js';
import { esc, money, table, td } from './presenter.js';

function presentWorksheet(payment) {
  const amount = (minor) => money(minor, payment.currency);
  const method = { transfer: '通常送金', advance: '前払', offset: '売掛相殺' }[payment.method];
  const allocations = payment.allocations.map((row) =>
    td(row.invoice_number, row.allocation_date, amount(row.amount_minor)),
  );
  const expenses = payment.expenses.map((row) =>
    td(row.usage_class === 'freight' ? '送料・諸費用' : '仕入対象外', row.reason, amount(row.amount_minor)),
  );
  return `
    <h1 id="voucherTitle">振替伝票 転記用紙</h1>
    <dl class="voucher-facts">
      <div><dt>決済ID</dt><dd>${payment.id}</dd></div>
      <div><dt>決済日</dt><dd>${esc(payment.payment_date)}</dd></div>
      <div><dt>決済方法</dt><dd>${esc(method)}</dd></div>
      <div><dt>仕入先</dt><dd>${esc(payment.supplier_code)} ${esc(payment.supplier_name)}</dd></div>
      <div><dt>支払先</dt><dd>${esc(payment.payee_name)}</dd></div>
      <div><dt>決済額（記録通貨）</dt><dd><strong>${esc(amount(payment.amount_minor))}</strong></dd></div>
    </dl>
    ${payment.note ? `<p class="voucher-note">決済備考　${esc(payment.note)}</p>` : ''}
    <h2>手書き欄</h2>
    <p class="voucher-line">伝票番号 <span></span>　起票日 <span></span></p>
    ${table(
      ['借方科目', '借方金額（円）', '貸方科目', '貸方金額（円）', '摘要'],
      Array.from({ length: 4 }, () => td('', '', '', '', '')),
    )}
    <p class="voucher-line">換算レート <span></span>　照合・メモ <span></span></p>
    <h2>INVOICEへの充当</h2>
    ${allocations.length ? table(['INVOICE番号', '充当日', '充当額'], allocations) : '<p>充当明細なし</p>'}
    ${expenses.length ? `<h2>前払金の費用処理</h2>${table(['用途', '理由', '使用額'], expenses)}` : ''}
    <p>充当合計 ${esc(amount(payment.allocated_minor))}${
      payment.method === 'advance'
        ? ` ／ 費用処理 ${esc(amount(payment.expensed_minor))} ／ 未充当 ${esc(amount(payment.remaining_minor))}`
        : ''
    }</p>`;
}

export function voucherWorksheet(component) {
  const dialog = component.view.find('voucherDialog');
  const sheet = component.child('voucherWorksheet', dialog);
  const view = sheet.view;
  let request = 0;

  view.render({ voucherSheet: { html: '<h1 id="voucherTitle">振替伝票 転記用紙</h1>' } });
  sheet.on(view.find('closeVoucher'), 'click', 'closeVoucher', () => dialog.close());
  sheet.on(view.find('printVoucher'), 'click', 'printVoucher', () => view.print());

  return {
    bindRows() {
      for (const button of component.view.all('.printWorksheet')) {
        sheet.on(button, 'click', 'openVoucher', async () => {
          const current = ++request;
          const payment = await api('/api/payments/' + button.dataset.id + '/worksheet');
          if (current !== request || !button.getClientRects().length) return;
          view.render({ voucherSheet: { html: presentWorksheet(payment) } });
          dialog.showModal();
        });
      }
    },
  };
}
