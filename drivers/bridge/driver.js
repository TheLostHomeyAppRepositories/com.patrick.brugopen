'use strict';
const Homey = require('homey');
const { FisClient, distanceMeters } = require('../../lib/fis_client');
const { version: APP_VERSION } = require('../../package.json');

class BridgeDriver extends Homey.Driver {
  async onInit() {
    this.log(`BridgeDriver init (v${APP_VERSION})`);
    this.fis = new FisClient();
  }

  _pairedIds() {
    return new Set(this.getDevices()
      .map(device => String((device.getData() || {}).id || '').toUpperCase())
      .filter(Boolean));
  }

  _pairedFisIsrsIds() {
    return new Set(this.getDevices()
      .map(device => Number(device.getStoreValue('fis_isrs_id')))
      .filter(Number.isFinite));
  }

  async onPair(session) {
    const sessionResults = new Map();
    const homeLocation = () => {
      try {
        const lat = Number(this.homey.geolocation.getLatitude());
        const lon = Number(this.homey.geolocation.getLongitude());
        return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
      } catch (_) { return null; }
    };
    const remember = (item, pairedFisIds, location = null) => {
      const key = String(item.candidateId || `${item.fisId}:${item.isrsId}`);
      const meters = Number.isFinite(Number(item.distanceMeters))
        ? Number(item.distanceMeters)
        : (location && Number.isFinite(item.lat) && Number.isFinite(item.lon)
          ? distanceMeters(location.lat, location.lon, item.lat, item.lon) : null);
      const result = {
        candidateId: key,
        name: item.name,
        city: item.city,
        lat: item.lat,
        lon: item.lon,
        fisId: item.fisId,
        isrsId: item.isrsId,
        distanceMeters: Number.isFinite(meters) ? Math.round(meters) : null,
        alreadyPaired: pairedFisIds.has(Number(item.isrsId)),
      };
      sessionResults.set(key, result);
      return result;
    };

    session.setHandler('search_bridges', async ({ query } = {}) => {
      const q = String(query || '').trim();
      if (q.length < 2) return [];

      try {
        const pairedFisIds = this._pairedFisIsrsIds();
        const results = await this.fis.search(q, 10);
        sessionResults.clear();

        const location = homeLocation();
        return results.map(item => remember(item, pairedFisIds, location));
      } catch (err) {
        this.error(`FIS bridge search failed for query: ${q}`, err);
        throw new Error(this.homey.__('pair.search_failed'));
      }
    });

    session.setHandler('nearby_bridges', async () => {
      const location = homeLocation();
      if (!location) throw new Error(this.homey.__('pair.location_unavailable'));
      try {
        const pairedFisIds = this._pairedFisIsrsIds();
        const results = await this.fis.nearby(location.lat, location.lon, 15);
        sessionResults.clear();
        return results.map(item => remember(item, pairedFisIds, location));
      } catch (err) {
        this.error('FIS nearby bridge search failed', err);
        throw new Error(this.homey.__('pair.nearby_failed'));
      }
    });

    session.setHandler('pair_bridge', async ({ candidateId } = {}) => {
      const key = String(candidateId || '').trim();
      const item = sessionResults.get(key);
      if (!item) throw new Error(this.homey.__('pair.missing_selection'));

      if (this._pairedFisIsrsIds().has(Number(item.isrsId))) {
        throw new Error(this.homey.__('pair.already_paired'));
      }

      let resolved;
      try {
        resolved = await this.fis.resolveBridge(item);
      } catch (err) {
        this.error(`FIS ISRS resolve failed for bridge: ${item.name}`, err);
        throw new Error(this.homey.__('pair.pair_failed'));
      }

      const code = String(resolved.isrs || '').trim().toUpperCase();
      if (!code) throw new Error(this.homey.__('pair.pair_failed'));
      if (this._pairedIds().has(code)) throw new Error(this.homey.__('pair.already_paired'));

      return {
        device: {
          name: resolved.name,
          data: { id: code },
          store: {
            isrs: code,
            bridge_name: resolved.name,
            city: resolved.city || '',
            fis_id: resolved.fisId || null,
            fis_isrs_id: resolved.isrsId || null,
            lat: Number.isFinite(resolved.lat) ? resolved.lat : null,
            lon: Number.isFinite(resolved.lon) ? resolved.lon : null,
            seen_in_ndw: false,
            missing_snapshots: 0,
          },
        },
      };
    });
  }
}

module.exports = BridgeDriver;
