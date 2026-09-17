'use strict';

const { NdwClient } = require('./ndw_client');
const { parseTrafficFeed, bridgeQueueImpact, trackedQueueImpact } = require('./datex_traffic_parser');

const TRAFFIC_FEED_URL = 'https://opendata.ndw.nu/actueel_beeld.xml.gz';
const TRAFFIC_POLL_MS = 30 * 1000;

class TrafficFeedService {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.client = options.client || new NdwClient({ feedUrl: TRAFFIC_FEED_URL, maxBytes: 20 * 1024 * 1024 });
    this.devices = new Set();
    this.timer = null;
    this.inFlight = null;
    this.stopped = false;
    this.lastFeed = null;
    this.lastSuccessAt = '';
    this.lastError = '';
    this.tracking = new Map();
  }
  start() { this.stopped = false; this._schedule(5000); }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  register(device) { this.devices.add(device); this._schedule(1200); }
  unregister(device) { this.devices.delete(device); this.tracking.delete(this._deviceKey(device)); }
  _schedule(delay = TRAFFIC_POLL_MS) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh().catch(() => {}).finally(() => this._schedule(TRAFFIC_POLL_MS)), delay);
  }
  _deviceKey(device) {
    try { return String((device.getData() || {}).id || device.getName() || ''); } catch (_) { return ''; }
  }
  getDiagnostics() {
    return {
      url: TRAFFIC_FEED_URL,
      pollMs: TRAFFIC_POLL_MS,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      deviceCount: this.devices.size,
      trackedBridgeQueues: this.tracking.size,
      mode: 'bridge-opening-caused-queues-only',
    };
  }
  async refresh() {
    if (!this.devices.size) return { skipped: true };
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
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
  async _refresh() {
    try {
      const fetched = await this.client.fetch();
      if (fetched.changed) this.lastFeed = parseTrafficFeed(fetched.xml);
      if (!this.lastFeed) return { changed: false, waiting: true };
      await this._apply(this.lastFeed);
      this.lastSuccessAt = new Date().toISOString(); this.lastError = '';
      return { changed: fetched.changed, queueCount: this.lastFeed.queues.length, bridgeRecordCount: this.lastFeed.bridges.length };
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      await Promise.all([...this.devices].map(d => typeof d.onTrafficError === 'function' ? d.onTrafficError(err) : null));
      if (this.homey && this.homey.app && typeof this.homey.app.error === 'function') this.homey.app.error('NDW bridge-impact feed failed', err);
      throw err;
    }
  }
}

module.exports = { TrafficFeedService, TRAFFIC_FEED_URL, TRAFFIC_POLL_MS };
