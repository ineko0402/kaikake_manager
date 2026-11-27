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
    view.render({ feedbackList: { html: feedbackTable(feedback) } });
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
  component.on($('exportFeedback'), 'click', 'exportFeedback', () => {
    const text = feedback
      .filter((x) => !x.done)
      .map((x) => `[${x.category}] ${x.page} / ${x.version} / ${x.created_at}\n${x.content}`)
      .join('\n\n');
    view.download(text, '要望.txt');
  });
  navigation.on(navigation.view.find('openFeedback'), 'click', 'openFeedback', () => {
    const current = navigation.view.scope.querySelector('.page.active');
    field('feedbackForm').elements.page.value =
      current.querySelector('.tabs button.active')?.textContent ||
      current.querySelector('h1')?.textContent ||
      '仕入先マスター';
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
