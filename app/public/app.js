import { Component } from './ui/component.js';
import { api } from './ui/api.js';
import { esc } from './ui/presenter.js';
import { tabs } from './ui/tabs.js';
import { filters } from './ui/filters.js';
import { purchases } from './ui/purchases.js';
import { invoices } from './ui/invoices.js';
import { payments } from './ui/payments.js';
import { transfers } from './ui/transfers.js';
import { backup } from './ui/backup.js';
import { feedback } from './ui/feedback.js';
import { supplier } from './ui/supplier.js';
import { dashboard } from './ui/dashboard.js';
import { voucherWorksheet } from './ui/worksheet.js';

const model = { suppliers: [], purchases: [], invoices: [], payments: [], adjustments: [] };
const today = new Date().toLocaleDateString('sv-SE');
const tableByPage = { purchases: 'purchaseTable', invoices: 'invoiceTable', payments: 'paymentTable' };
const filterPage = {
  purchaseChoices: 'invoices',
  allocationChoices: 'payments',
  ...Object.fromEntries(Object.entries(tableByPage).map(([page, table]) => [table, page])),
};

class AppMediator {
  #root;
  #page = 'dashboard';
  #load = 0;
  #busy = new Set();
  #screens;
  #filters;
  #tabs;

  constructor() {
    this.#root = new Component(document, null, (event) => this.dispatch(event));
    const view = this.#root.view;
    const page = (id) => this.#root.child(id, view.find(id));
    const panels = Object.fromEntries(
      Array.from(view.all('.page'), (element) => [element.id, page(element.id)]),
    );
    const navigation = this.#root.child('navigation', document);
    this.#tabs = tabs(navigation);
    this.#filters = filters(navigation, (id) => panels[filterPage[id]], model, today);
    const controls = this.#filters.states;
    this.#screens = {
      dashboard: dashboard(panels.dashboard, model, today),
      purchases: purchases(panels.purchases, model, today),
      invoices: invoices(panels.invoices, model, today, controls),
      payments: payments(panels.payments, model, today, controls),
      transfers: transfers(panels.transfers, model, today),
      supplier: supplier(panels.supplier, model),
      backup: backup(panels.backup),
      feedback: feedback(panels.feedback, navigation),
    };
    voucherWorksheet(this.#root, today);
    for (const nav of view.all('[data-page]')) {
      navigation.on(nav, 'click', 'openPage', () => navigation.emit('navigate', { page: nav.dataset.page }));
    }
    for (const nav of view.all('[data-flow]')) {
      panels.workflow.on(nav, 'click', 'openWorkflowStep', () =>
        panels.workflow.emit('navigate', {
          page: nav.dataset.flow,
          tab: Number(nav.dataset.tab),
          plan: nav.dataset.flow === 'transfers',
        }),
      );
    }
    for (const input of view.all('input[type=date]')) {
      if (input.name !== 'due_date') input.value = today;
    }
    view.observeUnload();
    view.observeHistory();
  }

  async start() {
    const saved = this.#root.view.historyPage();
    if (saved) await this.navigate(saved, true);
    else {
      this.#root.view.saveHistoryPage({ page: this.#page }, true);
      await this.refresh();
    }
    await this.#screens.backup.load();
  }

  #savePage(filter) {
    const view = this.#root.view;
    const page = this.#page;
    const tab = this.#screens[page]?.selectedTab?.() ?? this.#tabs.selected(page);
    const current = view.historyPage();
    if (current?.page === page && current.tab === tab && (filter === undefined || current.filter === filter))
      return;
    view.saveHistoryPage({ page, tab, filter });
  }

  status(text, error = false) {
    this.#root.view.render({ status: { text, className: error ? 'status error' : 'status' } });
  }

  async navigate({ page, tab, filter, plan, currentMonth }, restoring = false) {
    if (!this.#root.view.find(page)?.classList.contains('page')) return;
    if (page !== this.#page) this.#root.view.scope.querySelector('main').scrollTop = 0;
    this.#page = page;
    if (filter !== undefined) this.#filters.reset(tableByPage[page], filter);
    if (tab !== undefined) {
      if (this.#screens[page]?.setTab) this.#screens[page].setTab(tab);
      else this.#tabs.set(page, tab);
    }
    if (plan) this.#screens.transfers.plan(currentMonth);
    for (const section of this.#root.view.all('.page'))
      section.classList.toggle('active', section.id === page);
    for (const nav of this.#root.view.all('[data-page]'))
      nav.classList.toggle('active', nav.dataset.page === page);
    if (!restoring) this.#savePage(filter);
    this.status('');
    await this.refresh();
    if (page !== this.#page) return;
    if (page === 'transfers') await this.#screens.transfers.enter();
    if (page === 'feedback') await this.#screens.feedback.load();
  }

  async refresh() {
    const request = ++this.#load;
    const keys = Object.keys(model);
    const lists = await Promise.all(keys.map((key) => api('/api/' + key)));
    if (request !== this.#load) return;
    for (const [index, key] of keys.entries()) model[key] = lists[index];
    const options =
      '<option value="">選択してください</option>' +
      model.suppliers
        .map(
          (supplier) => `<option value="${supplier.id}">${esc(supplier.code + ' ' + supplier.name)}</option>`,
        )
        .join('');
    for (const select of this.#root.view.all('select.suppliers')) {
      const selected = select.value;
      select.innerHTML = options;
      select.value = selected;
    }
    for (const name of ['dashboard', 'purchases', 'invoices', 'payments', 'supplier'])
      this.#screens[name].render();
    this.#filters.apply();
  }

  dispatch({ source, type, detail }) {
    switch (type) {
      case 'beforeUnload':
        return this.#screens.supplier.dirty();
      case 'status':
        return this.status(detail.text, detail.error);
      case 'navigate':
        return this.navigate(detail).catch((error) => this.status(error.message, true));
      case 'tabChanged':
        if (detail === this.#page) this.#savePage();
        return;
      case 'restorePage':
        for (const dialog of this.#root.view.all('dialog[open]')) dialog.close();
        return this.navigate(detail ?? { page: 'dashboard' }, true).catch((error) =>
          this.status(error.message, true),
        );
      case 'refresh':
        return this.refresh();
      case 'filter':
        if (detail === 'purchaseChoices' || detail === 'allocationChoices')
          return this.#screens[filterPage[detail]].filter();
        return this.#filters.apply();
    }
    const handler = source.handler(type, detail);
    if (!handler) return;
    const exclusive = detail.type === 'submit' || type === 'confirmTransfers' || type === 'makeBackup';
    if (exclusive && this.#busy.has(type)) return;
    if (exclusive) this.#busy.add(type);
    try {
      const result = handler(detail);
      if (result?.then) {
        return result
          .catch((error) => this.status(error.message, true))
          .finally(() => this.#busy.delete(type));
      }
      if (exclusive) this.#busy.delete(type);
      return result;
    } catch (error) {
      if (exclusive) this.#busy.delete(type);
      this.status(error.message, true);
    }
  }
}

const mediator = new AppMediator();
mediator.start().catch((error) => mediator.status(error.message, true));
