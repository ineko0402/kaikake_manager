import { api, post } from './api.js';
import { feedbackTable } from './presenter.js';
export function feedback(component, navigation) {
  const view = component.view;
  const dialog = component.child('feedbackDialog', navigation.view.find('feedbackDialog'));
  const $ = (id) => view.find(id);
  const field = (id) => dialog.view.find(id);
  const dialogElement = navigation.view.find('feedbackDialog');
  const values = (form) => view.readForm(form);
  const msg = (text, error = false) => component.emit('status', { text, error });
  let feedback = [];
  async function loadFeedback() {
    feedback = await api('/api/feedback');
    render();
  }
  function visibleFeedback() {
    const status = $('feedbackFilter').value;
    const direction = $('feedbackSort').value === 'oldest' ? 1 : -1;
    return feedback
      .filter((row) => status === 'all' || Boolean(row.done) === (status === 'done'))
      .sort((a, b) => direction * (a.created_at.localeCompare(b.created_at) || a.id - b.id));
  }
  function render() {
    const rows = visibleFeedback();
    view.render({
      feedbackList: rows.length ? { html: feedbackTable(rows) } : { text: '対象の要望はありません。' },
      exportFeedback: { disabled: !rows.length },
      copyFeedback: { disabled: !rows.length },
    });
    view.all('[data-feedback]').forEach((b) =>
      component.on(b, 'change', 'toggleFeedback', async () => {
        try {
          await api('/api/feedback/' + b.dataset.feedback, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ done: b.checked }),
          });
          await loadFeedback();
        } catch (e) {
          msg(e.message, true);
        }
      }),
    );
  }
  dialog.on(field('feedbackForm'), 'submit', 'saveFeedback', async (e) => {
    try {
      await post('/api/feedback', values(e.target));
      e.target.elements.content.value = '';
      dialogElement.close();
      msg('要望を保存しました');
    } catch (e) {
      field('feedbackStatus').textContent = e.message;
    }
  });
  component.on($('feedbackFilter'), 'change', 'filterFeedback', render);
  component.on($('feedbackSort'), 'change', 'sortFeedback', render);
  const exportText = () =>
    visibleFeedback()
      .map((x) => `[${x.category}] ${x.page} / ${x.version} / ${x.created_at}\n${x.content}`)
      .join('\n\n');
  component.on($('exportFeedback'), 'click', 'exportFeedback', () => view.download(exportText(), '要望.txt'));
  component.on($('copyFeedback'), 'click', 'copyFeedback', async () => {
    await view.copy(exportText());
    msg('表示中の要望をコピーしました');
  });
  navigation.on(navigation.view.find('openFeedback'), 'click', 'openFeedback', () => {
    const current = navigation.view.scope.querySelector('.page.active');
    field('feedbackForm').elements.page.value =
      current.querySelector('.tabs button.active')?.textContent ||
      current.querySelector('h1')?.textContent ||
      '仕入先マスター';
    field('feedbackForm').elements.category.value = '改善要望';
    field('feedbackStatus').textContent = '';
    dialogElement.showModal();
  });
  dialog.on(field('closeFeedback'), 'click', 'closeFeedback', () => dialogElement.close());
  dialog.on(field('feedbackHistory'), 'click', 'viewFeedbackHistory', () => {
    dialogElement.close();
    component.emit('navigate', { page: 'feedback' });
  });
  return { load: loadFeedback };
}
