// 買掛管理 v0.5.3 - 業務API
'use strict';
const {backup}=require('node:sqlite');
const fs=require('node:fs');const path=require('node:path');
module.exports=function makeApi(db,root){
 const fail=(code,msg)=>{throw [code,msg]};
 const get=(sql,...p)=>db.prepare(sql).get(...p);
 const all=(sql,...p)=>db.prepare(sql).all(...p);
 const run=(sql,...p)=>db.prepare(sql).run(...p);
 const tx=(fn)=>{db.exec('BEGIN IMMEDIATE');try{let r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}};
 const log=(type,id,action,before,after,reason)=>run('INSERT INTO audit_log(entity_type,entity_id,action,before_json,after_json,reason) VALUES (?,?,?,?,?,?)',type,id,action,before?JSON.stringify(before):null,after?JSON.stringify(after):null,reason||null);
 const required=(v,name)=>{if(v===undefined||v===null||String(v).trim()==='')fail(400,name+'が必要です');return String(v).trim()};
 const date=(v,name)=>{v=required(v,name);if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail(400,name+'はYYYY-MM-DDで指定してください');return v};
 const integer=(v,name,positive=false)=>{if(v===undefined||v===null||String(v).trim()===''||!Number.isSafeInteger(Number(v))||(positive&&Number(v)<=0))fail(400,name+'は整数で指定してください');return Number(v)};
 const supplier=(id)=>{const s=get('SELECT * FROM suppliers WHERE id=?',integer(id,'仕入先'));if(!s)fail(404,'仕入先が見つかりません');return s};
 const invoice=(id)=>{const x=get('SELECT * FROM invoices WHERE id=?',integer(id,'INVOICE'));if(!x||x.status!=='active')fail(404,'INVOICEが見つかりません');return x};
 const balance=(id)=>{const x=invoice(id);const allocated=get("SELECT COALESCE(SUM(a.amount_minor),0) n FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.invoice_id=? AND a.status='active' AND p.status='active'",id).n;const adj=get("SELECT COALESCE(SUM(amount_minor),0) n FROM invoice_adjustments WHERE invoice_id=? AND status='active'",id).n;return x.total_minor-allocated-adj};
 const paymentRemaining=(id)=>{const p=get('SELECT * FROM payments WHERE id=?',id);if(!p||p.status!=='active')fail(404,'決済が見つかりません');const a=get("SELECT COALESCE(SUM(amount_minor),0) n FROM allocations WHERE payment_id=? AND status='active'",id).n;const u=get("SELECT COALESCE(SUM(amount_minor),0) n FROM advance_uses WHERE payment_id=? AND status='active'",id).n;return p.amount_minor-a-u};
 const due=(dateStr)=>{let d=new Date(dateStr+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+2,10);const day=d.getUTCDay();if(day===6)d.setUTCDate(d.getUTCDate()+2);if(day===0)d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10)};
 const toMinor=(v,c)=>{let s=required(v,'金額').replace(/,/g,'');if(!/^-?\d+(\.\d{1,2})?$/.test(s))fail(400,'金額形式が不正です');let [a,b='']=s.split('.');if(c==='JPY'&&b)fail(400,'JPYは小数不可');let n=BigInt(a)*(c==='JPY'?1n:100n);if(b)n+=BigInt(b.padEnd(2,'0'))*(a.startsWith('-')?-1n:1n);if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))fail(400,'金額が大きすぎます');return Number(n)};
 const fmt=(n,c)=>c==='JPY'?String(n):(n/100).toFixed(2);
 const linkPurchases=(target,rawIds)=>{
  const ids=rawIds.map(raw=>integer(raw,'仕入ID',true));
  for(const id of ids){
   const result=run("UPDATE purchases SET invoice_id=?,updated_at=datetime('now') WHERE id=? AND supplier_id=? AND status='active' AND invoice_id IS NULL",target.id,id,target.supplier_id);
   if(result.changes!==1)fail(400,'紐付けできない仕入明細があります');
  }
  return ids;
 };
 return async function handle(req,url,body){const p=url.pathname,method=req.method;
 if(p==='/api/feedback'&&method==='GET')return all('SELECT * FROM feedback ORDER BY id DESC');
 if(p==='/api/feedback'&&method==='POST')return {id:Number(run('INSERT INTO feedback(category,page,content,version) VALUES (?,?,?,?)',required(body.category,'分類'),required(body.page,'画面'),required(body.content,'内容'),'v0.5.3').lastInsertRowid)};
 const fm=p.match(/^\/api\/feedback\/(\d+)$/);if(fm&&method==='PUT'){run('UPDATE feedback SET done=? WHERE id=?',body.done?1:0,Number(fm[1]));return {ok:true};}
 if(p==='/api/dashboard'&&method==='GET'){const inv=all("SELECT i.*,s.name supplier_name FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.status='active' ORDER BY i.due_date,i.id");return {invoices:inv.map(i=>({...i,remaining_minor:balance(i.id)})),purchase_count:get("SELECT COUNT(*) n FROM purchases WHERE status='active'").n,payment_count:get("SELECT COUNT(*) n FROM payments WHERE status='active'").n};}
 if(p==='/api/purchases'&&method==='GET')return all("SELECT p.*,s.code supplier_code,s.name supplier_name,i.invoice_number FROM purchases p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.status='active' ORDER BY p.purchase_date DESC,p.id DESC LIMIT 1000");
 if(p==='/api/purchases/import'&&method==='POST')return tx(()=>{let lines=required(body.text,'貼り付けデータ').replace(/\r/g,'').split('\n').filter(x=>x.trim());if(lines.length>1000)fail(400,'一度に1000行まで');const items=lines.map((line,index)=>{let a=line.split('\t');if(a.length!==4)fail(400,(index+1)+'行目は4列必要です');let s=get('SELECT * FROM suppliers WHERE code=?',a[0].trim());if(!s)fail(400,(index+1)+'行目の仕入先コードが未登録です: '+a[0]);let raw=a[2].trim().normalize('NFKC');let m=raw.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/);if(m)raw=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');else if(/^\d{8}$/.test(raw))raw=raw.slice(0,4)+'-'+raw.slice(4,6)+'-'+raw.slice(6);else if(/^\d{5}(?:\.0+)?$/.test(raw)&&Number(raw)>60)raw=new Date(Date.UTC(1899,11,30)+Number(raw)*86400000).toISOString().slice(0,10);return {supplier_id:s.id,order_number:required(a[1],'発注番号'),purchase_date:date(raw,(index+1)+'行目の仕入日 ('+a[2]+')'),amount_jpy:integer(Number(a[3].replace(/[,￥¥\s]/g,'')),'金額')};});const seen=new Set();const warnings=[];items.forEach((x,k)=>{const key=[x.supplier_id,x.order_number,x.purchase_date,x.amount_jpy].join('|');if(seen.has(key))warnings.push((k+1)+'行目: 今回の貼付内で同一行');seen.add(key);if(get("SELECT id FROM purchases WHERE supplier_id=? AND order_number=? AND purchase_date=? AND amount_jpy=? AND status='active' LIMIT 1",x.supplier_id,x.order_number,x.purchase_date,x.amount_jpy))warnings.push((k+1)+'行目: 登録済みと同一');});if(warnings.length&&!body.override)return {needs_confirmation:true,warnings};const batch=run('INSERT INTO import_batches(note) VALUES (?)','Excel貼付').lastInsertRowid;let ids=[];for(const x of items){const branch=get('SELECT COALESCE(MAX(branch_number),0)+1 n FROM purchases WHERE supplier_id=? AND order_number=?',x.supplier_id,x.order_number).n;const id=run('INSERT INTO purchases(supplier_id,order_number,branch_number,purchase_date,amount_jpy,import_batch_id,duplicate_override) VALUES (?,?,?,?,?,?,?)',x.supplier_id,x.order_number,branch,x.purchase_date,x.amount_jpy,batch,warnings.length?1:0).lastInsertRowid;ids.push(Number(id));log('purchase',Number(id),'create',null,{...x,branch_number:branch});}return {saved:ids.length,batch_id:Number(batch),ids,warnings};});
 const pc=p.match(/^\/api\/purchases\/(\d+)\/cancel$/);
 if(pc&&method==='POST')return tx(()=>{const id=Number(pc[1]),old=get('SELECT * FROM purchases WHERE id=?',id);if(!old||old.status!=='active')fail(404,'仕入明細がありません');if(old.invoice_id)fail(409,'INVOICE紐付けを解除してから取消してください');const reason=required(body.reason,'取消理由');run("UPDATE purchases SET status='cancelled',updated_at=datetime('now') WHERE id=?",id);log('purchase',id,'cancel',old,{status:'cancelled'},reason);return {ok:true};});
 const pm=p.match(/^\/api\/purchases\/(\d+)$/);if(pm&&method==='PUT')return tx(()=>{let old=get('SELECT * FROM purchases WHERE id=?',Number(pm[1]));if(!old||old.status!=='active')fail(404,'仕入明細がありません');let change={purchase_date:date(body.purchase_date,'仕入日'),amount_jpy:integer(body.amount_jpy,'金額'),order_number:required(body.order_number,'発注番号')};if(change.order_number!==old.order_number)fail(400,'発注番号の変更は取消・再登録してください');run('UPDATE purchases SET purchase_date=?,amount_jpy=?,updated_at=datetime(\'now\') WHERE id=?',change.purchase_date,change.amount_jpy,old.id);log('purchase',old.id,'update',old,change,body.reason);return {ok:true};});
 if(p==='/api/invoices'&&method==='GET')return all("SELECT i.*,s.code supplier_code,s.name supplier_name, (SELECT COUNT(*) FROM purchases pu WHERE pu.invoice_id=i.id AND pu.status='active') purchase_count, COALESCE((SELECT SUM(a.amount_minor) FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.invoice_id=i.id AND a.status='active' AND p.status='active'),0) allocated_minor, COALESCE((SELECT SUM(amount_minor) FROM invoice_adjustments WHERE invoice_id=i.id AND status='active'),0) adjusted_minor FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.status='active' ORDER BY i.invoice_date DESC,i.id DESC").map(i=>({...i,remaining_minor:i.total_minor-i.allocated_minor-i.adjusted_minor}));
 if(p==='/api/invoices'&&method==='POST')return tx(()=>{let s=supplier(body.supplier_id);let num=required(body.invoice_number,'INVOICE番号'),dt=date(body.invoice_date,'INVOICE日付'),currency=required(body.currency||s.currency,'通貨').toUpperCase();if(!/^[A-Z]{3}$/.test(currency))fail(400,'通貨が不正です');let goods=(body.goods==null||String(body.goods).trim()===""?null:toMinor(body.goods,currency)),total=toMinor(body.total,currency);let duplicate=get("SELECT id FROM invoices WHERE supplier_id=? AND invoice_number=? AND status='active'",s.id,num);if(duplicate&&!body.override) return {needs_confirmation:true,warnings:['同じ仕入先に同一INVOICE番号があります']};let method=body.settlement_method||s.default_settlement_method||'transfer';if(!['transfer','advance','offset'].includes(method))fail(400,'決済区分が不正');if(total<0&&method!=='transfer')fail(400,'返品は通常送金を指定してください');let standard=method==='transfer'?due(dt.slice(0,7)+'-01'):null;let finalDue=body.due_date?date(body.due_date,'支払予定日'):standard;if(method==='advance'&&!finalDue)fail(400,'前払予定日を指定してください');if(method!=='transfer')standard=finalDue;let reason=body.due_reason?.trim()||null;if(finalDue!==standard&&!reason)fail(400,'支払予定日を変更する場合は理由が必要です');let usage=body.usage_class||'purchase';if(!['purchase','non_purchase','freight','undetermined'].includes(usage))fail(400,'用途が不正です');let id=run('INSERT INTO invoices(supplier_id,invoice_number,invoice_date,currency,goods_minor,total_minor,standard_due_date,due_date,due_override_reason,usage_class,duplicate_override,difference_reason,settlement_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',s.id,num,dt,currency,goods,total,standard,finalDue,reason,usage,duplicate?1:0,String(body.difference_reason||''),method).lastInsertRowid;const purchaseIds=linkPurchases({id,supplier_id:s.id},Array.isArray(body.purchase_ids)?body.purchase_ids:[]);log('invoice',Number(id),'create',null,{supplier_id:s.id,invoice_number:num,total_minor:total,purchase_ids:purchaseIds});return {id:Number(id)};});
 const invoicePurchases=p.match(/^\/api\/invoices\/(\d+)\/purchases$/);
 if(invoicePurchases&&method==='POST')return tx(()=>{
  const target=invoice(Number(invoicePurchases[1]));
  if(!Array.isArray(body?.purchase_ids)||!body.purchase_ids.length)fail(400,'仕入明細を選択してください');
  const ids=linkPurchases(target,body.purchase_ids);
  log('invoice',target.id,'link_purchases',null,{purchase_ids:ids});
  return {linked:ids.length};
 });
 const im=p.match(/^\/api\/invoices\/(\d+)$/);
 if(im&&method==='PUT')return tx(()=>{const id=Number(im[1]),old=invoice(id),s=supplier(old.supplier_id);
  const num=required(body.invoice_number,'INVOICE番号'),dt=date(body.invoice_date,'INVOICE日付');
  const goods=(body.goods==null||String(body.goods).trim()===""?null:toMinor(body.goods,old.currency)),total=toMinor(body.total,old.currency);
  
  const duplicate=get("SELECT id FROM invoices WHERE supplier_id=? AND invoice_number=? AND id<>? AND status='active'",s.id,num,id);
  if(duplicate&&!body.override)return {needs_confirmation:true,warnings:['同じ仕入先に同一INVOICE番号があります']};
  const method=body.settlement_method||old.settlement_method;if(!['transfer','advance','offset'].includes(method))fail(400,'決済区分が不正');if(total<0&&method!=='transfer')fail(400,'返品は通常送金を指定してください');let standard=method==='transfer'?due(dt.slice(0,7)+'-01'):null;const finalDue=body.due_date?date(body.due_date,'支払予定日'):standard;if(method==='advance'&&!finalDue)fail(400,'前払予定日を指定してください');if(method!=='transfer')standard=finalDue;
  const reason=body.due_reason?.trim()||null;if(finalDue!==standard&&!reason)fail(400,'予定日変更理由が必要です');
  const usage=body.usage_class||old.usage_class;if(!['purchase','non_purchase','freight','undetermined'].includes(usage))fail(400,'用途が不正です');
  const settled=old.total_minor-balance(id);if(settled!==0&&(Math.sign(total)!==Math.sign(settled)||Math.abs(total)<Math.abs(settled)||method!==old.settlement_method))fail(400,'変更後の請求総額が充当・調整済み金額を下回ります');
  run("UPDATE invoices SET invoice_number=?,invoice_date=?,goods_minor=?,total_minor=?,standard_due_date=?,due_date=?,due_override_reason=?,usage_class=?,duplicate_override=?,difference_reason=?,settlement_method=?,updated_at=datetime('now') WHERE id=?",num,dt,goods,total,standard,finalDue,reason,usage,duplicate?1:old.duplicate_override,String(body.difference_reason??old.difference_reason),method,id);
  const after=invoice(id);log('invoice',id,'update',old,after,body.reason||null);return {id};
 });
 const ic=p.match(/^\/api\/invoices\/(\d+)\/cancel$/);
 if(ic&&method==='POST')return tx(()=>{const id=Number(ic[1]),old=invoice(id),reason=required(body.reason,'取消理由');
  const allocation=get("SELECT COUNT(*) n FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.invoice_id=? AND a.status='active' AND p.status='active'",id).n;
  const adjustments=get("SELECT COUNT(*) n FROM invoice_adjustments WHERE invoice_id=? AND status='active'",id).n;
  if(allocation||adjustments)fail(409,'充当・調整のあるINVOICEは取消できません。先に決済・調整を取り消してください');
  run('UPDATE purchases SET invoice_id=NULL,updated_at=datetime(\'now\') WHERE invoice_id=?',id);
  run("UPDATE invoices SET status='cancelled',updated_at=datetime('now') WHERE id=?",id);
  log('invoice',id,'cancel',old,{status:'cancelled'},reason);return {ok:true};
 });
 if(p==='/api/payments/worksheet'&&method==='GET'){
  const month=url.searchParams.get('month')||'';
  if(!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month))fail(400,'対象月を指定してください');
  const start=month+'-01', end=month+'-31';
  const period="p.status='active' AND p.payment_date BETWEEN ? AND ?";
  const payments=all(`SELECT p.id,p.payment_date,p.method,p.currency,p.amount_minor,p.note,
   s.code supplier_code,s.name supplier_name,COALESCE(NULLIF(p.payee_name_snapshot,''),s.name) payee_name
   FROM payments p JOIN suppliers s ON s.id=p.supplier_id
   WHERE ${period} ORDER BY p.payment_date,p.id`,start,end);
  const byId=new Map(payments.map(payment=>[payment.id,{...payment,allocations:[],expenses:[],allocated_minor:0,expensed_minor:0}]));
  for(const {payment_id,...allocation} of all(`SELECT a.payment_id,a.invoice_id,i.invoice_number,a.allocation_date,a.amount_minor,
   i.total_minor invoice_total_minor,i.currency invoice_currency,
   (SELECT SUM(pu.amount_jpy) FROM purchases pu WHERE pu.invoice_id=i.id AND pu.status='active') invoice_jpy
   FROM allocations a JOIN invoices i ON i.id=a.invoice_id JOIN payments p ON p.id=a.payment_id
   WHERE a.status='active' AND ${period} ORDER BY a.allocation_date,a.id`,start,end)){
   const payment=byId.get(payment_id);
   payment.allocations.push(allocation);
   payment.allocated_minor+=allocation.amount_minor;
  }
  for(const {payment_id,...expense} of all(`SELECT u.payment_id,u.usage_class,u.reason,u.amount_minor
   FROM advance_uses u JOIN payments p ON p.id=u.payment_id
   WHERE u.status='active' AND ${period} ORDER BY u.id`,start,end)){
   const payment=byId.get(payment_id);
   payment.expenses.push(expense);
   payment.expensed_minor+=expense.amount_minor;
  }
  return [...byId.values()].map(payment=>({...payment,
   remaining_minor:payment.amount_minor-payment.allocated_minor-payment.expensed_minor}));
 }
 if(p==='/api/payments'&&method==='GET')return all("SELECT p.*,s.name supplier_name,s.code supplier_code,COALESCE((SELECT SUM(amount_minor) FROM allocations WHERE payment_id=p.id AND status='active'),0) allocated_minor,COALESCE((SELECT SUM(amount_minor) FROM advance_uses WHERE payment_id=p.id AND status='active'),0) expensed_minor FROM payments p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.payment_date DESC,p.id DESC LIMIT 1000").map(x=>({...x,remaining_minor:x.amount_minor-x.allocated_minor-x.expensed_minor}));
 if(p==='/api/payments'&&method==='POST')return tx(()=>{let s=supplier(body.supplier_id);let method=required(body.method,'決済方法');if(!['transfer','advance','offset'].includes(method))fail(400,'決済方法が不正です');let currency=required(body.currency||s.currency,'通貨'),amount=toMinor(body.amount,currency);if(amount<0||(method!=='transfer'&&amount===0))fail(400,'決済金額が不正です');let allocations=Array.isArray(body.allocations)?body.allocations:[];if(method==='advance'&&!allocations.length)fail(400,'前払いにはINVOICEを1件以上指定してください');let prepared=allocations.map(x=>{let i=invoice(x.invoice_id);if(i.supplier_id!==s.id||i.currency!==currency)fail(400,'仕入先・通貨が一致しません');let n=toMinor(x.amount,currency);if(!n||(n<0&&method!=='transfer'))fail(400,'充当金額が不正です');return {i,n}});let sum=prepared.reduce((a,x)=>a+x.n,0);if(sum>amount)fail(400,'充当額が決済額を超えています');if(method!=='advance'&&sum!==amount)fail(400,'通常送金・相殺は全額をINVOICEへ充当してください');let byInvoice=new Map();for(const {i,n} of prepared)byInvoice.set(i.id,(byInvoice.get(i.id)||0)+n);if(!prepared.length||byInvoice.size!==prepared.length)fail(400,'充当対象が不正です');for(const [id,n] of byInvoice){const b=balance(id);if(Math.sign(n)!==Math.sign(b)||Math.abs(n)>Math.abs(b))fail(400,'INVOICEの未決済残高を超えています');}let usage=body.usage_class||'undetermined';if(!['purchase','non_purchase','freight','undetermined'].includes(usage))fail(400,'用途が不正です');let id=run('INSERT INTO payments(supplier_id,method,payment_date,currency,amount_minor,payee_name_snapshot,bank_beneficiary_code_snapshot,usage_class,note) VALUES (?,?,?,?,?,?,?,?,?)',s.id,method,date(body.payment_date,'決済日'),currency,amount,s.payee_name||s.name,s.bank_beneficiary_code,usage,body.note||null).lastInsertRowid;for(const {i,n} of prepared)run('INSERT INTO allocations(payment_id,invoice_id,amount_minor,allocation_date) VALUES (?,?,?,?)',id,i.id,n,body.payment_date);log('payment',Number(id),'create',null,{amount_minor:amount,method,allocations:prepared.map(x=>({invoice_id:x.i.id,amount_minor:x.n}))});return {id:Number(id)};});
 const pay=p.match(/^\/api\/payments\/(\d+)\/cancel$/);if(pay&&method==='POST')return tx(()=>{let id=Number(pay[1]),old=get('SELECT * FROM payments WHERE id=?',id);if(!old||old.status!=='active')fail(404,'決済がありません');let reason=required(body.reason,'取消理由');run("UPDATE payments SET status='cancelled',updated_at=datetime('now') WHERE id=?",id);run("UPDATE allocations SET status='cancelled',updated_at=datetime('now') WHERE payment_id=?",id);run("UPDATE advance_uses SET status='cancelled' WHERE payment_id=?",id);log('payment',id,'cancel',old,{status:'cancelled'},reason);return {ok:true};});
 if(p==='/api/allocations'&&method==='POST')return tx(()=>{let id=integer(body.payment_id,'決済ID'),i=invoice(body.invoice_id),p=get('SELECT * FROM payments WHERE id=?',id);if(!p||p.status!=='active'||p.method!=='advance')fail(400,'有効な前払いを指定してください');if(i.supplier_id!==p.supplier_id||i.currency!==p.currency)fail(400,'仕入先・通貨が一致しません');let n=toMinor(body.amount,p.currency);if(n<=0||n>paymentRemaining(id)||n>balance(i.id))fail(400,'充当可能残高を超えています');let aid=run('INSERT INTO allocations(payment_id,invoice_id,amount_minor,allocation_date) VALUES (?,?,?,?)',id,i.id,n,date(body.allocation_date,'充当日')).lastInsertRowid;log('allocation',Number(aid),'create',null,{payment_id:id,invoice_id:i.id,amount_minor:n});return {id:Number(aid)};});
 if(p==='/api/advance-uses'&&method==='POST')return tx(()=>{let id=integer(body.payment_id,'決済ID'),p=get('SELECT * FROM payments WHERE id=?',id);if(!p||p.status!=='active'||p.method!=='advance')fail(400,'有効な前払いが必要です');let n=toMinor(body.amount,p.currency);if(n<=0||n>paymentRemaining(id))fail(400,'使用可能残高を超えています');if(!['non_purchase','freight'].includes(body.usage_class))fail(400,'用途を指定してください');let reason=required(body.reason,'理由');let uid=run('INSERT INTO advance_uses(payment_id,amount_minor,usage_class,reason) VALUES (?,?,?,?)',id,n,body.usage_class,reason).lastInsertRowid;log('advance_use',Number(uid),'create',null,{payment_id:id,amount_minor:n,reason});return {id:Number(uid)};});
 if(p==='/api/adjustments'&&method==='GET')return all("SELECT a.*,i.invoice_number,s.name supplier_name,i.currency FROM invoice_adjustments a JOIN invoices i ON i.id=a.invoice_id JOIN suppliers s ON s.id=i.supplier_id ORDER BY a.id DESC LIMIT 1000");
 const ac=p.match(/^\/api\/adjustments\/(\d+)\/cancel$/);
 if(ac&&method==='POST')return tx(()=>{const id=Number(ac[1]),old=get('SELECT * FROM invoice_adjustments WHERE id=?',id);if(!old||old.status!=='active')fail(404,'有効な調整が見つかりません');const reason=required(body.reason,'取消理由');run("UPDATE invoice_adjustments SET status='cancelled' WHERE id=?",id);log('adjustment',id,'cancel',old,{status:'cancelled'},reason);return {ok:true};});
 if(p==='/api/adjustments'&&method==='POST')return tx(()=>{let i=invoice(body.invoice_id),n=toMinor(body.amount,i.currency);if(!n||Math.sign(n)!==Math.sign(balance(i.id))||Math.abs(n)>Math.abs(balance(i.id)))fail(400,'調整金額が不正です');let reason=required(body.reason,'調整理由');let id=run('INSERT INTO invoice_adjustments(invoice_id,amount_minor,reason,adjustment_date) VALUES (?,?,?,?)',i.id,n,reason,date(body.adjustment_date,'調整日')).lastInsertRowid;log('adjustment',Number(id),'create',null,{invoice_id:i.id,amount_minor:n,reason});return {id:Number(id)};});
 if(p==='/api/transfers/confirm'&&method==='POST')return tx(()=>{
  const paymentDate=date(body.payment_date,'実際の送金日');
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>200)fail(400,'送金対象を1～200件選択してください');
  const seen=new Set(), groups=new Map();
  for(const item of body.items){
   const id=integer(item.invoice_id,'INVOICE ID');if(seen.has(id))fail(400,'同一INVOICEを重複選択しています');seen.add(id);
   const i=invoice(id),s=supplier(i.supplier_id),remaining=balance(id);if(i.settlement_method==='offset')fail(400,'相殺予定は送金対象外です');
   const amount=item.amount==null||String(item.amount).trim()===''?remaining:toMinor(item.amount,i.currency);
   if(!amount||Math.sign(amount)!==Math.sign(remaining)||Math.abs(amount)>Math.abs(remaining))fail(400,i.invoice_number+' の送金額が未決済残高を超えています');
   if(!s.currency||!s.payee_name||!s.bank_beneficiary_code)fail(400,s.name+' の支払先・受取人コード・通貨を仕入先マスターに登録してください');
   if(s.currency!==i.currency)fail(400,i.invoice_number+' の通貨が仕入先マスターと異なります');
   const method=i.settlement_method==='advance'?'advance':'transfer';const key=[s.id,i.currency,method].join('|');if(!groups.has(key))groups.set(key,{s,method,currency:i.currency,items:[],amount:0});
   const g=groups.get(key);g.items.push({id,amount});g.amount+=amount;
   if(!Number.isSafeInteger(g.amount))fail(400,'送金金額が大きすぎます');
  }
  const messages=new Map();
  for(const m of body.messages||[]){if(!Array.isArray(m.ids)||typeof m.text!=='string'||m.text.length>20000)fail(400,'送金メッセージが不正です');const ids=m.ids.map(Number).sort((a,b)=>a-b);const key=JSON.stringify(ids);if(messages.has(key))fail(400,'送金メッセージが重複しています');messages.set(key,m.text);}
  const bankGroups=new Map();for(const g of groups.values()){const key=JSON.stringify([g.s.payee_name,g.s.bank_beneficiary_code,g.currency]);if(!bankGroups.has(key))bankGroups.set(key,[]);bankGroups.get(key).push(...g.items.map(i=>i.id));}
  const byId=new Map();for(const ids of bankGroups.values()){const key=JSON.stringify(ids.sort((a,b)=>a-b));if(messages.has(key)){for(const id of ids)byId.set(id,messages.get(key));messages.delete(key);}}if(messages.size)fail(400,'送金メッセージの対象が一致しません');
  const created=[];
  for(const g of groups.values()){
   if(g.amount<0)fail(400,'返品超過です。返品の充当額を減らし、差引額を0以上にしてください（仕入先単位）');
   const r=run('INSERT INTO payments(supplier_id,method,payment_date,currency,amount_minor,payee_name_snapshot,bank_beneficiary_code_snapshot,usage_class,note) VALUES (?,?,?,?,?,?,?,?,?)',g.s.id,g.method,paymentDate,g.currency,g.amount,g.s.payee_name,g.s.bank_beneficiary_code,'purchase',body.note||'送金一覧から一括確定');
   const pid=Number(r.lastInsertRowid);
   if(byId.has(g.items[0].id))run("UPDATE payments SET remittance_message=? WHERE id=?",byId.get(g.items[0].id),pid);
   for(const item of g.items)run('INSERT INTO allocations(payment_id,invoice_id,amount_minor,allocation_date) VALUES (?,?,?,?)',pid,item.id,item.amount,paymentDate);
   log('payment',pid,'create',null,{source:'transfer_batch',payment_date:paymentDate,amount_minor:g.amount,items:g.items});
   created.push({payment_id:pid,supplier_id:g.s.id,currency:g.currency,amount_minor:g.amount,invoice_count:g.items.length});
  }
  return {ok:true,payments:created,invoice_count:seen.size};
 });
 if(p==='/api/transfers/history'&&method==='GET'){
  const month=url.searchParams.get('month');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))fail(400,'年月が不正です');
  const rows=all("SELECT p.id,p.payment_date,p.method,p.currency,p.amount_minor,p.remittance_message,COALESCE(NULLIF(p.payee_name_snapshot,''),s.name) payee_name,s.name supplier_name FROM payments p JOIN suppliers s ON s.id=p.supplier_id WHERE p.status='active' AND p.method IN ('transfer','advance') AND p.amount_minor>0 AND substr(p.payment_date,1,7)=? ORDER BY p.payment_date,p.id",month);
  const details=all("SELECT a.payment_id,a.amount_minor,i.invoice_number FROM allocations a JOIN invoices i ON i.id=a.invoice_id JOIN payments p ON p.id=a.payment_id WHERE a.status='active' AND p.status='active' AND p.method IN ('transfer','advance') AND p.amount_minor>0 AND substr(p.payment_date,1,7)=? ORDER BY a.id",month);
  const grouped=new Map();for(const a of details){if(!grouped.has(a.payment_id))grouped.set(a.payment_id,[]);grouped.get(a.payment_id).push(a);}return rows.map(r=>({...r,allocations:grouped.get(r.id)||[]}));
 }
 if(p==='/api/transfers'&&method==='GET'){let month=url.searchParams.get('month')||new Date().toISOString().slice(0,7);if(!/^\d{4}-\d{2}$/.test(month))fail(400,'年月が不正です');return all("SELECT i.id,i.invoice_number,i.currency,i.due_date,i.total_minor,i.settlement_method,s.id supplier_id,s.name supplier_name,COALESCE(s.payee_name,s.name) payee_name,s.bank_beneficiary_code FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.status='active' AND i.settlement_method<>'offset' AND (substr(i.due_date,1,7)=? OR (i.total_minor<0 AND substr(i.due_date,1,7)<?)) ORDER BY payee_name,i.due_date",month,month).map(x=>({...x,remaining_minor:balance(x.id)})).filter(x=>x.remaining_minor!==0);}
 if(p==='/api/backup'&&method==='POST'){const folder=path.join(root,'backup');fs.mkdirSync(folder,{recursive:true});const dest=path.join(folder,'kaikake_manual_'+new Date().toISOString().replace(/[:.]/g,'-')+'.db');await backup(db,dest);return {file:path.basename(dest)};}
 if(p==='/api/backups'&&method==='GET'){const dir=path.join(root,'backup');return fs.existsSync(dir)?fs.readdirSync(dir).filter(x=>x.endsWith('.db')).sort().reverse():[];}
 return null;
 };
};
