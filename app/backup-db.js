'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
(async()=>{
 const root=__dirname, source=path.join(root,'data','kaikake.db');
 if(!fs.existsSync(source)){console.log('No existing database; backup skipped.');return;}
 const folder=path.join(root,'backup');fs.mkdirSync(folder,{recursive:true});
 const date=new Date().toISOString().replace(/[:.]/g,'-');
 const dest=path.join(folder,`kaikake_before_update_${date}.db`);
 const db=new DatabaseSync(source);
 try {await backup(db,dest); console.log('Backup: '+dest);}finally{db.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
