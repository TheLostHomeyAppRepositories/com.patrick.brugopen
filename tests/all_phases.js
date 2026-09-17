'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '..');
const { parseTrafficFeed, bridgeQueueImpact, trackedQueueImpact, distanceKm } = require('../lib/datex_traffic_parser');
const { TrafficFeedService } = require('../lib/traffic_feed_service');
const { FisClient } = require('../lib/fis_client');

function loadWithHomeyStub(rel) {
  const orig = Module._load;
  class App {} class Driver {} class Device {}
  Module._load = function(req) { if (req === 'homey') return { App, Driver, Device }; return orig.apply(this, arguments); };
  try { const r=require.resolve(rel); delete require.cache[r]; return require(rel); }
  finally { Module._load=orig; }
}

function testTrafficParser() {
  const xml = `<?xml version="1.0"?><d2LogicalModel><payloadPublication><publicationTime>2026-09-16T17:00:00Z</publicationTime>
  <situation id="S-BRIDGE">
    <situationRecord id="NLABC123456789012345_B1" type="GeneralNetworkManagement"><overallStartTime>2026-09-16T16:49:00Z</overallStartTime><latitude>51.9000</latitude><longitude>4.4000</longitude><generalNetworkManagementType>bridgeSwingInOperation</generalNetworkManagementType></situationRecord>
    <situationRecord id="Q1" type="AbnormalTraffic"><overallStartTime>2026-09-16T16:50:00Z</overallStartTime><latitude>51.8995</latitude><longitude>4.3995</longitude><roadNumber>A15</roadNumber><queueLength>1250</queueLength><trafficTrendType>trafficBuildingUp</trafficTrendType></situationRecord>
  </situation>
  <situation id="S-ACCIDENT">
    <situationRecord id="A1" type="Accident"><latitude>51.9001</latitude><longitude>4.4001</longitude></situationRecord>
    <situationRecord id="Q2" type="AbnormalTraffic"><latitude>51.9002</latitude><longitude>4.4002</longitude><roadNumber>A15</roadNumber><queueLength>3000</queueLength></situationRecord>
  </situation></payloadPublication></d2LogicalModel>`;
  const parsed = parseTrafficFeed(xml);
  assert.strictEqual(parsed.queues.length, 1, 'Unrelated accident queue must be ignored');
  assert.strictEqual(parsed.queues[0].recordId, 'Q1');
  const impact = bridgeQueueImpact(parsed, {lat:51.9000,lon:4.4000,isrs:'NLABC123456789012345'});
  assert.strictEqual(impact.matched, true);
  assert.strictEqual(impact.queueLength, 1250);
  assert.strictEqual(impact.road, 'A15');
  assert(distanceKm(51.9,4.4,51.9005,4.4005) < 1);

  const cross = parseTrafficFeed(`<?xml version="1.0"?><d2LogicalModel><payloadPublication>
   <situation id="SB"><situationRecord id="BR-CROSS" type="GeneralNetworkManagement"><latitude>51.91</latitude><longitude>4.41</longitude><generalNetworkManagementType>bridgeSwingInOperation</generalNetworkManagementType></situationRecord></situation>
   <situation id="SQ"><situationRecord id="Q-CROSS" type="AbnormalTraffic"><latitude>51.91</latitude><longitude>4.41</longitude><queueLength>800</queueLength><cause type="ManagedCause"><managedCause id="BR-CROSS" version="last" targetClass="SituationRecord"/></cause></situationRecord></situation>
  </payloadPublication></d2LogicalModel>`);
  assert.strictEqual(cross.queues.length,1,'ManagedCause may link queue to bridge across situations');
  assert.strictEqual(cross.queues[0].evidence,'managed_cause');
  assert.strictEqual(trackedQueueImpact(cross,{recordIds:['Q-CROSS']}).queueLength,800);
}

function testTrafficServiceCorrelation() {
  const service = new TrafficFeedService({});
  let bridgeStatus='open';
  const device={
    getData:()=>({id:'NLTEST'}), getName:()=> 'Testbrug',
    getBridgeMeta:()=>({isrs:'NLTEST',lat:51.9,lon:4.4,status:bridgeStatus,lastClosedAt:'2026-09-16T17:01:00Z'})
  };
  const openParsed=parseTrafficFeed(`<?xml version="1.0"?><d2LogicalModel><payloadPublication><situation id="S1"><situationRecord id="NLTEST00000000000000_B" type="GeneralNetworkManagement"><latitude>51.9</latitude><longitude>4.4</longitude><generalNetworkManagementType>bridgeSwingInOperation</generalNetworkManagementType></situationRecord><situationRecord id="QX" type="AbnormalTraffic"><latitude>51.899</latitude><longitude>4.399</longitude><queueLength>1400</queueLength></situationRecord></situation></payloadPublication></d2LogicalModel>`);
  let state=service._stateFor(device,openParsed);
  assert.strictEqual(state.status,'queue');
  assert.strictEqual(state.queueLengthMeters,1400);
  bridgeStatus='closed';
  const residualParsed=parseTrafficFeed(`<?xml version="1.0"?><d2LogicalModel><payloadPublication><situation id="S1"><situationRecord id="QX" type="AbnormalTraffic"><latitude>51.899</latitude><longitude>4.399</longitude><queueLength>900</queueLength><cause type="NonManagedCause"><causeType>congestion</causeType></cause></situationRecord></situation></payloadPublication></d2LogicalModel>`);
  state=service._stateFor(device,residualParsed);
  assert.strictEqual(state.status,'residual','Previously proven bridge queue must be followed after closing');
  assert.strictEqual(state.queueLengthMeters,900);
  const clearParsed=parseTrafficFeed(`<?xml version="1.0"?><d2LogicalModel><payloadPublication></payloadPublication></d2LogicalModel>`);
  state=service._stateFor(device,clearParsed);
  assert.strictEqual(state.status,'clear');
}

async function testNearbyFis() {
  const c = new FisClient({getJson:async url=>{
    const u=new URL(url);
    assert(url.includes('/collections/brug/items'));
    assert(u.searchParams.get('bbox'));
    return {json:{type:'FeatureCollection',features:[
      {properties:{id:1,name:'Dichtbijbrug',city:'Teststad',isrsid:101,canopen:'Yes'},geometry:{type:'Point',coordinates:[4.4005,51.9004]}},
      {properties:{id:2,name:'Verderbrug',city:'Teststad',isrsid:102,canopen:'Yes'},geometry:{type:'Point',coordinates:[4.42,51.91]}},
    ]}};
  }});
  const result=await c.nearby(51.9,4.4,2);
  assert.strictEqual(result.length,2);
  assert.strictEqual(result[0].name,'Dichtbijbrug');
  assert(Number.isFinite(result[0].distanceMeters));
  assert(result[0].candidateId.includes(':'));
}

function bridgeExternalHarness() {
  const Bridge=loadWithHomeyStub('../drivers/bridge/device'); const device=new Bridge();
  const caps=new Map([
['bridge_traffic_status','unknown'],['bridge_traffic_summary','—'],['bridge_queue_length',0],['bridge_aftermath_duration','—'],
    ['bridge_status','closed'],['bridge_data_status','ok']
  ]);
  const store=new Map([['bridge_name','Testbrug']]); const triggered=[];
  device.homey={__:k=>k,i18n:{getLanguage:()=> 'nl'},clock:{getTimezone:()=> 'Europe/Amsterdam'},app:{notifyRoutes(){},emitDashboardChanged(){},triggerBridge:async(id,dev,tokens,state)=>{triggered.push({id,tokens,state});}}};
  device.getName=()=> 'Testbrug'; device.getData=()=>({id:'NLTEST'}); device.hasCapability=k=>caps.has(k); device.addCapability=async k=>{ if(!caps.has(k)) caps.set(k,null); }; device.removeCapability=async k=>caps.delete(k); device.getCapabilityValue=k=>caps.get(k); device.setCapabilityValue=async(k,v)=>caps.set(k,v); device.getStoreValue=k=>store.get(k); device.setStoreValue=async(k,v)=>store.set(k,v); device.log=()=>{};
  return {device,caps,store,triggered};
}

async function testBridgeExternalStates() {
  const {device,caps,triggered}=bridgeExternalHarness();
  await device.onTrafficState({status:'clear',summary:'Geen file door brugopening',checkedAt:new Date().toISOString()});
  device._impactBootSynced=true;
  await device.onTrafficState({status:'queue',summary:'File door brugopening · A15 · 1,2 km',queueLengthMeters:1200,checkedAt:new Date().toISOString()});
  assert.strictEqual(caps.get('bridge_traffic_status'),'queue');
  assert.strictEqual(caps.get('bridge_queue_length'),1.2);
  assert.strictEqual(caps.get('bridge_traffic_display'),'queue');
  assert.strictEqual(caps.get('bridge_queue_length_display'),1.2);
  assert(!caps.has('bridge_aftermath_display'));
  assert(triggered.some(x=>x.id==='bridge_queue_started'));
  triggered.length=0;
  await device.onTrafficState({status:'residual',summary:'Brug dicht · file loopt nog terug',queueLengthMeters:700,aftermathSeconds:120,checkedAt:new Date().toISOString()});
  assert.strictEqual(caps.get('bridge_traffic_status'),'residual');
  assert.strictEqual(caps.get('bridge_traffic_display'),'residual');
  assert.strictEqual(caps.get('bridge_queue_length_display'),0.7);
  assert(caps.has('bridge_aftermath_display'));
  assert(triggered.some(x=>x.id==='bridge_queue_residual'));
  triggered.length=0;
  await device.onTrafficState({status:'clear',summary:'Geen file door brugopening',queueLengthMeters:0,checkedAt:new Date().toISOString()});
  assert(!caps.has('bridge_traffic_display'));
  assert(!caps.has('bridge_queue_length_display'));
  assert(!caps.has('bridge_aftermath_display'));
  assert(triggered.some(x=>x.id==='bridge_queue_recovered'));
  triggered.length=0;
}

function routeHarness() {
  const Route=loadWithHomeyStub('../drivers/route/device'); const device=new Route();
  const caps=new Map([
    ['route_status','free'],['route_problem_bridge','—'],['route_next_opening','Geen aankondiging'],['route_summary',''],['route_bridge_count',2],['route_open_count',0],['route_announced_count',0],
    ['route_blockages_today',0],['route_blocked_time_today','0 sec'],['route_average_blockage_duration','—'],['route_longest_blockage_duration','—'],['route_traffic_status','unknown'],['route_traffic_summary',''],['route_queue_length',0],['route_aftermath_duration','—']
  ]);
  const store=new Map([['bridge_ids',['A','B']],['bridge_names',['A-brug','B-brug']],['route_plan_signature','']]); const triggered=[];
  const translations={'route.free':'Alle bruggen op deze route zijn dicht.','route.no_announcement':'Geen aankondiging','route.blocked_one':'Geblokkeerd: {bridge} is open.','route.blocked_many':'Geblokkeerd: {count} bruggen zijn open.','route.uncertain':'Status onzeker: geen betrouwbare actuele data voor {bridge}.','route.announced':'Route is nu vrij; opening aangekondigd bij {bridge} om {time}.','route.traffic_clear':'Geen file door brugopening','route.traffic_unknown':'File-impact onbekend','route.traffic_queue':'File door brugopening bij','route.traffic_residual':'Nasleep van brugopening bij','route_status.free':'Vrij','route_status.blocked':'Geblokkeerd','route_status.announced':'Aangekondigd','route_status.unknown':'Data onzeker','traffic_status.clear':'Geen file door brugopening','traffic_status.queue':'File door brugopening','traffic_status.residual':'Nasleep na brugopening','traffic_status.unknown':'Onbekend'};
  device.homey={__:k=>translations[k]||k,i18n:{getLanguage:()=> 'nl'},clock:{getTimezone:()=> 'Europe/Amsterdam'},app:{getBridgeDevices:()=>[],emitDashboardChanged(){},triggerRoute:async(id,dev,tokens,state)=>{triggered.push({id,tokens,state});}}};
  device.getName=()=> 'Route test';device.getData=()=>({id:'route-x'});device.hasCapability=k=>caps.has(k);device.addCapability=async k=>{ if(!caps.has(k)) caps.set(k,null); };device.removeCapability=async k=>caps.delete(k);device.getCapabilityValue=k=>caps.get(k);device.setCapabilityValue=async(k,v)=>caps.set(k,v);device.getStoreValue=k=>store.get(k);device.setStoreValue=async(k,v)=>store.set(k,v);device.log=()=>{};
  return {device,caps,store,triggered};
}

async function testRouteHistoryTrafficAndEdit() {
  const {device,caps,store,triggered}=routeHarness();
  const blockedStart=Date.parse('2026-09-16T08:00:00Z');
  await device.setStoreValue('route_blocked_started_at',new Date(blockedStart).toISOString()); caps.set('route_status','blocked');
  await device._handleBlockageTransition('blocked','free',blockedStart+8*60*1000);
  assert.strictEqual(store.get('route_blockage_history').length,1);
  await device._updateHistoryStats(Date.parse('2026-09-16T10:00:00Z'));
  assert.strictEqual(caps.get('route_blockages_today'),1);
  assert(caps.get('route_blocked_time_today').includes('8 min'));

  device._bootSynced=true; device._trafficBootSynced=true; caps.set('route_status','free'); caps.set('route_traffic_status','queue'); caps.set('route_queue_length',1.4); device._lastAftermathSeconds=0;
  device._bridgeSnapshots=()=>[
    {id:'A',name:'A-brug',status:'closed',dataStatus:'ok',currentKnown:true,trafficStatus:'residual',trafficSummary:'Brug dicht · file loopt terug',queueLengthKm:0.8,aftermathSeconds:180},
    {id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true,trafficStatus:'clear',trafficSummary:'Geen file door brugopening',queueLengthKm:0,aftermathSeconds:0},
  ];
  await device.refreshRoute();
  assert.strictEqual(caps.get('route_traffic_status'),'residual');
  assert.strictEqual(caps.get('route_queue_length'),0.8);
  assert.strictEqual(caps.get('route_traffic_display'),'residual');
  assert.strictEqual(caps.get('route_queue_length_display'),0.8);
  assert(caps.has('route_aftermath_display'));
  assert(triggered.some(x=>x.id==='route_queue_residual'));
  triggered.length=0;
  device._bridgeSnapshots=()=>[
    {id:'A',name:'A-brug',status:'closed',dataStatus:'ok',currentKnown:true,trafficStatus:'clear',trafficSummary:'Geen file door brugopening',queueLengthKm:0,aftermathSeconds:0},
    {id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true,trafficStatus:'clear',trafficSummary:'Geen file door brugopening',queueLengthKm:0,aftermathSeconds:0},
  ];
  await device.refreshRoute();
  assert.strictEqual(caps.get('route_traffic_status'),'clear');
  assert(!caps.has('route_traffic_display'));
  assert(!caps.has('route_queue_length_display'));
  assert(!caps.has('route_aftermath_display'));
  assert(triggered.some(x=>x.id==='route_traffic_recovered'));

  device.refreshRoute=async()=>{};
  await device.setBridgeIds(['B'],['B-brug']);
  assert.deepStrictEqual(store.get('bridge_ids'),['B']);
  assert.strictEqual(device._bootSynced,false);
}

function testManifestAndControlCenter() {
  const compose=JSON.parse(fs.readFileSync(path.join(root,'.homeycompose/app.json'),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
  assert.strictEqual(compose.version,'1.1.2');
  assert(compose.permissions.includes('homey:manager:geolocation'));
  for(const key of ['getDashboard','updateRoute','refreshEverything','getNearby']) assert(compose.api[key]);
  assert(fs.existsSync(path.join(root,'settings/index.html')));
  const flowIds=new Set([...(manifest.flow&&manifest.flow.triggers||[]).map(x=>x.id),...(manifest.flow&&manifest.flow.conditions||[]).map(x=>x.id),...(manifest.flow&&manifest.flow.actions||[]).map(x=>x.id)]);
  assert(!flowIds.has('bridge_operation_status_changed'));
  assert(!flowIds.has('bridge_is_operated'));
  for(const id of ['bridge_notice_started','bridge_notice_changed','bridge_notice_cleared','bridge_has_notice','refresh_official_info']) assert(!flowIds.has(id),`Obsolete notice flow still present: ${id}`);
  assert(!manifest.capabilities.bridge_notice_status && !manifest.capabilities.bridge_notice, 'Obsolete navigation notice capabilities still present');
  for (const id of ['bridge_traffic_status','bridge_traffic_summary','bridge_queue_length','bridge_aftermath_duration','route_traffic_status','route_traffic_summary','route_queue_length','route_aftermath_duration']) {
    assert.strictEqual(manifest.capabilities[id].uiComponent, null, `${id} must stay internal/hidden`);
  }
  for (const id of ['bridge_traffic_display','bridge_queue_length_display','bridge_aftermath_display','route_traffic_display','route_queue_length_display','route_aftermath_display']) assert(manifest.capabilities[id], `Missing presentation capability ${id}`);
  const bridgeDriver=manifest.drivers.find(x=>x.id==='bridge'); const routeDriver=manifest.drivers.find(x=>x.id==='route');
  assert(!bridgeDriver.capabilities.includes('bridge_traffic_display') && !bridgeDriver.capabilities.includes('bridge_queue_length_display'), 'Bridge presentation capabilities must be dynamic');
  assert(!routeDriver.capabilities.includes('route_traffic_display') && !routeDriver.capabilities.includes('route_queue_length_display'), 'Route presentation capabilities must be dynamic');
  for(const id of ['bridge_queue_started','bridge_queue_residual','bridge_queue_recovered','bridge_queue_longer_than','bridge_aftermath_longer_than','bridge_has_opening_queue','bridge_has_residual_queue','bridge_queue_length_above','check_bridge_impact','route_queue_residual','route_queue_longer_than','route_aftermath_longer_than','route_has_residual_queue','route_queue_length_above']) assert(flowIds.has(id),`Missing flow ${id}`);
  const api=require('../api'); for(const fn of Object.keys(compose.api)) assert.strictEqual(typeof api[fn],'function');
}

(async()=>{
  testTrafficParser(); testTrafficServiceCorrelation(); await testNearbyFis(); await testBridgeExternalStates(); await testRouteHistoryTrafficAndEdit(); testManifestAndControlCenter();
  console.log('All-phases tests OK: bridge-opening-caused NDW queues only, nearby FIS search, route traffic recovery/history/editing, Control Center and API manifest; navigation-notice enrichment removed.');
})().catch(err=>{console.error(err);process.exit(1);});
