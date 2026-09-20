'use strict';
const Homey = require('homey');

const DEVICE_TICK_MS = 5 * 1000;
const STALE_STATUS_AFTER_MS = 60 * 1000;

class BridgeDevice extends Homey.Device {
  async onInit() {
    this.log(`Bridge device init: ${this.getName()}`);
    this._bootSynced = false;
    this._planningBootSynced = false;
    this._impactBootSynced = false;
    this._tickBusy = false;
    this._lastQueueLengthMeters = null;
    this._lastAftermathSeconds = null;
    this._plannedCountdown = null;
    this._lastOpenDurationSeconds = null;
    this._lastDataAgeSeconds = null;
    this._lastStatsMinute = null;
    await this._ensureCapabilities();
    await this._ensureDefaults();
    await this._syncTrafficPresentation(
      String(this.getCapabilityValue('bridge_traffic_status') || 'unknown'),
      Number(this.getCapabilityValue('bridge_queue_length') || 0),
      String(this.getCapabilityValue('bridge_aftermath_duration') || '—'),
    );
    for (const key of ['official_notice_signature', 'notice_last_success']) {
      try { if (typeof this.unsetStoreValue === 'function') await this.unsetStoreValue(key); } catch (_) {}
    }
    this._restoreRuntimeState();
    await this._updateHistoryStats(Date.now());
    if (this.homey.app && typeof this.homey.app.registerBridgeDevice === 'function') this.homey.app.registerBridgeDevice(this);
    this._runtimeTimer = this.homey && typeof this.homey.setInterval === 'function'
      ? this.homey.setInterval(() => {
        this._runtimeTick().catch(err => this.log(`Runtime tick failed: ${err && err.message ? err.message : err}`));
      }, DEVICE_TICK_MS)
      : setInterval(() => {
        this._runtimeTick().catch(err => this.log(`Runtime tick failed: ${err && err.message ? err.message : err}`));
      }, DEVICE_TICK_MS);
    await this._runtimeTick();
  }

  async onDeleted() {
    if (this._runtimeTimer) {
      if (this.homey && typeof this.homey.clearInterval === 'function') this.homey.clearInterval(this._runtimeTimer);
      else clearInterval(this._runtimeTimer);
    }
    this._runtimeTimer = null;
    if (this.homey.app && typeof this.homey.app.unregisterBridgeDevice === 'function') this.homey.app.unregisterBridgeDevice(this);
  }

  getBridgeMeta() {
    const data = this.getData() || {};
    return {
      isrs: String(this.getStoreValue('isrs') || data.id || '').toUpperCase(),
      lat: Number(this.getStoreValue('lat')),
      lon: Number(this.getStoreValue('lon')),
      status: String(this.getCapabilityValue('bridge_status') || 'unknown'),
      openSince: String(this.getStoreValue('open_started_at') || ''),
      lastClosedAt: String(this.getStoreValue('last_closed_at') || ''),
    };
  }

  getRouteSnapshot() {
    const data = this.getData() || {};
    return {
      id: String(data.id || this.getStoreValue('isrs') || '').toUpperCase(),
      name: String(this.getStoreValue('bridge_name') || this.getName()),
      status: String(this.getCapabilityValue('bridge_status') || 'unknown'),
      dataStatus: String(this.getCapabilityValue('bridge_data_status') || 'unknown'),
      plannedStart: String(this.getStoreValue('planning_start') || this.getStoreValue('planning_next_opening') || ''),
      plannedEnd: String(this.getStoreValue('planning_end') || ''),
      planningKnown: this.getStoreValue('planning_snapshot_known') === true,
      planningSupported: this.getStoreValue('seen_in_ndw') === true,
      currentKnown: this.getStoreValue('current_snapshot_known') === true,
      openSince: String(this.getStoreValue('open_started_at') || ''),
      trafficStatus: String(this.getCapabilityValue('bridge_traffic_status') || 'unknown'),
      trafficSummary: String(this.getCapabilityValue('bridge_traffic_summary') || ''),
      queueLengthKm: Number(this.getCapabilityValue('bridge_queue_length') || 0),
      aftermathSeconds: Number(this.getStoreValue('impact_aftermath_seconds') || 0),
    };
  }

  async _ensureCapabilities() {
    const required = [
      'bridge_open_state',
      'bridge_open_since',
      'bridge_open_duration',
      'bridge_last_open_duration',
      'bridge_openings_today',
      'bridge_open_time_today',
      'bridge_average_open_duration',
      'bridge_longest_open_duration',
      'bridge_traffic_status',
      'bridge_traffic_summary',
      'bridge_queue_length',
      'bridge_aftermath_duration',
    ];
    for (const capability of required) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }
    if (this.hasCapability('alarm_generic') && typeof this.removeCapability === 'function') {
      try {
        await this.removeCapability('alarm_generic');
      } catch (err) {
        this.log(`Could not remove legacy opening alarm: ${err && err.message ? err.message : err}`);
      }
    }
    if (this.hasCapability('bridge_data_age') && typeof this.removeCapability === 'function') {
      try {
        await this.removeCapability('bridge_data_age');
      } catch (err) {
        this.log(`Could not remove data age capability: ${err && err.message ? err.message : err}`);
      }
    }
    for (const obsoleteCapability of ['bridge_operation_status', 'bridge_operation_times', 'bridge_notice_status', 'bridge_notice']) {
      if (this.hasCapability(obsoleteCapability) && typeof this.removeCapability === 'function') {
        try {
          await this.removeCapability(obsoleteCapability);
        } catch (err) {
          this.log(`Could not remove obsolete operation capability ${obsoleteCapability}: ${err && err.message ? err.message : err}`);
        }
      }
    }
  }

  _openStateForStatus(status) {
    if (status === 'open') return 'yes';
    if (status === 'closed' || status === 'planned') return 'no';
    return 'unknown';
  }

  async _ensureDefaults() {
    const defaults = {
      bridge_status: 'unknown',
      bridge_open_state: 'unknown',
      bridge_next_opening: this._planningText('waiting', 'Waiting for data'),
      bridge_last_check: '—',
      bridge_data_status: 'unknown',
      bridge_open_since: '—',
      bridge_open_duration: '—',
      bridge_last_open_duration: '—',
      bridge_openings_today: 0,
      bridge_open_time_today: '0 sec',
      bridge_average_open_duration: '—',
      bridge_longest_open_duration: '—',
      bridge_traffic_status: 'unknown',
      bridge_traffic_summary: this._planningText('traffic_waiting', 'Wachten op file-impact'),
      bridge_queue_length: 0,
      bridge_aftermath_duration: '—',
    };
    for (const [cap, value] of Object.entries(defaults)) {
      if (this.hasCapability(cap) && (this.getCapabilityValue(cap) === null || typeof this.getCapabilityValue(cap) === 'undefined')) {
        await this.setCapabilityValue(cap, value);
      }
    }
    const impactStatus = String(this.getCapabilityValue('bridge_traffic_status') || 'unknown');
    if (!['unknown', 'clear', 'queue', 'residual'].includes(impactStatus)) {
      await this._set('bridge_traffic_status', 'unknown');
      await this._set('bridge_traffic_summary', this._planningText('traffic_waiting', 'Wachten op file-impact'));
      await this._set('bridge_queue_length', 0);
      await this._set('bridge_aftermath_duration', '—');
    }
  }

  _restoreRuntimeState() {
    const status = String(this.getCapabilityValue('bridge_status') || 'unknown');
    const openStartedAt = this._timeMs(this.getStoreValue('open_started_at'));
    if (status === 'open' && Number.isFinite(openStartedAt)) {
      this._lastOpenDurationSeconds = Math.max(0, Math.floor((Date.now() - openStartedAt) / 1000));
    }
    const lastSuccess = this._timeMs(this.getStoreValue('last_successful_current_at'));
    if (Number.isFinite(lastSuccess)) {
      this._lastDataAgeSeconds = Math.max(0, Math.floor((Date.now() - lastSuccess) / 1000));
    }
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap)) return;
    if (this.getCapabilityValue(cap) !== value) await this.setCapabilityValue(cap, value);
  }

  async _addPresentationCapability(capability) {
    if (this.hasCapability(capability)) return;
    if (typeof this.addCapability !== 'function') return;
    try { await this.addCapability(capability); }
    catch (err) { this.log(`Could not add presentation capability ${capability}: ${err && err.message ? err.message : err}`); }
  }

  async _removePresentationCapability(capability) {
    if (!this.hasCapability(capability)) return;
    if (typeof this.removeCapability !== 'function') return;
    try { await this.removeCapability(capability); }
    catch (err) { this.log(`Could not remove presentation capability ${capability}: ${err && err.message ? err.message : err}`); }
  }

  async _syncTrafficPresentation(status, queueLengthKm = 0, aftermathDuration = '—') {
    const active = ['queue', 'residual'].includes(String(status));
    if (!active) {
      for (const capability of ['bridge_aftermath_display', 'bridge_queue_length_display', 'bridge_traffic_display']) {
        await this._removePresentationCapability(capability);
      }
      return;
    }

    await this._addPresentationCapability('bridge_traffic_display');
    await this._addPresentationCapability('bridge_queue_length_display');
    await this._set('bridge_traffic_display', String(status));
    await this._set('bridge_queue_length_display', Math.max(0, Number(queueLengthKm) || 0));

    if (String(status) === 'residual') {
      await this._addPresentationCapability('bridge_aftermath_display');
      await this._set('bridge_aftermath_display', String(aftermathDuration || '—'));
    } else {
      await this._removePresentationCapability('bridge_aftermath_display');
    }
  }

  _timeMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value) return NaN;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? t : NaN;
  }

  _isoOrEmpty(value) {
    const ms = this._timeMs(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  }

  _formatTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '—';
    const lang = (this.homey.i18n && this.homey.i18n.getLanguage && this.homey.i18n.getLanguage()) || 'nl';
    let tz;
    try { tz = this.homey.clock && this.homey.clock.getTimezone && this.homey.clock.getTimezone(); } catch (_) {}
    try {
      return new Intl.DateTimeFormat(lang, {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        ...(tz ? { timeZone: tz } : {}),
      }).format(d);
    } catch (_) {
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  _planningText(key, fallback) {
    const path = `planning.${key}`;
    const value = this.homey.__(path);
    return value === path ? fallback : value;
  }

  _nextOpeningDisplay(state = {}) {
    if (this.getStoreValue('planning_feed_error') === true) {
      return this._planningText('unavailable', 'Planning unavailable');
    }
    if (state.nextOpening) return this._formatTime(state.nextOpening);
    const planning = state.planningState || {};
    if (planning.planningSnapshotKnown !== true) {
      return this._planningText('waiting', 'Waiting for data');
    }
    if (planning.seenInNdw === true) {
      return this._planningText('none', 'No announcement');
    }
    return this._planningText('support_unknown', 'Support unknown');
  }

  _planningStateFromStore() {
    return {
      planningSnapshotKnown: this.getStoreValue('planning_snapshot_known') === true,
      seenInNdw: this.getStoreValue('seen_in_ndw') === true,
      nextOpening: String(this.getStoreValue('planning_next_opening') || ''),
    };
  }

  _formatDurationMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const lang = (this.homey.i18n && this.homey.i18n.getLanguage && this.homey.i18n.getLanguage()) || 'nl';
    const hourLabel = String(lang).toLowerCase().startsWith('nl') ? 'u' : 'h';
    if (hours > 0) return `${hours} ${hourLabel} ${String(minutes).padStart(2, '0')} min`;
    if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} sec`;
    return `${seconds} sec`;
  }

  _label(status) {
    const key = `status.${status}`;
    const value = this.homey.__(key);
    return value === key ? status : value;
  }

  _eventTokens(status, previous, state) {
    const event = state.event || {};
    const name = String(this.getStoreValue('bridge_name') || this.getName());
    const openStartedAt = this._timeMs(this.getStoreValue('open_started_at'));
    const lastDurationSeconds = Number(this.getStoreValue('last_open_duration_seconds'));
    const currentDurationSeconds = status === 'open' && Number.isFinite(openStartedAt)
      ? Math.max(0, Math.floor((Date.now() - openStartedAt) / 1000))
      : 0;
    return {
      bridge_name: name,
      status: this._label(status),
      status_id: status,
      previous_status: this._label(previous),
      previous_status_id: previous,
      started_at: this._formatTime(event.start || (Number.isFinite(openStartedAt) ? openStartedAt : '')),
      ended_at: this._formatTime(event.end),
      expected_end: this._formatTime(event.end),
      planned_start: this._formatTime(state.plannedStart || state.nextOpening),
      planned_end: this._formatTime(state.plannedEnd),
      probability: String(state.probability || event.probability || ''),
      open_duration: this._formatDurationMs(currentDurationSeconds * 1000),
      open_duration_seconds: currentDurationSeconds,
      last_open_duration: Number.isFinite(lastDurationSeconds) ? this._formatDurationMs(lastDurationSeconds * 1000) : '—',
      last_open_duration_seconds: Number.isFinite(lastDurationSeconds) ? lastDurationSeconds : 0,
    };
  }

  _history() {
    const raw = this.getStoreValue('opening_history');
    if (Array.isArray(raw)) return raw.filter(item => item && Number.isFinite(Number(item.durationSeconds)));
    if (typeof raw === 'string' && raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(item => item && Number.isFinite(Number(item.durationSeconds)));
      } catch (_) {}
    }
    return [];
  }

  async _recordOpening(startMs, endMs, durationSeconds) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(durationSeconds) || durationSeconds < 0) return;
    const history = this._history();
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    if (!history.some(item => item.start === start && item.end === end)) {
      history.push({ start, end, durationSeconds: Math.max(0, Math.floor(durationSeconds)) });
    }
    const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const trimmed = history
      .filter(item => this._timeMs(item.end) >= cutoff)
      .sort((a, b) => this._timeMs(a.start) - this._timeMs(b.start))
      .slice(-500);
    await this.setStoreValue('opening_history', trimmed);
  }

  _timezone() {
    try { return (this.homey.clock && this.homey.clock.getTimezone && this.homey.clock.getTimezone()) || 'Europe/Amsterdam'; }
    catch (_) { return 'Europe/Amsterdam'; }
  }

  _zonedParts(ms) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: this._timezone(), year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
    });
    const parts = {};
    for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
    return parts;
  }

  _zonedDateTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
    let guess = Date.UTC(year, month - 1, day, hour, minute, second);
    for (let i = 0; i < 4; i += 1) {
      const p = this._zonedParts(guess);
      const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      const target = Date.UTC(year, month - 1, day, hour, minute, second);
      const diff = rendered - target;
      if (!diff) break;
      guess -= diff;
    }
    return guess;
  }

  _todayBounds(now = Date.now()) {
    const p = this._zonedParts(now);
    const start = this._zonedDateTimeToUtc(p.year, p.month, p.day, 0, 0, 0);
    const nextDate = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    const end = this._zonedDateTimeToUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate(), 0, 0, 0);
    return { start, end };
  }

  async _updateHistoryStats(now = Date.now()) {
    const history = this._history();
    const { start: dayStart, end: dayEnd } = this._todayBounds(now);
    let openingsToday = 0;
    let openSecondsToday = 0;
    for (const item of history) {
      const start = this._timeMs(item.start);
      const end = this._timeMs(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start >= dayStart && start < dayEnd) openingsToday += 1;
      const overlap = Math.max(0, Math.min(end, Math.min(now, dayEnd)) - Math.max(start, dayStart));
      openSecondsToday += Math.floor(overlap / 1000);
    }

    const currentStart = String(this.getCapabilityValue('bridge_status') || 'unknown') === 'open'
      ? this._timeMs(this.getStoreValue('open_started_at')) : NaN;
    if (Number.isFinite(currentStart)) {
      if (currentStart >= dayStart && currentStart < dayEnd) openingsToday += 1;
      const overlap = Math.max(0, Math.min(now, dayEnd) - Math.max(currentStart, dayStart));
      openSecondsToday += Math.floor(overlap / 1000);
    }

    const durations = history.map(item => Number(item.durationSeconds)).filter(Number.isFinite);
    const average = durations.length ? Math.round(durations.reduce((a,b) => a + b, 0) / durations.length) : null;
    const longest = durations.length ? Math.max(...durations) : null;
    await this._set('bridge_openings_today', openingsToday);
    await this._set('bridge_open_time_today', this._formatDurationMs(openSecondsToday * 1000));
    await this._set('bridge_average_open_duration', average === null ? '—' : this._formatDurationMs(average * 1000));
    await this._set('bridge_longest_open_duration', longest === null ? '—' : this._formatDurationMs(longest * 1000));
  }

  getHistorySnapshot(now = Date.now()) {
    const history = this._history().slice().sort((a, b) => this._timeMs(a.start) - this._timeMs(b.start));
    const { start: dayStart, end: dayEnd } = this._todayBounds(now);
    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, seconds: 0 }));
    const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: 0, seconds: 0 }));
    let todayCount = 0;
    let todaySeconds = 0;
    let totalSeconds = 0;

    for (const item of history) {
      const start = this._timeMs(item.start);
      const end = this._timeMs(item.end);
      const seconds = Math.max(0, Number(item.durationSeconds) || 0);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      totalSeconds += seconds;
      const parts = this._zonedParts(start);
      if (Number.isFinite(parts.hour) && byHour[parts.hour]) {
        byHour[parts.hour].count += 1;
        byHour[parts.hour].seconds += seconds;
      }
      const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: this._timezone(), weekday: 'short' }).format(new Date(start));
      const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const wi = weekdays.indexOf(weekdayName);
      if (wi >= 0) {
        byWeekday[wi].count += 1;
        byWeekday[wi].seconds += seconds;
      }
      if (start >= dayStart && start < dayEnd) todayCount += 1;
      todaySeconds += Math.floor(Math.max(0, Math.min(end, Math.min(now, dayEnd)) - Math.max(start, dayStart)) / 1000);
    }

    const currentStart = String(this.getCapabilityValue('bridge_status') || 'unknown') === 'open'
      ? this._timeMs(this.getStoreValue('open_started_at')) : NaN;
    if (Number.isFinite(currentStart)) {
      if (currentStart >= dayStart && currentStart < dayEnd) todayCount += 1;
      todaySeconds += Math.floor(Math.max(0, Math.min(now, dayEnd) - Math.max(currentStart, dayStart)) / 1000);
    }

    const durations = history.map(item => Number(item.durationSeconds)).filter(Number.isFinite);
    return {
      measurementStartedAt: history.length ? history[0].start : '',
      totalOpenings: history.length,
      todayCount,
      todaySeconds,
      averageSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      longestSeconds: durations.length ? Math.max(...durations) : 0,
      totalSeconds,
      latest: history.slice(-10).reverse(),
      byHour,
      byWeekday,
      currentOpenSince: Number.isFinite(currentStart) ? new Date(currentStart).toISOString() : '',
    };
  }

  _impactLabel(status) {
    const key = `traffic_status.${status}`;
    const value = this.homey.__(key);
    return value === key ? status : value;
  }

  _impactTokens(status, previousStatus, state = {}) {
    const queueMeters = Math.max(0, Number(state.queueLengthMeters) || 0);
    const aftermathSeconds = Math.max(0, Number(state.aftermathSeconds) || 0);
    return {
      bridge_name: String(this.getStoreValue('bridge_name') || this.getName()),
      impact_status: this._impactLabel(status),
      impact_status_id: status,
      previous_impact_status: this._impactLabel(previousStatus || 'unknown'),
      previous_impact_status_id: String(previousStatus || 'unknown'),
      queue_length_km: Math.round(queueMeters / 100) / 10,
      queue_length_meters: queueMeters,
      aftermath_duration: this._formatDurationMs(aftermathSeconds * 1000),
      aftermath_seconds: aftermathSeconds,
      road: String(state.road || ''),
      summary: String(state.summary || ''),
    };
  }

  async onTrafficState(state = {}) {
    const status = ['clear', 'queue', 'residual'].includes(String(state.status)) ? String(state.status) : 'unknown';
    const previous = String(this.getCapabilityValue('bridge_traffic_status') || 'unknown');
    const previousQueueMeters = Math.max(0, Number(this.getCapabilityValue('bridge_queue_length') || 0) * 1000);
    const queueMeters = Math.max(0, Number(state.queueLengthMeters) || 0);
    const aftermathSeconds = status === 'residual' ? Math.max(0, Number(state.aftermathSeconds) || 0) : 0;
    const summary = String(state.summary || this._planningText('traffic_unknown', 'File-impact onbekend'));

    const queueLengthKm = Math.round(queueMeters / 100) / 10;
    const aftermathDisplay = status === 'residual' ? this._formatDurationMs(aftermathSeconds * 1000) : '—';
    await this._set('bridge_traffic_status', status);
    await this._set('bridge_traffic_summary', summary);
    await this._set('bridge_queue_length', queueLengthKm);
    await this._set('bridge_aftermath_duration', aftermathDisplay);
    await this._syncTrafficPresentation(status, queueLengthKm, aftermathDisplay);
    await this.setStoreValue('impact_aftermath_seconds', aftermathSeconds);
    if (status === 'residual') {
      const existing = this._timeMs(this.getStoreValue('impact_aftermath_started_at'));
      if (!Number.isFinite(existing)) {
        const closed = this._timeMs(this.getStoreValue('last_closed_at'));
        await this.setStoreValue('impact_aftermath_started_at', new Date(Number.isFinite(closed) ? closed : Date.now()).toISOString());
      }
    } else {
      await this.setStoreValue('impact_aftermath_started_at', '');
      this._lastAftermathSeconds = null;
    }
    if (state.publicationTime) await this.setStoreValue('traffic_publication_time', String(state.publicationTime));
    await this.setStoreValue('traffic_last_success', String(state.checkedAt || new Date().toISOString()));
    if (state.evidence) await this.setStoreValue('impact_evidence', String(state.evidence));
    await this.setStoreValue('impact_road', String(state.road || ''));
    await this.setStoreValue('impact_delay_seconds', Math.max(0, Number(state.delaySeconds) || 0));

    const first = !this._impactBootSynced;
    this._impactBootSynced = true;
    if (!first && this.homey.app && typeof this.homey.app.triggerBridge === 'function') {
      const tokens = this._impactTokens(status, previous, state);
      if (previous !== status) {
        if (!['queue', 'residual'].includes(previous) && ['queue', 'residual'].includes(status)) {
          await this.homey.app.triggerBridge('bridge_queue_started', this, tokens, { previous, current: status });
        }
        if (status === 'residual' && previous !== 'residual') {
          await this.homey.app.triggerBridge('bridge_queue_residual', this, tokens, { previous, current: status });
        }
        if (['queue', 'residual'].includes(previous) && status === 'clear') {
          await this.homey.app.triggerBridge('bridge_queue_recovered', this, tokens, { previous, current: status });
        }
      }
      if (queueMeters !== previousQueueMeters && queueMeters > 0) {
        await this.homey.app.triggerBridge('bridge_queue_longer_than', this, tokens, {
          previous_meters: previousQueueMeters,
          current_meters: queueMeters,
        });
      }
    }
    this._lastQueueLengthMeters = queueMeters;
    if (this.homey.app && typeof this.homey.app.notifyRoutes === 'function') this.homey.app.notifyRoutes();
    if (this.homey.app && typeof this.homey.app.emitDashboardChanged === 'function') this.homey.app.emitDashboardChanged();
  }

  async onTrafficError(err) {
    this.log(`NDW bridge-impact data temporarily unavailable: ${err && err.message ? err.message : err}`);
    await this._set('bridge_traffic_status', 'unknown');
    await this._set('bridge_traffic_summary', this._planningText('traffic_unavailable', 'File-impact tijdelijk niet bereikbaar'));
    await this._syncTrafficPresentation('unknown', 0, '—');
    if (this.homey.app && typeof this.homey.app.notifyRoutes === 'function') this.homey.app.notifyRoutes();
  }

  async _handlePlanningChange(previousPlan, state) {
    if (!state || state.feedSource !== 'planning' || !this._planningBootSynced) return;
    const planning = state.planningState || {};
    const oldStart = this._isoOrEmpty(previousPlan && previousPlan.start);
    const oldEnd = this._isoOrEmpty(previousPlan && previousPlan.end);
    const newStart = this._isoOrEmpty(planning.plannedStart || planning.nextOpening);
    const newEnd = this._isoOrEmpty(planning.plannedEnd);
    const now = Date.now();
    const oldStartMs = Date.parse(oldStart);
    const futureOld = Number.isFinite(oldStartMs) && oldStartMs > now + 60 * 1000;
    if (!futureOld) return;

    const name = String(this.getStoreValue('bridge_name') || this.getName());
    if (newStart && (newStart !== oldStart || newEnd !== oldEnd)) {
      await this.homey.app.triggerBridge('bridge_planned_changed', this, {
        bridge_name: name,
        old_planned_start: this._formatTime(oldStart),
        old_planned_end: this._formatTime(oldEnd),
        new_planned_start: this._formatTime(newStart),
        new_planned_end: this._formatTime(newEnd),
      }, { old_start: oldStart, new_start: newStart });
      return;
    }

    const cancelled = !newStart && (String(planning.status || '') === 'closed' || Number(planning.missingSnapshots || 0) >= 2);
    if (cancelled && String(state.status || '') !== 'open') {
      await this.homey.app.triggerBridge('bridge_planned_cancelled', this, {
        bridge_name: name,
        planned_start: this._formatTime(oldStart),
        planned_end: this._formatTime(oldEnd),
      }, { old_start: oldStart });
    }
  }

  async _markCurrentDataSuccess(value) {
    const ms = this._timeMs(value);
    const timestamp = Number.isFinite(ms) ? ms : Date.now();
    await this.setStoreValue('last_successful_current_at', new Date(timestamp).toISOString());
    this._lastDataAgeSeconds = 0;
  }

  async _handleOpenState(previous, next, state) {
    const now = Date.now();
    if (next === 'open') {
      const existing = this._timeMs(this.getStoreValue('open_started_at'));
      const eventStart = this._timeMs(state && state.event && state.event.start);
      let start = Number.isFinite(existing) ? existing : (Number.isFinite(eventStart) ? eventStart : now);
      if (previous !== 'open' && Number.isFinite(eventStart)) start = eventStart;
      await this.setStoreValue('open_started_at', new Date(start).toISOString());
      await this._set('bridge_open_since', this._formatTime(start));
      const seconds = Math.max(0, Math.floor((now - start) / 1000));
      await this._set('bridge_open_duration', this._formatDurationMs(seconds * 1000));
      if (previous !== 'open') this._lastOpenDurationSeconds = 0;
      else if (this._lastOpenDurationSeconds === null) this._lastOpenDurationSeconds = seconds;
      return;
    }

    if (previous === 'open') {
      const start = this._timeMs(this.getStoreValue('open_started_at'));
      await this.setStoreValue('last_closed_at', new Date(now).toISOString());
      const eventEnd = this._timeMs(state && state.event && state.event.end);
      const end = Number.isFinite(eventEnd) && eventEnd >= start ? eventEnd : now;
      if (Number.isFinite(start)) {
        const seconds = Math.max(0, Math.floor((end - start) / 1000));
        await this.setStoreValue('last_open_duration_seconds', seconds);
        await this._set('bridge_last_open_duration', this._formatDurationMs(seconds * 1000));
        await this._recordOpening(start, end, seconds);
      }
    }
    await this.setStoreValue('open_started_at', '');
    this._lastOpenDurationSeconds = null;
    await this._set('bridge_open_since', '—');
    await this._set('bridge_open_duration', '—');
  }

  async onBridgeState(state) {
    const previous = String(this.getCapabilityValue('bridge_status') || 'unknown');
    const next = String(state.status || 'unknown');
    const previousPlan = {
      start: String(this.getStoreValue('planning_start') || this.getStoreValue('planning_next_opening') || ''),
      end: String(this.getStoreValue('planning_end') || ''),
      status: String(this.getStoreValue('planning_status') || 'unknown'),
    };

    await this._set('bridge_status', next);
    await this._set('bridge_open_state', this._openStateForStatus(next));
    await this._set('bridge_last_check', this._formatTime(state.checkedAt));
    if (state.feedSource === 'current') await this._set('bridge_data_status', state.dataStatus || 'ok');

    const planningState = state.planningState || {};
    const currentState = state.currentState || {};
    if (state.feedSource === 'planning') await this.setStoreValue('planning_feed_error', false);
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
    await this._set('bridge_next_opening', this._nextOpeningDisplay(state));

    await this._handleOpenState(previous, next, state);
    if (state.feedSource === 'current') {
      await this._markCurrentDataSuccess(state.checkedAt);
      if (previous !== next && this.homey.app && typeof this.homey.app.notifyTrafficMonitoring === 'function') {
        this.homey.app.notifyTrafficMonitoring();
      }
    }
    await this._updateHistoryStats(Date.now());
    if (state.feedSource === 'planning') {
      if (this._planningBootSynced) await this._handlePlanningChange(previousPlan, state);
      else this._planningBootSynced = true;
    }
    if (this.homey.app && typeof this.homey.app.notifyRoutes === 'function') this.homey.app.notifyRoutes();

    const firstSync = !this._bootSynced;
    if (firstSync) {
      this._bootSynced = true;
      const start = this._timeMs(this.getStoreValue('open_started_at'));
      if (next === 'open' && Number.isFinite(start)) this._lastOpenDurationSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      this._syncPlannedCountdownWithoutTrigger();
      return;
    }

    if (previous === next) return;
    const tokens = this._eventTokens(next, previous, state);
    const flowState = { previous, current: next };
    await this.homey.app.triggerBridge('bridge_status_changed', this, tokens, flowState);
    if (next === 'open') await this.homey.app.triggerBridge('bridge_opened', this, tokens, flowState);
    else if (next === 'closed' && (previous === 'open' || previous === 'planned')) await this.homey.app.triggerBridge('bridge_closed', this, tokens, flowState);
    else if (next === 'planned') await this.homey.app.triggerBridge('bridge_planned', this, tokens, flowState);
  }

  async onFeedHeartbeat(checkedAt) {
    await this._set('bridge_last_check', this._formatTime(checkedAt));
    await this._markCurrentDataSuccess(checkedAt);
    const snapshotKnown = this.getStoreValue('current_snapshot_known') === true;
    await this._set('bridge_data_status', snapshotKnown ? 'ok' : 'unknown');
    if (!this._bootSynced) {
      this._bootSynced = true;
      this._syncPlannedCountdownWithoutTrigger();
    }
    if (this.homey.app && typeof this.homey.app.notifyRoutes === 'function') this.homey.app.notifyRoutes();
  }

  async onPlanningFeedHeartbeat() {
    await this.setStoreValue('planning_feed_error', false);
    this._planningBootSynced = true;
    const planningState = this._planningStateFromStore();
    await this._set('bridge_next_opening', this._nextOpeningDisplay({
      nextOpening: planningState.nextOpening,
      planningState,
    }));
    if (this.homey.app && typeof this.homey.app.notifyRoutes === 'function') this.homey.app.notifyRoutes();
  }

  async onPlanningFeedError(err) {
    this.log(`NDW planning temporarily unavailable: ${err && err.message ? err.message : err}`);
    await this.setStoreValue('planning_feed_error', true);
    await this._set('bridge_next_opening', this._planningText('unavailable', 'Planning unavailable'));
    if (this.homey.app && typeof this.homey.app.notifyRoutes === 'function') this.homey.app.notifyRoutes();
  }

  async onFeedError(err) {
    this.log(`NDW temporarily unavailable: ${err && err.message ? err.message : err}`);
    await this._set('bridge_data_status', 'error');
    if (this.homey.app && typeof this.homey.app.notifyRoutes === 'function') this.homey.app.notifyRoutes();
  }

  _syncPlannedCountdownWithoutTrigger() {
    const plannedStart = this._isoOrEmpty(this.getStoreValue('planning_start') || this.getStoreValue('planning_next_opening'));
    if (!plannedStart) {
      this._plannedCountdown = null;
      return;
    }
    const seconds = Math.floor((Date.parse(plannedStart) - Date.now()) / 1000);
    this._plannedCountdown = { start: plannedStart, seconds };
  }

  async _evaluateOpenDuration(now) {
    if (String(this.getCapabilityValue('bridge_status') || 'unknown') !== 'open') return;
    const start = this._timeMs(this.getStoreValue('open_started_at'));
    if (!Number.isFinite(start)) return;
    const currentSeconds = Math.max(0, Math.floor((now - start) / 1000));
    await this._set('bridge_open_since', this._formatTime(start));
    await this._set('bridge_open_duration', this._formatDurationMs(currentSeconds * 1000));

    if (!this._bootSynced || this._lastOpenDurationSeconds === null) {
      this._lastOpenDurationSeconds = currentSeconds;
      return;
    }
    const previousSeconds = this._lastOpenDurationSeconds;
    this._lastOpenDurationSeconds = currentSeconds;
    if (currentSeconds <= previousSeconds || Math.floor(currentSeconds / 60) === Math.floor(previousSeconds / 60)) return;

    const tokens = {
      bridge_name: String(this.getStoreValue('bridge_name') || this.getName()),
      open_duration: this._formatDurationMs(currentSeconds * 1000),
      open_duration_seconds: currentSeconds,
      started_at: this._formatTime(start),
    };
    await this.homey.app.triggerBridge('bridge_open_longer_than', this, tokens, {
      previous_seconds: previousSeconds,
      current_seconds: currentSeconds,
    });
  }

  async _evaluatePlannedCountdown(now) {
    if (!this._bootSynced) {
      this._syncPlannedCountdownWithoutTrigger();
      return;
    }
    const plannedStart = this._isoOrEmpty(this.getStoreValue('planning_start') || this.getStoreValue('planning_next_opening'));
    if (!plannedStart) {
      this._plannedCountdown = null;
      return;
    }
    const startMs = Date.parse(plannedStart);
    if (!Number.isFinite(startMs)) {
      this._plannedCountdown = null;
      return;
    }
    const currentSeconds = Math.floor((startMs - now) / 1000);
    if (currentSeconds < -60) {
      this._plannedCountdown = null;
      return;
    }

    let previousSeconds;
    if (!this._plannedCountdown || this._plannedCountdown.start !== plannedStart) {
      previousSeconds = 1e12;
      this._plannedCountdown = { start: plannedStart, seconds: currentSeconds };
    } else {
      previousSeconds = this._plannedCountdown.seconds;
      this._plannedCountdown.seconds = currentSeconds;
    }

    const crossedMinute = Math.ceil(currentSeconds / 60) !== Math.ceil(previousSeconds / 60);
    const newlyDiscovered = previousSeconds === 1e12;
    if (!newlyDiscovered && !crossedMinute) return;

    const plannedEnd = this.getStoreValue('planning_end');
    const tokens = {
      bridge_name: String(this.getStoreValue('bridge_name') || this.getName()),
      planned_start: this._formatTime(plannedStart),
      planned_end: this._formatTime(plannedEnd),
      minutes_until: Math.max(0, Math.ceil(currentSeconds / 60)),
    };
    await this.homey.app.triggerBridge('bridge_planned_within', this, tokens, {
      previous_seconds: previousSeconds,
      current_seconds: currentSeconds,
    });
  }

  async _evaluateAftermath(now) {
    if (String(this.getCapabilityValue('bridge_traffic_status') || 'unknown') !== 'residual') return;
    const start = this._timeMs(this.getStoreValue('impact_aftermath_started_at'));
    if (!Number.isFinite(start)) return;
    const currentSeconds = Math.max(0, Math.floor((now - start) / 1000));
    await this.setStoreValue('impact_aftermath_seconds', currentSeconds);
    const display = this._formatDurationMs(currentSeconds * 1000);
    await this._set('bridge_aftermath_duration', display);
    await this._set('bridge_aftermath_display', display);
    if (!this._impactBootSynced || this._lastAftermathSeconds === null) {
      this._lastAftermathSeconds = currentSeconds;
      return;
    }
    const previousSeconds = this._lastAftermathSeconds;
    this._lastAftermathSeconds = currentSeconds;
    if (currentSeconds <= previousSeconds || Math.floor(currentSeconds / 60) === Math.floor(previousSeconds / 60)) return;
    const state = {
      queueLengthMeters: Math.max(0, Number(this.getCapabilityValue('bridge_queue_length') || 0) * 1000),
      aftermathSeconds: currentSeconds,
      road: '',
      summary: String(this.getCapabilityValue('bridge_traffic_summary') || ''),
    };
    await this.homey.app.triggerBridge('bridge_aftermath_longer_than', this, this._impactTokens('residual', 'residual', state), {
      previous_seconds: previousSeconds,
      current_seconds: currentSeconds,
    });
  }

  async _evaluateDataAge(now) {
    const lastSuccess = this._timeMs(this.getStoreValue('last_successful_current_at'));
    if (!Number.isFinite(lastSuccess)) return;
    const currentSeconds = Math.max(0, Math.floor((now - lastSuccess) / 1000));
    if (currentSeconds * 1000 >= STALE_STATUS_AFTER_MS && this.getCapabilityValue('bridge_data_status') === 'ok') {
      await this._set('bridge_data_status', 'stale');
    }

    if (!this._bootSynced || this._lastDataAgeSeconds === null) {
      this._lastDataAgeSeconds = currentSeconds;
      return;
    }
    const previousSeconds = this._lastDataAgeSeconds;
    this._lastDataAgeSeconds = currentSeconds;
    if (currentSeconds <= previousSeconds || Math.floor(currentSeconds / 60) === Math.floor(previousSeconds / 60)) return;

    const tokens = {
      bridge_name: String(this.getStoreValue('bridge_name') || this.getName()),
      data_age: this._formatDurationMs(currentSeconds * 1000),
      data_age_seconds: currentSeconds,
      last_successful_check: this._formatTime(lastSuccess),
    };
    await this.homey.app.triggerBridge('bridge_data_stale', this, tokens, {
      previous_seconds: previousSeconds,
      current_seconds: currentSeconds,
    });
  }

  async _runtimeTick() {
    if (this._tickBusy) return;
    this._tickBusy = true;
    try {
      const now = Date.now();
      await this._evaluateOpenDuration(now);
      await this._evaluatePlannedCountdown(now);
      await this._evaluateAftermath(now);
      await this._evaluateDataAge(now);
      const statsMinute = Math.floor(now / 60000);
      if (this._lastStatsMinute !== statsMinute) {
        this._lastStatsMinute = statsMinute;
        await this._updateHistoryStats(now);
      }
    } finally {
      this._tickBusy = false;
    }
  }
}

BridgeDevice.DEVICE_TICK_MS = DEVICE_TICK_MS;
BridgeDevice.STALE_STATUS_AFTER_MS = STALE_STATUS_AFTER_MS;
module.exports = BridgeDevice;
