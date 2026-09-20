'use strict';

const { NdwClient, PLANNING_FEED_URL, CURRENT_FEED_URL } = require('./ndw_client');
const { parseBridgeFeed } = require('./datex_bridge_parser');
const {
  deriveBridgeState,
  applySnapshotPolicy,
  applyCurrentSnapshotPolicy,
  mergeBridgeStates,
} = require('./bridge_state');

const CURRENT_POLL_MS = 15 * 1000;
const PLANNING_POLL_MS = 60 * 1000;
const CURRENT_OPERATION_TIMEOUT_MS = 45 * 1000;
const PLANNING_OPERATION_TIMEOUT_MS = 50 * 1000;
const CURRENT_WATCHDOG_MS = 30 * 1000;
const CURRENT_RECOVERY_AFTER_MS = 90 * 1000;

class BridgeFeedService {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.currentClient = options.currentClient || new NdwClient({
      feedUrl: CURRENT_FEED_URL,
      maxBytes: 20 * 1024 * 1024,
    });
    this.planningClient = options.planningClient || new NdwClient({
      feedUrl: PLANNING_FEED_URL,
      maxBytes: 15 * 1024 * 1024,
    });
    this.devices = new Set();
    this.currentTimer = null;
    this.planningTimer = null;
    this.currentKickTimer = null;
    this.planningKickTimer = null;
    this.watchdogTimer = null;
    this.currentInFlight = null;
    this.planningInFlight = null;
    this.currentGeneration = 0;
    this.planningGeneration = 0;
    this.stopped = false;
    this.lastCurrentFeed = null;
    this.lastPlanningFeed = null;
    this.lastCurrentSuccessAt = 0;
    this.lastPlanningSuccessAt = 0;
    this.startedAt = 0;
    this.lastRecoveryAt = 0;
  }

  _setTimeout(fn, delay) {
    return this.homey && typeof this.homey.setTimeout === 'function'
      ? this.homey.setTimeout(fn, delay)
      : setTimeout(fn, delay);
  }

  _clearTimeout(timer) {
    if (!timer) return;
    if (this.homey && typeof this.homey.clearTimeout === 'function') this.homey.clearTimeout(timer);
    else clearTimeout(timer);
  }

  _setInterval(fn, delay) {
    return this.homey && typeof this.homey.setInterval === 'function'
      ? this.homey.setInterval(fn, delay)
      : setInterval(fn, delay);
  }

  _clearInterval(timer) {
    if (!timer) return;
    if (this.homey && typeof this.homey.clearInterval === 'function') this.homey.clearInterval(timer);
    else clearInterval(timer);
  }

  start() {
    this.stopped = false;
    this.startedAt = Date.now();
    this.currentTimer = this._setInterval(() => {
      this.refreshCurrent().catch(() => {});
    }, CURRENT_POLL_MS);
    this.planningTimer = this._setInterval(() => {
      this.refreshPlanning().catch(() => {});
    }, PLANNING_POLL_MS);
    this.watchdogTimer = this._setInterval(() => this._watchdogTick(), CURRENT_WATCHDOG_MS);
    this._kickCurrent(1000);
    this._kickPlanning(1800);
  }

  stop() {
    this.stopped = true;
    this._clearInterval(this.currentTimer);
    this._clearInterval(this.planningTimer);
    this._clearInterval(this.watchdogTimer);
    this._clearTimeout(this.currentKickTimer);
    this._clearTimeout(this.planningKickTimer);
    this.currentTimer = null;
    this.planningTimer = null;
    this.watchdogTimer = null;
    this.currentKickTimer = null;
    this.planningKickTimer = null;
  }

  register(device) {
    this.devices.add(device);
    this._kickCurrent(250);
    this._kickPlanning(700);
  }

  unregister(device) { this.devices.delete(device); }

  getDiagnostics() {
    return {
      currentUrl: CURRENT_FEED_URL,
      planningUrl: PLANNING_FEED_URL,
      currentPollMs: CURRENT_POLL_MS,
      planningPollMs: PLANNING_POLL_MS,
      currentPublicationTime: this.lastCurrentFeed ? String(this.lastCurrentFeed.publicationTime || '') : '',
      planningPublicationTime: this.lastPlanningFeed ? String(this.lastPlanningFeed.publicationTime || '') : '',
      lastCurrentSuccessAt: this.lastCurrentSuccessAt ? new Date(this.lastCurrentSuccessAt).toISOString() : '',
      lastPlanningSuccessAt: this.lastPlanningSuccessAt ? new Date(this.lastPlanningSuccessAt).toISOString() : '',
      deviceCount: this.devices.size,
    };
  }

  _kickCurrent(delay = 0) {
    if (this.stopped) return;
    this._clearTimeout(this.currentKickTimer);
    this.currentKickTimer = this._setTimeout(() => {
      this.currentKickTimer = null;
      this.refreshCurrent().catch(() => {});
    }, delay);
  }

  _kickPlanning(delay = 0) {
    if (this.stopped) return;
    this._clearTimeout(this.planningKickTimer);
    this.planningKickTimer = this._setTimeout(() => {
      this.planningKickTimer = null;
      this.refreshPlanning().catch(() => {});
    }, delay);
  }

  _withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this._setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => this._clearTimeout(timer));
  }

  _watchdogTick() {
    if (this.stopped || !this.devices.size) return;
    const now = Date.now();
    const reference = this.lastCurrentSuccessAt || this.startedAt || now;
    if (now - reference < CURRENT_RECOVERY_AFTER_MS) return;
    if (now - this.lastRecoveryAt < CURRENT_WATCHDOG_MS) return;
    this.lastRecoveryAt = now;
    this.currentInFlight = null;
    this._kickCurrent(0);
  }

  async refresh() {
    if (!this.devices.size) return { skipped: true };
    const current = await this.refreshCurrent();
    const planning = await this.refreshPlanning();
    return { current, planning };
  }

  async refreshCurrent() {
    if (this.currentInFlight) return this.currentInFlight;
    const generation = ++this.currentGeneration;
    const run = this._withTimeout(this._refreshCurrentImpl(generation), CURRENT_OPERATION_TIMEOUT_MS, 'NDW current refresh');
    this.currentInFlight = run;
    try {
      return await run;
    } finally {
      if (this.currentInFlight === run) this.currentInFlight = null;
    }
  }

  async refreshPlanning() {
    if (this.planningInFlight) return this.planningInFlight;
    const generation = ++this.planningGeneration;
    const run = this._withTimeout(this._refreshPlanningImpl(generation), PLANNING_OPERATION_TIMEOUT_MS, 'NDW planning refresh');
    this.planningInFlight = run;
    try {
      return await run;
    } finally {
      if (this.planningInFlight === run) this.planningInFlight = null;
    }
  }

  _planningFromStore(device) {
    return {
      status: String(device.getStoreValue('planning_status') || device.getCapabilityValue('bridge_status') || 'unknown'),
      seenInNdw: device.getStoreValue('seen_in_ndw') === true,
      planningSnapshotKnown: device.getStoreValue('planning_snapshot_known') === true,
      missingSnapshots: Number(device.getStoreValue('missing_snapshots') || 0),
      nextOpening: String(device.getStoreValue('planning_next_opening') || ''),
      plannedStart: String(device.getStoreValue('planning_start') || ''),
      plannedEnd: String(device.getStoreValue('planning_end') || ''),
      probability: String(device.getStoreValue('planning_probability') || ''),
      event: null,
    };
  }

  _currentFromStore(device) {
    return {
      status: String(device.getStoreValue('current_status') || 'unknown'),
      seenInCurrent: device.getStoreValue('seen_in_current') === true,
      coverageKnown: device.getStoreValue('ndw_coverage_known') === true,
      currentSnapshotKnown: device.getStoreValue('current_snapshot_known') === true,
      currentMissingSnapshots: Number(device.getStoreValue('current_missing_snapshots') || 0),
      event: null,
    };
  }

  async _applyCurrentSnapshot(parsed, checkedAt, devices = [...this.devices]) {
    await Promise.all(devices.map(async device => {
      const meta = device.getBridgeMeta();
      const currentDerived = deriveBridgeState(parsed.records, meta);
      const planningState = this._planningFromStore(device);
      const currentPrevious = this._currentFromStore(device);
      const currentState = applyCurrentSnapshotPolicy(currentPrevious, currentDerived);
      const previous = String(device.getCapabilityValue('bridge_status') || 'unknown');
      const merged = mergeBridgeStates(currentState, planningState, previous);

      await device.onBridgeState({
        ...merged,
        checkedAt,
        dataStatus: 'ok',
        currentPublicationTime: parsed.publicationTime,
        currentState,
        planningState,
        feedSource: 'current',
      });
    }));
  }

  async _applyPlanningSnapshot(parsed, checkedAt, devices = [...this.devices]) {
    await Promise.all(devices.map(async device => {
      const meta = device.getBridgeMeta();
      const planningDerived = deriveBridgeState(parsed.records, meta);
      const planningState = applySnapshotPolicy(this._planningFromStore(device), planningDerived);
      const currentStored = this._currentFromStore(device);
      const currentState = planningState.seenInNdw === true
        ? { ...currentStored, coverageKnown: true, status: currentStored.currentSnapshotKnown && currentStored.status === 'unknown' ? 'closed' : currentStored.status }
        : currentStored;
      const previous = String(device.getCapabilityValue('bridge_status') || 'unknown');
      const merged = mergeBridgeStates(currentState, planningState, previous);

      await device.onBridgeState({
        ...merged,
        checkedAt,
        dataStatus: 'ok',
        planningPublicationTime: parsed.publicationTime,
        currentState,
        planningState,
        feedSource: 'planning',
      });
    }));
  }

  async _refreshCurrentImpl(generation = this.currentGeneration) {
    if (!this.devices.size) return { skipped: true };
    const checkedAt = new Date().toISOString();
    try {
      const fetched = await this.currentClient.fetch();
      if (generation !== this.currentGeneration) return { superseded: true, source: 'current' };
      if (!fetched.changed) {
        // A newly paired device still needs to be evaluated against the last successful snapshot.
        // Otherwise HTTP 304 / unchanged data could leave it at Unknown indefinitely.
        const pending = [...this.devices].filter(d => d.getStoreValue('current_snapshot_known') !== true);
        if (this.lastCurrentFeed && pending.length) {
          await this._applyCurrentSnapshot(this.lastCurrentFeed, checkedAt, pending);
        }
        const pendingSet = new Set(pending);
        await Promise.all([...this.devices].filter(d => !pendingSet.has(d)).map(d => d.onFeedHeartbeat(checkedAt)));
        this.lastCurrentSuccessAt = Date.now();
        return { changed: false, source: 'current', synchronized: pending.length };
      }

      const parsed = parseBridgeFeed(fetched.xml);
      this.lastCurrentFeed = parsed;
      await this._applyCurrentSnapshot(parsed, checkedAt);
      this.lastCurrentSuccessAt = Date.now();

      return { changed: true, source: 'current', count: parsed.records.length };
    } catch (err) {
      await Promise.all([...this.devices].map(d => d.onFeedError(err)));
      if (this.homey && this.homey.app && typeof this.homey.app.error === 'function') {
        this.homey.app.error('NDW current bridge closures feed failed', err);
      }
      throw err;
    }
  }

  async _refreshPlanningImpl(generation = this.planningGeneration) {
    if (!this.devices.size) return { skipped: true };
    const checkedAt = new Date().toISOString();
    try {
      const fetched = await this.planningClient.fetch();
      if (generation !== this.planningGeneration) return { superseded: true, source: 'planning' };
      if (!fetched.changed) {
        // Same rule for a newly paired bridge: reuse the cached planning snapshot so a known
        // upcoming opening can be shown immediately even when the server returns unchanged data.
        const pending = [...this.devices].filter(d => d.getStoreValue('planning_snapshot_known') !== true);
        if (this.lastPlanningFeed && pending.length) {
          await this._applyPlanningSnapshot(this.lastPlanningFeed, checkedAt, pending);
        }
        const pendingSet = new Set(pending);
        await Promise.all([...this.devices]
          .filter(d => !pendingSet.has(d) && typeof d.onPlanningFeedHeartbeat === 'function')
          .map(d => d.onPlanningFeedHeartbeat(checkedAt)));
        this.lastPlanningSuccessAt = Date.now();
        return { changed: false, source: 'planning', synchronized: pending.length };
      }

      const parsed = parseBridgeFeed(fetched.xml);
      this.lastPlanningFeed = parsed;
      await this._applyPlanningSnapshot(parsed, checkedAt);
      this.lastPlanningSuccessAt = Date.now();

      return { changed: true, source: 'planning', count: parsed.records.length };
    } catch (err) {
      // The current feed is the critical source for live open/closed status. A planning-feed
      // failure must not make a currently working live bridge status look unavailable.
      await Promise.all([...this.devices]
        .filter(d => typeof d.onPlanningFeedError === 'function')
        .map(d => d.onPlanningFeedError(err)));
      if (this.homey && this.homey.app && typeof this.homey.app.error === 'function') {
        this.homey.app.error('NDW bridge planning feed failed', err);
      }
      throw err;
    }
  }
}

module.exports = { BridgeFeedService, CURRENT_POLL_MS, PLANNING_POLL_MS };
