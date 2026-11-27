import { api, post } from './api.js';
import { purchaseTable } from './presenter.js';
export function purchases(component, model, today) {
  const view = component.view;
  const $ = (id) => view.find(id);
  const values = (form) => view.readForm(form);
  const msg = (text, error = false) => component.emit('status', { text, error });
  const refresh = () => component.emit('refresh');
  component.on($('import'), 'click', 'importPurchases', async () => {
    try {
      let text = $('paste').value;
      let d = await post('/api/purchases/import', { text });
      if (d.needs_confirmation) {
        if (!view.confirm(d.warnings.join('\n') + '\n\n重複を承知で登録しますか？')) return;
        d = await post('/api/purchases/import', { text, override: true });
      }
      msg(d.saved + '件登録しました');
      $('paste').value = '';
      await refresh();
    } catch (e) {
      msg(e.message, true);
    }
  });
  component.on($('closePurchaseEdit'), 'click', 'closePurchaseEdit', () => {
    $('purchaseEditPanel').hidden = true;
  });
  component.on($('purchaseEditForm'), 'submit', 'savePurchaseEdit', async (e) => {
    try {
      const v = values(e.target);
      await api('/api/purchases/' + v.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      });
      $('purchaseEditPanel').hidden = true;
      await refresh();
      msg('仕入明細を更新しました');
    } catch (err) {
      msg(err.message, true);
    }
  });
  function render() {
    view.render({ purchaseTable: { html: purchaseTable(model.purchases) } });
    view.all('.editPurchase').forEach((b) =>
      component.on(b, 'click', 'editPurchase', () => {
        const p = model.purchases.find((x) => x.id === Number(b.dataset.id));
        if (!p) return;
        const f = $('purchaseEditForm');
        for (const k of ['id', 'order_number', 'purchase_date', 'amount_jpy']) f.elements[k].value = p[k];
        f.elements.reason.value = '';
        $('purchaseEditPanel').hidden = false;
        $('purchaseEditPanel').scrollIntoView({ behavior: 'smooth' });
      }),
    );
    view.all('.cancelPurchase').forEach((b) =>
      component.on(b, 'click', 'cancelPurchase', async () => {
        const reason = view.prompt('仕入明細の取消理由');
        if (!reason?.trim() || !view.confirm('仕入明細を取り消しますか？')) return;
        try {
          await post('/api/purchases/' + b.dataset.id + '/cancel', { reason });
          await refresh();
          msg('仕入明細を取り消しました');
        } catch (e) {
          msg(e.message, true);
        }
      }),
    );
  }
  return { render };
}
