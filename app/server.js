// 買掛管理アプリ v0.5.4
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, {recursive:true});
const db = new DatabaseSync(path.join(DATA,'kaikake.db'));
db.exec(fs.readFileSync(path.join(ROOT,'schema.sql'),'utf8'));
db.exec('PRAGMA foreign_keys=OFF');
db.exec('BEGIN IMMEDIATE');
try {
 const cols=db.prepare('PRAGMA table_info(invoices)').all().map(x=>x.name);
 if(!cols.includes('difference_reason')) db.exec("ALTER TABLE invoices ADD COLUMN difference_reason TEXT NOT NULL DEFAULT ''");
 if(!cols.includes('settlement_method')) db.exec("ALTER TABLE invoices ADD COLUMN settlement_method TEXT NOT NULL DEFAULT 'transfer'");
 db.exec("CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, category TEXT NOT NULL, page TEXT NOT NULL, content TEXT NOT NULL, version TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, done INTEGER NOT NULL DEFAULT 0)");
 for(const name of ['invoices','payments','allocations']){
  const ddl=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql;
  const revised=ddl.replace(/goods_minor INTEGER(?: NOT NULL)? CHECK\(goods_minor >= 0\)/i,'goods_minor INTEGER').replace(/ CHECK\(total_minor >= 0\)/i,'').replace(/CHECK\(amount_minor > 0\)/i,name==='payments'?'CHECK(amount_minor >= 0)':'CHECK(amount_minor != 0)');
  if(revised===ddl)continue;
  const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name);
  const names=db.prepare(`PRAGMA table_info(${name})`).all().map(x=>'"'+x.name+'"').join(',');
  const createPrefix = new RegExp('^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"'+name+'"|`'+name+'`|\\['+name+'\\]|'+name+')(?=\\s*\\()', 'i');
  if(!createPrefix.test(revised)) throw Error('Unexpected table definition: '+name);
  db.exec(revised.replace(createPrefix,'CREATE TABLE "'+name+'_new"'));
  db.exec(`INSERT INTO ${name}_new (${names}) SELECT ${names} FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_new RENAME TO ${name};`);
  for(const idx of indexes)db.exec(idx.sql);
 }
 for(const k of ['message_format','message_prefix','message_separator','message_suffix']) if(!db.prepare('PRAGMA table_info(suppliers)').all().some(x=>x.name===k)) db.exec('ALTER TABLE suppliers ADD COLUMN '+k+' TEXT');
 if(!db.prepare('PRAGMA table_info(payments)').all().some(x=>x.name==='remittance_message')) db.exec('ALTER TABLE payments ADD COLUMN remittance_message TEXT');
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('DB foreign key check failed');
 db.exec('INSERT OR IGNORE INTO schema_migrations(version) VALUES (400),(401),(403),(404),(408)');
 db.exec('COMMIT');
} catch(e){db.exec('ROLLBACK');throw e;}
db.exec('PRAGMA foreign_keys=ON');
const PORT = Number(process.env.PORT || 37841);
const business = require('./business-api')(db, ROOT);
const FIELDS = ['code','name','payee_name','currency','bank_beneficiary_code','supplier_country','origin_country','shipping_port','main_business','is_active','default_settlement_method','payment_terms','invoice_number_template','message_format','message_prefix','message_separator','message_suffix'];
const TEXTS = FIELDS.filter(x=>!['is_active','default_settlement_method'].includes(x));
function validate(input, id=null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw [400,'入力形式が不正です'];
  const obj={};
  for(const key of TEXTS){
    const v=input[key];
    if(v!=null && typeof v!=='string') throw [400,`${key} は文字列で指定してください`];
    obj[key]=v==null || v.trim()==='' ? null : v.trim();
    if(obj[key] && obj[key].length>(key==='code'?4:256)) throw [400,`${key} が長すぎます`];
  }
  obj.message_format=input.message_format||'number';
  if(!['number','amount'].includes(obj.message_format)) throw [400,'メッセージ形式が不正です'];
  obj.message_separator=input.message_separator??' ';
  if(typeof obj.message_separator!=='string'||obj.message_separator.length>256) throw [400,'区切り文字が不正です'];
  if(!obj.code || !obj.name) throw [400,'仕入先コードと仕入先名は必須です'];
  if(obj.currency && !/^[A-Z]{3}$/.test(obj.currency)) throw [400,'通貨は半角英大文字3文字で指定してください'];
  obj.is_active = input.is_active===false || input.is_active===0 ? 0 : 1;
  obj.default_settlement_method=input.default_settlement_method || 'transfer';
  if(!['transfer','advance','offset'].includes(obj.default_settlement_method)) throw [400,'決済区分が不正です'];
  const existing=db.prepare('SELECT id FROM suppliers WHERE code=?').get(obj.code);
  if(existing && existing.id!==id) throw [409,'この仕入先コードは登録済みです'];
  return obj;
}
function send(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function audit(id,action,before,after){db.prepare('INSERT INTO audit_log(entity_type,entity_id,action,before_json,after_json) VALUES (?,?,?,?,?)').run('supplier',id,action,before?JSON.stringify(before):null,after?JSON.stringify(after):null);}
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/suppliers')){const result=await business(req,url,req.method==='GET'?null:await body(req));if(result!==null)return send(res,200,result);}
  if(url.pathname==='/api/suppliers'){
   if(req.method==='GET'){
    const q=(url.searchParams.get('q')||'').trim();
    const rows=q?db.prepare('SELECT * FROM suppliers WHERE code LIKE ? OR name LIKE ? ORDER BY code').all(`%${q}%`,`%${q}%`):db.prepare('SELECT * FROM suppliers ORDER BY code').all();
    return send(res,200,rows);
   }
   if(req.method==='POST'){
    const input=validate(await body(req));
    const saved=transaction(()=>{const params=FIELDS.map(k=>input[k]);const result=db.prepare(`INSERT INTO suppliers (${FIELDS.join(',')}) VALUES (${FIELDS.map(()=>'?').join(',')})`).run(...params);const row=db.prepare('SELECT * FROM suppliers WHERE id=?').get(result.lastInsertRowid);audit(row.id,'create',null,row);return row;});
    return send(res,201,saved);
   }
  }
  const m=url.pathname.match(/^\/api\/suppliers\/(\d+)$/);
  if(m && req.method==='PUT'){
   const id=Number(m[1]);const before=db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);if(!before) return send(res,404,{error:'仕入先が見つかりません'});
   const input=validate(await body(req),id);
   const saved=transaction(()=>{const fields=FIELDS.filter(k=>k!=='code');db.prepare(`UPDATE suppliers SET ${fields.map(k=>k+'=?').join(',')}, code=?, updated_at=datetime('now') WHERE id=?`).run(...fields.map(k=>input[k]),input.code,id);const row=db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);audit(id,'update',before,row);return row;});
   return send(res,200,saved);
  }
  if(req.method!=='GET')return send(res,405,{error:'許可されていない操作です'});
  const files={__proto__:null,'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/layout.css':'layout.css'};
  const moduleFile=/^\/ui\/[a-z]+\.js$/.test(url.pathname) ? url.pathname.slice(1) : null;
  const file=files[url.pathname] || moduleFile;if(!file || !fs.existsSync(path.join(ROOT,'public',file))){res.writeHead(404);return res.end('Not Found');}
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store'});fs.createReadStream(path.join(ROOT,'public',file)).pipe(res);
 }catch(e){const status=Array.isArray(e)?e[0]:500;console.error(e);send(res,status,{error:Array.isArray(e)?e[1]:'処理に失敗しました。サーバーログを確認してください'});}
});
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>100000)throw [413,'入力データが大きすぎます'];}try{return JSON.parse(s);}catch{throw [400,'JSON形式が不正です'];}}
async function start(){
 const folder=path.join(ROOT,'backup');fs.mkdirSync(folder,{recursive:true});
 const date=new Date().toLocaleDateString('sv-SE');
 const filename='kaikake_daily_'+date+'.db';
 if(!fs.existsSync(path.join(folder,filename))){
  await backup(db,path.join(folder,filename));
  const daily=fs.readdirSync(folder).filter(x=>/^kaikake_daily_\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().reverse();
  for(const old of daily.slice(30))fs.unlinkSync(path.join(folder,old));
 }
 server.listen(PORT,'127.0.0.1',()=>{
  const port=server.address().port;
  console.log(`買掛管理 v0.5.4: http://127.0.0.1:${port}`);
  process.send?.({port});
 });
}
start().catch(e=>{console.error('起動時バックアップ失敗:',e);process.exitCode=1;db.close()});
