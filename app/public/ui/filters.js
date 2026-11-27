export function filters(component, componentFor, model, today) {
  const view = component.view;
  const $ = (id) => view.find(id);
  const filterStates = {};
  const configs = {
    allocationChoices: ['due_date', []],
    purchaseChoices: ['purchase_date', []],
    purchaseTable: [
      'purchase_date',
      [
        ['unlinked', '未紐付け'],
        ['linked', '紐付け済'],
      ],
    ],
    invoiceTable: [
      'invoice_date',
      [
        ['unlinked', '仕入未紐付け'],
        ['linked', '仕入紐付け済'],
        ['open', '未決済'],
        ['paid', '決済済'],
        ['overdue', '期限超過'],
        ['nodue', '予定日未設定'],
      ],
    ],
    paymentTable: [
      'payment_date',
      [
        ['advance', '未充当前払'],
        ['active', '有効'],
        ['cancelled', '取消済'],
      ],
    ],
  };
  for (const [id, [, states]] of Object.entries(configs)) {
    const filter = componentFor(id).child(id + 'Filter', $(id).parentElement);
    const bar = view.create('div');
    bar.className = 'filterbar';
    bar.innerHTML = `<select aria-label="期間"><option value="all">全期間</option><option value="month">月別</option><option value="day">日付指定</option></select><button type="button" aria-label="前月">‹</button><input type="month" aria-label="対象月" value="${today.slice(0, 7)}"><button type="button" aria-label="翌月">›</button><input type="date" aria-label="対象日" value="${today}"><input type="search" placeholder="仕入先・番号検索"><select aria-label="状態"><option value="">すべて</option>${states.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><select aria-label="決済区分"><option value="">全決済区分</option><option value="transfer">通常送金</option><option value="advance">前払</option><option value="offset">相殺</option></select><select aria-label="並び順"><option value="desc">日付：新しい順</option><option value="asc">日付：古い順</option></select><button type="button">解除</button><small></small>`;
    const [period, prev, month, next, day, search, status, method, sort, reset, count] = bar.children;
    method.hidden = id === 'purchaseTable' || id === 'purchaseChoices';
    status.hidden = ['purchaseChoices', 'allocationChoices'].includes(id);
    filterStates[id] = { period, prev, month, next, day, search, status, method, sort, count };
    $(id).before(bar);
    const update = () => filter.emit('filter', id);
    filter.on(bar, 'input', 'inputFilter', update);
    filter.on(bar, 'change', 'changeFilter', update);
    for (const [b, n] of [
      [prev, -1],
      [next, 1],
    ])
      filter.on(b, 'click', 'shiftFilterMonth', () => {
        const [y, m] = month.value.split('-').map(Number);
        const d = new Date(y, m - 1 + n, 1);
        month.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        update();
      });
    filter.on(reset, 'click', 'resetFilter', () => {
      if (id === 'purchaseChoices') $('onlyChosen').checked = false;
      period.value = 'all';
      search.value = status.value = method.value = '';
      sort.value = ['purchaseChoices', 'allocationChoices'].includes(id) ? 'asc' : 'desc';
      update();
    });
  }
  function applyFilters() {
    for (const [id, rows] of [
      ['purchaseTable', model.purchases],
      ['invoiceTable', model.invoices],
      ['paymentTable', model.payments],
    ]) {
      const st = filterStates[id],
        key = configs[id][0],
        body = $(id).querySelector('tbody');
      updatePeriodControls(st);
      if (!body) continue;
      const map = new Map(rows.map((x) => [String(x.id), x]));
      const trs = [...body.rows];
      let count = 0;
      for (const tr of trs) {
        const x = map.get(tr.cells[0]?.textContent);
        if (!x) continue;
        const linked = id === 'invoiceTable' ? x.purchase_count > 0 : !!x.invoice_id;
        const tests = {
          unlinked: !linked,
          linked,
          open: x.remaining_minor !== 0,
          paid: x.remaining_minor === 0,
          overdue: x.remaining_minor !== 0 && x.due_date && x.due_date < today,
          nodue: x.remaining_minor !== 0 && !x.due_date,
          advance: x.status === 'active' && x.method === 'advance' && x.remaining_minor > 0,
          active: x.status === 'active',
          cancelled: x.status === 'cancelled',
        };
        tr.hidden = !(
          inPeriod(x[key], st) &&
          (!st.status.value || tests[st.status.value]) &&
          (!st.method.value || st.method.value === (x.method || x.settlement_method)) &&
          [x.supplier_code, x.supplier_name, x.order_number, x.invoice_number, x.id]
            .join(' ')
            .toLowerCase()
            .includes(st.search.value.toLowerCase())
        );
        if (!tr.hidden) count++;
      }
      trs.sort((a, b) => {
        const x = map.get(a.cells[0]?.textContent),
          y = map.get(b.cells[0]?.textContent);
        return (
          (st.sort.value === 'asc' ? 1 : -1) * String(x?.[key] || '').localeCompare(String(y?.[key] || ''))
        );
      });
      for (const tr of trs) body.append(tr);
      st.count.textContent = count + '件';
    }
  }

  function reset(id, status) {
    const st = filterStates[id];
    if (!st) return;
    st.period.value = 'all';
    st.search.value = st.method.value = '';
    st.status.value = status;
  }
  return { states: filterStates, apply: applyFilters, reset };
}

export function inPeriod(date, controls) {
  switch (controls.period.value) {
    case 'month':
      return date?.startsWith(controls.month.value);
    case 'day':
      return date === controls.day.value;
    default:
      return true;
  }
}

export function updatePeriodControls(controls, selectedOnly = false) {
  controls.month.hidden =
    controls.prev.hidden =
    controls.next.hidden =
      selectedOnly || controls.period.value !== 'month';
  controls.day.hidden = selectedOnly || controls.period.value !== 'day';
}
