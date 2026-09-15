'use strict';

const { getJson } = require('./http');

const PDOK_SEARCH_URL = 'https://api.pdok.nl/kadaster/location-api/v1/search';

function geometryCenter(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const points = [];
  const collect = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    for (const child of value) collect(child);
  };
  collect(geometry.coordinates);
  if (!points.length) return null;
  const lon = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const lat = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

class PdokClient {
  constructor(options = {}) {
    this._getJson = options.getJson || getJson;
  }

  async searchBridgeName(query, limit = 5) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const params = new URLSearchParams({
      q,
      'inrichtingselement[version]': '1',
      'inrichtingselement[relevance]': '0.35',
      limit: String(Math.min(Math.max(limit, 1), 8)),
      f: 'json',
    });
    const { json } = await this._getJson(`${PDOK_SEARCH_URL}?${params.toString()}`, {
      timeoutMs: 10000,
      maxBytes: 768 * 1024,
      headers: { Accept: 'application/geo+json, application/json;q=0.9' },
    });
    if (!json || !Array.isArray(json.features)) return [];
    return json.features.map((feature, index) => {
      const center = geometryCenter(feature.geometry);
      const p = feature.properties || {};
      if (!center) return null;
      return {
        name: String(p.display_name || p.naam || p.name || '').trim(),
        lon: center.lon,
        lat: center.lat,
        rank: index,
      };
    }).filter(item => item && item.name);
  }
}

module.exports = { PdokClient, PDOK_SEARCH_URL, geometryCenter };
