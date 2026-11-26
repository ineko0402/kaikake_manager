-- 買掛・決済管理アプリ SQLite schema v0.1.0 (draft for implementation)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 1 AND 4),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
  payee_name TEXT CHECK(payee_name IS NULL OR length(payee_name) <= 256),
  currency TEXT CHECK(currency IS NULL OR (length(currency)=3 AND currency=upper(currency))),
  bank_beneficiary_code TEXT CHECK(bank_beneficiary_code IS NULL OR length(bank_beneficiary_code) <= 256),
  supplier_country TEXT CHECK(supplier_country IS NULL OR length(supplier_country) <= 256),
  origin_country TEXT CHECK(origin_country IS NULL OR length(origin_country) <= 256),
  shipping_port TEXT CHECK(shipping_port IS NULL OR length(shipping_port) <= 256),
  main_business TEXT CHECK(main_business IS NULL OR length(main_business) <= 256),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  default_settlement_method TEXT NOT NULL DEFAULT 'transfer' CHECK(default_settlement_method IN ('transfer','advance','offset')),
  payment_terms TEXT CHECK(payment_terms IS NULL OR length(payment_terms) <= 256),
  invoice_number_template TEXT CHECK(invoice_number_template IS NULL OR length(invoice_number_template) <= 256),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT
);

-- Invoice may exist without purchases. A purchase belongs to at most one invoice.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL CHECK(length(invoice_number) BETWEEN 1 AND 256),
  invoice_date TEXT NOT NULL CHECK(invoice_date GLOB '????-??-??'),
  currency TEXT NOT NULL CHECK(length(currency)=3 AND currency=upper(currency)),
  goods_minor INTEGER,
  total_minor INTEGER NOT NULL,
  standard_due_date TEXT CHECK(standard_due_date IS NULL OR standard_due_date GLOB '????-??-??'),
  due_date TEXT CHECK(due_date IS NULL OR due_date GLOB '????-??-??'),
  due_override_reason TEXT,
  usage_class TEXT NOT NULL DEFAULT 'undetermined' CHECK(usage_class IN ('purchase','non_purchase','freight','undetermined')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  duplicate_override INTEGER NOT NULL DEFAULT 0 CHECK(duplicate_override IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(due_date IS NULL OR standard_due_date IS NOT NULL),
  CHECK(due_date IS NULL OR due_date=standard_due_date OR (due_override_reason IS NOT NULL AND length(trim(due_override_reason))>0))
);
CREATE INDEX IF NOT EXISTS idx_invoices_supplier_number ON invoices(supplier_id,invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(status,due_date);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  order_number TEXT NOT NULL CHECK(length(order_number) BETWEEN 1 AND 256),
  branch_number INTEGER NOT NULL CHECK(branch_number > 0),
  purchase_date TEXT NOT NULL CHECK(purchase_date GLOB '????-??-??'),
  amount_jpy INTEGER NOT NULL,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE RESTRICT,
  duplicate_override INTEGER NOT NULL DEFAULT 0 CHECK(duplicate_override IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(supplier_id,order_number,branch_number)
);
CREATE INDEX IF NOT EXISTS idx_purchases_duplicate ON purchases(supplier_id,order_number,purchase_date,amount_jpy,status);
CREATE INDEX IF NOT EXISTS idx_purchases_invoice ON purchases(invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchases_batch ON purchases(import_batch_id);

-- A settlement event is either an actual bank transfer or an AR/AP offset.
-- For advance transfers, unallocated amount may remain available for later use.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK(method IN ('transfer','advance','offset')),
  payment_date TEXT NOT NULL CHECK(payment_date GLOB '????-??-??'),
  currency TEXT NOT NULL CHECK(length(currency)=3 AND currency=upper(currency)),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  payee_name_snapshot TEXT,
  bank_beneficiary_code_snapshot TEXT,
  usage_class TEXT NOT NULL DEFAULT 'undetermined' CHECK(usage_class IN ('purchase','non_purchase','freight','undetermined')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date,status);
CREATE INDEX IF NOT EXISTS idx_payments_supplier ON payments(supplier_id,currency,status);

CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
  allocation_date TEXT NOT NULL CHECK(allocation_date GLOB '????-??-??'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_allocations_payment ON allocations(payment_id,status);
CREATE INDEX IF NOT EXISTS idx_allocations_invoice ON allocations(invoice_id,status);

-- Consumes advance amount for expenses that will not be allocated to invoices.
CREATE TABLE IF NOT EXISTS advance_uses (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  usage_class TEXT NOT NULL CHECK(usage_class IN ('non_purchase','freight')),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_advance_uses_payment ON advance_uses(payment_id,status);

-- Explicit write-off/rounding adjustment; notes alone never settle balances.
CREATE TABLE IF NOT EXISTS invoice_adjustments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  adjustment_date TEXT NOT NULL CHECK(adjustment_date GLOB '????-??-??'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoice_adjustments_invoice ON invoice_adjustments(invoice_id,status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  event_at TEXT NOT NULL DEFAULT (datetime('now')),
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  batch_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type,entity_id,event_at);

-- All balance and cross-table invariants are validated inside a single
-- BEGIN IMMEDIATE ... COMMIT transaction by the Node.js service:
-- 1. active allocations + active advance_uses <= payment amount;
-- 2. active allocations + signed adjustments <= invoice total;
-- 3. payment/invoice supplier and currency must match, except explicit
--    shared-payee workflows with independently verified grouping rules;
-- 4. transfer/offset confirmation allocates the full amount;
-- 5. advance registration requires at least one linked invoice;
-- 6. no active allocations remain against a cancelled invoice/payment;
-- 7. branch numbers are allocated using MAX(branch_number)+1 including cancelled rows;
-- 8. duplicate overrides and all changes/cancellations are audited.
