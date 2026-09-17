'use strict';
const assert = require('assert');
const Module = require('module');

function loadWithHomeyStub(rel) {
  const orig = Module._load;
  class App {}
  class Driver {}
  class Device {}
  Module._load = function(req, parent, isMain) {
    if (req === 'homey') return { App, Driver, Device };
    return orig.apply(this, arguments);
  };
  try {
    const resolved = require.resolve(rel);
    delete require.cache[resolved];
    return require(rel);
  } finally {
    Module._load = orig;
  }
}

function bridgeHarness() {
  const BridgeDevice = loadWithHomeyStub('../drivers/bridge/device');
  const device = new BridgeDevice();
  const caps = new Map([
    ['bridge_status','closed'], ['bridge_data_status','ok'], ['bridge_openings_today',0],
    ['bridge_open_time_today','0 sec'], ['bridge_average_open_duration','—'], ['bridge_longest_open_duration','—'],
    ['bridge_open_since','—'], ['bridge_open_duration','—'], ['bridge_last_open_duration','—'],
    ['bridge_next_opening','—'], ['bridge_open_state','no'], ['bridge_last_check','—'],
  ]);
  const store = new Map([['bridge_name','Testbrug']]);
  const triggered = [];
  device.homey = {
    i18n: { getLanguage: () => 'nl' },
    clock: { getTimezone: () => 'Europe/Amsterdam' },
    app: { triggerBridge: async (id, dev, tokens, state) => { triggered.push({id,tokens,state}); return true; }, notifyRoutes() {} },
    __: key => key,
  };
  device.getName = () => 'Testbrug';
  device.getData = () => ({id:'NLTEST00000000000001'});
  device.hasCapability = key => caps.has(key);
  device.getCapabilityValue = key => caps.get(key);
  device.setCapabilityValue = async (key,value) => caps.set(key,value);
  device.getStoreValue = key => store.get(key);
  device.setStoreValue = async (key,value) => store.set(key,value);
  return {device,caps,store,triggered};
}

async function testLocalHistory() {
  const {device,caps,store} = bridgeHarness();
  const start = Date.parse('2026-09-16T08:00:00Z'); // 10:00 in Amsterdam (CEST)
  const end = Date.parse('2026-09-16T08:10:00Z');
  await device._recordOpening(start,end,600);
  await device._updateHistoryStats(Date.parse('2026-09-16T10:00:00Z'));
  assert.strictEqual(caps.get('bridge_openings_today'),1);
  assert(caps.get('bridge_open_time_today').includes('10 min'));
  assert(caps.get('bridge_average_open_duration').includes('10 min'));
  assert(caps.get('bridge_longest_open_duration').includes('10 min'));
  assert.strictEqual(store.get('opening_history').length,1);
}

async function testAnnouncementChangedAndCancelled() {
  const {device,triggered} = bridgeHarness();
  device._bootSynced = true;
  device._planningBootSynced = true;
  const oldStart = new Date(Date.now()+30*60*1000).toISOString();
  const oldEnd = new Date(Date.now()+35*60*1000).toISOString();
  const newStart = new Date(Date.now()+40*60*1000).toISOString();
  const newEnd = new Date(Date.now()+45*60*1000).toISOString();
  await device._handlePlanningChange({start:oldStart,end:oldEnd}, {
    feedSource:'planning', status:'planned', planningState:{status:'planned',plannedStart:newStart,plannedEnd:newEnd,missingSnapshots:0},
  });
  assert.strictEqual(triggered.at(-1).id,'bridge_planned_changed');
  triggered.length=0;
  await device._handlePlanningChange({start:oldStart,end:oldEnd}, {
    feedSource:'planning', status:'closed', planningState:{status:'closed',plannedStart:'',plannedEnd:'',missingSnapshots:2},
  });
  assert.strictEqual(triggered.at(-1).id,'bridge_planned_cancelled');
}

function routeHarness() {
  const RouteDevice = loadWithHomeyStub('../drivers/route/device');
  const device = new RouteDevice();
  const caps = new Map([
    ['route_status','free'], ['route_problem_bridge','—'], ['route_next_opening','Geen aankondiging'],
    ['route_summary',''], ['route_bridge_count',2], ['route_open_count',0], ['route_announced_count',0],
  ]);
  const store = new Map([['bridge_ids',['A','B']],['route_plan_signature','']]);
  const triggered=[];
  const translations = {
    'route.no_announcement':'Geen aankondiging','route.free':'Alle bruggen op deze route zijn dicht.',
    'route.blocked_one':'Geblokkeerd: {bridge} is open.','route.blocked_many':'Geblokkeerd: {count} bruggen zijn open.',
    'route.uncertain':'Status onzeker: geen betrouwbare actuele data voor {bridge}.',
    'route.announced':'Route is nu vrij; opening aangekondigd bij {bridge} om {time}.',
    'route_status.free':'Vrij','route_status.announced':'Opening aangekondigd','route_status.blocked':'Geblokkeerd','route_status.unknown':'Data onzeker',
  };
  device.homey={
    i18n:{getLanguage:()=> 'nl'}, clock:{getTimezone:()=> 'Europe/Amsterdam'}, __:key=>translations[key]||key,
    app:{triggerRoute:async(id,dev,tokens,state)=>{triggered.push({id,tokens,state});return true;},getBridgeDevices:()=>[]},
  };
  device.getName=()=> 'Route werk'; device.getData=()=>({id:'route-test'});
  device.hasCapability=key=>caps.has(key); device.getCapabilityValue=key=>caps.get(key); device.setCapabilityValue=async(key,value)=>caps.set(key,value);
  device.getStoreValue=key=>store.get(key); device.setStoreValue=async(key,value)=>store.set(key,value);
  return {device,caps,store,triggered};
}

async function testRouteCalculationAndFlows() {
  const {device,caps,store,triggered}=routeHarness();
  let r=device._calculate([{id:'A',name:'A-brug',status:'closed',dataStatus:'ok',currentKnown:true},{id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true}]);
  assert.strictEqual(r.status,'free');
  r=device._calculate([{id:'A',name:'A-brug',status:'open',dataStatus:'ok',currentKnown:true},{id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true}]);
  assert.strictEqual(r.status,'blocked'); assert.strictEqual(r.problemBridge,'A-brug');
  r=device._calculate([{id:'A',name:'A-brug',status:'closed',dataStatus:'stale',currentKnown:true},{id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true}]);
  assert.strictEqual(r.status,'unknown');
  const future=new Date(Date.now()+20*60*1000).toISOString();
  r=device._calculate([{id:'A',name:'A-brug',status:'planned',dataStatus:'ok',currentKnown:true,plannedStart:future},{id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true}]);
  assert.strictEqual(r.status,'announced'); assert(r.nextOpening.includes('A-brug'));

  device._bootSynced=true;
  device._bridgeSnapshots=()=>[{id:'A',name:'A-brug',status:'open',dataStatus:'ok',currentKnown:true},{id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true}];
  await device.refreshRoute();
  assert.strictEqual(caps.get('route_status'),'blocked');
  assert(triggered.some(x=>x.id==='route_blocked'));
  triggered.length=0;
  device._bridgeSnapshots=()=>[{id:'A',name:'A-brug',status:'closed',dataStatus:'ok',currentKnown:true},{id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true}];
  await device.refreshRoute();
  assert.strictEqual(caps.get('route_status'),'free');
  assert(triggered.some(x=>x.id==='route_cleared'));

  const scan=await device.getDepartureScanResult();
  assert.strictEqual(scan.route_status_id,'free');
  assert.strictEqual(scan.bridge_count,2);
  assert(scan.summary.includes('Alle bruggen'));
  assert.strictEqual(store.get('bridge_ids').length,2);
}

async function testRouteStartupDoesNotFireFalseFlows() {
  const {device,triggered}=routeHarness();
  device._bootSynced=false;
  device._bridgeSnapshots=()=>[
    {id:'A',name:'A-brug',status:'unknown',dataStatus:'unknown',currentKnown:false},
    {id:'B',name:'B-brug',status:'unknown',dataStatus:'unknown',currentKnown:false},
  ];
  await device.refreshRoute();
  assert.strictEqual(device._bootSynced,false);
  assert.strictEqual(triggered.length,0);

  device._bridgeSnapshots=()=>[
    {id:'A',name:'A-brug',status:'closed',dataStatus:'ok',currentKnown:true},
    {id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true},
  ];
  await device.refreshRoute();
  assert.strictEqual(device._bootSynced,true);
  assert.strictEqual(triggered.length,0,'First complete route synchronization must establish a baseline without firing Flows');

  device._bridgeSnapshots=()=>[
    {id:'A',name:'A-brug',status:'open',dataStatus:'ok',currentKnown:true},
    {id:'B',name:'B-brug',status:'closed',dataStatus:'ok',currentKnown:true},
  ];
  await device.refreshRoute();
  assert(triggered.some(x=>x.id==='route_blocked'));
}

(async()=>{
  await testLocalHistory();
  await testAnnouncementChangedAndCancelled();
  await testRouteCalculationAndFlows();
  await testRouteStartupDoesNotFireFalseFlows();
  console.log('Five-star tests OK: local history, announcement changes/cancellations, route aggregation, blocked/free route flows and departure scan.');
})().catch(err=>{console.error(err);process.exit(1);});
