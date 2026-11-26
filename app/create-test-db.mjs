import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const app = fileURLToPath(new URL('.', import.meta.url));

async function seed(port) {
  async function request(path, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok || result.needs_confirmation) {
      throw new Error(`${path} (${response.status}) ${result.error ?? JSON.stringify(result)}`);
    }
    return result;
  }

  const suppliers = {};
  for (const [code, name, currency, method] of [
    ['T001', 'テスト商事', 'USD', 'transfer'],
    ['T002', 'テスト工業', 'JPY', 'advance'],
    ['T003', 'テスト物流', 'JPY', 'offset'],
    ['T004', 'テスト休止先', 'JPY', 'transfer'],
  ]) {
    suppliers[code] = await request('suppliers', {
      code, name, currency, is_active: code !== 'T004', default_settlement_method: method,
      payee_name: `TEST PAYEE ${code}`, bank_beneficiary_code: `TEST-${code}`,
      message_format: code === 'T001' ? 'amount' : 'number',
      message_prefix: 'TEST ', message_separator: ' / ',
    });
  }

  const invoiceDate = '2026-11-05';
  const paymentDate = '2026-11-26';
  const { ids } = await request('purchases/import', {
    text: [
      ['T001', 'TEST-PO-01', invoiceDate, 18000],
      ['T001', 'TEST-PO-01', '2026-11-06', 12000],
      ['T001', 'TEST-PO-02', '2026-11-06', -3000],
      ['T001', 'TEST-PO-03', '2026-11-07', 9000],
      ['T002', 'TEST-PO-04', '2026-11-07', 18000],
      ['T003', 'TEST-PO-05', '2026-11-07', 16000],
    ].map(row => row.join('\t')).join('\n'),
  });

  async function invoice(code, suffix, total, purchaseIds = [], options = {}) {
    return (await request('invoices', {
      supplier_id: suppliers[code].id, invoice_number: `TEST-${suffix}`,
      invoice_date: invoiceDate, total, purchase_ids: purchaseIds, ...options,
    })).id;
  }

  const partial = await invoice('T001', 'PARTIAL', '200.00', ids.slice(0, 2));
  const returnUsed = await invoice('T001', 'RETURN-USED', '-20.00', [ids[2]]);
  await invoice('T001', 'RETURN-OPEN', '-5.00');
  await invoice('T001', 'UNPAID', '60.00');
  const cancelled = await invoice('T001', 'CANCELLED-PAYMENT', '40.00');
  const advance = await invoice('T002', 'ADVANCE', '18000', [ids[4]], { due_date: paymentDate });
  const offset = await invoice('T003', 'OFFSET', '16000', [ids[5]]);

  await request('transfers/confirm', {
    payment_date: paymentDate,
    items: [{ invoice_id: partial, amount: '100.00' }, { invoice_id: returnUsed }],
    messages: [{ ids: [partial, returnUsed], text: 'TEST TEST-PARTIAL / TEST-RETURN-USED (編集済み)' }],
  });

  async function payment(code, method, amount, invoiceId, allocationAmount = amount) {
    return (await request('payments', {
      supplier_id: suppliers[code].id, method, amount, payment_date: paymentDate,
      allocations: [{ invoice_id: invoiceId, amount: allocationAmount }],
    })).id;
  }

  await payment('T002', 'advance', '25000', advance, '10000');
  await payment('T003', 'offset', '16000', offset);
  const cancelledPayment = await payment('T001', 'transfer', '40.00', cancelled);
  await request(`payments/${cancelledPayment}/cancel`, { reason: 'テスト用の決済取消' });

  const completed = await request('feedback', {
    category: '要望', page: '仕入登録', content: 'テスト用の対応済み要望',
  });
  await request(`feedback/${completed.id}`, { done: true }, 'PUT');
  await request('feedback', {
    category: '要望', page: '送金一覧', content: 'テスト用の未対応要望',
  });
}

async function create() {
  if (process.argv.length > 3) throw new Error('使い方: node create-test-db.mjs [出力フォルダ]');
  const folder = resolve(process.argv[2] ?? join(app, 'test-db'));
  const target = join(folder, 'kaikake_test.db');
  const temporary = await mkdtemp(join(tmpdir(), 'kaikake-test-'));
  try {
    for (const file of ['server.js', 'business-api.js', 'schema.sql']) {
      await copyFile(join(app, file), join(temporary, file));
    }
    const child = fork(join(temporary, 'server.js'), [], {
      env: { ...process.env, PORT: '0' },
      execArgv: [],
    });
    const closed = new Promise(resolveClose => child.once('close', resolveClose));
    try {
      const port = await new Promise((resolvePort, reject) => {
        const timeout = setTimeout(() => reject(new Error('テスト用サーバーの起動がタイムアウトしました')), 10000);
        function finish(callback, result) {
          clearTimeout(timeout);
          callback(result);
        }
        child.once('message', ({ port }) => finish(resolvePort, port));
        child.once('error', error => finish(reject, error));
        child.once('exit', code => finish(reject, new Error(`テスト用サーバーが終了しました (${code})`)));
      });
      await seed(port);
    } finally {
      child.kill();
      await closed;
    }

    const source = join(temporary, 'data', 'kaikake.db');
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
          db.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('テスト用DBの整合性検査に失敗しました');
      }
    } finally {
      db.close();
    }
    await mkdir(folder, { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    console.log(`テスト用DBを作成しました。 ${target}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

create().catch(error => {
  console.error(error.code === 'EEXIST' ? 'kaikake_test.db が既にあります。別の出力フォルダを指定してください。' : error.message);
  process.exitCode = 1;
});
