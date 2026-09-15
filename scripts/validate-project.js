'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'); const root=path.resolve(__dirname,'..'); const issues=[];
const exists=r=>fs.existsSync(path.join(root,r)); const read=r=>fs.readFileSync(path.join(root,r),'utf8'); const json=r=>JSON.parse(read(r)); const fail=m=>issues.push(m);
function pngSize(rel){const b=fs.readFileSync(path.join(root,rel)); if(b.toString('ascii',1,4)!=='PNG')throw new Error(`${rel} not PNG`);return[b.readUInt32BE(16),b.readUInt32BE(20)];}
function assertPng(rel,size){if(!exists(rel))return fail(`Missing ${rel}`);const a=pngSize(rel);if(a[0]!==size[0]||a[1]!==size[1])fail(`${rel}: ${a.join('x')} expected ${size.join('x')}`);}
function hash(r){return crypto.createHash('sha256').update(fs.readFileSync(path.join(root,r))).digest('hex');}
function walkTranslations(v,where){if(!v||typeof v!=='object')return;if(Object.prototype.hasOwnProperty.call(v,'en')||Object.prototype.hasOwnProperty.call(v,'nl')){if(!v.en||!v.nl)fail(`${where} missing en/nl`);}for(const [k,x] of Object.entries(v))if(x&&typeof x==='object')walkTranslations(x,`${where}.${k}`);}
const pkg=json('package.json'), compose=json('.homeycompose/app.json'), manifest=json('app.json');
if(pkg.name!==compose.id||manifest.id!==compose.id)fail('App id mismatch'); if(pkg.version!==compose.version||manifest.version!==compose.version)fail('Version mismatch');
if(compose.sdk!==3)fail('SDK must be 3'); if(compose.runtime!=='nodejs')fail('runtime must be nodejs'); if(!compose.platforms||!compose.platforms.includes('local'))fail('local platform required');
if(!/^#[0-9A-Fa-f]{6}$/.test(compose.brandColor||''))fail('brandColor missing/invalid'); walkTranslations(compose,'app');
if(exists('drivers/bridge/driver.json'))fail('driver.json duplicates Compose source'); const dc=json('drivers/bridge/driver.compose.json'); walkTranslations(dc,'driver');
for(const kind of ['triggers','conditions','actions']){const dir=path.join(root,'.homeycompose','flow',kind);for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){const x=json(path.join('.homeycompose','flow',kind,f));walkTranslations(x,`${kind}/${f}`);if(!x.id)fail(`${f} missing id`);if(!(x.args||[]).some(a=>a.type==='device'&&a.filter==='driver_id=bridge'))fail(`${f} missing bridge device arg`);}}
for(const f of fs.readdirSync(path.join(root,'.homeycompose','capabilities')).filter(x=>x.endsWith('.json')))walkTranslations(json(path.join('.homeycompose','capabilities',f)),`cap/${f}`);
for(const [r,s] of [['assets/images/small.png',[250,175]],['assets/images/large.png',[500,350]],['assets/images/xlarge.png',[1000,700]],['drivers/bridge/assets/images/small.png',[75,75]],['drivers/bridge/assets/images/large.png',[500,500]],['drivers/bridge/assets/images/xlarge.png',[1000,1000]]])assertPng(r,s);
for(const r of ['assets/icon.svg','drivers/bridge/assets/icon.svg']){if(!exists(r))fail(`Missing ${r}`);else{const s=read(r);if(!/viewBox=["']0 0 960 960["']/.test(s))fail(`${r} must use 960x960 viewBox`);if(/<text\b/i.test(s))fail(`${r} contains text`);}}
if(exists('assets/icon.svg')&&exists('drivers/bridge/assets/icon.svg')&&hash('assets/icon.svg')===hash('drivers/bridge/assets/icon.svg'))fail('App and driver icon must differ');
if(exists('assets/images/xlarge.png')&&exists('drivers/bridge/assets/images/xlarge.png')&&hash('assets/images/xlarge.png')===hash('drivers/bridge/assets/images/xlarge.png'))fail('App and driver images must differ');
if(!exists('drivers/bridge/pair/search_bridge.html'))fail('Pair view missing'); if(!exists('LICENSE'))fail('LICENSE missing'); if(!exists('.homeychangelog.json'))fail('Changelog missing');
for(const r of ['README.txt','README.nl.txt']){if(!exists(r))fail(`${r} missing`);else if(/https?:\/\/|[#*_`]/.test(read(r)))fail(`${r} must be plain text without URL/Markdown`);}
const generated=read('app.json'); require('./generate-app-json'); const regenerated=read('app.json'); if(generated!==regenerated)fail('Generated app.json was stale');
if(issues.length){console.error('\nValidation failed:\n- '+issues.join('\n- '));process.exit(1);} console.log('Project validation OK: SDK3/Compose, translations, flows, pairing and assets checked.');
