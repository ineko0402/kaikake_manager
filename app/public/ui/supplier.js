import { api } from './api.js';
export function supplier(component, model) {
  const view = component.view;
  const $ = (id) => view.find(id);
  const form = $('form');
  let selectedId = null,
    dirty = false;
  const keys = [
    'code',
    'name',
    'payee_name',
    'currency',
    'bank_beneficiary_code',
    'supplier_country',
    'origin_country',
    'shipping_port',
    'main_business',
    'is_active',
    'default_settlement_method',
    'payment_terms',
    'invoice_number_template',
    'message_format',
    'message_prefix',
    'message_separator',
    'message_suffix',
  ];
  function message(s, error = false) {
    $('message').textContent = s;
    $('message').style.color = error ? '#b13b3b' : '#236d4b';
  }
  function confirmDiscard() {
    return !dirty || view.confirm('未保存の編集内容があります。破棄して移動しますか？');
  }
  function fill(row) {
    HTMLFormElement.prototype.reset.call(form);
    for (const k of keys) {
      const el = form.elements.namedItem(k);
      const value =
        row?.[k] ??
        (k === 'message_format'
          ? 'number'
          : k === 'message_separator'
            ? ' '
            : k === 'is_active'
              ? '1'
              : k === 'default_settlement_method'
                ? 'transfer'
                : '');
      if (k === 'currency' && value && !Array.from(el.options).some((o) => o.value === value)) {
        el.add(new Option(value, value));
      }
      el.value = value;
    }
    syncToggle();
    selectedId = row?.id ?? null;
    $('editorTitle').textContent = row ? `仕入先の編集：${row.code}` : '新規登録';
    dirty = false;
    message('');
    render();
  }
  function render() {
    const q = $('search').value.toLowerCase();
    const filtered = model.suppliers.filter(
      (r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
    );
    $('count').textContent = `${filtered.length} 件`;
    $('list').replaceChildren();
    for (const r of filtered) {
      const b = view.create('button');
      b.type = 'button';
      b.className = 'supplier' + (r.id === selectedId ? ' active' : '');
      const title = view.create('strong');
      title.textContent = `${r.code}　${r.name}`;
      const detail = view.create('small');
      detail.textContent = `${r.currency || '通貨未設定'} / ${r.is_active ? '使用中' : '未使用'}`;
      b.append(title, detail);
      component.on(b, 'click', 'editSupplier', () => {
        if (confirmDiscard()) {
          fill(r);
          view.scope.querySelector('.editor').style.display = '';
        }
      });
      $('list').append(b);
    }
  }
  const refresh = () => component.emit('refresh');
  function markDirty() {
    dirty = true;
    message('未保存の変更があります');
  }
  function syncToggle() {
    const enabled = form.elements.is_active.value === '1';
    $('activeToggle').checked = enabled;
    $('activeText').textContent = enabled ? '使用する' : '使用しない';
  }
  component.on($('activeToggle'), 'change', 'toggleSupplier', () => {
    form.elements.is_active.value = $('activeToggle').checked ? '1' : '0';
    syncToggle();
    markDirty();
  });
  component.on($('copySupplier'), 'click', 'copySupplierName', () => {
    form.elements.payee_name.value = form.elements.name.value;
    markDirty();
  });
  component.on($('defaultTerms'), 'click', 'applyDefaultTerms', () => {
    form.elements.payment_terms.value = '月末締め・翌々月10日払い';
    markDirty();
  });
  for (const button of view.all('[data-token]'))
    component.on(button, 'click', 'insertInvoiceToken', () => {
      const el = form.elements.invoice_number_template;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const token = button.dataset.token;
      el.setRangeText(token, start, end, 'end');
      el.focus();
      markDirty();
    });
  component.on($('new'), 'click', 'newSupplier', () => {
    if (confirmDiscard()) {
      fill(null);
      supplierTab(0);
    }
  });
  component.on($('discard'), 'click', 'discardSupplierEdit', () => {
    if (confirmDiscard()) fill(model.suppliers.find((r) => r.id === selectedId));
  });
  component.on($('search'), 'input', 'searchSupplier', render);
  component.on(form, 'input', 'editSupplierField', () => {
    dirty = true;
    message('未保存の変更があります');
  });
  component.on(form, 'change', 'changeSupplierField', () => {
    dirty = true;
    message('未保存の変更があります');
  });
  component.on(form, 'submit', 'saveSupplier', async (e) => {
    const obj = {};
    for (const k of keys) obj[k] = form.elements[k].value;
    obj.is_active = obj.is_active === '1';
    obj.currency = obj.currency.toUpperCase().trim();
    const button = $('save');
    button.disabled = true;
    try {
      const saved = await api(selectedId ? `/api/suppliers/${selectedId}` : '/api/suppliers', {
        method: selectedId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj),
      });
      await refresh();
      fill(saved);
      message('保存しました');
    } catch (e) {
      message(e.message, true);
    } finally {
      button.disabled = false;
    }
  });

  const tabs = view.create('div');
  tabs.className = 'tabs';
  tabs.innerHTML = '<button type="button">新規登録</button><button type="button">仕入先一覧</button>';
  view.scope.querySelector('h1').after(tabs);
  function supplierTab(n) {
    view.scope.querySelector('.listpanel').style.display = n ? '' : 'none';
    view.scope.querySelector('.editor').style.display = n ? 'none' : '';
    view.scope.querySelector('.content').classList.toggle('registration', n === 0);
    [...tabs.children].forEach((button, index) => {
      button.classList.toggle('active', index === n);
      button.setAttribute('aria-pressed', String(index === n));
    });
  }
  component.on(tabs.children[0], 'click', 'supplierRegistrationTab', () => {
    if (confirmDiscard()) {
      fill(null);
      supplierTab(0);
    }
  });
  component.on(tabs.children[1], 'click', 'supplierManagementTab', () => {
    if (confirmDiscard()) {
      fill(null);
      supplierTab(1);
      return refresh();
    }
  });
  supplierTab(1);
  return { render, dirty: () => dirty };
}
