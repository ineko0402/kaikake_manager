export function tabs(component) {
  const view = component.view;
  const $ = (id) => view.find(id);
  const tabState = {};
  const tabConfig = {
    purchases: ['仕入登録', '仕入管理', [0], [1, 2]],
    invoices: ['INVOICE登録', 'INVOICE管理', [0], [1, 2]],
    payments: ['決済登録', '決済管理', [0, 2, 3], [1, 4]],
  };
  for (const [id, c] of Object.entries(tabConfig)) {
    const section = $(id),
      panels = [...section.querySelectorAll(':scope > .panel')];
    const tabs = view.create('div');
    tabs.className = 'tabs';
    section.querySelector('h1').after(tabs);
    for (let n = 0; n < 2; n++) {
      const b = view.create('button');
      b.textContent = c[n];
      component.on(b, 'click', 'changeTab', () => {
        setTab(id, n);
        component.emit('filter');
      });
      tabs.append(b);
    }
    tabState[id] = { panels, tabs, c };
    setTab(id, 0);
  }
  function setTab(id, n) {
    const t = tabState[id];
    if (!t) return;
    t.n = n;
    t.panels.forEach((p, i) => {
      p.style.display = t.c[n + 2].includes(i) ? '' : 'none';
    });
    [...t.tabs.children].forEach((b, i) => b.classList.toggle('active', i === n));
  }
  return { set: setTab };
}
