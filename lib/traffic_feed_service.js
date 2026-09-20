'use strict';

const { NdwClient } = require('./ndw_client');
const { parseTrafficFeed, bridgeQueueImpact, trackedQueueImpact } = require('./datex_traffic_parser');

const TRAFFIC_FEED_URL = 'https://opendata.ndw.nu/actueel_beeld.xml.gz';
const TRAFFIC_POLL_MS = 30 * 1000;
const TRAFFIC_MONITOR_CHECK_MS = 5 * 1000;
const TRAFFIC_CLOSE_GRACE_MS = 90 * 1000;
const TRAFFIC_OPERATION_TIMEOUT_MS = 50 * 1000;

class TrafficFeedService {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.client = options.client || new NdwClient({ feedUrl: TRAFFIC_FEED_URL, maxBytes: 20 * 1024 * 1024 });
    this.devices = new Set();
    this.pollTimer = null;
    this.monitorTimer = null;
    this.kickTimer = null;
    this.inFlight = null;
    this.generation = 0;
    this.stopped = false;
    this.active = false;
    this.lastFeed = null;
    this.lastSuccessAt = '';
    this.lastError = '';
    this.tracking = new Map();
  }
  _setTimeout(fn, delay) {
    return this.homey && typeof this.homey.setTimeout === 'function' ? this.homey.setTimeout(fn, delay) : setTimeout(fn, delay);
  }
  _clearTimeout(timer) {
    if (!timer) return;
    if (this.homey && typeof this.homey.clearTimeout === 'function') this.homey.clearTimeout(timer);
    else clearTimeout(timer);
  }
  _setInterval(fn, delay) {
    return this.homey && typeof this.homey.setInterval === 'function' ? this.homey.setInterval(fn, delay) : setInterval(fn, delay);
  }
  _clearInterval(timer) {
    if (!timer) return;
    if (this.homey && typeof this.homey.clearInterval === 'function') this.homey.clearInterval(timer);
    else clearInterval(timer);
  }
  start() {
    this.stopped = false;
    this.monitorTimer = this._setInterval(() => this.updateMonitoring({ kick: false }), TRAFFIC_MONITOR_CHECK_MS);
  }
  stop() {
    this.stopped = true;
    this.active = false;
    this._clearInterval(this.pollTimer);
    this._clearInterval(this.monitorTimer);
    this._clearTimeout(this.kickTimer);
    this.pollTimer = null;
    this.monitorTimer = null;
    this.kickTimer = null;
  }
  register(device) {
    this.devices.add(device);
    // One coalesced initial snapshot keeps the hidden traffic state synchronized after app/device startup.
    // Continuous traffic polling is enabled only when a followed bridge is open or has bridge-related queue aftermath.
    this._kick(1200, true);
    this.updateMonitoring({ kick: false });
  }
  unregister(device) {
    this.devices.delete(device);
    this.tracking.delete(this._deviceKey(device));
    this.updateMonitoring({ kick: false });
  }
  _kick(delay = 0, force = false) {
    if (this.stopped) return;
    if (!force && !this.active) return;
    this._clearTimeout(this.kickTimer);
    this.kickTimer = this._setTimeout(() => {
      this.kickTimer = null;
      this.refresh({ force }).catch(() => {});
    }, delay);
  }
  _withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this._setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => this._clearTimeout(timer));
  }
  _deviceKey(device) {
    try { return String((device.getData() || {}).id || device.getName() || ''); } catch (_) { return ''; }
  }
  _deviceNeedsMonitoring(device, now = Date.now()) {
    if (!device || typeof device.getBridgeMeta !== 'function') return false;
    let meta;
    try { meta = device.getBridgeMeta() || {}; } catch (_) { return false; }
    const key = this._deviceKey(device);
    if (String(meta.status || 'unknown') === 'open') return true;
    if (this.tracking.has(key)) return true;
    try {
      const trafficStatus = String(device.getCapabilityValue('bridge_traffic_status') || 'unknown');
      if (trafficStatus === 'queue' || trafficStatus === 'residual') return true;
    } catch (_) {}
    const closedAt = Date.parse(String(meta.lastClosedAt || ''));
    return Number.isFinite(closedAt) && now >= closedAt && now - closedAt <= TRAFFIC_CLOSE_GRACE_MS;
  }
  _needsMonitoring() {
    const now = Date.now();
    return [...this.devices].some(device => this._deviceNeedsMonitoring(device, now));
  }
  _startActivePolling(kick = true) {
    if (this.stopped) return;
    this.active = true;
    if (!this.pollTimer) {
      this.pollTimer = this._setInterval(() => this.refresh({ force: false }).catch(() => {}), TRAFFIC_POLL_MS);
    }
    if (kick) this._kick(0, false);
  }
  _stopActivePolling() {
    this.active = false;
    this._clearInterval(this.pollTimer);
    this.pollTimer = null;
    this._clearTimeout(this.kickTimer);
    this.kickTimer = null;
  }
  updateMonitoring(options = {}) {
    if (this.stopped) return false;
    const shouldMonitor = this._needsMonitoring();
    if (shouldMonitor) this._startActivePolling(options.kick !== false);
    else if (this.active || this.pollTimer) this._stopActivePolling();
    return shouldMonitor;
  }
  getDiagnostics() {
    return {
      url: TRAFFIC_FEED_URL,
      pollMs: TRAFFIC_POLL_MS,
      active: this.active,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      deviceCount: this.devices.size,
      trackedBridgeQueues: this.tracking.size,
      mode: 'bridge-opening-caused-queues-only-dynamic',
    };
  }
  async refresh(options = {}) {
    const force = options.force !== false;
    if (!this.devices.size) return { skipped: true };
    if (!force && !this.active) return { skipped: true, inactive: true };
    if (this.inFlight) return this.inFlight;
    const generation = ++this.generation;
    const run = this._withTimeout(this._refresh(generation), TRAFFIC_OPERATION_TIMEOUT_MS, 'NDW traffic refresh');
    this.inFlight = run;
    try { return await run; }
    finally { if (this.inFlight === run) this.inFlight = null; }
  }
  _stateFor(device, parsed) {
    const key = this._deviceKey(device);
    const meta = device.getBridgeMeta();
    const direct = bridgeQueueImpact(parsed, meta, 0.5);
    let impact = direct;
    let tracked = this.tracking.get(key) || null;

    if (direct.matched) {
      tracked = {
        recordIds: direct.records.map(r => r.recordId).filter(Boolean),
        situationIds: [...new Set(direct.records.map(r => r.situationId).filter(Boolean))],
        firstSeenAt: tracked && tracked.firstSeenAt ? tracked.firstSeenAt : new Date().toISOString(),
      };
      this.tracking.set(key, tracked);
    } else if (tracked) {
      const stillThere = trackedQueueImpact(parsed, tracked);
      if (stillThere.matched) impact = stillThere;
      else {
        this.tracking.delete(key);
        tracked = null;
      }
    }

    const bridgeStatus = String(meta.status || 'unknown');
    if (!impact.matched) {
      return {
        status: 'clear',
        summary: 'Geen file door brugopening',
        queueLengthMeters: 0,
        delaySeconds: 0,
        aftermathSeconds: 0,
        road: '',
        records: [],
      };
    }

    const residual = bridgeStatus !== 'open';
    const closedAt = Date.parse(String(meta.lastClosedAt || ''));
    const aftermathSeconds = residual && Number.isFinite(closedAt) ? Math.max(0, Math.floor((Date.now() - closedAt) / 1000)) : 0;
    const km = Number(impact.queueLength || 0) / 1000;
    const lengthText = impact.queueLength >= 1000
      ? `${km.toFixed(1).replace('.', ',')} km`
      : `${Math.round(impact.queueLength)} m`;
    const road = impact.road ? ` · ${impact.road}` : '';
    return {
      status: residual ? 'residual' : 'queue',
      summary: residual
        ? `Brug dicht · file door vorige opening loopt nog terug${road} · ${lengthText}`
        : `File door brugopening${road} · ${lengthText}`,
      queueLengthMeters: Number(impact.queueLength || 0),
      delaySeconds: Number(impact.delaySeconds || 0),
      aftermathSeconds,
      road: impact.road || '',
      records: impact.records || [],
      evidence: (impact.records && impact.records[0] && impact.records[0].evidence) || (direct.matched ? 'direct' : 'tracked'),
      trackedSince: tracked && tracked.firstSeenAt ? tracked.firstSeenAt : '',
    };
  }
  async _apply(parsed) {
    await Promise.all([...this.devices].map(async device => {
      if (!device || typeof device.getBridgeMeta !== 'function' || typeof device.onTrafficState !== 'function') return;
      const result = this._stateFor(device, parsed);
      await device.onTrafficState({ ...result, publicationTime: parsed.publicationTime, checkedAt: new Date().toISOString() });
    }));
  }
  async _refresh(generation = this.generation) {
    try {
      const fetched = await this.client.fetch();
      if (generation !== this.generation) return { superseded: true };
      if (fetched.changed) this.lastFeed = parseTrafficFeed(fetched.xml);
      if (!this.lastFeed) return { changed: false, waiting: true };
      await this._apply(this.lastFeed);
      this.lastSuccessAt = new Date().toISOString(); this.lastError = '';
      this.updateMonitoring({ kick: false });
      return { changed: fetched.changed, queueCount: this.lastFeed.queues.length, bridgeRecordCount: this.lastFeed.bridges.length, active: this.active };
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      await Promise.all([...this.devices].map(d => typeof d.onTrafficError === 'function' ? d.onTrafficError(err) : null));
      if (this.homey && this.homey.app && typeof this.homey.app.error === 'function') this.homey.app.error('NDW bridge-impact feed failed', err);
      throw err;
    }
  }
}

module.exports = {
  TrafficFeedService,
  TRAFFIC_FEED_URL,
  TRAFFIC_POLL_MS,
  TRAFFIC_MONITOR_CHECK_MS,
  TRAFFIC_CLOSE_GRACE_MS,
};
