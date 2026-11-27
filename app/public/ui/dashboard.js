import { esc, money, dashboardTable } from './presenter.js';
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
    $('summary').innerHTML =
      '<h2>今月の支払予定残額</h2><p>' +
      Object.entries(totals)
        .map(([c, n]) => esc(money(n, c)))
        .join(' / ') +
      '</p><button class="action" id="dashMonth">今月の送金予定（' +
      month.length +
      '件）</button><p id="dashLinks"></p>';
    component.on($('dashMonth'), 'click', 'openCurrentTransfers', () => {
      component.emit('navigate', { page: 'transfers', plan: true, currentMonth: true });
    });
    for (const [label, id, f, n] of [
      ['未紐付け仕入', 'purchases', 'unlinked', model.purchases.filter((x) => !x.invoice_id).length],
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

  function render() {
    const open = model.invoices.filter((i) => i.remaining_minor !== 0);
    view.render({ dashboardTable: { html: dashboardTable(open) } });
    renderDashboard();
  }
  return { render };
}
