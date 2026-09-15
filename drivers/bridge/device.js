'use strict';
const Homey = require('homey');

class BridgeDevice extends Homey.Device {
  async onInit() {
    this.log(`Bridge device init: ${this.getName()}`); this._bootSynced = false;
    await this._ensureCapabilities();
    await this._ensureDefaults();
    if (this.homey.app && typeof this.homey.app.registerBridgeDevice === 'function') this.homey.app.registerBridgeDevice(this);
  }
  async onDeleted() { if (this.homey.app && typeof this.homey.app.unregisterBridgeDevice === 'function') this.homey.app.unregisterBridgeDevice(this); }
  getBridgeMeta() {
    const data = this.getData() || {};
    return { isrs:String(this.getStoreValue('isrs') || data.id || '').toUpperCase(), lat:Number(this.getStoreValue('lat')), lon:Number(this.getStoreValue('lon')) };
  }

  async _ensureCapabilities() {
    // Keep the three-state bridge-open indicator and remove the obsolete alarm tile.
    if (!this.hasCapability('bridge_open_state')) {
      await this.addCapability('bridge_open_state');
    }
    if (this.hasCapability('alarm_generic') && typeof this.removeCapability === 'function') {
      try {
        await this.removeCapability('alarm_generic');
      } catch (err) {
        this.log(`Could not remove legacy opening alarm: ${err && err.message ? err.message : err}`);
      }
    }
  }
  _openStateForStatus(status) {
    if (status === 'open') return 'yes';
    if (status === 'closed' || status === 'planned') return 'no';
    return 'unknown';
  }
  async _ensureDefaults() {
    const defaults = { bridge_status:'unknown', bridge_open_state:'unknown', bridge_next_opening:'—', bridge_last_check:'—', bridge_data_status:'unknown' };
    for (const [cap,value] of Object.entries(defaults)) {
      if (this.hasCapability(cap) && (this.getCapabilityValue(cap) === null || typeof this.getCapabilityValue(cap) === 'undefined')) await this.setCapabilityValue(cap,value);
    }
  }
  async _set(cap, value) { if (!this.hasCapability(cap)) return; if (this.getCapabilityValue(cap) !== value) await this.setCapabilityValue(cap, value); }
  _formatTime(value) {
    if (!value) return '—'; const d = new Date(value); if (!Number.isFinite(d.getTime())) return '—';
    const lang = (this.homey.i18n && this.homey.i18n.getLanguage && this.homey.i18n.getLanguage()) || 'nl';
    let tz; try { tz = this.homey.clock && this.homey.clock.getTimezone && this.homey.clock.getTimezone(); } catch (_) {}
    try { return new Intl.DateTimeFormat(lang, { day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit', ...(tz ? {timeZone:tz}: {}) }).format(d); }
    catch (_) { return d.toISOString().slice(0,16).replace('T',' '); }
  }
  _label(status) { const key = `status.${status}`; const value = this.homey.__(key); return value === key ? status : value; }
  _eventTokens(status, previous, state) {
    const event = state.event || {}; const name = String(this.getStoreValue('bridge_name') || this.getName());
    return {
      bridge_name:name, status:this._label(status), status_id:status,
      previous_status:this._label(previous), previous_status_id:previous,
      started_at:this._formatTime(event.start), ended_at:this._formatTime(event.end), expected_end:this._formatTime(event.end),
      planned_start:this._formatTime(state.plannedStart || state.nextOpening), planned_end:this._formatTime(state.plannedEnd),
      probability:String(state.probability || event.probability || '')
    };
  }
  async onBridgeState(state) {
    const previous = String(this.getCapabilityValue('bridge_status') || 'unknown'); const next = String(state.status || 'unknown');
    await this._set('bridge_status', next); await this._set('bridge_open_state', this._openStateForStatus(next));
    await this._set('bridge_next_opening', this._formatTime(state.nextOpening)); await this._set('bridge_last_check', this._formatTime(state.checkedAt));
    await this._set('bridge_data_status', state.dataStatus || 'ok');
    const planningState = state.planningState || {}; const currentState = state.currentState || {};
    await this.setStoreValue('seen_in_ndw', planningState.seenInNdw === true);
    await this.setStoreValue('planning_snapshot_known', planningState.planningSnapshotKnown === true);
    await this.setStoreValue('missing_snapshots', Number(planningState.missingSnapshots || 0));
    await this.setStoreValue('planning_status', String(planningState.status || 'unknown'));
    await this.setStoreValue('planning_next_opening', String(planningState.nextOpening || ''));
    await this.setStoreValue('planning_start', String(planningState.plannedStart || ''));
    await this.setStoreValue('planning_end', String(planningState.plannedEnd || ''));
    await this.setStoreValue('planning_probability', String(planningState.probability || ''));
    await this.setStoreValue('seen_in_current', currentState.seenInCurrent === true);
    await this.setStoreValue('ndw_coverage_known', currentState.coverageKnown === true || planningState.seenInNdw === true);
    await this.setStoreValue('current_snapshot_known', currentState.currentSnapshotKnown === true);
    await this.setStoreValue('current_missing_snapshots', Number(currentState.currentMissingSnapshots || 0));
    await this.setStoreValue('current_status', String(currentState.status || 'unknown'));
    if (state.currentPublicationTime) await this.setStoreValue('last_current_publication_time', state.currentPublicationTime);
    if (state.planningPublicationTime) await this.setStoreValue('last_planning_publication_time', state.planningPublicationTime);
    if (!this._bootSynced) { this._bootSynced = true; return; }
    if (previous === next) return;
    const tokens = this._eventTokens(next, previous, state); const flowState = { previous, current:next };
    await this.homey.app.triggerBridge('bridge_status_changed', this, tokens, flowState);
    if (next === 'open') await this.homey.app.triggerBridge('bridge_opened', this, tokens, flowState);
    else if (next === 'closed' && (previous === 'open' || previous === 'planned')) await this.homey.app.triggerBridge('bridge_closed', this, tokens, flowState);
    else if (next === 'planned') await this.homey.app.triggerBridge('bridge_planned', this, tokens, flowState);
  }
  async onFeedHeartbeat(checkedAt) {
    await this._set('bridge_last_check', this._formatTime(checkedAt));
    const snapshotKnown = this.getStoreValue('current_snapshot_known') === true;
    await this._set('bridge_data_status', snapshotKnown ? 'ok' : 'unknown');
    if (!this._bootSynced) this._bootSynced = true;
  }
  async onFeedError(err) { this.log(`NDW temporarily unavailable: ${err && err.message ? err.message : err}`); await this._set('bridge_data_status','error'); }
}
module.exports = BridgeDevice;
