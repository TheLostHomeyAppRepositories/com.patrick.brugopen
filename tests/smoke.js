'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '..');
const { parseBridgeFeed, extractIsrs } = require('../lib/datex_bridge_parser');
const { deriveBridgeState, applySnapshotPolicy, applyCurrentSnapshotPolicy, mergeBridgeStates } = require('../lib/bridge_state');
const {
  scoreBridge, movable, FisClient, mapOgcBridgeFeature, buildBridgeFilter, broadSearchTerm,
} = require('../lib/fis_client');

function fixture(n) { return fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'); }

function testParser() {
  let p = parseBridgeFeed(fixture('planned.xml'));
  assert.strictEqual(p.records.length, 1);
  assert.strictEqual(p.records[0].state, 'planned');
  assert.strictEqual(p.records[0].isrs, 'NLZAA0233O6308300007');
  p = parseBridgeFeed(fixture('open.xml'));
  assert.strictEqual(p.records[0].state, 'open');
  assert.strictEqual(p.records[0].isrs, 'NLGOU002700535900110');
  p = parseBridgeFeed(fixture('closed.xml'));
  assert.strictEqual(p.records[0].state, 'closed');
  assert.strictEqual(p.records[0].ended, true);
  assert.strictEqual(extractIsrs('PNH02_NLZAA0233O6308300007_314148'), 'NLZAA0233O6308300007');
}

function testState() {
  const planned = parseBridgeFeed(fixture('planned.xml')).records;
  let d = deriveBridgeState(planned, { isrs: 'NLZAA0233O6308300007', lat: 51.9, lon: 4.5 }, Date.parse('2026-09-14T15:00:00Z'));
  assert.strictEqual(d.status, 'planned');
  const open = parseBridgeFeed(fixture('open.xml')).records;
  d = deriveBridgeState(open, { isrs: 'NLGOU002700535900110', lat: 52.024437, lon: 4.667765 });
  assert.strictEqual(d.status, 'open');
  let s = applySnapshotPolicy({ status: 'open', seenInNdw: true, missingSnapshots: 0 }, { seen: false, status: null });
  assert.strictEqual(s.status, 'open');
  s = applySnapshotPolicy(s, { seen: false, status: null });
  assert.strictEqual(s.status, 'closed');
  const unknown = applySnapshotPolicy({ status: 'unknown', seenInNdw: false, missingSnapshots: 0 }, { seen: false, status: null });
  assert.strictEqual(unknown.status, 'unknown');

  const firstClosed = applyCurrentSnapshotPolicy(
    { status: 'unknown', seenInCurrent: false, currentSnapshotKnown: false, currentMissingSnapshots: 0 },
    { seen: false, status: null }
  );
  assert.strictEqual(firstClosed.status, 'closed', 'A bridge absent from a successful current snapshot must resolve Closed');
  assert.strictEqual(firstClosed.currentSnapshotKnown, true);
  assert.strictEqual(mergeBridgeStates(firstClosed, { status: 'unknown' }, 'unknown').status, 'closed');

  const currentOpen = applyCurrentSnapshotPolicy(
    { status: 'unknown', seenInCurrent: false, currentSnapshotKnown: false, currentMissingSnapshots: 0 },
    deriveBridgeState(open, { isrs: 'NLGOU002700535900110', lat: 52.024437, lon: 4.667765 })
  );
  assert.strictEqual(currentOpen.status, 'open');
  assert.strictEqual(currentOpen.seenInCurrent, true);
  assert.strictEqual(currentOpen.currentSnapshotKnown, true);

  const mergedOpen = mergeBridgeStates(currentOpen, { status: 'unknown' }, 'unknown');
  assert.strictEqual(mergedOpen.status, 'open', 'A bridge added while already open must immediately become Open');

  const currentClosed = applyCurrentSnapshotPolicy(currentOpen, { seen: false, status: null }, true);
  assert.strictEqual(currentClosed.status, 'closed');
  assert.strictEqual(mergeBridgeStates(currentClosed, { status: 'open' }, 'open').status, 'closed', 'Current feed must close a stale planning-feed Open state');
  assert.strictEqual(mergeBridgeStates(currentClosed, { status: 'planned', nextOpening: '2026-09-15T10:00:00Z' }, 'closed').status, 'planned', 'A future planned opening must remain visible while the bridge is currently closed');
}


async function testCachedSnapshotSynchronizesNewDevice() {
  const { BridgeFeedService } = require('../lib/bridge_feed_service');
  const parsed = parseBridgeFeed(fixture('open.xml'));
  const store = new Map();
  const caps = new Map([['bridge_status', 'unknown']]);
  let received = null;
  let heartbeat = 0;
  const device = {
    getStoreValue: key => store.get(key),
    getCapabilityValue: key => caps.get(key),
    getBridgeMeta: () => ({ isrs: 'NLNOT00000000000000', lat: 52.1, lon: 4.8 }),
    onBridgeState: async state => {
      received = state;
      caps.set('bridge_status', state.status);
      store.set('current_snapshot_known', state.currentState.currentSnapshotKnown === true);
      store.set('current_status', state.currentState.status);
      store.set('seen_in_current', state.currentState.seenInCurrent === true);
    },
    onFeedHeartbeat: async () => { heartbeat += 1; },
    onFeedError: async () => {},
  };
  const service = new BridgeFeedService({ app: { error() {} } }, {
    currentClient: { fetch: async () => ({ changed: false }) },
    planningClient: { fetch: async () => ({ changed: false }) },
  });
  service.devices.add(device);
  service.lastCurrentFeed = parsed;
  const result = await service._refreshCurrentImpl();
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.synchronized, 1);
  assert(received, 'New device must be evaluated against cached current snapshot');
  assert.strictEqual(received.status, 'closed', 'A new bridge absent from a valid cached current snapshot must resolve Closed');
  assert.strictEqual(store.get('current_snapshot_known'), true);
  assert.strictEqual(heartbeat, 0, 'Pending device must be state-synchronized, not heartbeat-only');
}

function testSearchHelpers() {
  const a = scoreBridge({ name: 'Botlekbrug', city: 'Rotterdam' }, 'botlek');
  const b = scoreBridge({ name: 'Calandbrug', city: 'Rotterdam' }, 'botlek');
  assert(a > b);
  assert(movable('TRUE'));
  assert(movable('Yes'));
  assert(!movable('No'));
  const f = mapOgcBridgeFeature({
    properties: { id: 10, name: 'Botlekbrug', city: 'Rotterdam', isrsid: 38136315, canopen: 'Yes' },
    geometry: { type: 'Point', coordinates: [4.3, 51.9] },
  });
  assert.strictEqual(f.name, 'Botlekbrug');
  assert.strictEqual(f.isrsId, 38136315);
  assert.strictEqual(f.lon, 4.3);
  assert(buildBridgeFilter('Botlek').includes("canopen = 'Yes'"));
  assert(buildBridgeFilter("O'Brien").includes("O''Brien"));
  assert.strictEqual(broadSearchTerm('Botlekbrg'), 'botle');
}

async function testTargetedOgcSearchAndLazyIsrsResolve() {
  const urls = [];
  const c = new FisClient({
    getJson: async url => {
      urls.push(url);
      if (url.includes('/collections/brug/items')) {
        const u = new URL(url);
        const filter = u.searchParams.get('filter') || '';
        assert(filter.includes("canopen = 'Yes'"));
        assert(filter.toLowerCase().includes('botlek'));
        assert(Number(u.searchParams.get('limit')) <= 50);
        return { json: {
          type: 'FeatureCollection',
          numberReturned: 2,
          features: [
            {
              type: 'Feature',
              properties: { id: 10, name: 'Botlekbrug', city: 'Rotterdam', isrsid: 38136315, canopen: 'Yes', isremotecontrolled: 'Yes', numberofopenings: 2 },
              geometry: { type: 'Point', coordinates: [4.3, 51.9] },
            },
            {
              type: 'Feature',
              properties: { id: 11, name: 'Vaste brug Botlek', city: 'Rotterdam', isrsid: 123, canopen: 'No' },
              geometry: { type: 'Point', coordinates: [4.31, 51.91] },
            },
          ],
          links: [],
        }};
      }
      if (url.includes('/collections/isrs_object/items')) {
        return { json: { type: 'FeatureCollection', features: [{ properties: {
          id: 38136315, code: 'NLRTM01234B000000001', objectname: 'Botlekbrug', function: 'bridge_5',
        }}] } };
      }
      throw new Error(`Unexpected HTTP call ${url}`);
    },
  });

  const r = await c.search('botlek', 10);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, 'Botlekbrug');
  assert.strictEqual(r[0].isrs, undefined);
  assert.strictEqual(urls.length, 1, 'Search must not resolve ISRS codes for every result');
  assert(!urls[0].includes('limit=1000'), 'Search must never download the full catalogue');

  const resolved = await c.resolveBridge(r[0]);
  assert.strictEqual(resolved.isrs, 'NLRTM01234B000000001');
  assert.strictEqual(urls.length, 2, 'ISRS lookup must happen only after bridge selection');
}

async function testBoundedFuzzyFallback() {
  const bridgeCalls = [];
  const c = new FisClient({
    getJson: async url => {
      if (!url.includes('/collections/brug/items')) throw new Error(`Unexpected ${url}`);
      bridgeCalls.push(url);
      if (bridgeCalls.length === 1) return { json: { type: 'FeatureCollection', features: [], links: [] } };
      return { json: { type: 'FeatureCollection', features: [{
        type: 'Feature',
        properties: { id: 10, name: 'Botlekbrug', city: 'Rotterdam', isrsid: 38136315, canopen: 'Yes' },
        geometry: { type: 'Point', coordinates: [4.3, 51.9] },
      }], links: [] } };
    },
  });
  const r = await c.search('botlekbrg', 10);
  assert.strictEqual(bridgeCalls.length, 2, 'Fuzzy fallback may do at most one extra targeted request');
  assert.strictEqual(r[0].name, 'Botlekbrug');
}

async function testIsrsArcgisFallbackIsExactAndSmall() {
  const urls = [];
  const c = new FisClient({
    getJson: async url => {
      urls.push(url);
      if (url.includes('/collections/isrs_object/items')) throw new Error('OGC temporarily unavailable');
      if (url.includes('/FeatureServer/9/query')) {
        const u = new URL(url);
        assert.strictEqual(u.searchParams.get('where'), 'id = 38136315');
        assert.strictEqual(u.searchParams.get('resultRecordCount'), '5');
        return { json: { features: [{ attributes: {
          id: 38136315, code: 'NLRTM01234B000000001', objectname: 'Botlekbrug', function: 'bridge_5',
        }}] } };
      }
      throw new Error(`Unexpected ${url}`);
    },
  });
  const resolved = await c.resolveBridge({ name: 'Botlekbrug', isrsId: 38136315 });
  assert.strictEqual(resolved.isrs, 'NLRTM01234B000000001');
  assert.strictEqual(urls.length, 2);
}

function testPairViewNoAutoSearch() {
  const html = fs.readFileSync(path.join(root, 'drivers', 'bridge', 'pair', 'search_bridge.html'), 'utf8');
  assert(!html.includes("addEventListener('input'"), 'Pairing must not search on every keystroke');
  assert(html.includes('search.onclick=doSearch'));
  assert(html.includes("e.key==='Enter'"));
}



function testBridgeOpenIndicatorCapability() {
  const cap = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'capabilities', 'bridge_open_state.json'), 'utf8'));
  assert.strictEqual(cap.type, 'enum');
  assert.deepStrictEqual(cap.values.map(v => v.id), ['unknown', 'no', 'yes']);
  const driver = JSON.parse(fs.readFileSync(path.join(root, 'drivers', 'bridge', 'driver.compose.json'), 'utf8'));
  assert(driver.capabilities.includes('bridge_open_state'));
  assert(!driver.capabilities.includes('alarm_generic'), 'Legacy opening alarm must not be in the driver');
  assert(!driver.capabilitiesOptions || !driver.capabilitiesOptions.alarm_generic, 'Legacy opening alarm options must be removed');
  const deviceCode = fs.readFileSync(path.join(root, 'drivers', 'bridge', 'device.js'), 'utf8');
  assert(deviceCode.includes("bridge_open_state:'unknown'"));
  assert(deviceCode.includes("status === 'open') return 'yes'"));
  assert(deviceCode.includes("status === 'closed' || status === 'planned') return 'no'"));
  assert(deviceCode.includes("removeCapability('alarm_generic')"), 'Existing devices must remove the legacy opening alarm');
  assert(!deviceCode.includes("_set('alarm_generic'"), 'Runtime must no longer update the legacy opening alarm');
}

function testRealtimeFeedConfiguration() {
  const { CURRENT_POLL_MS, PLANNING_POLL_MS } = require('../lib/bridge_feed_service');
  const { CURRENT_FEED_URL, PLANNING_FEED_URL } = require('../lib/ndw_client');
  assert.strictEqual(CURRENT_POLL_MS, 15000);
  assert.strictEqual(PLANNING_POLL_MS, 60000);
  assert(CURRENT_FEED_URL.endsWith('/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz'));
  assert(PLANNING_FEED_URL.endsWith('/planningsfeed_brugopeningen.xml.gz'));
}


function testStoreReadinessText() {
  const compose = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'app.json'), 'utf8'));
  assert.strictEqual(compose.version, '1.0.0');
  assert.strictEqual(compose.description.nl, 'Weet wanneer een brug je route kan onderbreken.');
  assert.strictEqual(compose.description.en, 'Know when a bridge may interrupt your route.');
  const flowCondition = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'flow', 'conditions', 'bridge_status_is.json'), 'utf8'));
  assert.strictEqual(flowCondition.titleFormatted.en, 'Bridge status is [[status]]');
  assert.strictEqual(flowCondition.titleFormatted.nl, 'Brugstatus is [[status]]');
  for (const rel of ['README.txt', 'README.nl.txt']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8').trim();
    assert(text.split(/\n\s*\n/).length <= 2, `${rel} must contain at most two paragraphs`);
    assert(!/15 seconds|15 seconden|60 seconds|60 seconden/i.test(text), `${rel} must not expose polling implementation details`);
  }
  const ignore = fs.readFileSync(path.join(root, '.homeyignore'), 'utf8');
  for (const pattern of ['CERTIFICATION_NOTES*.md', 'RELEASE_NOTES*.md', 'TESTPLAN*.md', 'README.md']) assert(ignore.includes(pattern));
}

function testModuleSyntax() {
  const orig = Module._load;
  class App {}
  class Driver {}
  class Device {}
  Module._load = function(req, parent, isMain) {
    if (req === 'homey') return { App, Driver, Device };
    return orig.apply(this, arguments);
  };
  try {
    require('../app');
    require('../drivers/bridge/driver');
    require('../drivers/bridge/device');
  } finally {
    Module._load = orig;
  }
}

(async () => {
  testParser();
  testState();
  await testCachedSnapshotSynchronizesNewDevice();
  testSearchHelpers();
  await testTargetedOgcSearchAndLazyIsrsResolve();
  await testBoundedFuzzyFallback();
  await testIsrsArcgisFallbackIsExactAndSmall();
  testPairViewNoAutoSearch();
  testRealtimeFeedConfiguration();
  testBridgeOpenIndicatorCapability();
  testStoreReadinessText();
  testModuleSyntax();
  console.log('Smoke tests OK: DATEX lifecycle, immediate known status after valid current snapshot, cached snapshot sync, dual NDW feeds, 15s current polling, targeted FIS search, lazy ISRS resolve, no auto-search, three-state bridge-open indicator, removed legacy opening alarm, Flow titleFormatted, and SDK modules.');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
