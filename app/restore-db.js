// Offline restore: node restore-db.js <backup-file-name>
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
(async()=>{
 const name=process.argv[2];
 if(!name||path.basename(name)!==name||!/^kaikake_[A-Za-z0-9_-]+\.db$/.test(name))throw Error('使い方: node restore-db.js kaikake_daily_YYYY-MM-DD.db');
 const root=__dirname,source=path.join(root,'backup',name),target=path.join(root,'data','kaikake.db');
 if(!fs.existsSync(source))throw Error('バックアップが見つかりません');
 const check=new DatabaseSync(source,{readOnly:true});
 try{const r=check.prepare('PRAGMA integrity_check').get();if(r.integrity_check!=='ok')throw Error('バックアップが破損しています');}finally{check.close()}
 if(fs.existsSync(target)){
  const current=new DatabaseSync(target);
  try{await backup(current,path.join(root,'backup','kaikake_before_restore_'+new Date().toISOString().replace(/[:.]/g,'-')+'.db'));}finally{current.close()}
 }
 const tmp=target+'.restore_tmp';fs.copyFileSync(source,tmp);fs.renameSync(tmp,target);
 console.log('復元しました。アプリを再起動してください。');
})().catch(e=>{console.error(e.message);process.exitCode=1});
