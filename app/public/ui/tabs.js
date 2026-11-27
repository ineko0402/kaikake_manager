export function tabs(component) {
  const view = component.view;
  const $ = (id) => view.find(id);
  const tabState = {};
  const tabConfig = {
    purchases: [
      ['Excel取り込み', [0]],
      ['仕入明細', [1, 2]],
    ],
    invoices: [
      ['新しいINVOICE', [0]],
      ['登録済みINVOICE', [1, 2]],
    ],
    payments: [
      ['新しい決済', [0]],
      ['決済履歴', [1]],
      ['前払・差額調整', [2, 3, 4]],
    ],
  };
  for (const [id, c] of Object.entries(tabConfig)) {
    const section = $(id),
      panels = [...section.querySelectorAll(':scope > .panel')];
    const tabs = view.create('div');
    tabs.className = 'tabs';
    section.querySelector('h1').after(tabs);
    for (const [n, [label]] of c.entries()) {
      const b = view.create('button');
      b.textContent = label;
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
    if (!t.c[n]) return;
    t.panels.forEach((p, i) => {
      p.style.display = t.c[n][1].includes(i) ? '' : 'none';
    });
    [...t.tabs.children].forEach((b, i) => {
      b.classList.toggle('active', i === n);
      b.setAttribute('aria-pressed', String(i === n));
    });
  }
  return { set: setTab };
}
