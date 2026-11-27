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
  const payments = await api('payments');
  const originalTransfer = payments.find((row) => row.method === 'transfer' && row.status === 'active');
  const cancelledTransfer = payments.find((row) => row.status === 'cancelled');
  const monthly = await api('payments/worksheet?month=2026-11');
  assert.equal(monthly.length, 3);
  assert(monthly.every((row) => row.id !== cancelledTransfer.id && row.payment_date.startsWith('2026-11')));
  const worksheet = monthly.find((row) => row.id === originalTransfer.id);
  assert.equal(worksheet.amount_minor, 8000);
  assert.deepEqual(
    worksheet.allocations.map((row) => [row.invoice_number, row.amount_minor]),
    [
      ['TEST-PARTIAL', 10000],
      ['TEST-RETURN-USED', -2000],
    ],
  );
  assert.equal(worksheet.allocations[0].invoice_jpy, 30000);
  assert.equal(worksheet.allocations[0].invoice_total_minor, 20000);
  assert.equal(monthly.find((row) => row.method === 'advance').remaining_minor, 15000);
  assert.deepEqual(await api('payments/worksheet?month=2025-11'), []);
  assert.equal((await fetch(base + '/api/payments/worksheet?month=2026-13')).status, 400);
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
  const advanceInvoice = byNumber['TEST-ADVANCE'];
  const arrival = await api('purchases/import', {
    text: 'T002\tCHECK-ARRIVAL\t2026-11-12\t7000',
  });
  const advancePayment = (await api('payments')).find((row) => row.method === 'advance');
  await api('allocations', {
    payment_id: advancePayment.id,
    invoice_id: advanceInvoice.id,
    allocation_date: '2026-11-12',
    amount: String(advanceInvoice.remaining_minor),
  });
  const originalBalance = (await api('invoices')).find((row) => row.id === advanceInvoice.id).remaining_minor;
  assert.equal(originalBalance, 0);
  const beforeAdvancePayment = (await api('payments')).find((row) => row.id === advancePayment.id);
  const invalidLink = await fetch(base + `/api/invoices/${advanceInvoice.id}/purchases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purchase_ids: [arrival.ids[0], purchases[0].id] }),
  });
  assert.equal(invalidLink.status, 400);
  assert.equal((await api('purchases')).find((row) => row.id === arrival.ids[0]).invoice_id, null);
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
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page.setDefaultTimeout(10000);
    const issues = [];
    page.on('pageerror', (error) => issues.push(error.message));
    await page.goto(base);
    await page.locator('[data-page="workflow"]').click();
    assert(await page.evaluate(() => document.documentElement.scrollHeight === innerHeight));
    assert.equal(await page.locator('header').evaluate((node) => node.getBoundingClientRect().top), 0);
    await page.locator('[data-page="invoices"]').click();
    const purchaseDetails = page.locator('#invoicePurchaseDetails');
    for (const width of [950, 960, 640, 390]) {
      await page.setViewportSize({ width, height: 720 });
      const [button, panel] = await Promise.all(
        ['#saveInvoice', '#invoices > .panel:visible'].map((selector) =>
          page.locator(selector).boundingBox(),
        ),
      );
      assert(button.x - panel.x < 24);
      assert(button.x + button.width < width && button.y + button.height < 720);
      assert(await page.locator('main').evaluate((main) => main.scrollWidth === main.clientWidth));
      for (const selector of ['#openFeedback', '#invoiceForm [name=total]', '#invoiceForm [name=currency]']) {
        const bounds = await page.locator(selector).boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
      }
    }
    await page.locator('#saveInvoice').click();
    assert.equal(await page.locator('#invoiceSaveStatus').innerText(), '仕入先を候補から選択してください');
    assert.equal(
      await page.locator('#invoiceSupplierSearch').evaluate((field) => field === document.activeElement),
      true,
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    const saveInvoice = await page.locator('#saveInvoice').boundingBox();
    const invoiceSearch = await page.locator('#invoiceSupplierSearch').boundingBox();
    assert(saveInvoice.y < invoiceSearch.y);
    assert.equal(await page.locator('#saveInvoice').getAttribute('form'), 'invoiceForm');
    assert.equal(
      await page.locator('#applyInvoiceTemplate').getAttribute('aria-label'),
      '仕入先の番号テンプレートを適用',
    );
    assert.equal(await purchaseDetails.isVisible(), false);
    const supplierSearch = page.locator('#invoiceSupplierSearch');
    await supplierSearch.fill('Ｔ００１ テスト商事');
    assert.equal(await page.locator('#invoiceSupplierCount').innerText(), '1件一致');
    assert.equal(await page.locator('#invoiceSupplierOptions [role=option]').count(), 1);
    await supplierSearch.press('ArrowDown');
    await supplierSearch.press('Enter');
    assert.equal(await supplierSearch.inputValue(), 'T001 テスト商事');
    await supplierSearch.fill('テスト工業');
    assert.equal(await supplierSearch.evaluate((field) => field.validity.valid), false);
    await supplierSearch.press('Escape');
    assert.equal(await supplierSearch.inputValue(), 'T001 テスト商事');
    assert.equal(await page.locator('#invoiceForm [name=supplier_id]').inputValue(), String(suppliers[0].id));
    assert.equal(await purchaseDetails.evaluate((node) => node.open), true);
    await page.setViewportSize({ width: 640, height: 500 });
    const main = page.locator('main');
    await main.evaluate((node) => {
      node.scrollTop = 280;
    });
    const stickyTop = await page.locator('#saveInvoice').evaluate((node) => node.getBoundingClientRect().top);
    const mainTop = await main.evaluate((node) => node.getBoundingClientRect().top);
    const tabTop = await page.locator('#invoices .tabs').evaluate((node) => node.getBoundingClientRect().top);
    const heading = await page
      .locator('.invoice-heading')
      .evaluate((node) => node.getBoundingClientRect().top);
    const scrolled = await main.evaluate((node) => node.scrollTop);
    assert(
      scrolled > 100 && heading >= mainTop && heading < mainTop + 18,
      JSON.stringify({ heading, mainTop, tabTop, stickyTop, scrolled }),
    );
    assert(
      tabTop > heading && tabTop < heading + 70,
      JSON.stringify({ heading, mainTop, tabTop, stickyTop }),
    );
    assert(stickyTop > tabTop && stickyTop < mainTop + 125);
    await main.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('#chooseVisible').click();
    await purchaseDetails.locator('summary').click();
    assert.equal(await page.locator('#chosenSummary').isVisible(), true);
    const invoiceTotal = page.locator('#invoiceForm [name=total]');
    await invoiceTotal.fill('150.00');
    assert.match(await page.locator('#invoiceReferenceRate').innerText(), /60 円 \/ USD/);
    await invoiceTotal.fill('0');
    assert.equal(await page.locator('#invoiceReferenceRate').isVisible(), false);
    await invoiceTotal.fill('150.00');
    await page.locator('#invoiceForm [name=currency]').selectOption('JPY');
    assert.equal(await page.locator('#invoiceReferenceRate').isVisible(), false);
    assert.match(await page.locator('#chosenSummary').innerText(), /選択 1件/);

    await page.locator('[data-page="payments"]').click();
    assert.equal(await page.locator('#paymentAllocation').isVisible(), false);
    assert.equal(await page.locator('#advanceForm').isVisible(), false);
    await page.getByRole('button', { name: '前払・差額調整' }).click();
    assert.equal(await page.locator('#advanceForm').isVisible(), true);
    assert.equal(await page.locator('#adjustmentTable').isVisible(), true);
    await page.getByRole('button', { name: '決済履歴', exact: true }).click();
    assert.equal(await page.locator('#paymentTable').isVisible(), true);
    await page.locator('#voucherMonth').fill('2026-11');
    const [monthField, worksheetButton] = await Promise.all(
      ['#voucherMonth', '#openVoucher'].map((selector) => page.locator(selector).boundingBox()),
    );
    assert.equal(monthField.height, worksheetButton.height);
    assert.equal(monthField.y, worksheetButton.y);
    await page.locator('#openVoucher').click();
    await page.locator('#voucherDialog').waitFor({ state: 'visible' });
    const sheet = page.locator('#voucherSheet');
    await sheet.locator('table').waitFor();
    assert.match(await sheet.innerText(), /TEST-RETURN-USED/);
    assert.match(await sheet.innerText(), /80\.00 USD/);
    assert.match(await sheet.innerText(), /2026年11月　決済 3件/);
    assert.match(await sheet.innerText(), /参考 150 円 \/ USD/);
    assert.equal(await sheet.locator('table').first().locator('tbody tr').count(), 3);
    const ledger = sheet.locator('table').first();
    assert.deepEqual((await ledger.locator('th').allTextContents()).slice(3, 5), ['決済額', '仕入額（円）']);
    const transferRow = ledger.locator('tbody tr').filter({ hasText: 'TEST-PARTIAL' });
    assert.equal(await transferRow.locator('td').nth(4).innerText(), '27,000 JPY');
    assert.equal(
      await transferRow
        .locator('td')
        .nth(2)
        .evaluate((cell) => getComputedStyle(cell).whiteSpace),
      'nowrap',
    );
    assert.equal(await sheet.locator('table').count(), 1);
    const day = transferRow.locator('td').first();
    assert.match(await day.innerText(), /^26日/);
    assert.equal(await day.evaluate((cell) => getComputedStyle(cell).whiteSpace), 'nowrap');
    assert.doesNotMatch(await sheet.innerText(), /手書き欄/);
    await page.evaluate(() => {
      window.print = () => {
        document.body.dataset.printInvoked = 'yes';
      };
    });
    await page.locator('#printVoucher').click();
    assert.equal(await page.locator('body').getAttribute('data-print-invoked'), 'yes');
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('body > header').isVisible(), false);
    assert.equal(await page.locator('#printVoucher').isVisible(), false);
    assert.equal(await sheet.isVisible(), true);
    if (process.env.KAIKAKE_WORKSHEET_PDF) {
      await page.pdf({ path: process.env.KAIKAKE_WORKSHEET_PDF, preferCSSPageSize: true, tagged: true });
      await sheet
        .locator('table')
        .first()
        .locator('tbody')
        .evaluate((body) => {
          for (let index = 0; index < 90; index++) {
            const row = body.rows[0].cloneNode(true);
            row.cells[0].textContent = 'PRINT-ROW-' + index;
            body.append(row);
          }
        });
      await page.pdf({ path: process.env.KAIKAKE_WORKSHEET_PDF + '.long.pdf', preferCSSPageSize: true });
    }
    await page.emulateMedia({ media: 'screen' });
    await page.locator('#closeVoucher').click();
    for (const screen of ['workflow', 'dashboard', 'transfers']) {
      await page.locator(`[data-page="${screen}"]`).click();
      if (screen === 'transfers') await page.locator('#month').fill('2026-11');
      await page.locator(`#${screen}.active [data-voucher]:visible`).click();
      const previewMonth = page.locator('#voucherPreviewMonth');
      if (screen === 'transfers') assert.equal(await previewMonth.inputValue(), '2026-11');
      else await previewMonth.fill('2026-11');
      await sheet.locator('table').waitFor();
      assert.match(await sheet.innerText(), /2026年11月　決済 3件/);
      await page.locator('#closeVoucher').click();
    }
    await page.locator('#actualTab').click();
    await page.locator('#actualMonth').fill('2026-11');
    await page.locator('#actualPanel [data-voucher]').click();
    assert.equal(await page.locator('#voucherPreviewMonth').inputValue(), '2026-11');
    await sheet.locator('table').waitFor();
    await page.locator('#closeVoucher').click();
    await page.locator('[data-page="payments"]').click();
    await page.getByRole('button', { name: '新しい決済' }).click();
    await page.locator('#paymentForm [name=supplier_id]').selectOption(String(suppliers[0].id));
    const [fields, allocations, submit] = await Promise.all(
      ['.payment-fields', '.payment-allocation', '#paymentForm button[type=submit]'].map((selector) =>
        page.locator(selector).boundingBox(),
      ),
    );
    assert(allocations.x > fields.x && Math.abs(allocations.y - fields.y) < 5);
    assert(submit.y + submit.height <= 720);
    const allocation = page.locator('#allocationChoices');
    await allocation.locator('.allocCheck').first().click();
    await allocation
      .locator('.allocCheck')
      .nth(2)
      .click({ modifiers: ['Shift'] });
    assert.match(await page.locator('#allocSummary').innerText(), /選択 3件/);
    await page.locator('#paymentForm .filterbar input[type=search]').fill('no match');
    assert.match(await page.locator('#allocSummary').innerText(), /表示範囲外 3件/);
    const paymentReview = page.waitForEvent('dialog');
    const reviewClick = page.locator('#reviewPayment').click();
    const decision = await paymentReview;
    assert.match(decision.message(), /充当先 3件/);
    await decision.dismiss();
    await reviewClick;
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
    assert.equal(await page.locator('#supplier .tabs button.active').innerText(), '仕入先一覧');
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
    assert.equal(await page.locator('#transferReview').isVisible(), false);
    await unpaid.locator('input[type=checkbox]').check();
    assert.equal(await page.locator('#transferReview').isVisible(), true);
    const draft = page.locator('#remittanceCards textarea');
    assert.equal(await draft.inputValue(), 'CHECK TEST-UNPAID(60)');
    await draft.fill('edited message for regression');
    await page.locator('#remittanceCards').getByRole('button', { name: '再生成' }).click();
    assert.equal(await draft.inputValue(), 'CHECK TEST-UNPAID(60)');
    await unpaid.locator('.transferAmount').fill('20.00');
    assert.equal(await draft.inputValue(), 'CHECK TEST-UNPAID(20)');
    await draft.fill('edited message for regression');
    await page.locator('#transferPaymentDate').fill('2027-01-10');
    const transferReview = page.waitForEvent('dialog');
    const confirmClick = page.locator('#confirmTransfers').click();
    const confirmation = await transferReview;
    assert.match(confirmation.message(), /通貨別合計/);
    await confirmation.accept();
    await confirmClick;
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
    assert.equal(await page.locator('#feedbackForm [name=category]').inputValue(), '改善要望');
    await page.locator('#feedbackForm textarea').fill('Browser regression case');
    await page.locator('#feedbackForm button').click();
    await page.getByText('要望を保存しました').waitFor();
    await page.locator('#openFeedback').click();
    await page.locator('#feedbackHistory').click();
    await page.getByText('Browser regression case').waitFor();
    await page.locator('#feedbackSort').selectOption('oldest');
    assert.match(await page.locator('#feedbackList tbody tr').first().innerText(), /未対応要望/);
    await page.locator('#copyFeedback').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /Browser regression case/);
    assert.doesNotMatch(copied, /対応済み要望/);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exportFeedback').click(),
    ]);
    assert.equal(download.suggestedFilename(), '要望.txt');
    await page.locator('#feedbackFilter').selectOption('done');
    assert.match(await page.locator('#feedbackList tbody').innerText(), /対応済み要望/);
    assert.doesNotMatch(await page.locator('#feedbackList tbody').innerText(), /Browser regression case/);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.locator('[data-page="payments"]').click();
    assert(await page.evaluate(() => document.documentElement.scrollHeight === innerHeight));
    assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('[data-page="workflow"]').click();
    assert.equal(await page.getByRole('heading', { name: '前払い', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '登録済みINVOICEに紐付け' }).click();
    const unlinkedInvoice = page.locator('#invoiceTable tr').filter({ hasText: 'TEST-UNPAID' });
    await unlinkedInvoice.getByText('未紐付け', { exact: true }).waitFor();
    const advanceRow = page.locator('#invoiceTable tr').filter({ hasText: 'TEST-ADVANCE' });
    assert.equal(await advanceRow.locator('td').nth(3).innerText(), '1件');
    await page.goBack();
    await page.locator('#workflow.active').waitFor();
    await page.goForward();
    await page.locator('#invoices.active').waitFor();
    assert.equal(await page.locator('#invoices .tabs button.active').innerText(), '登録済みINVOICE');

    await page.locator(`.editInvoice[data-id="${advanceInvoice.id}"]`).click();
    await page.locator('#invoiceArrivalDetails summary').click();
    await page.getByRole('checkbox', { name: 'CHECK-ARRIVAL 枝番1' }).check();
    await page.locator('#linkArrival').click();
    await page.getByText('仕入明細 1件を紐付けました').waitFor();
    assert.equal(await advanceRow.locator('td').nth(3).innerText(), '2件');
    await page.getByRole('button', { name: '新しいINVOICE', exact: true }).click();
    await page.goBack();
    await page.locator('#invoices .tabs button.active').filter({ hasText: '登録済みINVOICE' }).waitFor();
    await page.goForward();
    await page.locator('#invoices .tabs button.active').filter({ hasText: '新しいINVOICE' }).waitFor();
    await page.reload();
    await page.locator('#invoices.active .tabs button.active').filter({ hasText: '新しいINVOICE' }).waitFor();

    assert.equal(
      (await api('purchases')).find((row) => row.id === arrival.ids[0]).invoice_id,
      advanceInvoice.id,
    );
    assert.equal(
      (await api('invoices')).find((row) => row.id === advanceInvoice.id).remaining_minor,
      originalBalance,
    );
    assert.deepEqual(
      (await api('payments')).find((row) => row.id === beforeAdvancePayment.id),
      beforeAdvancePayment,
    );
    await page.locator('[data-page="dashboard"]').click();
    assert.equal(await page.locator('#summary [data-voucher]').isVisible(), true);
    await page.getByRole('button', { name: /未紐付け仕入.*INVOICEへ/ }).click();
    await page.locator('#invoices.active .tabs button.active').filter({ hasText: '新しいINVOICE' }).waitFor();

    await page.locator('[data-page="workflow"]').click();
    await page
      .locator('[aria-labelledby=advanceFlowTitle] [data-method=advance][data-flow=invoices]')
      .click();
    await supplierSearch.fill('T001');
    await page.getByRole('option', { name: 'T001 テスト商事', exact: true }).click();
    assert.equal(await page.locator('#invoiceForm [name=settlement_method]').inputValue(), 'advance');
    await page.locator('[data-page="workflow"]').click();
    await page.getByRole('button', { name: '前払を登録' }).click();
    assert.equal(await page.locator('#paymentForm [name=method]').inputValue(), 'advance');

    // Follow the normal workflow from a new purchase through a bank transfer.
    await page.locator('[data-page="workflow"]').click();
    const regular = page.locator('[aria-labelledby=regularFlowTitle]');
    assert.equal(await regular.getByRole('button', { name: '決済履歴を確認' }).isVisible(), true);
    assert.equal(await regular.getByRole('button', { name: '月別転記用紙' }).isVisible(), true);
    await regular.getByRole('button', { name: '仕入を取り込む' }).click();
    await page.locator('#paste').fill('T001\tFLOW-PURCHASE\t2025-07-15\t1500');
    await page.locator('#import').click();
    await page.getByText('1件登録しました', { exact: true }).waitFor();
    await page.locator('[data-page="workflow"]').click();
    await regular.getByRole('button', { name: 'INVOICEを登録' }).click();
    const invoiceForm = page.locator('#invoiceForm');
    await supplierSearch.fill('T001');
    await supplierSearch.press('Enter');
    await invoiceForm.locator('[name=settlement_method]').selectOption('transfer');
    await invoiceForm.locator('[name=invoice_number]').fill('FLOW-INVOICE');
    await invoiceForm.locator('[name=invoice_date]').fill('2025-07-15');
    await invoiceForm.locator('[name=total]').fill('10.00');
    await page.locator('#invoicePurchaseDetails select[aria-label="期間"]').selectOption('all');
    await page.locator('#purchaseChoices tr').filter({ hasText: 'FLOW-PURCHASE' }).locator('input').check();
    await page.locator('#saveInvoice').click();
    await page
      .locator('#invoiceSaveStatus')
      .getByText(/INVOICE #.*登録しました/)
      .waitFor();
    const flowInvoice = (await api('invoices')).find((row) => row.invoice_number === 'FLOW-INVOICE');
    assert.equal(flowInvoice.purchase_count, 1);
    await page.locator('[data-page="workflow"]').click();
    await regular.getByRole('button', { name: '月次送金を確認' }).click();
    await page.locator('#month').fill(flowInvoice.due_date.slice(0, 7));
    await page
      .locator('#transferTable tr')
      .filter({ hasText: 'FLOW-INVOICE' })
      .locator('.transferCheck')
      .check();
    await page.locator('#transferPaymentDate').fill(flowInvoice.due_date);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#confirmTransfers').click();
    await page.getByText(/送金確定: 1件/).waitFor();
    assert.equal((await api('invoices')).find((row) => row.id === flowInvoice.id).remaining_minor, 0);
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
