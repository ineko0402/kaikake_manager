import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const app = new URL('../app/', import.meta.url);
const temp = mkdtempSync(join(tmpdir(), 'kaikake-regression-'));
const instance = join(temp, 'app');
let server;
let browser;
try {
  cpSync(app, instance, { recursive: true, filter: (file) => !/[/\\](?:data|backup|test-db)$/.test(file) });
  const fixture = join(temp, 'fixture');
  execFileSync(process.execPath, [join(instance, 'create-test-db.mjs'), fixture]);
  mkdirSync(join(instance, 'data'));
  mkdirSync(join(instance, 'backup'));
  cpSync(
    process.env.KAIKAKE_FIXTURE || join(fixture, 'kaikake_test.db'),
    join(instance, 'backup', 'kaikake_test.db'),
  );
  execFileSync(process.execPath, [join(instance, 'restore-db.js'), 'kaikake_test.db']);
  execFileSync(process.execPath, [join(instance, 'backup-db.js')]);

  server = spawn(process.execPath, [join(instance, 'server.js')], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const address = await Promise.race([
    once(server, 'message').then(([message]) => message),
    once(server, 'exit').then(([code]) => {
      throw Error('Server exited: ' + code);
    }),
  ]);
  const base = 'http://127.0.0.1:' + address.port;
  async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + '/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result;
  }
  const suppliers = await api('suppliers');
  assert.equal(suppliers.length, 4);
  const purchases = await api('purchases');
  assert.equal(purchases.length, 6);
  assert.equal(purchases.find((row) => row.branch_number === 2).invoice_number, 'TEST-PARTIAL');
  const invoices = await api('invoices');
  const byNumber = Object.fromEntries(invoices.map((row) => [row.invoice_number, row]));
  for (const [name, remaining] of Object.entries({
    PARTIAL: 10000,
    'RETURN-USED': 0,
    'RETURN-OPEN': -500,
    ADVANCE: 8000,
    OFFSET: 0,
    'CANCELLED-PAYMENT': 4000,
  }))
    assert.equal(byNumber['TEST-' + name].remaining_minor, remaining);
  const history = await api('transfers/history?month=2026-11');
  assert.equal(history.length, 2);
  assert(history.some((row) => row.remittance_message?.includes('編集済み')));
  assert((await api('transfers?month=2027-01')).some((row) => row.invoice_number === 'TEST-UNPAID'));
  assert.deepEqual(
    (await api('feedback')).map((row) => row.done),
    [0, 1],
  );
  const registered = await api('purchases/import', {
    text: 'T001\tCHECK-ORDER\t2026-11-08\t700',
  });
  const registeredInvoice = await api('invoices', {
    supplier_id: suppliers[0].id,
    invoice_number: 'CHECK-INVOICE',
    invoice_date: '2026-11-08',
    total: '20.00',
    purchase_ids: registered.ids,
  });
  assert.equal(
    (await api('purchases')).find((row) => row.id === registered.ids[0]).invoice_id,
    registeredInvoice.id,
  );
  const payment = await api('payments', {
    supplier_id: suppliers[0].id,
    method: 'transfer',
    payment_date: '2026-11-26',
    amount: '5.00',
    allocations: [{ invoice_id: registeredInvoice.id, amount: '5.00' }],
  });
  const balance = async () =>
    (await api('invoices')).find((row) => row.id === registeredInvoice.id).remaining_minor;
  assert.equal(await balance(), 1500);
  await api('payments/' + payment.id + '/cancel', { reason: '回帰テスト' });
  assert.equal(await balance(), 2000);
  await api('invoices/' + registeredInvoice.id + '/cancel', { reason: '回帰テスト' });
  await api('purchases/' + registered.ids[0] + '/cancel', { reason: '回帰テスト' });
  const backup = await api('backup', {});
  assert((await api('backups')).includes(backup.file));
  const db = new DatabaseSync(join(instance, 'data', 'kaikake.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 408);
  } finally {
    db.close();
  }
  console.log('API, DB compatibility, backup and restore passed');

  if (process.env.KAIKAKE_PLAYWRIGHT) {
    const { chromium } = createRequire(import.meta.url)(process.env.KAIKAKE_PLAYWRIGHT);
    browser = await chromium.launch({ executablePath: process.env.KAIKAKE_CHROMIUM });
    const page = await browser.newPage();
    const issues = [];
    page.on('pageerror', (error) => issues.push(error.message));
    await page.goto(base);
    await page.locator('[data-page="invoices"]').click();
    await page.locator('#invoiceForm [name=supplier_id]').selectOption(String(suppliers[0].id));
    await page.locator('#chooseVisible').click();
    assert.match(await page.locator('#chosenSummary').innerText(), /選択 1件/);

    await page.locator('[data-page="payments"]').click();
    await page.locator('#paymentForm [name=supplier_id]').selectOption(String(suppliers[0].id));
    const allocation = page.locator('#allocationChoices');
    await allocation.locator('.allocCheck').first().click();
    await allocation
      .locator('.allocCheck')
      .nth(2)
      .click({ modifiers: ['Shift'] });
    assert.match(await page.locator('#allocSummary').innerText(), /選択 3件/);
    await page.locator('#paymentForm .filterbar input[type=search]').fill('no match');
    assert.match(await page.locator('#allocSummary').innerText(), /表示範囲外 3件/);
    await page.locator('#allocClear').click();
    assert.match(await page.locator('#allocSummary').innerText(), /選択 0件/);

    await page.locator('[data-page="transfers"]').click();
    await page.locator('#actualTab').click();
    await page.locator('#actualMonth').fill('2026-11');
    await page.getByText('2件 ／', { exact: false }).waitFor();
    assert.match(await page.locator('#actualTable').textContent(), /編集済み/);
    await page.locator('[data-page="supplier"]').click();
    const includesModules = await page.locator('script[type=module][src="/app.js"]').count();
    if (includesModules) {
      assert.equal(await page.locator('iframe').count(), 0);
      const route = await page.evaluate(async () => {
        const { Component } = await import('/ui/component.js');
        const notifications = [];
        const root = new Component(document, null, ({ source, type, detail }) => {
          notifications.push(type);
          source.handler(type, detail)?.(detail);
        });
        const parent = root.child('screen', document.body);
        const child = parent.child('table', document.body);
        const button = document.createElement('button');
        child.on(button, 'click', 'selectRow', () => notifications.push('handler'));
        button.click();
        return notifications;
      });
      assert.deepEqual(route, ['selectRow', 'handler']);
    }
    const frame = (await page.locator('iframe').count()) ? page.frameLocator('iframe') : page;
    await frame.locator('#list button').first().click();
    assert.match(await frame.locator('#editorTitle').innerText(), /T001/);
    await frame.locator('#form [name=message_prefix]').fill('CHECK ');
    await frame.locator('#save').click();
    await frame.getByText('保存しました', { exact: true }).waitFor();
    assert.equal((await api('suppliers')).find((row) => row.id === suppliers[0].id).message_prefix, 'CHECK');

    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/transfers/history?month=2026-11')),
      page.locator('[data-page="transfers"]').click(),
    ]);
    await page.locator('#planTab').click();
    await page.locator('#month').fill('2027-01');
    const unpaid = page.locator('#transferTable tr').filter({ hasText: 'TEST-UNPAID' });
    await unpaid.locator('input[type=checkbox]').check();
    const draft = page.locator('#remittanceCards textarea');
    assert.equal(await draft.inputValue(), 'CHECK TEST-UNPAID(60)');
    await draft.fill('edited message for regression');
    await page.locator('#remittanceCards').getByRole('button', { name: '再生成' }).click();
    assert.equal(await draft.inputValue(), 'CHECK TEST-UNPAID(60)');
    await unpaid.locator('.transferAmount').fill('20.00');
    assert.equal(await draft.inputValue(), 'CHECK TEST-UNPAID(20)');
    await draft.fill('edited message for regression');
    await page.locator('#transferPaymentDate').fill('2027-01-10');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#confirmTransfers').click();
    await page
      .getByText(/送金確定: 1件/)
      .waitFor()
      .catch(async (error) => {
        throw new Error(String(error) + '\nStatus: ' + (await page.locator('#status').innerText()));
      });
    assert.equal(
      (await api('transfers/history?month=2027-01'))[0].remittance_message,
      'edited message for regression',
    );
    assert.equal(
      (await api('invoices')).find((row) => row.invoice_number === 'TEST-UNPAID').remaining_minor,
      4000,
    );

    await page.locator('#openFeedback').click();
    await page.locator('#feedbackForm textarea').fill('Browser regression case');
    await page.locator('#feedbackForm button').click();
    await page.getByText('要望を保存しました').waitFor();
    await page.locator('#openFeedback').click();
    await page.locator('#feedbackHistory').click();
    await page.getByText('Browser regression case').waitFor();
    assert.deepEqual(issues, []);
    console.log('Browser selection, filtering, remittance history and suppliers passed');
  }
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  rmSync(temp, { recursive: true, force: true });
}
