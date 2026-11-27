import { api, post } from './api.js';
import { esc } from './presenter.js';
export function backup(component, model, today) {
  const view = component.view;
  const $ = (id) => view.find(id);
  const msg = (text, error = false) => component.emit('status', { text, error });
  component.on($('makeBackup'), 'click', 'makeBackup', async () => {
    try {
      let d = await post('/api/backup', {});
      msg('バックアップ作成: ' + d.file);
      loadBackups();
    } catch (e) {
      msg(e.message, true);
    }
  });
  async function loadBackups() {
    try {
      $('backupList').innerHTML = (await api('/api/backups'))
        .map((x) => '<div>' + esc(x) + '</div>')
        .join('');
    } catch (e) {
      msg(e.message, true);
    }
  }
  return { load: loadBackups };
}
