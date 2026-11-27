import { money, dashboardTable } from './presenter.js';
export function dashboard(component, model, today) {
  const view = component.view;
  const $ = (id) => view.find(id);
  function renderDashboard() {
    const open = model.invoices.filter((i) => i.remaining_minor !== 0),
      month = open.filter(
        (i) =>
          (i.due_date?.startsWith(today.slice(0, 7)) ||
            (i.remaining_minor < 0 && i.due_date && i.due_date.slice(0, 7) < today.slice(0, 7))) &&
          i.settlement_method !== 'offset',
      );
    const totals = {};
    for (const i of month) totals[i.currency] = (totals[i.currency] || 0) + i.remaining_minor;
    view.render({
      dashTotals: {
        text: month.length
          ? '支払予定残額 ' +
            Object.entries(totals)
              .map(([currency, total]) => money(total, currency))
              .join(' ／ ')
          : '支払予定はありません',
      },
      dashMonth: { text: `今月の送金予定（${month.length}件）` },
    });
    $('dashLinks').replaceChildren();
    if (model.purchases.some((row) => !row.invoice_id)) {
      const count = model.purchases.filter((row) => !row.invoice_id).length;
      const button = view.create('button');
      button.textContent = `未紐付け仕入 ${count}件をINVOICEへ`;
      component.on(button, 'click', 'linkUnassignedPurchases', () =>
        component.emit('navigate', { page: 'invoices', tab: 0 }),
      );
      $('dashLinks').append(button);
    }
    for (const [label, id, f, n] of [
      ['期限超過', 'invoices', 'overdue', open.filter((x) => x.due_date && x.due_date < today).length],
      ['予定日未設定', 'invoices', 'nodue', open.filter((x) => !x.due_date).length],
      [
        '未充当前払',
        'payments',
        'advance',
        model.payments.filter((x) => x.status === 'active' && x.method === 'advance' && x.remaining_minor > 0)
          .length,
      ],
    ]) {
      if (!n) continue;
      const b = view.create('button');
      b.textContent = label + ' ' + n + '件';
      component.on(b, 'click', 'openDashboardDetail', () =>
        component.emit('navigate', { page: id, tab: 1, filter: f }),
      );
      $('dashLinks').append(b);
    }
  }

  component.on($('dashMonth'), 'click', 'openCurrentTransfers', () => {
    component.emit('navigate', { page: 'transfers', plan: true, currentMonth: true });
  });

  function render() {
    const open = model.invoices.filter((i) => i.remaining_minor !== 0);
    view.render({ dashboardTable: { html: dashboardTable(open) } });
    renderDashboard();
  }
  return { render };
}
