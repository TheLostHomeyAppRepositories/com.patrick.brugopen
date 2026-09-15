'use strict';

const { getJson } = require('./http');
const { applyBridgeAlias } = require('./bridge_aliases');
const { PdokClient } = require('./pdok_client');

const ARCGIS_SERVICE = 'https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/fis_vnds/FeatureServer';
const OGC_SERVICE = 'https://geo.rijkswaterstaat.nl/services/ogc/gdr/fis_vnds/ogc/features/v1';
const BRIDGE_LAYER = 3;
const ISRS_LAYER = 9;
const OPENING_LAYER = 15;
const SEARCH_CACHE_MS = 10 * 60 * 1000;

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[()_,./\\-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compact(value) {
  return norm(value).replace(/[^a-z0-9]/g, '');
}

function movable(value) {
  return ['true', '1', 'yes', 'ja'].includes(norm(value));
}

function levenshtein(a, b) {
  a = compact(a).slice(0, 100);
  b = compact(b).slice(0, 100);
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j < cur.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

function cleanOpeningName(value) {
  let text = String(value || '').trim();
  text = text
    .replace(/^doorvaartopening\s*\d*\s*\((?:beweegbaar|vast)\)\s*/i, '')
    .replace(/^doorvaartopening\s*\d*\s*/i, '')
    .trim();
  return text;
}

function searchNamesForBridge(bridge) {
  return [...new Set([
    bridge.name,
    bridge.sourceName,
    bridge.relatedBuildingComplexName,
    bridge.isrsObjectName,
    ...(Array.isArray(bridge.openingNames) ? bridge.openingNames : []),
    ...(Array.isArray(bridge.searchNames) ? bridge.searchNames : []),
  ].filter(Boolean).map(String))];
}

function scoreName(name, query) {
  const n = norm(name);
  const q = norm(query);
  const nc = compact(name);
  const qc = compact(query);
  if (!n || !q) return 0;

  let score = 0;
  if (n === q || nc === qc) score += 1600;
  else if (n.startsWith(q) || nc.startsWith(qc)) score += 1200;
  else if (n.includes(q) || nc.includes(qc)) score += 950;

  const qTokens = q.split(' ').filter(Boolean);
  for (const token of qTokens) {
    const tc = compact(token);
    if (!tc) continue;
    if (n.split(' ').some(word => word === token)) score += 180;
    else if (n.split(' ').some(word => word.startsWith(token))) score += 130;
    else if (n.includes(token) || nc.includes(tc)) score += 90;
  }

  const distance = levenshtein(q, n);
  const span = Math.max(qc.length, nc.length, 1);
  score += Math.max(0, 220 * (1 - distance / span));
  return score;
}

function scoreBridge(bridge, query) {
  const q = norm(query);
  if (!q) return -Infinity;

  let score = 0;
  for (const name of searchNamesForBridge(bridge)) score = Math.max(score, scoreName(name, q));

  const city = norm(bridge.city);
  if (city === q) score += 700;
  else if (city.startsWith(q)) score += 500;
  else if (city.includes(q)) score += 380;

  for (const token of q.split(' ').filter(Boolean)) {
    if (city && city.includes(token)) score += 70;
  }
  return score;
}

function mapOgcBridgeFeature(feature) {
  const p = feature.properties || {};
  const coordinates = feature.geometry && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates
    : [];
  return {
    fisId: Number(p.id),
    name: String(p.name || '').trim(),
    city: String(p.city || '').trim(),
    isrsId: Number(p.isrsid),
    canOpen: p.canopen,
    remote: p.isremotecontrolled,
    openings: Number(p.numberofopenings || 0),
    relatedBuildingComplexName: String(p.relatedbuildingcomplexname || '').trim(),
    note: String(p.note || '').trim(),
    foreignCode: String(p.foreigncode || '').trim(),
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    source: 'bridge-layer',
  };
}

function mapOgcOpeningFeature(feature) {
  const p = feature.properties || {};
  return {
    id: Number(p.id),
    name: String(p.name || '').trim(),
    cleanName: cleanOpeningName(p.name),
    isrsId: Number(p.isrsid),
    parentId: Number(p.parentid),
    parentGeoType: String(p.parentgeotype || '').trim().toLowerCase(),
    type: String(p.type || '').trim(),
  };
}

function mapOgcIsrsFeature(feature) {
  const p = feature.properties || {};
  return {
    id: Number(p.id),
    code: String(p.code || '').trim().toUpperCase(),
    objectName: String(p.objectname || '').trim(),
    function: String(p.function || '').trim(),
    countryCode: String(p.countrycode || '').trim().toUpperCase(),
  };
}

function mapArcgisIsrsFeature(feature) {
  const a = feature.attributes || {};
  return {
    id: Number(a.id),
    code: String(a.code || '').trim().toUpperCase(),
    objectName: String(a.objectname || '').trim(),
    function: String(a.function || '').trim(),
  };
}

function cqlString(value) {
  return String(value || '').replace(/'/g, "''");
}

function titleVariant(value) {
  return String(value || '').replace(/\b\p{L}/gu, char => char.toUpperCase());
}

function queryVariants(value) {
  const raw = String(value || '').trim().replace(/[%_]/g, ' ');
  return [...new Set([
    raw,
    raw.toLowerCase(),
    raw.toUpperCase(),
    titleVariant(raw),
  ].filter(Boolean))];
}

function cqlContains(field, value) {
  const variants = queryVariants(value);
  if (!variants.length) return '1 = 0';
  return `(${variants.map(item => `${field} LIKE '%${cqlString(item)}%'`).join(' OR ')})`;
}

function buildBridgeFilter(value) {
  return `canopen = 'Yes' AND (${[
    cqlContains('name', value),
    cqlContains('city', value),
    cqlContains('relatedbuildingcomplexname', value),
  ].join(' OR ')})`;
}

function buildOpeningFilter(value) {
  return `parentgeotype = 'bridge' AND ${cqlContains('name', value)}`;
}

function buildIsrsFilter(value) {
  return `countrycode = 'NL' AND (${cqlContains('objectname', value)} OR ${cqlContains('code', value)})`;
}

const GENERIC_WORDS = new Set([
  'brug', 'bruggen', 'sluisbrug', 'spoorbrug', 'fietsbrug', 'verkeersbrug',
  'hefbrug', 'ophaalbrug', 'draaibrug', 'basculebrug', 'klapbrug', 'hef',
  'ophaal', 'draai', 'bascule', 'noord', 'zuid', 'oost', 'west',
  'noordelijk', 'zuidelijk', 'oostelijk', 'westelijk', 'de', 'het', 'een',
]);

function splitCompounds(value) {
  const parts = norm(value).split(' ').filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part.length > 6 && part.endsWith('bruggen')) {
      out.push(part.slice(0, -7), 'bruggen');
    } else if (part.length > 5 && part.endsWith('brug')) {
      out.push(part.slice(0, -4), 'brug');
    } else {
      out.push(part);
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function deriveSearchTerms(value) {
  const original = norm(value);
  if (!original) return [];
  const split = splitCompounds(original);
  const tokens = split.split(' ').filter(Boolean);
  const meaningful = tokens.filter(t => !GENERIC_WORDS.has(t) && t.length >= 3);

  const terms = [original];
  if (meaningful.length) terms.push(meaningful.join(' '));
  if (split !== original) terms.push(split);
  for (const token of meaningful.sort((a, b) => b.length - a.length)) {
    if (token.length >= 5) terms.push(token);
  }

  return [...new Set(terms.map(norm).filter(term => term.length >= 2))].slice(0, 4);
}

function broadSearchTerm(value) {
  const original = norm(value);
  const derived = deriveSearchTerms(value).find(term => term !== original && term.length >= 5);
  if (derived) return derived;
  const token = original.split(' ').filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return token.length >= 5 ? token.slice(0, Math.min(5, token.length)) : '';
}

function smartFallbackTerm(value) {
  return broadSearchTerm(value);
}

function directionFromQuery(value) {
  const q = ` ${norm(value)} `;
  if (/\s(noord|noordelijk|north)\s/.test(q)) return 'north';
  if (/\s(zuid|zuidelijk|south)\s/.test(q)) return 'south';
  if (/\s(oost|oostelijk|east)\s/.test(q)) return 'east';
  if (/\s(west|westelijk|west)\s/.test(q)) return 'west';
  return '';
}

function applyDirectionalBonus(items, query) {
  const direction = directionFromQuery(query);
  if (!direction || items.length < 2) return items;

  const coordinate = direction === 'north' || direction === 'south' ? 'lat' : 'lon';
  const values = items.map(x => Number(x[coordinate])).filter(Number.isFinite);
  if (values.length < 2) return items;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return items;

  return items.map(item => {
    const value = Number(item[coordinate]);
    if (!Number.isFinite(value)) return item;
    let pos = (value - min) / (max - min);
    if (direction === 'south' || direction === 'west') pos = 1 - pos;
    return { ...item, score: item.score + (pos * 280) };
  });
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2].map(Number);
  if (!values.every(Number.isFinite)) return Infinity;
  const [aLat, aLon, bLat, bLon] = values;
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function errorDetail(json) {
  if (!json || !json.error) return '';
  const parts = [];
  if (json.error.message) parts.push(String(json.error.message));
  if (Array.isArray(json.error.details)) {
    for (const detail of json.error.details) {
      if (detail && !parts.includes(String(detail))) parts.push(String(detail));
    }
  }
  return parts.join(' - ');
}

class FisClient {
  constructor(options = {}) {
    this._getJson = options.getJson || getJson;
    this._pdok = options.pdokClient || new PdokClient({ getJson: this._getJson });
    this._cache = new Map();
  }

  async _queryOgcCollection(collection, filter, limit = 40, maxBytes = 2 * 1024 * 1024, extraParams = {}) {
    const params = new URLSearchParams({
      limit: String(Math.min(Math.max(limit, 5), 50)),
      filter,
      'filter-lang': 'cql2-text',
    });
    for (const [key, value] of Object.entries(extraParams || {})) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const url = `${OGC_SERVICE}/collections/${collection}/items?${params.toString()}`;
    const { json } = await this._getJson(url, {
      timeoutMs: 15000,
      maxBytes,
      headers: { Accept: 'application/geo+json, application/json;q=0.9' },
    });
    if (!json || !Array.isArray(json.features)) {
      throw new Error(`FIS OGC ${collection} response is not a FeatureCollection`);
    }
    return json.features;
  }

  async _searchBridgeCandidatesOgc(query, limit = 40) {
    const features = await this._queryOgcCollection('brug', buildBridgeFilter(query), limit);
    return features
      .map(mapOgcBridgeFeature)
      .filter(item => item.name && Number.isFinite(item.fisId) && Number.isFinite(item.isrsId) && movable(item.canOpen))
      .map(applyBridgeAlias);
  }

  async _searchOpeningRefsOgc(query, limit = 35) {
    const features = await this._queryOgcCollection('opening', buildOpeningFilter(query), limit, 1024 * 1024);
    return features
      .map(mapOgcOpeningFeature)
      .filter(item => Number.isFinite(item.parentId) && item.parentGeoType === 'bridge');
  }

  async _searchIsrsRefsOgc(query, limit = 35) {
    const features = await this._queryOgcCollection('isrs_object', buildIsrsFilter(query), limit, 1024 * 1024);
    return features
      .map(mapOgcIsrsFeature)
      .filter(item => Number.isFinite(item.id) && item.countryCode === 'NL');
  }

  async _fetchBridgesByIds(ids, limit = 50) {
    const unique = [...new Set(ids.map(Number).filter(Number.isFinite))].slice(0, 40);
    if (!unique.length) return [];
    const clauses = unique.map(id => `id = ${id}`).join(' OR ');
    const features = await this._queryOgcCollection('brug', `canopen = 'Yes' AND (${clauses})`, Math.min(limit, 50));
    return features
      .map(mapOgcBridgeFeature)
      .filter(item => item.name && Number.isFinite(item.fisId) && Number.isFinite(item.isrsId) && movable(item.canOpen))
      .map(applyBridgeAlias);
  }

  async _fetchBridgesByIsrsIds(ids, limit = 50) {
    const unique = [...new Set(ids.map(Number).filter(Number.isFinite))].slice(0, 40);
    if (!unique.length) return [];
    const clauses = unique.map(id => `isrsid = ${id}`).join(' OR ');
    const features = await this._queryOgcCollection('brug', `canopen = 'Yes' AND (${clauses})`, Math.min(limit, 50));
    return features
      .map(mapOgcBridgeFeature)
      .filter(item => item.name && Number.isFinite(item.fisId) && Number.isFinite(item.isrsId) && movable(item.canOpen))
      .map(applyBridgeAlias);
  }

  _mergeCandidates(groups) {
    const byBridge = new Map();
    for (const group of groups) {
      for (const item of group || []) {
        const key = Number.isFinite(item.fisId) ? `fis:${item.fisId}` : `isrs:${item.isrsId}`;
        const existing = byBridge.get(key);
        if (!existing) {
          byBridge.set(key, {
            ...item,
            searchNames: [...new Set(item.searchNames || [])],
            openingNames: [...new Set(item.openingNames || [])],
          });
          continue;
        }
        existing.searchNames = [...new Set([
          ...(existing.searchNames || []),
          ...(item.searchNames || []),
          item.name,
          item.sourceName,
          item.isrsObjectName,
        ].filter(Boolean))];
        existing.openingNames = [...new Set([...(existing.openingNames || []), ...(item.openingNames || [])].filter(Boolean))];
        if (!existing.isrsObjectName && item.isrsObjectName) existing.isrsObjectName = item.isrsObjectName;
      }
    }
    return [...byBridge.values()];
  }

  async _searchRelatedSources(term, fetchLimit) {
    const [openingRefs, isrsRefs] = await Promise.all([
      this._searchOpeningRefsOgc(term, fetchLimit).catch(() => []),
      this._searchIsrsRefsOgc(term, fetchLimit).catch(() => []),
    ]);

    const [fromOpenings, fromIsrs] = await Promise.all([
      this._fetchBridgesByIds(openingRefs.map(x => x.parentId), fetchLimit).catch(() => []),
      this._fetchBridgesByIsrsIds(isrsRefs.map(x => x.id), fetchLimit).catch(() => []),
    ]);

    const openingByParent = new Map();
    for (const opening of openingRefs) {
      if (!openingByParent.has(opening.parentId)) openingByParent.set(opening.parentId, []);
      openingByParent.get(opening.parentId).push(opening.cleanName || opening.name);
    }
    for (const bridge of fromOpenings) {
      bridge.openingNames = [...new Set([...(bridge.openingNames || []), ...(openingByParent.get(bridge.fisId) || [])].filter(Boolean))];
      bridge.searchNames = [...new Set([...(bridge.searchNames || []), ...(bridge.openingNames || [])].filter(Boolean))];
    }

    const isrsById = new Map(isrsRefs.map(x => [x.id, x]));
    for (const bridge of fromIsrs) {
      const ref = isrsById.get(bridge.isrsId);
      if (ref) {
        bridge.isrsObjectName = ref.objectName;
        bridge.searchNames = [...new Set([...(bridge.searchNames || []), ref.objectName, ref.code].filter(Boolean))];
      }
    }

    return [...fromOpenings, ...fromIsrs];
  }

  async _searchBridgesNear(lon, lat, radiusDeg = 0.015, limit = 25) {
    const x = Number(lon);
    const y = Number(lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const bbox = [x - radiusDeg, y - radiusDeg, x + radiusDeg, y + radiusDeg].join(',');
    const features = await this._queryOgcCollection(
      'brug',
      "canopen = 'Yes'",
      limit,
      1024 * 1024,
      { bbox },
    );
    return features
      .map(mapOgcBridgeFeature)
      .filter(item => item.name && Number.isFinite(item.fisId) && Number.isFinite(item.isrsId) && movable(item.canOpen))
      .map(applyBridgeAlias);
  }

  async _searchPdokFallback(query, fetchLimit) {
    let locations;
    try {
      locations = await this._pdok.searchBridgeName(query, 5);
    } catch (err) {
      return [];
    }
    const found = [];
    for (const location of locations.slice(0, 3)) {
      let nearby = [];
      try {
        nearby = await this._searchBridgesNear(location.lon, location.lat, 0.015, Math.min(fetchLimit, 25));
      } catch (err) {
        continue;
      }
      const ranked = nearby
        .map(bridge => ({
          ...bridge,
          pdokName: location.name,
          pdokDistance: distanceMeters(location.lat, location.lon, bridge.lat, bridge.lon),
        }))
        .filter(bridge => bridge.pdokDistance <= 1500)
        .sort((a, b) => a.pdokDistance - b.pdokDistance)
        .slice(0, 3);
      for (const bridge of ranked) {
        bridge.searchNames = [...new Set([...(bridge.searchNames || []), location.name].filter(Boolean))];
        // If PDOK's official display name closely matches what the user typed, prefer it as the visible name.
        if (scoreName(location.name, query) >= 900 && bridge.pdokDistance <= 900) {
          bridge.sourceName = bridge.sourceName || bridge.name;
          bridge.name = location.name;
        }
        found.push(bridge);
      }
      if (found.length >= 5) break;
    }
    return found;
  }

  async _resolveIsrsOgc(isrsId) {
    const features = await this._queryOgcCollection('isrs_object', `id = ${Number(isrsId)}`, 5, 512 * 1024);
    for (const feature of features) {
      const item = mapOgcIsrsFeature(feature);
      if (item.id === Number(isrsId) && item.code) return item;
    }
    return null;
  }

  async _resolveIsrsArcgis(isrsId) {
    const params = new URLSearchParams({
      where: `id = ${Number(isrsId)}`,
      outFields: 'objectid,id,code,objectname,function',
      returnGeometry: 'false',
      f: 'json',
      resultRecordCount: '5',
      sqlFormat: 'standard',
    });
    const { json } = await this._getJson(`${ARCGIS_SERVICE}/${ISRS_LAYER}/query?${params.toString()}`, {
      timeoutMs: 12000,
      maxBytes: 512 * 1024,
      headers: { Accept: 'application/json' },
    });
    if (!json || json.error) {
      const detail = errorDetail(json);
      throw new Error(`FIS ArcGIS ISRS query failed${detail ? `: ${detail}` : ''}`);
    }
    for (const feature of Array.isArray(json.features) ? json.features : []) {
      const item = mapArcgisIsrsFeature(feature);
      if (item.id === Number(isrsId) && item.code) return item;
    }
    return null;
  }

  async _resolveIsrs(isrsId) {
    if (!Number.isFinite(Number(isrsId))) return null;
    try {
      const item = await this._resolveIsrsOgc(isrsId);
      if (item) return item;
    } catch (err) {
      // Fall through to a tiny exact-ID ArcGIS lookup. This never downloads a catalogue.
    }
    return this._resolveIsrsArcgis(isrsId);
  }

  async search(query, limit = 10) {
    const q = norm(query);
    if (q.length < 2) return [];

    const cacheKey = `${q}|${limit}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.time < SEARCH_CACHE_MS) return cached.value;

    const fetchLimit = Math.min(Math.max(limit * 4, 30), 50);
    const terms = deriveSearchTerms(query);
    const groups = [];

    // First try the bridge collection itself using the exact user query.
    groups.push(await this._searchBridgeCandidatesOgc(terms[0], fetchLimit).catch(() => []));

    // If that was not enough, query related nationwide FIS collections as well.
    // These are still small targeted requests; the complete catalogue is never downloaded.
    let initial = this._mergeCandidates(groups);
    let initialBest = initial.reduce((best, item) => Math.max(best, scoreBridge(item, q)), -Infinity);
    if (initial.length === 0 || initialBest < 500) {
      // The exact text may exist in the opening or ISRS-object collection even when it is not the bridge-layer name.
      if (initial.length === 0 && terms[0]) {
        const relatedExact = await this._searchRelatedSources(terms[0], fetchLimit);
        groups.push(relatedExact);
        initial = this._mergeCandidates(groups);
        initialBest = initial.reduce((best, item) => Math.max(best, scoreBridge(item, q)), -Infinity);
      }

      if (initialBest < 900) {
        const fallbackTerms = terms.slice(1, 3);
        const smart = smartFallbackTerm(query);
        if (smart && smart !== terms[0] && !fallbackTerms.includes(smart)) fallbackTerms.push(smart);

        for (const term of fallbackTerms.slice(0, 3)) {
          const [bridgeMatches, relatedMatches] = await Promise.all([
            this._searchBridgeCandidatesOgc(term, fetchLimit).catch(() => []),
            this._searchRelatedSources(term, fetchLimit),
          ]);
          groups.push(bridgeMatches, relatedMatches);
          const mergedNow = this._mergeCandidates(groups);
          const bestNow = mergedNow.reduce((best, item) => Math.max(best, scoreBridge(item, q)), -Infinity);
          if (mergedNow.length >= fetchLimit || bestNow >= 900) break;
        }
      }
    }

    let merged = this._mergeCandidates(groups);
    let bestScore = merged.reduce((best, item) => Math.max(best, scoreBridge(item, q)), -Infinity);

    // Nationwide public-name fallback. PDOK resolves common Dutch place/object names to a location;
    // we still select the actual device exclusively from Rijkswaterstaat's movable-bridge layer.
    if (merged.length === 0 || bestScore < 450) {
      const pdokMatches = await this._searchPdokFallback(query, fetchLimit);
      if (pdokMatches.length) {
        groups.push(pdokMatches);
        merged = this._mergeCandidates(groups);
        bestScore = merged.reduce((best, item) => Math.max(best, scoreBridge(item, q)), -Infinity);
      }
    }

    let candidates = merged
      .map(item => ({ ...item, score: scoreBridge(item, q) }))
      .filter(item => item.score >= 70);

    candidates = applyDirectionalBonus(candidates, q);

    const result = candidates
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(item => ({
        ...item,
        candidateId: `${item.fisId}:${item.isrsId}`,
      }));

    this._cache.set(cacheKey, { time: Date.now(), value: result });
    return result;
  }

  async resolveBridge(candidate) {
    if (!candidate || !Number.isFinite(Number(candidate.isrsId))) {
      throw new Error('Bridge has no usable FIS ISRS relation');
    }
    const resolved = await this._resolveIsrs(Number(candidate.isrsId));
    if (!resolved || !resolved.code) throw new Error('No usable ISRS code found for selected bridge');
    return {
      ...candidate,
      isrs: resolved.code,
      isrsObjectName: resolved.objectName,
      isrsFunction: resolved.function,
    };
  }
}

module.exports = {
  FisClient,
  scoreBridge,
  norm,
  compact,
  movable,
  levenshtein,
  cleanOpeningName,
  mapOgcBridgeFeature,
  mapOgcOpeningFeature,
  mapOgcIsrsFeature,
  mapArcgisIsrsFeature,
  cqlString,
  cqlContains,
  buildBridgeFilter,
  buildOpeningFilter,
  buildIsrsFilter,
  deriveSearchTerms,
  broadSearchTerm,
  smartFallbackTerm,
  directionFromQuery,
  applyDirectionalBonus,
  distanceMeters,
  ARCGIS_SERVICE,
  OGC_SERVICE,
  BRIDGE_LAYER,
  ISRS_LAYER,
  OPENING_LAYER,
};
