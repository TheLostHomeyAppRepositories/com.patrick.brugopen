'use strict';
const Homey = require('homey');
const { BridgeFeedService } = require('./lib/bridge_feed_service');
const { TrafficFeedService } = require('./lib/traffic_feed_service');
const { FisClient } = require('./lib/fis_client');
const { version: APP_VERSION } = require('./package.json');

class BrugOpenApp extends Homey.App {
  async onInit() {
    this.log(`Brug Open app started (v${APP_VERSION})`);
    this._bridgeDevices = new Map();
    this._routeDevices = new Set();
    this._dashboardEventTimer = null;
    this.fis = new FisClient();
    try { await this.homey.settings.unset('euris_token'); } catch (_) {}

    this._registerTriggerCards();
    this._registerConditionCards();
    this._registerActionCards();

    this.bridgeFeed = new BridgeFeedService(this.homey);
    this.trafficFeed = new TrafficFeedService(this.homey);
    this.bridgeFeed.start();
    this.trafficFeed.start();
  }

  async onUninit() {
    if (this._dashboardEventTimer) {
      if (this.homey && typeof this.homey.clearTimeout === 'function') this.homey.clearTimeout(this._dashboardEventTimer);
      else clearTimeout(this._dashboardEventTimer);
    }
    if (this.bridgeFeed) this.bridgeFeed.stop();
    if (this.trafficFeed) this.trafficFeed.stop();
  }

  _requireDevice(args) {
    if (!args || !args.route_a) throw new Error(this.homey.__('errors.no_device'));
    return args.route_a;
  }

  _minutesArg(args) {
    const value = Number(args && args.minutes);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  _registerTriggerCards() {
    this._triggerCards = {};
    const simple = [
      'bridge_opened', 'bridge_closed', 'bridge_planned', 'bridge_status_changed',
      'bridge_planned_changed', 'bridge_planned_cancelled',
      'bridge_queue_started', 'bridge_queue_residual', 'bridge_queue_recovered',
      'route_blocked', 'route_cleared', 'route_planned', 'route_status_changed',
      'route_planned_changed', 'route_planned_cancelled',
      'route_traffic_changed', 'route_traffic_delay', 'route_traffic_recovered', 'route_queue_residual',
    ];
    for (const id of simple) {
      const card = this.homey.flow.getDeviceTriggerCard(id);
      card.registerRunListener(async () => true);
      this._triggerCards[id] = card;
    }

    const openLonger = this.homey.flow.getDeviceTriggerCard('bridge_open_longer_than');
    openLonger.registerRunListener(async (args, state) => {
      const threshold = this._minutesArg(args) * 60;
      const previous = Number(state && state.previous_seconds);
      const current = Number(state && state.current_seconds);
      return Number.isFinite(previous) && Number.isFinite(current) && previous < threshold && current >= threshold;
    });
    this._triggerCards.bridge_open_longer_than = openLonger;

    const plannedWithin = this.homey.flow.getDeviceTriggerCard('bridge_planned_within');
    plannedWithin.registerRunListener(async (args, state) => {
      const threshold = this._minutesArg(args) * 60;
      const previous = Number(state && state.previous_seconds);
      const current = Number(state && state.current_seconds);
      return Number.isFinite(previous) && Number.isFinite(current) && current >= 0 && previous > threshold && current <= threshold;
    });
    this._triggerCards.bridge_planned_within = plannedWithin;

    const dataStale = this.homey.flow.getDeviceTriggerCard('bridge_data_stale');
    dataStale.registerRunListener(async (args, state) => {
      const threshold = this._minutesArg(args) * 60;
      const previous = Number(state && state.previous_seconds);
      const current = Number(state && state.current_seconds);
      return Number.isFinite(previous) && Number.isFinite(current) && previous < threshold && current >= threshold;
    });
    this._triggerCards.bridge_data_stale = dataStale;

    const bridgeQueueLonger = this.homey.flow.getDeviceTriggerCard('bridge_queue_longer_than');
    bridgeQueueLonger.registerRunListener(async (args, state) => {
      const threshold = Math.max(0.1, Number(args && args.kilometers) || 0.1) * 1000;
      const previous = Number(state && state.previous_meters);
      const current = Number(state && state.current_meters);
      return Number.isFinite(previous) && Number.isFinite(current) && previous < threshold && current >= threshold;
    });
    this._triggerCards.bridge_queue_longer_than = bridgeQueueLonger;

    const bridgeAftermath = this.homey.flow.getDeviceTriggerCard('bridge_aftermath_longer_than');
    bridgeAftermath.registerRunListener(async (args, state) => {
      const threshold = this._minutesArg(args) * 60;
      const previous = Number(state && state.previous_seconds);
      const current = Number(state && state.current_seconds);
      return Number.isFinite(previous) && Number.isFinite(current) && previous < threshold && current >= threshold;
    });
    this._triggerCards.bridge_aftermath_longer_than = bridgeAftermath;

    const routeQueueLonger = this.homey.flow.getDeviceTriggerCard('route_queue_longer_than');
    routeQueueLonger.registerRunListener(async (args, state) => {
      const threshold = Math.max(0.1, Number(args && args.kilometers) || 0.1) * 1000;
      const previous = Number(state && state.previous_meters);
      const current = Number(state && state.current_meters);
      return Number.isFinite(previous) && Number.isFinite(current) && previous < threshold && current >= threshold;
    });
    this._triggerCards.route_queue_longer_than = routeQueueLonger;

    const routeAftermath = this.homey.flow.getDeviceTriggerCard('route_aftermath_longer_than');
    routeAftermath.registerRunListener(async (args, state) => {
      const threshold = this._minutesArg(args) * 60;
      const previous = Number(state && state.previous_seconds);
      const current = Number(state && state.current_seconds);
      return Number.isFinite(previous) && Number.isFinite(current) && previous < threshold && current >= threshold;
    });
    this._triggerCards.route_aftermath_longer_than = routeAftermath;
  }

  _registerConditionCards() {
    const bridgeStatus = args => String(this._requireDevice(args).getCapabilityValue('bridge_status') || 'unknown');
    this.homey.flow.getConditionCard('bridge_is_open').registerRunListener(async args => bridgeStatus(args) === 'open');
    this.homey.flow.getConditionCard('bridge_is_closed').registerRunListener(async args => bridgeStatus(args) === 'closed');
    this.homey.flow.getConditionCard('bridge_is_planned').registerRunListener(async args => bridgeStatus(args) === 'planned');
    this.homey.flow.getConditionCard('bridge_status_is').registerRunListener(async args => bridgeStatus(args) === String(args.status || 'unknown'));
    this.homey.flow.getConditionCard('bridge_has_opening_queue').registerRunListener(async args => ['queue','residual'].includes(String(this._requireDevice(args).getCapabilityValue('bridge_traffic_status') || 'unknown')));
    this.homey.flow.getConditionCard('bridge_has_residual_queue').registerRunListener(async args => String(this._requireDevice(args).getCapabilityValue('bridge_traffic_status') || 'unknown') === 'residual');
    this.homey.flow.getConditionCard('bridge_queue_length_above').registerRunListener(async args => Number(this._requireDevice(args).getCapabilityValue('bridge_queue_length') || 0) >= Math.max(0.1, Number(args.kilometers) || 0.1));

    const routeStatus = args => String(this._requireDevice(args).getCapabilityValue('route_status') || 'unknown');
    this.homey.flow.getConditionCard('route_is_free').registerRunListener(async args => ['free', 'announced'].includes(routeStatus(args)));
    this.homey.flow.getConditionCard('route_is_blocked').registerRunListener(async args => routeStatus(args) === 'blocked');
    this.homey.flow.getConditionCard('route_has_planned').registerRunListener(async args => Number(this._requireDevice(args).getCapabilityValue('route_announced_count') || 0) > 0);
    this.homey.flow.getConditionCard('route_status_is').registerRunListener(async args => routeStatus(args) === String(args.status || 'unknown'));
    this.homey.flow.getConditionCard('route_has_traffic_delay').registerRunListener(async args => ['queue','residual'].includes(String(this._requireDevice(args).getCapabilityValue('route_traffic_status') || 'unknown')));
    this.homey.flow.getConditionCard('route_has_residual_queue').registerRunListener(async args => String(this._requireDevice(args).getCapabilityValue('route_traffic_status') || 'unknown') === 'residual');
    this.homey.flow.getConditionCard('route_queue_length_above').registerRunListener(async args => Number(this._requireDevice(args).getCapabilityValue('route_queue_length') || 0) >= Math.max(0.1, Number(args.kilometers) || 0.1));
    this.homey.flow.getConditionCard('route_is_road_clear').registerRunListener(async args => {
      const route = this._requireDevice(args);
      const status = String(route.getCapabilityValue('route_status') || 'unknown');
      const traffic = String(route.getCapabilityValue('route_traffic_status') || 'unknown');
      return ['free', 'announced'].includes(status) && traffic === 'clear';
    });
  }

  _registerActionCards() {
    this.homey.flow.getActionCard('refresh_bridge_status').registerRunListener(async args => {
      this._requireDevice(args);
      return this.refreshBridgeData();
    });

    this.homey.flow.getActionCard('scan_route').registerRunListener(async args => {
      const route = this._requireDevice(args);
      if (typeof route.refreshRoute === 'function') await route.refreshRoute();
      if (typeof route.getDepartureScanResult !== 'function') throw new Error(this.homey.__('errors.route_scan_failed'));
      return route.getDepartureScanResult();
    });

    this.homey.flow.getActionCard('check_bridge_impact').registerRunListener(async args => {
      const bridge = this._requireDevice(args);
      if (this.trafficFeed) await this.trafficFeed.refresh();
      const status = String(bridge.getCapabilityValue('bridge_traffic_status') || 'unknown');
      const queueKm = Number(bridge.getCapabilityValue('bridge_queue_length') || 0);
      const aftermathSeconds = Number(bridge.getStoreValue('impact_aftermath_seconds') || 0);
      return {
        bridge_name: bridge.getName(),
        impact_status: this.homey.__(`traffic_status.${status}`),
        impact_status_id: status,
        queue_length_km: queueKm,
        queue_length_meters: Math.round(queueKm * 1000),
        aftermath_duration: String(bridge.getCapabilityValue('bridge_aftermath_duration') || '—'),
        aftermath_seconds: aftermathSeconds,
        road: String(bridge.getStoreValue('impact_road') || ''),
        summary: String(bridge.getCapabilityValue('bridge_traffic_summary') || '—'),
      };
    });

    this.homey.flow.getActionCard('compare_routes').registerRunListener(async args => {
      const routeA = args && args.route_a;
      const routeB = args && args.route_b;
      if (!routeA || !routeB || typeof routeA.getDepartureScanResult !== 'function' || typeof routeB.getDepartureScanResult !== 'function') {
        throw new Error(this.homey.__('errors.route_compare_failed'));
      }
      if (typeof routeA.refreshRoute === 'function') await routeA.refreshRoute();
      if (typeof routeB.refreshRoute === 'function') await routeB.refreshRoute();
      const a = await routeA.getDepartureScanResult();
      const b = await routeB.getDepartureScanResult();
      const aText = `${routeA.getName()}: ${a.route_status} · ${a.traffic_status}`;
      const bText = `${routeB.getName()}: ${b.route_status} · ${b.traffic_status}`;
      return {
        route_a_name: routeA.getName(),
        route_a_status: a.route_status,
        route_a_status_id: a.route_status_id,
        route_a_traffic: a.traffic_status,
        route_a_traffic_id: a.traffic_status_id,
        route_a_open_bridges: Number(a.open_bridge_count || 0),
        route_a_blockages_today: Number(routeA.getCapabilityValue('route_blockages_today') || 0),
        route_a_queue_length_km: Number(routeA.getCapabilityValue('route_queue_length') || 0),
        route_a_aftermath: String(routeA.getCapabilityValue('route_aftermath_duration') || '—'),
        route_b_name: routeB.getName(),
        route_b_status: b.route_status,
        route_b_status_id: b.route_status_id,
        route_b_traffic: b.traffic_status,
        route_b_traffic_id: b.traffic_status_id,
        route_b_open_bridges: Number(b.open_bridge_count || 0),
        route_b_blockages_today: Number(routeB.getCapabilityValue('route_blockages_today') || 0),
        route_b_queue_length_km: Number(routeB.getCapabilityValue('route_queue_length') || 0),
        route_b_aftermath: String(routeB.getCapabilityValue('route_aftermath_duration') || '—'),
        comparison_summary: `${aText} | ${bText}`,
      };
    });
  }

  registerBridgeDevice(device) {
    if (!this._bridgeDevices) this._bridgeDevices = new Map();
    const id = String((device.getData() || {}).id || '').toUpperCase();
    if (id) this._bridgeDevices.set(id, device);
    if (this.bridgeFeed) this.bridgeFeed.register(device);
    if (this.trafficFeed) this.trafficFeed.register(device);
    this.notifyRoutes();
    this.emitDashboardChanged();
  }

  unregisterBridgeDevice(device) {
    const id = String((device.getData() || {}).id || '').toUpperCase();
    if (this._bridgeDevices && id) this._bridgeDevices.delete(id);
    if (this.bridgeFeed) this.bridgeFeed.unregister(device);
    if (this.trafficFeed) this.trafficFeed.unregister(device);
    this.notifyRoutes();
    this.emitDashboardChanged();
  }

  getBridgeDevices() {
    return this._bridgeDevices ? [...this._bridgeDevices.values()] : [];
  }

  registerRouteDevice(device) {
    if (!this._routeDevices) this._routeDevices = new Set();
    this._routeDevices.add(device);
    this.emitDashboardChanged();
  }

  unregisterRouteDevice(device) {
    if (this._routeDevices) this._routeDevices.delete(device);
    this.emitDashboardChanged();
  }

  getRouteDevices() {
    return this._routeDevices ? [...this._routeDevices.values()] : [];
  }

  notifyTrafficMonitoring() {
    if (!this.trafficFeed || typeof this.trafficFeed.updateMonitoring !== 'function') return;
    try { this.trafficFeed.updateMonitoring({ kick: true }); }
    catch (err) { if (typeof this.error === 'function') this.error('Traffic monitoring update failed', err); }
  }

  notifyRoutes() {
    if (!this._routeDevices) return;
    for (const device of this._routeDevices) {
      if (!device || typeof device.refreshRoute !== 'function') continue;
      Promise.resolve().then(() => device.refreshRoute()).catch(err => {
        if (typeof this.error === 'function') this.error('Route refresh failed', err);
      });
    }
    this.emitDashboardChanged();
  }

  emitDashboardChanged() {
    if (this._dashboardEventTimer) return;
    const schedule = this.homey && typeof this.homey.setTimeout === 'function' ? this.homey.setTimeout.bind(this.homey) : setTimeout;
    this._dashboardEventTimer = schedule(() => {
      this._dashboardEventTimer = null;
      if (this.homey && this.homey.api && typeof this.homey.api.realtime === 'function') {
        this.homey.api.realtime('dashboard_changed', { at: new Date().toISOString() }).catch(() => {});
      }
    }, 400);
  }

  async refreshBridgeData() {
    if (!this.bridgeFeed) throw new Error(this.homey.__('errors.refresh_failed'));
    return this.bridgeFeed.refresh();
  }

  async refreshEverything() {
    const result = {};
    const calls = [
      ['bridge', this.bridgeFeed && (() => this.bridgeFeed.refresh())],
      ['traffic', this.trafficFeed && (() => this.trafficFeed.refresh())],
    ].filter(([, fn]) => typeof fn === 'function');
    await Promise.all(calls.map(async ([key, fn]) => {
      try { result[key] = await fn(); }
      catch (err) { result[key] = { error: err && err.message ? err.message : String(err) }; }
    }));
    await Promise.all(this.getRouteDevices().map(route => typeof route.refreshRoute === 'function' ? route.refreshRoute().catch(() => null) : null));
    this.emitDashboardChanged();
    return result;
  }

  getHomeLocation() {
    try {
      const lat = Number(this.homey.geolocation.getLatitude());
      const lon = Number(this.homey.geolocation.getLongitude());
      const accuracy = Number(this.homey.geolocation.getAccuracy());
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : null };
    } catch (_) {}
    return null;
  }

  async getNearbyBridges(limit = 12) {
    const location = this.getHomeLocation();
    if (!location) throw new Error(this.homey.__('errors.location_unavailable'));
    return this.fis.nearby(location.lat, location.lon, Number(limit) || 12);
  }

  _cap(device, id, fallback = null) {
    try {
      const value = device.getCapabilityValue(id);
      return value === null || typeof value === 'undefined' ? fallback : value;
    } catch (_) { return fallback; }
  }

  async getDashboardSnapshot() {
    const bridges = await Promise.all(this.getBridgeDevices().map(async device => {
      const meta = typeof device.getBridgeMeta === 'function' ? device.getBridgeMeta() : {};
      return {
        id: String((device.getData() || {}).id || ''),
        name: device.getName(),
        city: String(device.getStoreValue('city') || ''),
        meta,
        status: this._cap(device, 'bridge_status', 'unknown'),
        openState: this._cap(device, 'bridge_open_state', 'unknown'),
        nextOpening: this._cap(device, 'bridge_next_opening', '—'),
        openSince: this._cap(device, 'bridge_open_since', '—'),
        openDuration: this._cap(device, 'bridge_open_duration', '—'),
        dataStatus: this._cap(device, 'bridge_data_status', 'unknown'),
        trafficStatus: this._cap(device, 'bridge_traffic_status', 'unknown'),
        trafficSummary: this._cap(device, 'bridge_traffic_summary', '—'),
        queueLengthKm: this._cap(device, 'bridge_queue_length', 0),
        aftermathDuration: this._cap(device, 'bridge_aftermath_duration', '—'),
        history: typeof device.getHistorySnapshot === 'function' ? device.getHistorySnapshot() : null,
      };
    }));

    const routes = await Promise.all(this.getRouteDevices().map(async device => ({
      id: String((device.getData() || {}).id || ''),
      name: device.getName(),
      bridgeIds: typeof device.getBridgeIds === 'function' ? device.getBridgeIds() : [],
      status: this._cap(device, 'route_status', 'unknown'),
      problemBridge: this._cap(device, 'route_problem_bridge', '—'),
      nextOpening: this._cap(device, 'route_next_opening', '—'),
      summary: this._cap(device, 'route_summary', '—'),
      trafficStatus: this._cap(device, 'route_traffic_status', 'unknown'),
      trafficSummary: this._cap(device, 'route_traffic_summary', '—'),
      queueLengthKm: this._cap(device, 'route_queue_length', 0),
      aftermathDuration: this._cap(device, 'route_aftermath_duration', '—'),
      blockagesToday: this._cap(device, 'route_blockages_today', 0),
      blockedTimeToday: this._cap(device, 'route_blocked_time_today', '0 sec'),
      history: typeof device.getHistorySnapshot === 'function' ? device.getHistorySnapshot() : null,
    })));

    return {
      version: APP_VERSION,
      generatedAt: new Date().toISOString(),
      bridges,
      routes,
      location: this.getHomeLocation(),
      diagnostics: {
        bridgeFeed: this.bridgeFeed && typeof this.bridgeFeed.getDiagnostics === 'function' ? this.bridgeFeed.getDiagnostics() : null,
        trafficFeed: this.trafficFeed && typeof this.trafficFeed.getDiagnostics === 'function' ? this.trafficFeed.getDiagnostics() : null,
      },
    };
  }

  async updateRoute(routeId, body = {}) {
    const route = this.getRouteDevices().find(device => String((device.getData() || {}).id || '') === String(routeId || ''));
    if (!route) throw new Error(this.homey.__('errors.route_not_found'));
    const ids = [...new Set((Array.isArray(body.bridgeIds) ? body.bridgeIds : []).map(id => String(id || '').trim().toUpperCase()).filter(Boolean))];
    if (!ids.length) throw new Error(this.homey.__('route_pair.bridge_required'));
    const available = new Map(this.getBridgeDevices().map(device => [String((device.getData() || {}).id || '').toUpperCase(), device]));
    const missing = ids.filter(id => !available.has(id));
    if (missing.length) throw new Error(`${this.homey.__('route_pair.bridge_missing')} (${missing.join(', ')})`);
    const names = ids.map(id => available.get(id).getName());
    if (typeof route.setBridgeIds !== 'function') throw new Error(this.homey.__('errors.route_update_failed'));
    await route.setBridgeIds(ids, names);
    this.emitDashboardChanged();
    return { ok: true, id: routeId, bridgeIds: ids, bridgeNames: names };
  }

  async _trigger(id, device, tokens = {}, state = {}) {
    const card = this._triggerCards && this._triggerCards[id];
    if (!card) return false;
    const result = await card.trigger(device, tokens, state);
    this.emitDashboardChanged();
    return result;
  }

  async triggerBridge(id, device, tokens = {}, state = {}) {
    return this._trigger(id, device, tokens, state);
  }

  async triggerRoute(id, device, tokens = {}, state = {}) {
    return this._trigger(id, device, tokens, state);
  }
}

module.exports = BrugOpenApp;
