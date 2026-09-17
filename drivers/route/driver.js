'use strict';
const Homey = require('homey');
const crypto = require('crypto');
const { version: APP_VERSION } = require('../../package.json');

class RouteDriver extends Homey.Driver {
  async onInit() {
    this.log(`RouteDriver init (v${APP_VERSION})`);
  }

  _bridgeDevices() {
    if (this.homey.app && typeof this.homey.app.getBridgeDevices === 'function') {
      return this.homey.app.getBridgeDevices();
    }
    try {
      const driver = this.homey.drivers.getDriver('bridge');
      return driver ? driver.getDevices() : [];
    } catch (_) {
      return [];
    }
  }

  _routeDevices() {
    return this.getDevices ? this.getDevices() : [];
  }

  async onPair(session) {
    session.setHandler('list_bridges', async () => this._bridgeDevices().map(device => ({
      id: String((device.getData() || {}).id || '').toUpperCase(),
      name: device.getName(),
      city: String(device.getStoreValue('city') || ''),
    })).filter(item => item.id));

    session.setHandler('pair_route', async ({ name, bridgeIds } = {}) => {
      const routeName = String(name || '').trim();
      const ids = [...new Set((Array.isArray(bridgeIds) ? bridgeIds : [])
        .map(id => String(id || '').trim().toUpperCase()).filter(Boolean))];
      if (!routeName) throw new Error(this.homey.__('route_pair.name_required'));
      if (!ids.length) throw new Error(this.homey.__('route_pair.bridge_required'));

      const available = new Map(this._bridgeDevices().map(device => [String((device.getData() || {}).id || '').toUpperCase(), device]));
      const missing = ids.filter(id => !available.has(id));
      if (missing.length) throw new Error(this.homey.__('route_pair.bridge_missing'));

      const key = `${routeName.toLocaleLowerCase()}|${[...ids].sort().join('|')}`;
      const routeId = `route-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}`;
      if (this._routeDevices().some(device => String((device.getData() || {}).id || '') === routeId)) {
        throw new Error(this.homey.__('route_pair.already_exists'));
      }

      return {
        device: {
          name: routeName,
          data: { id: routeId },
          store: {
            bridge_ids: ids,
            bridge_names: ids.map(id => available.get(id).getName()),
          },
        },
      };
    });
  }
}

module.exports = RouteDriver;
