'use strict';
const fs=require('fs'); const path=require('path'); const root=path.resolve(__dirname,'..');
function read(rel){return JSON.parse(fs.readFileSync(path.join(root,rel),'utf8'));}
function files(dir){const p=path.join(root,dir);return fs.readdirSync(p).filter(n=>n.endsWith('.json')).sort().map(n=>({id:path.basename(n,'.json'),json:read(path.join(dir,n))}));}
function flow(kind){return files(path.join('.homeycompose','flow',kind)).map(({json})=>({id:json.id}));}
function drivers(){
  const base=path.join(root,'drivers');
  return fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort().map(id=>{
    const dc=read(path.join('drivers',id,'driver.compose.json'));
    return {...dc,id,icon:`/drivers/${id}/assets/icon.svg`};
  });
}
const pkg=read('package.json'), app=read('.homeycompose/app.json');
if(pkg.version!==app.version)throw new Error('Version mismatch package/compose');
const capabilities={}; for(const {id,json} of files('.homeycompose/capabilities'))capabilities[id]=json;
const manifest={_comment:'Generated file. Edit .homeycompose and *.compose.json sources instead.',...app,drivers:drivers(),flow:{triggers:flow('triggers'),conditions:flow('conditions'),actions:flow('actions')},capabilities};
fs.writeFileSync(path.join(root,'app.json'),JSON.stringify(manifest,null,2)+'\n'); console.log(`Generated app.json for ${pkg.name} v${pkg.version}`);
