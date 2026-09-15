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
    this.currentInFlight = null;
    this.planningInFlight = null;
    this.stopped = false;
    this.lastCurrentFeed = null;
    this.lastPlanningFeed = null;
  }

  start() {
    this.stopped = false;
    this._scheduleCurrent(1000);
    this._schedulePlanning(1800);
  }

  stop() {
    this.stopped = true;
    if (this.currentTimer) clearTimeout(this.currentTimer);
    if (this.planningTimer) clearTimeout(this.planningTimer);
    this.currentTimer = null;
    this.planningTimer = null;
  }

  register(device) {
    this.devices.add(device);
    this._scheduleCurrent(250);
    this._schedulePlanning(700);
  }

  unregister(device) { this.devices.delete(device); }

  _scheduleCurrent(delay = CURRENT_POLL_MS) {
    if (this.stopped) return;
    if (this.currentTimer) clearTimeout(this.currentTimer);
    this.currentTimer = setTimeout(() => {
      this.refreshCurrent().catch(() => {}).finally(() => this._scheduleCurrent(CURRENT_POLL_MS));
    }, delay);
  }

  _schedulePlanning(delay = PLANNING_POLL_MS) {
    if (this.stopped) return;
    if (this.planningTimer) clearTimeout(this.planningTimer);
    this.planningTimer = setTimeout(() => {
      this.refreshPlanning().catch(() => {}).finally(() => this._schedulePlanning(PLANNING_POLL_MS));
    }, delay);
  }

  async refresh() {
    if (!this.devices.size) return { skipped: true };
    const current = await this.refreshCurrent();
    const planning = await this.refreshPlanning();
    return { current, planning };
  }

  async refreshCurrent() {
    if (this.currentInFlight) return this.currentInFlight;
    this.currentInFlight = this._refreshCurrentImpl().finally(() => { this.currentInFlight = null; });
    return this.currentInFlight;
  }

  async refreshPlanning() {
    if (this.planningInFlight) return this.planningInFlight;
    this.planningInFlight = this._refreshPlanningImpl().finally(() => { this.planningInFlight = null; });
    return this.planningInFlight;
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
      });
    }));
  }

  async _refreshCurrentImpl() {
    if (!this.devices.size) return { skipped: true };
    const checkedAt = new Date().toISOString();
    try {
      const fetched = await this.currentClient.fetch();
      if (!fetched.changed) {
        // A newly paired device still needs to be evaluated against the last successful snapshot.
        // Otherwise HTTP 304 / unchanged data could leave it at Unknown indefinitely.
        const pending = [...this.devices].filter(d => d.getStoreValue('current_snapshot_known') !== true);
        if (this.lastCurrentFeed && pending.length) {
          await this._applyCurrentSnapshot(this.lastCurrentFeed, checkedAt, pending);
        }
        const pendingSet = new Set(pending);
        await Promise.all([...this.devices].filter(d => !pendingSet.has(d)).map(d => d.onFeedHeartbeat(checkedAt)));
        return { changed: false, source: 'current', synchronized: pending.length };
      }

      const parsed = parseBridgeFeed(fetched.xml);
      this.lastCurrentFeed = parsed;
      await this._applyCurrentSnapshot(parsed, checkedAt);

      return { changed: true, source: 'current', count: parsed.records.length };
    } catch (err) {
      await Promise.all([...this.devices].map(d => d.onFeedError(err)));
      if (this.homey && this.homey.app && typeof this.homey.app.error === 'function') {
        this.homey.app.error('NDW current bridge closures feed failed', err);
      }
      throw err;
    }
  }

  async _refreshPlanningImpl() {
    if (!this.devices.size) return { skipped: true };
    const checkedAt = new Date().toISOString();
    try {
      const fetched = await this.planningClient.fetch();
      if (!fetched.changed) {
        // Same rule for a newly paired bridge: reuse the cached planning snapshot so a known
        // upcoming opening can be shown immediately even when the server returns unchanged data.
        const pending = [...this.devices].filter(d => d.getStoreValue('planning_snapshot_known') !== true);
        if (this.lastPlanningFeed && pending.length) {
          await this._applyPlanningSnapshot(this.lastPlanningFeed, checkedAt, pending);
        }
        return { changed: false, source: 'planning', synchronized: pending.length };
      }

      const parsed = parseBridgeFeed(fetched.xml);
      this.lastPlanningFeed = parsed;
      await this._applyPlanningSnapshot(parsed, checkedAt);

      return { changed: true, source: 'planning', count: parsed.records.length };
    } catch (err) {
      // The current feed is the critical source for live open/closed status. A planning-feed
      // failure must not make a currently working live bridge status look unavailable.
      if (this.homey && this.homey.app && typeof this.homey.app.error === 'function') {
        this.homey.app.error('NDW bridge planning feed failed', err);
      }
      throw err;
    }
  }
}

module.exports = { BridgeFeedService, CURRENT_POLL_MS, PLANNING_POLL_MS };
