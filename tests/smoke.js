'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '..');
const { parseBridgeFeed, extractIsrs } = require('../lib/datex_bridge_parser');
const { deriveBridgeState, applySnapshotPolicy, applyCurrentSnapshotPolicy, mergeBridgeStates } = require('../lib/bridge_state');
const {
  scoreBridge, movable, FisClient, mapOgcBridgeFeature, buildBridgeFilter, broadSearchTerm, smartFallbackTerm,
  deriveSearchTerms, cleanOpeningName, buildOpeningFilter, buildIsrsFilter,
} = require('../lib/fis_client');
const { applyBridgeAlias, aliasSearchTerm } = require('../lib/bridge_aliases');
const { geometryCenter } = require('../lib/pdok_client');

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
    properties: { id: 10, name: 'Botlekbrug', city: 'Rotterdam', isrsid: 38136315, canopen: 'Yes', relatedbuildingcomplexname: 'Botlekcomplex' },
    geometry: { type: 'Point', coordinates: [4.3, 51.9] },
  });
  assert.strictEqual(f.name, 'Botlekbrug');
  assert.strictEqual(f.isrsId, 38136315);
  assert.strictEqual(f.lon, 4.3);
  assert.strictEqual(f.relatedBuildingComplexName, 'Botlekcomplex');
  assert(buildBridgeFilter('Botlek').includes("canopen = 'Yes'"));
  assert(buildBridgeFilter("O'Brien").includes("O''Brien"));
  assert(buildOpeningFilter('Botlek').includes("parentgeotype = 'bridge'"));
  assert(buildIsrsFilter('Botlek').includes("countrycode = 'NL'"));
  assert.strictEqual(broadSearchTerm('botlekbrg'), 'botle');
  assert(deriveSearchTerms('Julianasluisbrug Zuid').includes('julianasluis'));
  assert(deriveSearchTerms('Spijkenisserbrug').includes('spijkenisser'));
  assert.strictEqual(cleanOpeningName('Doorvaartopening 1 (beweegbaar) Abtswoudsebrug'), 'Abtswoudsebrug');
  assert.strictEqual(cleanOpeningName('Doorvaartopening (vast) brug in Lekkumerweg'), 'brug in Lekkumerweg');
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


async function testNationalMultiSourceSearch() {
  const urls = [];
  const c = new FisClient({
    getJson: async url => {
      urls.push(url);
      const u = new URL(url);
      const filter = (u.searchParams.get('filter') || '').toLowerCase();

      if (url.includes('/collections/brug/items')) {
        // Exact public-name request returns nothing, generic "julianasluis" fallback returns both movable bridges.
        if (filter.includes('julianasluisbrug zuid')) {
          return { json: { type: 'FeatureCollection', features: [], links: [] } };
        }
        if (filter.includes('julianasluis') && !filter.includes('id =') && !filter.includes('isrsid =')) {
          return { json: { type: 'FeatureCollection', features: [
            {
              type: 'Feature',
              properties: { id: 201, name: 'Brug over binnenhoofd Julianasluis', city: 'Gouda', isrsid: 143, canopen: 'Yes' },
              geometry: { type: 'Point', coordinates: [4.7100, 52.0120] },
            },
            {
              type: 'Feature',
              properties: { id: 202, name: 'Brug over buitenhoofd Julianasluis', city: 'Gouda', isrsid: 144, canopen: 'Yes' },
              geometry: { type: 'Point', coordinates: [4.7100, 52.0060] },
            },
          ], links: [] } };
        }
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }

      if (url.includes('/collections/opening/items')) {
        return { json: { type: 'FeatureCollection', features: [{
          type: 'Feature',
          properties: {
            id: 501,
            name: 'Doorvaartopening (beweegbaar) Julianasluis',
            parentid: 202,
            parentgeotype: 'bridge',
            isrsid: 9001,
            type: 'OPH',
          },
        }], links: [] } };
      }

      if (url.includes('/collections/isrs_object/items')) {
        // Search-stage ISRS request.
        if (!filter.includes('id =')) {
          return { json: { type: 'FeatureCollection', features: [{ properties: {
            id: 144,
            code: 'NLGOU002700536600144',
            countrycode: 'NL',
            objectname: 'Brug over buitenhoofd Julianasluis',
            function: 'bridge_5',
          }}], links: [] } };
        }
        // Resolve-stage exact ID request.
        return { json: { type: 'FeatureCollection', features: [{ properties: {
          id: 144,
          code: 'NLGOU002700536600144',
          countrycode: 'NL',
          objectname: 'Brug over buitenhoofd Julianasluis',
          function: 'bridge_5',
        }}], links: [] } };
      }

      throw new Error(`Unexpected HTTP call ${url}`);
    },
  });

  const result = await c.search('Julianasluisbrug Zuid', 10);
  assert(result.length >= 2, 'Generic fallback should find both Julianasluis bridge objects');
  assert.strictEqual(result[0].name, 'Julianasluisbrug Zuid', 'South direction should rank the southern bridge first');
  assert.strictEqual(result[0].sourceName, 'Brug over buitenhoofd Julianasluis');
  assert(result[0].searchNames.some(name => /julianasluis/i.test(name)));
  assert(urls.some(url => url.includes('/collections/opening/items')), 'Opening names must participate in fallback search');
  assert(urls.some(url => url.includes('/collections/isrs_object/items')), 'ISRS object names must participate in fallback search');
  assert(!urls.some(url => /limit=1000/.test(url)), 'Search must never download the complete catalogue');

  const resolved = await c.resolveBridge(result[0]);
  assert.strictEqual(resolved.isrs, 'NLGOU002700536600144');
}

async function testOpeningNameResolvesBridge() {
  const c = new FisClient({
    pdokClient: { searchBridgeName: async () => [] },
    getJson: async url => {
      const u = new URL(url);
      const filter = (u.searchParams.get('filter') || '').toLowerCase();
      if (url.includes('/collections/opening/items')) {
        if (filter.includes('abtswoudse')) {
          return { json: { type: 'FeatureCollection', features: [{
            type: 'Feature',
            properties: { id: 601, name: 'Doorvaartopening 1 (beweegbaar) Abtswoudsebrug', parentid: 401, parentgeotype: 'bridge', isrsid: 9601, type: 'DR' },
          }], links: [] } };
        }
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      if (url.includes('/collections/isrs_object/items')) {
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      if (url.includes('/collections/brug/items')) {
        if (filter.includes('id = 401')) {
          return { json: { type: 'FeatureCollection', features: [{
            type: 'Feature',
            properties: { id: 401, name: 'Technische brugnaam Delft', city: 'Delft', isrsid: 9401, canopen: 'Yes' },
            geometry: { type: 'Point', coordinates: [4.35, 52.0] },
          }], links: [] } };
        }
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      throw new Error(`Unexpected ${url}`);
    },
  });
  const result = await c.search('Abtswoudsebrug', 10);
  assert.strictEqual(result.length, 1);
  assert(result[0].searchNames.some(name => /Abtswoudsebrug/i.test(name)), 'Opening name must become a searchable bridge name');
}

async function testIsrsObjectNameResolvesBridge() {
  const c = new FisClient({
    pdokClient: { searchBridgeName: async () => [] },
    getJson: async url => {
      const u = new URL(url);
      const filter = (u.searchParams.get('filter') || '').toLowerCase();
      if (url.includes('/collections/isrs_object/items')) {
        if (filter.includes('publieke isrs naam')) {
          return { json: { type: 'FeatureCollection', features: [{ properties: {
            id: 9402, code: 'NLXXX000000000009402', countrycode: 'NL', objectname: 'Publieke ISRS Naam', function: 'bridge_1',
          }}], links: [] } };
        }
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      if (url.includes('/collections/opening/items')) {
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      if (url.includes('/collections/brug/items')) {
        if (filter.includes('isrsid = 9402')) {
          return { json: { type: 'FeatureCollection', features: [{
            type: 'Feature',
            properties: { id: 402, name: 'Technische FIS naam 2', city: 'Teststad', isrsid: 9402, canopen: 'Yes' },
            geometry: { type: 'Point', coordinates: [5.1, 52.1] },
          }], links: [] } };
        }
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      throw new Error(`Unexpected ${url}`);
    },
  });
  const result = await c.search('Publieke ISRS Naam', 10);
  assert.strictEqual(result.length, 1);
  assert(result[0].searchNames.includes('Publieke ISRS Naam'));
}

async function testPdokPublicNameFallback() {
  const urls = [];
  const c = new FisClient({
    getJson: async url => {
      urls.push(url);
      if (url.includes('api.pdok.nl/kadaster/location-api/v1/search')) {
        const u = new URL(url);
        assert.strictEqual(u.searchParams.get('q'), 'Lokale Brugnaam');
        assert.strictEqual(u.searchParams.get('inrichtingselement[version]'), '1');
        return { json: { type: 'FeatureCollection', features: [{
          type: 'Feature',
          properties: { display_name: 'Lokale Brugnaam' },
          geometry: { type: 'Point', coordinates: [4.5000, 52.0000] },
        }] } };
      }
      if (url.includes('/collections/brug/items')) {
        const u = new URL(url);
        if (u.searchParams.get('bbox')) {
          return { json: { type: 'FeatureCollection', features: [{
            type: 'Feature',
            properties: { id: 301, name: 'Technische FIS naam', city: 'Voorbeeldstad', isrsid: 9301, canopen: 'Yes' },
            geometry: { type: 'Point', coordinates: [4.5005, 52.0003] },
          }], links: [] } };
        }
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      if (url.includes('/collections/opening/items') || url.includes('/collections/isrs_object/items')) {
        return { json: { type: 'FeatureCollection', features: [], links: [] } };
      }
      throw new Error(`Unexpected ${url}`);
    },
  });

  const result = await c.search('Lokale Brugnaam', 10);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'Lokale Brugnaam');
  assert.strictEqual(result[0].sourceName, 'Technische FIS naam');
  assert(urls.some(url => url.includes('api.pdok.nl')), 'PDOK must be used only as a public-name fallback');
  assert(urls.some(url => new URL(url).searchParams.get('bbox')), 'PDOK location must be linked back to a nearby movable FIS bridge');
  assert(!urls.some(url => /limit=1000/.test(url)));

  const center = geometryCenter({ type: 'LineString', coordinates: [[4.4, 52.0], [4.6, 52.2]] });
  assert(Math.abs(center.lon - 4.5) < 1e-9);
  assert(Math.abs(center.lat - 52.1) < 1e-9);
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
  assert(deviceCode.includes("bridge_open_state: 'unknown'"));
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
  assert.strictEqual(compose.version, '1.1.2');
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


function testV110CapabilitiesAndFlows() {
  const driver = JSON.parse(fs.readFileSync(path.join(root, 'drivers', 'bridge', 'driver.compose.json'), 'utf8'));
  for (const cap of ['bridge_open_since', 'bridge_open_duration', 'bridge_last_open_duration']) {
    assert(driver.capabilities.includes(cap), `${cap} must be included in the bridge driver`);
    assert(fs.existsSync(path.join(root, '.homeycompose', 'capabilities', `${cap}.json`)), `${cap} definition missing`);
  }
  assert(!driver.capabilities.includes('bridge_data_age'), 'Visible data-age capability must be removed');
  assert(!fs.existsSync(path.join(root, '.homeycompose', 'capabilities', 'bridge_data_age.json')), 'Data-age capability definition must be removed');
  const dataStatus = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'capabilities', 'bridge_data_status.json'), 'utf8'));
  assert(dataStatus.values.some(v => v.id === 'stale'), 'Data status must support stale data');

  for (const id of ['bridge_open_longer_than', 'bridge_planned_within', 'bridge_data_stale']) {
    const card = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'flow', 'triggers', `${id}.json`), 'utf8'));
    assert(card.args.some(a => a.type === 'device' && a.filter === 'driver_id=bridge'));
    assert(card.args.some(a => a.name === 'minutes' && a.type === 'number'));
  }

  const deviceCode = fs.readFileSync(path.join(root, 'drivers', 'bridge', 'device.js'), 'utf8');
  assert(deviceCode.includes("triggerBridge('bridge_open_longer_than'"));
  assert(deviceCode.includes("triggerBridge('bridge_planned_within'"));
  assert(deviceCode.includes("triggerBridge('bridge_data_stale'"));
  assert(deviceCode.includes("removeCapability('bridge_data_age')"), 'Existing devices must remove the visible data-age tile');
  assert(deviceCode.includes("last_successful_current_at"));
  assert(deviceCode.includes("open_started_at"));
  assert(deviceCode.includes("if (!this._bootSynced)"), 'Runtime triggers must be suppressed during boot synchronization');

  const feedCode = fs.readFileSync(path.join(root, 'lib', 'bridge_feed_service.js'), 'utf8');
  assert(feedCode.includes("feedSource: 'current'"));
  assert(feedCode.includes("feedSource: 'planning'"));
}


function loadWithHomeyStub(rel, classes = {}) {
  const orig = Module._load;
  class BaseApp {}
  class BaseDriver {}
  class BaseDevice {}
  Module._load = function(req, parent, isMain) {
    if (req === 'homey') return {
      App: classes.App || BaseApp,
      Driver: classes.Driver || BaseDriver,
      Device: classes.Device || BaseDevice,
    };
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

async function testV110FlowThresholds() {
  const BrugOpenApp = loadWithHomeyStub('../app');
  const app = new BrugOpenApp();
  const cards = new Map();
  const cardFor = id => {
    if (!cards.has(id)) cards.set(id, {
      registerRunListener(fn) { this.listener = fn; return this; },
      async trigger() { return true; },
    });
    return cards.get(id);
  };
  app.homey = {
    flow: {
      getDeviceTriggerCard: cardFor,
      getConditionCard: cardFor,
      getActionCard: cardFor,
    },
  };
  app._registerTriggerCards();

  assert.strictEqual(await cards.get('bridge_open_longer_than').listener({ minutes: 7 }, { previous_seconds: 419, current_seconds: 420 }), true);
  assert.strictEqual(await cards.get('bridge_open_longer_than').listener({ minutes: 8 }, { previous_seconds: 419, current_seconds: 420 }), false);
  assert.strictEqual(await cards.get('bridge_planned_within').listener({ minutes: 10 }, { previous_seconds: 601, current_seconds: 596 }), true);
  assert.strictEqual(await cards.get('bridge_planned_within').listener({ minutes: 5 }, { previous_seconds: 601, current_seconds: 596 }), false);
  assert.strictEqual(await cards.get('bridge_data_stale').listener({ minutes: 2 }, { previous_seconds: 119, current_seconds: 121 }), true);
  assert.strictEqual(await cards.get('bridge_data_stale').listener({ minutes: 3 }, { previous_seconds: 119, current_seconds: 121 }), false);
}

async function testV110DeviceRuntime() {
  const BridgeDevice = loadWithHomeyStub('../drivers/bridge/device');
  const device = new BridgeDevice();
  const caps = new Map([
    ['bridge_status', 'open'],
    ['bridge_open_since', '—'],
    ['bridge_open_duration', '—'],
    ['bridge_last_open_duration', '—'],
    ['bridge_data_status', 'ok'],
    ['bridge_next_opening', '—'],
  ]);
  const store = new Map([['bridge_name', 'Testbrug']]);
  const triggered = [];
  device.homey = {
    i18n: { getLanguage: () => 'nl' },
    clock: { getTimezone: () => 'Europe/Amsterdam' },
    app: { triggerBridge: async (id, dev, tokens, state) => { triggered.push({ id, tokens, state }); return true; } },
    __: key => key,
  };
  device.getName = () => 'Testbrug';
  device.hasCapability = key => caps.has(key);
  device.getCapabilityValue = key => caps.get(key);
  device.setCapabilityValue = async (key, value) => { caps.set(key, value); };
  device.getStoreValue = key => store.get(key);
  device.setStoreValue = async (key, value) => { store.set(key, value); };
  device._bootSynced = true;

  const now = Date.now();
  store.set('open_started_at', new Date(now - 300000).toISOString());
  device._lastOpenDurationSeconds = 299;
  await device._evaluateOpenDuration(now);
  assert.strictEqual(triggered.at(-1).id, 'bridge_open_longer_than');
  assert.strictEqual(triggered.at(-1).state.current_seconds, 300);
  assert(caps.get('bridge_open_duration').includes('5 min'));

  triggered.length = 0;
  store.set('planning_start', new Date(now + 600000).toISOString());
  store.set('planning_end', new Date(now + 660000).toISOString());
  device._plannedCountdown = null;
  await device._evaluatePlannedCountdown(now);
  assert.strictEqual(triggered.at(-1).id, 'bridge_planned_within');
  assert.strictEqual(triggered.at(-1).tokens.minutes_until, 10);

  const tr = {
    'planning.waiting': 'Wachten op data',
    'planning.none': 'Geen aankondiging',
    'planning.support_unknown': 'Ondersteuning onbekend',
    'planning.unavailable': 'Planning niet bereikbaar',
  };
  device.homey.__ = key => tr[key] || key;
  store.set('planning_feed_error', false);
  assert.strictEqual(device._nextOpeningDisplay({ planningState: { planningSnapshotKnown: false, seenInNdw: false } }), 'Wachten op data');
  assert.strictEqual(device._nextOpeningDisplay({ planningState: { planningSnapshotKnown: true, seenInNdw: false } }), 'Ondersteuning onbekend');
  assert.strictEqual(device._nextOpeningDisplay({ planningState: { planningSnapshotKnown: true, seenInNdw: true } }), 'Geen aankondiging');
  store.set('planning_feed_error', true);
  assert.strictEqual(device._nextOpeningDisplay({ nextOpening: new Date(now + 600000).toISOString(), planningState: { planningSnapshotKnown: true, seenInNdw: true } }), 'Planning niet bereikbaar');
  store.set('planning_feed_error', false);

  triggered.length = 0;
  store.set('last_successful_current_at', new Date(now - 60000).toISOString());
  device._lastDataAgeSeconds = 59;
  await device._evaluateDataAge(now);
  assert.strictEqual(triggered.at(-1).id, 'bridge_data_stale');
  assert.strictEqual(caps.get('bridge_data_status'), 'stale');
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
    require('../drivers/route/driver');
    require('../drivers/route/device');
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
  await testNationalMultiSourceSearch();
  await testOpeningNameResolvesBridge();
  await testIsrsObjectNameResolvesBridge();
  await testPdokPublicNameFallback();
  await testIsrsArcgisFallbackIsExactAndSmall();
  testPairViewNoAutoSearch();
  testRealtimeFeedConfiguration();
  testBridgeOpenIndicatorCapability();
  testStoreReadinessText();
  testV110CapabilitiesAndFlows();
  await testV110FlowThresholds();
  await testV110DeviceRuntime();
  testModuleSyntax();
  
// Regression: compare_routes uses the first device field as the Flow card device.
// Homey does not allow that first device argument in titleFormatted; the second
// device field behaves like an autocomplete argument and must be represented.
{
  const compare = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/flow/actions/compare_routes.json'), 'utf8'));
  assert.strictEqual(compare.args[0].name, 'route_a');
  assert.strictEqual(compare.args[0].type, 'device');
  assert.strictEqual(compare.args[1].name, 'route_b');
  assert.strictEqual(compare.args[1].type, 'device');
  for (const lang of ['en', 'nl']) {
    assert(!compare.titleFormatted[lang].includes('[[route_a]]'), 'first device argument must not be used in titleFormatted');
    assert(compare.titleFormatted[lang].includes('[[route_b]]'), 'second device argument must be present in titleFormatted');
  }
}

console.log('Smoke tests OK: DATEX lifecycle, immediate known status after valid current snapshot, cached snapshot sync, dual NDW feeds, 15s current polling, targeted nationwide FIS search, bridge/opening/ISRS name matching, opening-parent and ISRS-name resolution, PDOK public-name fallback, lazy ISRS resolve, no auto-search, three-state bridge-open indicator, removed legacy opening alarm, v1.1.2 duration/countdown/data-watchdog features, explicit planning availability states, removed visible data-age tile, Flow titleFormatted, and SDK modules.');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
