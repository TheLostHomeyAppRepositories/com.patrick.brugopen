'use strict';
const fs=require('fs'); const path=require('path'); const root=path.resolve(__dirname,'..'); const driverId='bridge';
function read(rel){return JSON.parse(fs.readFileSync(path.join(root,rel),'utf8'));}
function files(dir){const p=path.join(root,dir);return fs.readdirSync(p).filter(n=>n.endsWith('.json')).sort().map(n=>({id:path.basename(n,'.json'),json:read(path.join(dir,n))}));}
function flow(kind){return files(path.join('.homeycompose','flow',kind)).map(({json})=>({id:json.id}));}
const pkg=read('package.json'), app=read('.homeycompose/app.json'), dc=read(`drivers/${driverId}/driver.compose.json`);
if(pkg.version!==app.version)throw new Error('Version mismatch package/compose');
const driver={...dc,id:driverId,icon:`/drivers/${driverId}/assets/icon.svg`}; const capabilities={}; for(const {id,json} of files('.homeycompose/capabilities'))capabilities[id]=json;
const manifest={_comment:'Generated file. Edit .homeycompose and *.compose.json sources instead.',...app,drivers:[driver],flow:{triggers:flow('triggers'),conditions:flow('conditions'),actions:flow('actions')},capabilities};
fs.writeFileSync(path.join(root,'app.json'),JSON.stringify(manifest,null,2)+'\n'); console.log(`Generated app.json for ${pkg.name} v${pkg.version}`);
