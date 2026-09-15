'use strict';

const { getJson } = require('./http');

const ARCGIS_SERVICE = 'https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/fis_vnds/FeatureServer';
const OGC_SERVICE = 'https://geo.rijkswaterstaat.nl/services/ogc/gdr/fis_vnds/ogc/features/v1';
const BRIDGE_LAYER = 3;
const ISRS_LAYER = 9;
const SEARCH_CACHE_MS = 10 * 60 * 1000;

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function movable(value) {
  return ['true', '1', 'yes', 'ja'].includes(norm(value));
}

function levenshtein(a, b) {
  a = norm(a).slice(0, 80);
  b = norm(b).slice(0, 80);
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

function scoreBridge(bridge, query) {
  const q = norm(query);
  if (!q) return -Infinity;
  const name = norm(bridge.name);
  const city = norm(bridge.city);
  let score = 0;

  if (name === q) score += 1200;
  else if (name.startsWith(q)) score += 950;
  else if (name.includes(q)) score += 760;

  if (city === q) score += 600;
  else if (city.startsWith(q)) score += 450;
  else if (city.includes(q)) score += 350;

  const tokens = q.split(' ').filter(Boolean);
  for (const token of tokens) {
    if (name.split(' ').some(word => word.startsWith(token))) score += 120;
    else if (name.includes(token)) score += 80;
    if (city.includes(token)) score += 40;
  }

  const distance = levenshtein(q, name);
  const span = Math.max(q.length, name.length, 1);
  score += Math.max(0, 180 * (1 - distance / span));
  return score;
}

function mapOgcBridgeFeature(feature) {
  const p = feature.properties || {};
  const coordinates = feature.geometry && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates
    : [];
  return {
    fisId: p.id,
    name: String(p.name || '').trim(),
    city: String(p.city || '').trim(),
    isrsId: Number(p.isrsid),
    canOpen: p.canopen,
    remote: p.isremotecontrolled,
    openings: Number(p.numberofopenings || 0),
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    source: 'bridge-layer',
  };
}

function mapOgcIsrsFeature(feature) {
  const p = feature.properties || {};
  return {
    id: Number(p.id),
    code: String(p.code || '').trim().toUpperCase(),
    objectName: String(p.objectname || '').trim(),
    function: String(p.function || '').trim(),
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
  return `canopen = 'Yes' AND (${cqlContains('name', value)} OR ${cqlContains('city', value)})`;
}

function broadSearchTerm(value) {
  const cleaned = norm(value).replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 5) return '';
  const token = cleaned.split(' ').sort((a, b) => b.length - a.length)[0] || '';
  return token.length >= 5 ? token.slice(0, Math.min(5, token.length)) : '';
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
    this._cache = new Map();
  }

  async _searchBridgeCandidatesOgc(query, limit = 40) {
    const params = new URLSearchParams({
      limit: String(Math.min(Math.max(limit, 10), 50)),
      filter: buildBridgeFilter(query),
      'filter-lang': 'cql2-text',
    });
    const url = `${OGC_SERVICE}/collections/brug/items?${params.toString()}`;
    const { json } = await this._getJson(url, {
      timeoutMs: 15000,
      maxBytes: 2 * 1024 * 1024,
      headers: { Accept: 'application/geo+json, application/json;q=0.9' },
    });
    if (!json || !Array.isArray(json.features)) {
      throw new Error('FIS OGC bridge response is not a FeatureCollection');
    }
    return json.features
      .map(mapOgcBridgeFeature)
      .filter(item => item.name && Number.isFinite(item.isrsId) && movable(item.canOpen));
  }

  async _resolveIsrsOgc(isrsId) {
    const params = new URLSearchParams({
      limit: '5',
      filter: `id = ${Number(isrsId)}`,
      'filter-lang': 'cql2-text',
    });
    const url = `${OGC_SERVICE}/collections/isrs_object/items?${params.toString()}`;
    const { json } = await this._getJson(url, {
      timeoutMs: 12000,
      maxBytes: 512 * 1024,
      headers: { Accept: 'application/geo+json, application/json;q=0.9' },
    });
    if (!json || !Array.isArray(json.features)) {
      throw new Error('FIS OGC ISRS response is not a FeatureCollection');
    }
    for (const feature of json.features) {
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
    let candidates = await this._searchBridgeCandidatesOgc(query, fetchLimit);

    // If a typo prevents a full substring match, perform one bounded prefix request.
    // We still never download the complete bridge catalogue.
    if (candidates.length === 0) {
      const broad = broadSearchTerm(query);
      if (broad && norm(broad) !== q) {
        const extra = await this._searchBridgeCandidatesOgc(broad, fetchLimit);
        const byId = new Map(candidates.map(item => [String(item.fisId), item]));
        for (const item of extra) if (!byId.has(String(item.fisId))) byId.set(String(item.fisId), item);
        candidates = [...byId.values()];
      }
    }

    const result = candidates
      .map(item => ({ ...item, score: scoreBridge(item, q) }))
      .filter(item => item.score >= 80)
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
  movable,
  levenshtein,
  mapOgcBridgeFeature,
  mapOgcIsrsFeature,
  mapArcgisIsrsFeature,
  cqlString,
  cqlContains,
  buildBridgeFilter,
  broadSearchTerm,
  ARCGIS_SERVICE,
  OGC_SERVICE,
  BRIDGE_LAYER,
  ISRS_LAYER,
};
