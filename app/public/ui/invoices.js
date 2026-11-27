import { inPeriod, updatePeriodControls } from './filters.js';
import { Selection } from './selection.js';
import { api, post } from './api.js';
import { esc, table, td, money, minorText, invoiceTable } from './presenter.js';
export function invoices(component, model, today, filterStates) {
  const view = component.view;
  const selection = component.child('purchaseSelection', view.find('purchaseChoices'));
  const $ = (id) => view.find(id);
  const values = (form) => view.readForm(form);
  const form = $('invoiceForm');
  const search = $('invoiceSupplierSearch');
  const supplierPicker = component.child('invoiceSupplierSearch', search.closest('.supplier-picker'));
  function renderSupplierOptions() {
    const select = form.elements.supplier_id;
    const selected = select.value;
    const normalize = (value) => value.normalize('NFKC').trim().toLowerCase();
    const terms = normalize(search.value).split(/\s+/).filter(Boolean);
    const matches = model.suppliers.filter(({ code, name }) =>
      terms.every((term) => normalize(code + ' ' + name).includes(term)),
    );
    const matchingIds = new Set(matches.map((supplier) => supplier.id));
    const options = [new Option('選択してください', '')];
    for (const { id, code, name } of model.suppliers) {
      const matchesSearch = matchingIds.has(id);
      if (matchesSearch || String(id) === selected) options.push(new Option(code + ' ' + name, id));
    }
    select.replaceChildren(...options);
    select.value = selected;
    $('invoiceSupplierCount').textContent = terms.length ? matches.length + '件一致' : '';
  }
  supplierPicker.on(search, 'input', 'filterInvoiceSuppliers', renderSupplierOptions);
  const changeSupplier = () => {
    const supplier = model.suppliers.find((row) => row.id === Number(form.elements.supplier_id.value));
    if (
      supplier?.currency &&
      Array.from(form.elements.currency.options).some((option) => option.value === supplier.currency)
    ) {
      form.elements.currency.value = supplier.currency;
    }
    renderPurchaseChoices();
  };
  component.on(form.elements.supplier_id, 'change', 'invoiceSupplier', changeSupplier);
  const msg = (text, error = false) => component.emit('status', { text, error });
  const refresh = () => component.emit('refresh');
  component.on($('invoiceForm'), 'submit', 'saveInvoice', async (e) => {
    try {
      let v = values(e.target);
      v.purchase_ids = [...chosenPurchases.ids()];
      let d = await post('/api/invoices', v);
      if (d.needs_confirmation) {
        if (!view.confirm(d.warnings.join('\n') + '\n登録しますか？')) return;
        d = await post('/api/invoices', { ...v, override: true });
      }
      msg('INVOICE #' + d.id + ' を登録しました');
      e.target.reset();
      e.target.elements.supplier_id.value = v.supplier_id;
      e.target.elements.invoice_date.value = today;
      chosenPurchases.clear();
      choiceSupplier = null;
      e.target.elements.supplier_id.dispatchEvent(new Event('change'));
      await refresh();
      choiceSupplier = null;
      renderPurchaseChoices();
      updateDifference(e.target, e.target.elements.currency.value);
    } catch (e) {
      msg(e.message, true);
    }
  });
  component.on($('closeInvoiceEdit'), 'click', 'closeInvoiceEdit', () => {
    $('invoiceEditPanel').hidden = true;
  });
  component.on($('invoiceEditForm'), 'submit', 'saveInvoiceEdit', async (e) => {
    try {
      const v = values(e.target);
      const id = v.id;
      let d = await api('/api/invoices/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      });
      if (d.needs_confirmation) {
        if (!view.confirm(d.warnings.join('\n') + '\n変更しますか？')) return;
        d = await api('/api/invoices/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...v, override: true }),
        });
      }
      msg('INVOICEを更新しました');
      $('invoiceEditPanel').hidden = true;
      await refresh();
    } catch (e) {
      msg(e.message, true);
    }
  });
  component.on($('applyInvoiceTemplate'), 'click', 'applyInvoiceTemplate', () => {
    const f = $('invoiceForm'),
      s = model.suppliers.find((x) => x.id === Number(f.elements.supplier_id.value));
    if (!s?.invoice_number_template) return msg('この仕入先には番号テンプレートがありません', true);
    const selected = selectedPurchases();
    const d = selected.map((x) => x.purchase_date).sort()[0] || f.elements.invoice_date.value;
    if (!d) return msg('INVOICE日付を入力してください', true);
    const [yyyy, mm, dd] = d.split('-'),
      yy = yyyy.slice(2);
    const tokens = {
      yyyy,
      yy,
      mm,
      dd,
      yymm: yy + mm,
      yymmdd: yy + mm + dd,
      yyyymmdd: yyyy + mm + dd,
      yyyymm: yyyy + mm,
    };
    f.elements.invoice_number.value = s.invoice_number_template.replace(
      /\{(yyyy|yy|mm|dd|yymm|yymmdd|yyyymmdd|yyyymm)\}/g,
      (m, k) => tokens[k],
    );
    msg((selected.length ? '最も早い仕入日 ' : 'INVOICE日付 ') + d + ' を基準に番号を作成しました');
  });
  function updateDifference(f, c) {
    const g = f.elements.goods.value.replace(/,/g, ''),
      t = f.elements.total.value.replace(/,/g, '');
    f.querySelector('.difference').textContent =
      g && t && Number.isFinite(Number(g)) && Number.isFinite(Number(t))
        ? money(Math.round((Number(t) - Number(g)) * (c === 'JPY' ? 1 : 100)), c)
        : '—';
  }
  for (const f of [$('invoiceForm'), $('invoiceEditForm')])
    component.on(f, 'input', 'calculateInvoiceDifference', () =>
      updateDifference(
        f,
        f.elements.currency?.value ||
          model.invoices.find((i) => i.id === Number(f.elements.id?.value))?.currency ||
          'USD',
      ),
    );
  component.on($('invoiceForm').elements.supplier_id, 'change', 'applySupplierMethod', () => {
    const s = model.suppliers.find((x) => x.id === Number($('invoiceForm').elements.supplier_id.value));
    $('invoiceForm').elements.settlement_method.value = s?.default_settlement_method || 'transfer';
  });
  const chosenPurchases = new Selection();
  let choiceSupplier = null;
  function selectedPurchases() {
    return model.purchases.filter(
      (p) =>
        chosenPurchases.has(p.id) &&
        !p.invoice_id &&
        p.supplier_id === Number($('invoiceForm').elements.supplier_id.value),
    );
  }
  function renderPurchaseChoices() {
    const sid = Number($('invoiceForm').elements.supplier_id.value),
      st = filterStates.purchaseChoices;
    const candidates = model.purchases.filter((p) => !p.invoice_id && p.supplier_id === sid);
    const details = $('invoicePurchaseDetails');
    details.hidden = !sid;
    if (choiceSupplier !== sid) {
      details.open = false;
      choiceSupplier = sid;
      chosenPurchases.clear();
      $('onlyChosen').checked = false;
      st.period.value = 'month';
      st.sort.value = 'asc';
      st.search.value = '';
      st.month.value =
        candidates
          .map((p) => p.purchase_date)
          .sort()[0]
          ?.slice(0, 7) || today.slice(0, 7);
    }
    const only = $('onlyChosen').checked;
    updatePeriodControls(st, only);
    const rows = candidates
      .filter((p) =>
        only
          ? chosenPurchases.has(p.id)
          : inPeriod(p.purchase_date, st) &&
            String(p.order_number).toLowerCase().includes(st.search.value.toLowerCase()),
      )
      .sort(
        (a, b) =>
          (st.sort.value === 'asc' ? 1 : -1) *
          (a.purchase_date.localeCompare(b.purchase_date) || a.id - b.id),
      );
    $('purchaseChoices').innerHTML = table(
      ['選択', '発注番号', '枝番', '仕入日', '金額'],
      rows.map(
        (p) =>
          `<tr><td><input type="checkbox" class="purchaseChoice" value="${p.id}" ${chosenPurchases.has(p.id) ? 'checked' : ''}></td><td>${esc(p.order_number)}</td><td>${p.branch_number}</td><td>${p.purchase_date}</td><td>${money(p.amount_jpy, 'JPY')}</td></tr>`,
      ),
    );
    chosenPurchases.update(candidates, rows, [
      sid,
      only,
      st.period.value,
      st.month.value,
      st.day.value,
      st.search.value,
      st.sort.value,
    ]);
    const root = $('purchaseChoices');
    const header = root.querySelector('th');
    header.innerHTML = '<input type="checkbox" id="chooseVisibleHeader" aria-label="表示中の仕入を一括選択">';
    function syncSelection() {
      root
        .querySelectorAll('.purchaseChoice')
        .forEach((x) => (x.checked = chosenPurchases.has(Number(x.value))));
      const { total, selected: count, outside } = chosenPurchases.summary();
      const all = $('chooseVisibleHeader');
      all.checked = total > 0 && count === total;
      all.indeterminate = count > 0 && count < total;
      all.disabled = !total;
      $('chooseVisible').disabled = !total || count === total;
      $('chooseVisible').textContent = `表示中の${total}件を選択`;
      $('clearVisible').disabled = !count;
      $('clearAllChoices').disabled = !chosenPurchases.size;
      $('outsideChoices').textContent = outside ? `表示範囲外にも ${outside}件 選択中` : '';
      updatePurchaseSummary();
    }
    function bulk(checked) {
      chosenPurchases.bulk(checked);
      renderPurchaseChoices();
    }
    selection.on($('chooseVisibleHeader'), 'change', 'bulkPurchaseHeader', (e) => bulk(e.target.checked));
    selection.on($('chooseVisible'), 'click', 'selectVisiblePurchases', () => bulk(true));
    selection.on($('clearVisible'), 'click', 'clearVisiblePurchases', () => bulk(false));
    selection.on($('clearAllChoices'), 'click', 'clearPurchaseSelection', () => {
      chosenPurchases.clear();
      renderPurchaseChoices();
    });
    root.querySelectorAll('.purchaseChoice').forEach((x) =>
      selection.on(x, 'click', 'togglePurchase', (e) => {
        chosenPurchases.toggle(Number(x.value), x.checked, e.shiftKey);
        if (only) renderPurchaseChoices();
        else syncSelection();
      }),
    );
    st.count.textContent = rows.length + '件';
    syncSelection();
  }
  function updatePurchaseSummary() {
    const rows = selectedPurchases(),
      sum = rows.reduce((n, p) => n + p.amount_jpy, 0),
      date = rows.map((p) => p.purchase_date).sort()[0],
      f = $('invoiceForm');
    $('chosenSummary').textContent = `選択 ${rows.length}件 ／ ${money(sum, 'JPY')}`;
    $('applyPurchaseDate').disabled = !date;
    $('applyPurchaseDate').textContent = date ? `仕入日 ${date} を適用` : '仕入日を適用';
    const raw = f.elements.total.value.trim().replace(/,/g, '');
    $('purchaseDifference').textContent =
      f.elements.currency.value === 'JPY' &&
      rows.length &&
      /^-?\d+$/.test(raw) &&
      Number.isSafeInteger(Number(raw))
        ? '請求総額 − 仕入合計：' + money(Number(raw) - sum, 'JPY')
        : '';
  }
  component.on($('onlyChosen'), 'change', 'showSelectedPurchases', renderPurchaseChoices);
  component.on($('invoiceForm'), 'input', 'updatePurchaseSummary', updatePurchaseSummary);
  component.on($('applyPurchaseDate'), 'click', 'applyPurchaseDate', () => {
    const d = selectedPurchases()
      .map((p) => p.purchase_date)
      .sort()[0];
    if (!d) return;
    $('invoiceForm').elements.invoice_date.value = d;
    $('onlyChosen').checked = true;
    renderPurchaseChoices();
    msg('仕入日 ' + d + ' を適用しました');
  });
  function render() {
    renderSupplierOptions();
    view.render({ invoiceTable: { html: invoiceTable(model.invoices) } });
    view.all('.editInvoice').forEach((b) =>
      component.on(b, 'click', 'editInvoice', () => {
        const i = model.invoices.find((x) => x.id === Number(b.dataset.id));
        if (!i) return;
        const f = $('invoiceEditForm');
        for (const k of [
          'id',
          'invoice_number',
          'invoice_date',
          'due_date',
          'due_reason',
          'usage_class',
          'difference_reason',
          'settlement_method',
        ])
          f.elements[k].value = i[k] ?? (k === 'due_reason' ? '' : '');
        f.elements.due_reason.value = i.due_override_reason || '';
        f.elements.goods.value = minorText(i.goods_minor, i.currency);
        f.elements.total.value = minorText(i.total_minor, i.currency);
        f.elements.reason.value = '';
        f.querySelector('details').open =
          i.goods_minor != null ||
          !!i.difference_reason ||
          !!i.due_override_reason ||
          i.usage_class !== 'purchase';
        $('invoiceEditPanel').hidden = false;
        updateDifference(f, i.currency);
        $('invoiceEditPanel').scrollIntoView({ behavior: 'smooth' });
      }),
    );
    view.all('.cancelInvoice').forEach((b) =>
      component.on(b, 'click', 'cancelInvoice', async () => {
        const reason = view.prompt('INVOICE取消理由を入力してください');
        if (!reason?.trim()) return;
        if (!view.confirm('INVOICEを取り消しますか？紐付けた仕入明細は未紐付けに戻ります。')) return;
        try {
          await post('/api/invoices/' + b.dataset.id + '/cancel', { reason });
          msg('INVOICEを取り消しました');
          await refresh();
        } catch (e) {
          msg(e.message, true);
        }
      }),
    );
    renderPurchaseChoices();
  }
  return { render, filter: renderPurchaseChoices };
}
