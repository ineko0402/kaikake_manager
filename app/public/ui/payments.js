import { inPeriod, updatePeriodControls } from './filters.js';
import { Selection } from './selection.js';
import { api, post } from './api.js';
import { esc, table, td, money, minorText, paymentTable, adjustmentTable } from './presenter.js';
export function payments(component, model, today, filterStates) {
  const view = component.view;
  const selection = component.child('allocationSelection', view.find('allocationChoices'));
  const $ = (id) => view.find(id);
  const values = (form) => view.readForm(form);
  const msg = (text, error = false) => component.emit('status', { text, error });
  const refresh = () => component.emit('refresh');
  component.on($('paymentForm'), 'submit', 'savePayment', async (e) => {
    try {
      let v = values(e.target);
      v.allocations = [...allocationSelected.entries()].map(([invoice_id, amount]) => ({
        invoice_id,
        amount,
      }));
      if (!v.allocations.length) return msg('充当するINVOICEを選択してください', true);
      const supplier = model.suppliers.find((row) => row.id === Number(v.supplier_id));
      const lines = v.allocations.map(({ invoice_id, amount }) => {
        const invoice = model.invoices.find((row) => row.id === invoice_id);
        return `${invoice?.invoice_number ?? invoice_id}　${amount} ${v.currency}`;
      });
      const method = e.target.elements.method.selectedOptions[0].textContent;
      if (
        !view.confirm(
          [
            'この内容で決済を確定しますか？',
            '',
            `${supplier?.name ?? ''} ／ ${method} ／ ${v.payment_date}`,
            `決済総額 ${v.amount} ${v.currency}`,
            '',
            `充当先 ${lines.length}件`,
            ...lines,
          ].join('\n'),
        )
      )
        return;
      let d = await post('/api/payments', v);
      msg('決済 #' + d.id + ' を登録しました');
      allocationSelected.clear();
      e.target.reset();
      e.target.elements.payment_date.value = today;
      await refresh();
    } catch (e) {
      msg(e.message, true);
    }
  });
  component.on($('advanceForm'), 'submit', 'applyAdvance', async (e) => {
    try {
      let v = values(e.target);
      let d = v.action === 'expense' ? await post('/api/advance-uses', v) : await post('/api/allocations', v);
      msg('追加処理 #' + d.id + ' を登録しました');
      e.target.reset();
      await refresh();
    } catch (e) {
      msg(e.message, true);
    }
  });
  component.on($('adjustForm'), 'submit', 'saveAdjustment', async (e) => {
    try {
      let d = await post('/api/adjustments', values(e.target));
      msg('調整 #' + d.id + ' を登録しました');
      e.target.reset();
      await refresh();
    } catch (e) {
      msg(e.message, true);
    }
  });
  for (const key of ['supplier_id', 'currency'])
    component.on($('paymentForm').elements[key], 'change', 'changePaymentSupplierOrCurrency', () => {
      const form = $('paymentForm');
      if (key === 'supplier_id') {
        const supplier = model.suppliers.find((row) => row.id === Number(form.elements.supplier_id.value));
        if (
          supplier?.currency &&
          Array.from(form.elements.currency.options).some((option) => option.value === supplier.currency)
        ) {
          form.elements.currency.value = supplier.currency;
        }
      }
      allocationSelected.clear();
      $('onlyAlloc').checked = false;
      $('paymentForm').elements.amount.value = '';
      renderAllocationChoices();
    });
  const allocationSelected = new Selection();
  filterStates.allocationChoices.sort.value = 'asc';
  function renderAllocationChoices() {
    const f = $('paymentForm'),
      st = filterStates.allocationChoices,
      c = f.elements.currency.value,
      sid = Number(f.elements.supplier_id.value),
      only = $('onlyAlloc').checked;
    view.render({
      paymentAllocation: { hidden: !sid },
      paymentStartHint: { hidden: Boolean(sid) },
      reviewPayment: { hidden: !sid },
    });
    const candidates = model.invoices.filter(
      (i) => i.supplier_id === sid && i.currency === c && i.remaining_minor !== 0,
    );
    updatePeriodControls(st, only);
    const rows = candidates
      .filter((i) =>
        only
          ? allocationSelected.has(i.id)
          : inPeriod(i.due_date, st) &&
            (!st.method.value || i.settlement_method === st.method.value) &&
            i.invoice_number.toLowerCase().includes(st.search.value.toLowerCase()),
      )
      .sort((a, b) =>
        !a.due_date
          ? !b.due_date
            ? a.id - b.id
            : 1
          : !b.due_date
            ? -1
            : (st.sort.value === 'asc' ? 1 : -1) * (a.due_date.localeCompare(b.due_date) || a.id - b.id),
      );
    allocationSelected.update(candidates, rows);
    const defaultAmount = (id) =>
      minorText(candidates.find((invoice) => invoice.id === id).remaining_minor, c);
    const root = $('allocationChoices');
    root.innerHTML = table(
      ['選択', 'INVOICE番号', '支払予定日', '未決済残額', '充当額'],
      rows.map(
        (i) =>
          `<tr><td><input type="checkbox" class="allocCheck" value="${i.id}" ${allocationSelected.has(i.id) ? 'checked' : ''}></td><td>${esc(i.invoice_number)}</td><td>${esc(i.due_date || '未設定')}</td><td>${money(i.remaining_minor, c)}</td><td><input class="allocAmount compact" data-id="${i.id}" value="${esc(allocationSelected.get(i.id) ?? minorText(i.remaining_minor, c))}" ${allocationSelected.has(i.id) ? '' : 'disabled'}></td></tr>`,
      ),
    );
    function summary() {
      let sum = 0,
        ok = true;
      for (const raw of allocationSelected.values()) {
        const v = String(raw).trim().replace(/,/g, '');
        if (!(c === 'JPY' ? /^-?\d+$/ : /^-?\d+(\.\d{1,2})?$/).test(v)) {
          ok = false;
          break;
        }
        const n = Math.round(Number(v) * (c === 'JPY' ? 1 : 100));
        if (!Number.isSafeInteger(n) || !Number.isSafeInteger(sum + n)) {
          ok = false;
          break;
        }
        sum += n;
      }
      const { outside } = allocationSelected.summary();
      $('allocSummary').textContent =
        `選択 ${allocationSelected.size}件 ／ 充当合計 ${ok ? money(sum, c) : '金額を確認してください'}${outside ? ' ／ 表示範囲外 ' + outside + '件' : ''}`;
      if (f.elements.method.value !== 'advance')
        f.elements.amount.value = ok && allocationSelected.size ? minorText(sum, c) : '';
    }
    function bulk(on) {
      allocationSelected.bulk(on, defaultAmount);
      renderAllocationChoices();
    }
    const h = root.querySelector('th');
    h.innerHTML = '<input type="checkbox" aria-label="表示中を一括選択">';
    const cb = h.firstChild;
    const { total, selected } = allocationSelected.summary();
    cb.checked = total > 0 && selected === total;
    cb.indeterminate = selected > 0 && selected < total;
    cb.disabled = !total;
    selection.on(cb, 'change', 'bulkAllocationHeader', () => bulk(cb.checked));
    selection.on($('allocAll'), 'click', 'selectVisibleAllocations', () => bulk(true));
    selection.on($('allocClearVisible'), 'click', 'clearVisibleAllocations', () => bulk(false));
    selection.on($('allocClear'), 'click', 'clearAllocationSelection', () => {
      allocationSelected.clear();
      renderAllocationChoices();
    });
    root.querySelectorAll('.allocCheck').forEach((x) =>
      selection.on(x, 'click', 'toggleAllocation', (e) => {
        allocationSelected.toggle(Number(x.value), x.checked, e.shiftKey, defaultAmount);
        renderAllocationChoices();
      }),
    );
    root.querySelectorAll('.allocAmount').forEach((x) =>
      selection.on(x, 'input', 'editAllocationAmount', () => {
        allocationSelected.set(Number(x.dataset.id), x.value);
        summary();
      }),
    );
    st.count.textContent = rows.length + '件';
    summary();
  }
  component.on($('onlyAlloc'), 'change', 'showSelectedAllocations', renderAllocationChoices);
  component.on($('paymentForm').elements.method, 'change', 'changePaymentMethod', renderAllocationChoices);

  function render() {
    view.render({ adjustmentTable: { html: adjustmentTable(model.adjustments) } });
    view.render({ paymentTable: { html: paymentTable(model.payments) } });
    view.all('.cancelAdjustment').forEach((b) =>
      component.on(b, 'click', 'cancelAdjustment', async () => {
        const reason = view.prompt('差額調整の取消理由');
        if (!reason?.trim() || !view.confirm('差額調整を取り消し、未決済残高に戻しますか？')) return;
        try {
          await post('/api/adjustments/' + b.dataset.id + '/cancel', { reason });
          await refresh();
          msg('差額調整を取り消しました');
        } catch (e) {
          msg(e.message, true);
        }
      }),
    );
    view.all('.cancelPayment').forEach((b) =>
      component.on(b, 'click', 'cancelPayment', async () => {
        const reason = view.prompt('取消理由を入力してください');
        if (!reason) return;
        try {
          await post('/api/payments/' + b.dataset.id + '/cancel', { reason });
          msg('決済を取消しました');
          await refresh();
        } catch (e) {
          msg(e.message, true);
        }
      }),
    );
    renderAllocationChoices();
  }
  return {
    render,
    filter: renderAllocationChoices,
    setMethod(method) {
      $('paymentForm').elements.method.value = method;
      renderAllocationChoices();
    },
  };
}
