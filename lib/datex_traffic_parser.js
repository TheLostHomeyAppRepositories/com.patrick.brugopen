'use strict';

const { findElements, findText, attr, extractIsrs } = require('./datex_bridge_parser');

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const nums = [lat1, lon1, lat2, lon2].map(Number);
  if (!nums.every(Number.isFinite)) return Infinity;
  const [aLat, aLon, bLat, bLon] = nums;
  const rad = v => v * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function typeFromAttrs(attrs) {
  return String(attr(attrs, 'type') || '').split(':').pop();
}

function isEnded(xml) {
  return findText(xml, 'end').toLowerCase() === 'true' || findText(xml, 'cancel').toLowerCase() === 'true';
}

function roadLabel(xml) {
  return findText(xml, 'roadName') || findText(xml, 'roadNumber') || findText(xml, 'locationDescriptor') || '';
}

function managedCauseIds(xml) {
  const out = [];
  const source = String(xml || '');
  const re = /<(?:(?:[A-Za-z_][\w.-]*):)?managedCause\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/(?:(?:[A-Za-z_][\w.-]*):)?managedCause\s*>)/gi;
  let m;
  while ((m = re.exec(source))) {
    const id = attr(m[1] || '', 'id');
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function nonManagedCauseTypes(xml) {
  return findElements(String(xml || ''), 'causeType').map(x => String(x.inner || '').replace(/<[^>]+>/g, '').trim().toLowerCase()).filter(Boolean);
}

function hasCompetingCauseRecord(records) {
  const bad = /Accident|Obstruction|VehicleObstruction|AnimalPresenceObstruction|EnvironmentalObstruction|ConstructionWorks|MaintenanceWorks|Roadworks|PoorRoadInfrastructure|WeatherRelatedRoadConditions|RoadsideAssistance/i;
  return records.some(r => bad.test(String(r.type || '')));
}

function parseTrafficFeed(xml) {
  const source = String(xml || '');
  if (!source.trim()) throw new Error('Empty NDW traffic document');
  const publicationTime = toDate(findText(source, 'publicationTime'));
  const queues = [];
  const rawQueues = [];
  const bridges = [];
  const parsedSituations = [];

  for (const situation of findElements(source, 'situation')) {
    const situationId = attr(situation.attrs, 'id');
    const records = findElements(situation.inner, 'situationRecord').map(rec => {
      const type = typeFromAttrs(rec.attrs);
      const recordId = attr(rec.attrs, 'id');
      const queueLength = Number(findText(rec.full, 'queueLength') || 0) || 0;
      const latitude = toNumber(findText(rec.full, 'latitude'));
      const longitude = toNumber(findText(rec.full, 'longitude'));
      const bridgeSwing = findText(rec.full, 'generalNetworkManagementType') === 'bridgeSwingInOperation';
      return {
        type, recordId, full: rec.full, queueLength, latitude, longitude, bridgeSwing,
        ended: isEnded(rec.full),
        managedCauseIds: managedCauseIds(rec.full),
        causeTypes: nonManagedCauseTypes(rec.full),
      };
    });
    parsedSituations.push({ situationId, records });
  }

  const globalBridgeById = new Map();
  for (const situation of parsedSituations) {
    for (const br of situation.records.filter(r => r.bridgeSwing)) {
      if (!Number.isFinite(br.latitude) || !Number.isFinite(br.longitude)) continue;
      const item = {
        situationId: situation.situationId,
        recordId: br.recordId,
        isrs: extractIsrs(br.recordId) || extractIsrs(situation.situationId) || extractIsrs(br.full),
        latitude: br.latitude,
        longitude: br.longitude,
        road: roadLabel(br.full),
        start: toDate(findText(br.full, 'overallStartTime')),
        end: toDate(findText(br.full, 'overallEndTime')),
        ended: br.ended,
      };
      bridges.push(item);
      if (item.recordId) globalBridgeById.set(item.recordId, item);
    }
  }

  for (const situation of parsedSituations) {
    const localBridges = situation.records.filter(r => r.bridgeSwing);
    const activeRecords = situation.records.filter(r => !r.ended);
    const competing = hasCompetingCauseRecord(activeRecords);

    for (const rec of activeRecords) {
      // Brug Open is interested only in a real queue/file, never generic incidents or works.
      if (!(rec.queueLength > 0)) continue;
      if (!Number.isFinite(rec.latitude) || !Number.isFinite(rec.longitude)) continue;

      const baseQueue = {
        situationId: situation.situationId,
        recordId: rec.recordId,
        type: rec.type,
        latitude: rec.latitude,
        longitude: rec.longitude,
        queueLength: rec.queueLength,
        delaySeconds: Number(findText(rec.full, 'delayTimeValue') || 0) || 0,
        trend: findText(rec.full, 'trafficTrendType') || '',
        flow: findText(rec.full, 'trafficFlowCharacteristics') || '',
        road: roadLabel(rec.full),
        start: toDate(findText(rec.full, 'overallStartTime')),
        end: toDate(findText(rec.full, 'overallEndTime')),
      };
      rawQueues.push(baseQueue);

      const explicitlyLinkedBridgeIds = rec.managedCauseIds.filter(id => globalBridgeById.has(id));
      const explicitlyCausedByBridge = explicitlyLinkedBridgeIds.length > 0;
      const nonManagedCause = rec.causeTypes.some(type => type && type !== 'congestion' && type !== 'earlierevent');
      // DATEX situations group related situationRecords. We only use this fallback when
      // a bridge swing is part of the same situation and no competing accident/works/cause exists.
      const sameSituationBridge = localBridges.length > 0 && !competing && !nonManagedCause;
      if (!explicitlyCausedByBridge && !sameSituationBridge) continue;

      const linkedBridgeIds = explicitlyCausedByBridge
        ? explicitlyLinkedBridgeIds
        : localBridges.map(br => br.recordId).filter(Boolean);

      queues.push({
        ...baseQueue,
        bridgeRecordIds: linkedBridgeIds,
        evidence: explicitlyCausedByBridge ? 'managed_cause' : 'same_situation',
      });
    }
  }

  return { publicationTime, records: queues, queues, rawQueues, bridges };
}

function bridgeMatchesMeta(bridge, meta, radiusKm = 0.5) {
  const isrs = String(meta && meta.isrs || '').toUpperCase();
  if (isrs && bridge.isrs && String(bridge.isrs).toUpperCase() === isrs) return true;
  const lat = Number(meta && meta.lat);
  const lon = Number(meta && meta.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return distanceKm(lat, lon, bridge.latitude, bridge.longitude) <= radiusKm;
}

function summarizeQueues(queues) {
  const list = Array.isArray(queues) ? queues : [];
  const queueLength = list.reduce((max, q) => Math.max(max, Number(q.queueLength) || 0), 0);
  const longest = list.slice().sort((a, b) => (Number(b.queueLength) || 0) - (Number(a.queueLength) || 0))[0] || null;
  const delaySeconds = list.reduce((max, q) => Math.max(max, Number(q.delaySeconds) || 0), 0);
  return {
    queueLength,
    delaySeconds,
    road: longest && longest.road ? longest.road : '',
    trend: longest && longest.trend ? longest.trend : '',
    records: list,
  };
}

function bridgeQueueImpact(parsed, meta, radiusKm = 0.5) {
  const bridges = Array.isArray(parsed && parsed.bridges) ? parsed.bridges : [];
  const queues = Array.isArray(parsed && parsed.queues) ? parsed.queues : [];
  const matchedBridges = bridges.filter(br => bridgeMatchesMeta(br, meta, radiusKm));
  if (!matchedBridges.length) return { matched: false, queueLength: 0, delaySeconds: 0, road: '', records: [], bridgeRecords: [] };
  const ids = new Set(matchedBridges.map(br => br.recordId).filter(Boolean));
  const situations = new Set(matchedBridges.map(br => br.situationId).filter(Boolean));
  const linked = queues.filter(q => q.bridgeRecordIds.some(id => ids.has(id)) || (q.evidence === 'same_situation' && situations.has(q.situationId)));
  const summary = summarizeQueues(linked);
  return { matched: linked.length > 0, ...summary, bridgeRecords: matchedBridges };
}

function trackedQueueImpact(parsed, tracking = {}) {
  const queues = Array.isArray(parsed && parsed.rawQueues) ? parsed.rawQueues : (Array.isArray(parsed && parsed.queues) ? parsed.queues : []);
  const ids = new Set(Array.isArray(tracking.recordIds) ? tracking.recordIds : []);
  const situationIds = new Set(Array.isArray(tracking.situationIds) ? tracking.situationIds : []);
  const linked = queues.filter(q => (q.recordId && ids.has(q.recordId)) || (q.situationId && situationIds.has(q.situationId)));
  return { matched: linked.length > 0, ...summarizeQueues(linked), bridgeRecords: [] };
}

module.exports = {
  parseTrafficFeed,
  bridgeQueueImpact,
  trackedQueueImpact,
  summarizeQueues,
  distanceKm,
  managedCauseIds,
};
