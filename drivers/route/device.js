'use strict';
const Homey = require('homey');

const ROUTE_TICK_MS = 5 * 1000;
const HISTORY_DAYS = 180;
const HISTORY_LIMIT = 500;

class RouteDevice extends Homey.Device {
  async onInit() {
    this.log(`Route device init: ${this.getName()}`);
    this._bootSynced = false;
    this._trafficBootSynced = false;
    this._refreshBusy = false;
    this._lastQueueLengthMeters = null;
    this._lastAftermathSeconds = null;
    this._lastPlanSignature = String(this.getStoreValue('route_plan_signature') || '');
    this._lastStatsMinute = null;
    await this._ensureCapabilities();
    await this._ensureDefaults();
    await this._syncTrafficPresentation(
      String(this.getCapabilityValue('route_traffic_status') || 'unknown'),
      Number(this.getCapabilityValue('route_queue_length') || 0),
      String(this.getCapabilityValue('route_aftermath_duration') || '—'),
    );
    if (this.homey.app && typeof this.homey.app.registerRouteDevice === 'function') this.homey.app.registerRouteDevice(this);
    this._timer = setInterval(() => this.refreshRoute().catch(err => this.log(`Route refresh failed: ${err && err.message ? err.message : err}`)), ROUTE_TICK_MS);
    await this.refreshRoute();
  }

  async onDeleted() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.homey.app && typeof this.homey.app.unregisterRouteDevice === 'function') this.homey.app.unregisterRouteDevice(this);
  }

  async _ensureCapabilities() {
    const required = [
      'route_status','route_problem_bridge','route_next_opening','route_summary','route_bridge_count','route_open_count','route_announced_count',
      'route_blockages_today','route_blocked_time_today','route_average_blockage_duration','route_longest_blockage_duration',
      'route_traffic_status','route_traffic_summary','route_queue_length','route_aftermath_duration',
    ];
    for (const capability of required) if (!this.hasCapability(capability)) await this.addCapability(capability);
  }

  async _ensureDefaults() {
    const defaults = {
      route_status: 'unknown',
      route_problem_bridge: '—',
      route_next_opening: this._t('route.no_announcement', 'Geen aankondiging'),
      route_summary: this._t('route.waiting', 'Wachten op brugdata'),
      route_bridge_count: 1,
      route_open_count: 0,
      route_announced_count: 0,
      route_blockages_today: 0,
      route_blocked_time_today: '0 sec',
      route_average_blockage_duration: '—',
      route_longest_blockage_duration: '—',
      route_traffic_status: 'unknown',
      route_traffic_summary: this._t('route.traffic_waiting', 'Wachten op file-impact'),
      route_queue_length: 0,
      route_aftermath_duration: '—',
    };
    for (const [cap, value] of Object.entries(defaults)) {
      if (this.hasCapability(cap) && (this.getCapabilityValue(cap) === null || typeof this.getCapabilityValue(cap) === 'undefined')) {
        await this.setCapabilityValue(cap, value);
      }
    }
    const impactStatus = String(this.getCapabilityValue('route_traffic_status') || 'unknown');
    if (!['unknown', 'clear', 'queue', 'residual'].includes(impactStatus)) {
      await this._set('route_traffic_status', 'unknown');
      await this._set('route_traffic_summary', this._t('route.traffic_waiting', 'Wachten op file-impact'));
      await this._set('route_queue_length', 0);
      await this._set('route_aftermath_duration', '—');
    }
  }

  _t(key, fallback) {
    const value = this.homey.__(key);
    return value === key ? fallback : value;
  }

  _timezone() {
    try { return (this.homey.clock && this.homey.clock.getTimezone && this.homey.clock.getTimezone()) || 'Europe/Amsterdam'; }
    catch (_) { return 'Europe/Amsterdam'; }
  }

  _formatTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '—';
    const lang = (this.homey.i18n && this.homey.i18n.getLanguage && this.homey.i18n.getLanguage()) || 'nl';
    try {
      return new Intl.DateTimeFormat(lang, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', timeZone: this._timezone() }).format(d);
    } catch (_) { return d.toISOString().slice(0,16).replace('T',' '); }
  }

  _formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const lang = (this.homey.i18n && this.homey.i18n.getLanguage && this.homey.i18n.getLanguage()) || 'nl';
    const hourLabel = String(lang).toLowerCase().startsWith('nl') ? 'u' : 'h';
    if (hours > 0) return `${hours} ${hourLabel} ${String(minutes).padStart(2,'0')} min`;
    if (minutes > 0) return `${minutes} min ${String(secs).padStart(2,'0')} sec`;
    return `${secs} sec`;
  }

  _timeMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = value ? Date.parse(String(value)) : NaN;
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  _zonedParts(ms) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: this._timezone(), year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
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
    const start = this._zonedDateTimeToUtc(p.year, p.month, p.day);
    const nextDate = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    const end = this._zonedDateTimeToUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate());
    return { start, end };
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
      for (const capability of ['route_aftermath_display', 'route_queue_length_display', 'route_traffic_display']) {
        await this._removePresentationCapability(capability);
      }
      return;
    }

    await this._addPresentationCapability('route_traffic_display');
    await this._addPresentationCapability('route_queue_length_display');
    await this._set('route_traffic_display', String(status));
    await this._set('route_queue_length_display', Math.max(0, Number(queueLengthKm) || 0));

    if (String(status) === 'residual') {
      await this._addPresentationCapability('route_aftermath_display');
      await this._set('route_aftermath_display', String(aftermathDuration || '—'));
    } else {
      await this._removePresentationCapability('route_aftermath_display');
    }
  }

  _bridgeIds() {
    const value = this.getStoreValue('bridge_ids');
    return Array.isArray(value) ? value.map(id => String(id || '').toUpperCase()).filter(Boolean) : [];
  }

  getBridgeIds() { return this._bridgeIds(); }

  async setBridgeIds(ids, names = []) {
    const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim().toUpperCase()).filter(Boolean))];
    if (!normalized.length) throw new Error(this._t('route_pair.bridge_required', 'Selecteer minimaal één brug.'));
    await this.setStoreValue('bridge_ids', normalized);
    await this.setStoreValue('bridge_names', normalized.map((id, index) => String(names[index] || id)));
    this._bootSynced = false;
    this._trafficBootSynced = false;
    this._lastQueueLengthMeters = null;
    this._lastAftermathSeconds = null;
    this._lastPlanSignature = '';
    await this.setStoreValue('route_plan_signature', '');
    await this.refreshRoute();
    return normalized;
  }

  _bridgeSnapshots() {
    const ids = this._bridgeIds();
    const storedNames = Array.isArray(this.getStoreValue('bridge_names')) ? this.getStoreValue('bridge_names') : [];
    const names = new Map(ids.map((id, index) => [id, String(storedNames[index] || id)]));
    const devices = this.homey.app && typeof this.homey.app.getBridgeDevices === 'function' ? this.homey.app.getBridgeDevices() : [];
    const map = new Map(devices.map(device => [String((device.getData() || {}).id || '').toUpperCase(), device]));
    return ids.map(id => {
      const device = map.get(id);
      if (!device) return { id, name: names.get(id) || id, missing: true, currentKnown: false, status: 'unknown', dataStatus: 'unknown', plannedStart: '', trafficStatus:'unknown', trafficSummary:'', queueLengthKm:0, aftermathSeconds:0 };
      if (typeof device.getRouteSnapshot === 'function') return device.getRouteSnapshot();
      return {
        id,
        name: device.getName(),
        status: String(device.getCapabilityValue('bridge_status') || 'unknown'),
        dataStatus: String(device.getCapabilityValue('bridge_data_status') || 'unknown'),
        plannedStart: String(device.getStoreValue('planning_start') || device.getStoreValue('planning_next_opening') || ''),
        plannedEnd: String(device.getStoreValue('planning_end') || ''),
        currentKnown: device.getStoreValue('current_snapshot_known') === true,
        trafficStatus: String(device.getCapabilityValue('bridge_traffic_status') || 'unknown'),
        trafficSummary: String(device.getCapabilityValue('bridge_traffic_summary') || ''),
        queueLengthKm: Number(device.getCapabilityValue('bridge_queue_length') || 0),
        aftermathSeconds: Number(device.getStoreValue('impact_aftermath_seconds') || 0),
      };
    });
  }

  _calculateTraffic(valid) {
    if (!valid.length) return { status:'unknown', summary:this._t('route.traffic_waiting','Wachten op file-impact'), queueLengthKm:0, aftermathSeconds:0, bridge:'—' };
    const impacted = valid.filter(x => ['queue','residual'].includes(String(x.trafficStatus || 'unknown')));
    const unknown = valid.some(x => String(x.trafficStatus || 'unknown') === 'unknown');
    if (!impacted.length) {
      if (unknown) return { status:'unknown', summary:this._t('route.traffic_unknown','File-impact voor deze route is niet volledig beschikbaar.'), queueLengthKm:0, aftermathSeconds:0, bridge:'—' };
      return { status:'clear', summary:this._t('route.traffic_clear','Geen file door een brugopening op deze route.'), queueLengthKm:0, aftermathSeconds:0, bridge:'—' };
    }
    const queueing = impacted.filter(x => String(x.trafficStatus) === 'queue');
    const status = queueing.length ? 'queue' : 'residual';
    const candidates = status === 'queue' ? queueing : impacted;
    const worst = candidates.slice().sort((a,b) => Number(b.queueLengthKm || 0) - Number(a.queueLengthKm || 0))[0] || candidates[0];
    const queueLengthKm = candidates.reduce((max,x)=>Math.max(max,Number(x.queueLengthKm)||0),0);
    const aftermathSeconds = candidates.reduce((max,x)=>Math.max(max,Number(x.aftermathSeconds)||0),0);
    const prefix = status === 'queue'
      ? this._t('route.traffic_queue','File door brugopening bij')
      : this._t('route.traffic_residual','Nasleep van brugopening bij');
    return {
      status,
      summary: `${prefix} ${worst.name || 'brug'}${worst.trafficSummary ? ` · ${worst.trafficSummary}` : ''}`,
      queueLengthKm,
      aftermathSeconds,
      bridge: worst.name || '—',
    };
  }

  _calculate(snapshots) {
    const now = Date.now();
    const valid = Array.isArray(snapshots) ? snapshots : [];
    const open = valid.filter(x => x.status === 'open');
    const uncertain = valid.filter(x => x.missing || x.currentKnown === false || x.status === 'unknown' || ['error','unknown','stale','coverage_unknown'].includes(String(x.dataStatus || 'unknown')));
    if (!valid.length) uncertain.push({ name: '—', missing: true, status: 'unknown', dataStatus: 'unknown' });
    const announced = valid.filter(x => {
      const t = Date.parse(String(x.plannedStart || ''));
      return x.status === 'planned' || (Number.isFinite(t) && t >= now - 60 * 1000);
    }).sort((a,b) => Date.parse(a.plannedStart || '9999') - Date.parse(b.plannedStart || '9999'));

    let status = 'free';
    let relevant = [];
    if (open.length) { status = 'blocked'; relevant = open; }
    else if (uncertain.length) { status = 'unknown'; relevant = uncertain; }
    else if (announced.length) { status = 'announced'; relevant = [announced[0]]; }

    const next = announced[0] || null;
    const relevantNames = relevant.map(x => x.name).filter(Boolean);
    let summary;
    if (status === 'blocked') {
      summary = open.length === 1
        ? this._t('route.blocked_one', 'Geblokkeerd: {bridge} is open.').replace('{bridge}', open[0].name)
        : this._t('route.blocked_many', 'Geblokkeerd: {count} bruggen zijn open.').replace('{count}', String(open.length));
    } else if (status === 'unknown') {
      summary = this._t('route.uncertain', 'Status onzeker: geen betrouwbare actuele data voor {bridge}.').replace('{bridge}', relevantNames.join(', ') || '—');
    } else if (status === 'announced') {
      summary = this._t('route.announced', 'Route is nu vrij; opening aangekondigd bij {bridge} om {time}.')
        .replace('{bridge}', next ? next.name : '—').replace('{time}', next ? this._formatTime(next.plannedStart) : '—');
    } else summary = this._t('route.free', 'Alle bruggen op deze route zijn dicht.');

    const traffic = this._calculateTraffic(valid);
    const problemBridge = relevantNames.length ? relevantNames.join(', ') : '—';
    const nextOpening = next ? `${next.name} · ${this._formatTime(next.plannedStart)}` : this._t('route.no_announcement', 'Geen aankondiging');
    const planSignature = next ? `${next.id}|${next.plannedStart || ''}|${next.plannedEnd || ''}` : '';

    return {
      status, problemBridge, nextOpening, summary,
      bridgeCount: valid.length, openCount: open.length, announcedCount: announced.length,
      planSignature, nextPlan: next,
      trafficStatus: traffic.status, trafficSummary: traffic.summary,
      queueLengthKm: traffic.queueLengthKm, aftermathSeconds: traffic.aftermathSeconds, impactBridge: traffic.bridge,
    };
  }

  _history() {
    const raw = this.getStoreValue('route_blockage_history');
    if (Array.isArray(raw)) return raw.filter(x => x && Number.isFinite(Number(x.durationSeconds)));
    if (typeof raw === 'string' && raw) {
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter(x => x && Number.isFinite(Number(x.durationSeconds))) : []; }
      catch (_) { return []; }
    }
    return [];
  }

  async _recordBlockage(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
    const history = this._history();
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const durationSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
    if (!history.some(item => item.start === start && item.end === end)) history.push({ start, end, durationSeconds });
    const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const trimmed = history.filter(item => this._timeMs(item.end) >= cutoff).sort((a,b) => this._timeMs(a.start)-this._timeMs(b.start)).slice(-HISTORY_LIMIT);
    await this.setStoreValue('route_blockage_history', trimmed);
  }

  async _handleBlockageTransition(previousStatus, currentStatus, now = Date.now()) {
    let started = this._timeMs(this.getStoreValue('route_blocked_started_at'));
    if (currentStatus === 'blocked') {
      if (!Number.isFinite(started)) await this.setStoreValue('route_blocked_started_at', new Date(now).toISOString());
      return;
    }
    if (previousStatus === 'blocked' && Number.isFinite(started)) {
      await this._recordBlockage(started, now);
      await this.setStoreValue('route_blocked_started_at', '');
    } else if (currentStatus !== 'blocked' && Number.isFinite(started)) {
      // Repair a stale active marker after a reboot or route edit without inventing extra duration.
      await this._recordBlockage(started, now);
      await this.setStoreValue('route_blocked_started_at', '');
    }
  }

  async _updateHistoryStats(now = Date.now()) {
    const history = this._history();
    const {start:dayStart,end:dayEnd} = this._todayBounds(now);
    let count = 0;
    let seconds = 0;
    for (const item of history) {
      const start = this._timeMs(item.start); const end = this._timeMs(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start >= dayStart && start < dayEnd) count += 1;
      seconds += Math.floor(Math.max(0, Math.min(end, Math.min(now, dayEnd)) - Math.max(start, dayStart)) / 1000);
    }
    const activeStart = this._timeMs(this.getStoreValue('route_blocked_started_at'));
    if (String(this.getCapabilityValue('route_status') || '') === 'blocked' && Number.isFinite(activeStart)) {
      if (activeStart >= dayStart && activeStart < dayEnd) count += 1;
      seconds += Math.floor(Math.max(0, Math.min(now, dayEnd) - Math.max(activeStart, dayStart)) / 1000);
    }
    const durations = history.map(x => Number(x.durationSeconds)).filter(Number.isFinite);
    const avg = durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : null;
    const longest = durations.length ? Math.max(...durations) : null;
    await this._set('route_blockages_today', count);
    await this._set('route_blocked_time_today', this._formatDuration(seconds));
    await this._set('route_average_blockage_duration', avg === null ? '—' : this._formatDuration(avg));
    await this._set('route_longest_blockage_duration', longest === null ? '—' : this._formatDuration(longest));
  }

  getHistorySnapshot(now = Date.now()) {
    const history = this._history().slice().sort((a,b)=>this._timeMs(a.start)-this._timeMs(b.start));
    const byHour = Array.from({length:24},(_,hour)=>({hour,count:0,seconds:0}));
    const byWeekday = Array.from({length:7},(_,weekday)=>({weekday,count:0,seconds:0}));
    for (const item of history) {
      const start=this._timeMs(item.start); if(!Number.isFinite(start)) continue;
      const seconds=Math.max(0,Number(item.durationSeconds)||0);
      const parts=this._zonedParts(start); if(byHour[parts.hour]){byHour[parts.hour].count+=1;byHour[parts.hour].seconds+=seconds;}
      const name=new Intl.DateTimeFormat('en-US',{timeZone:this._timezone(),weekday:'short'}).format(new Date(start));
      const wi=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(name); if(wi>=0){byWeekday[wi].count+=1;byWeekday[wi].seconds+=seconds;}
    }
    const activeStart=this._timeMs(this.getStoreValue('route_blocked_started_at'));
    return {
      measurementStartedAt: history.length ? history[0].start : (Number.isFinite(activeStart) ? new Date(activeStart).toISOString() : ''),
      totalBlockages: history.length,
      blockagesToday: Number(this.getCapabilityValue('route_blockages_today') || 0),
      blockedTimeToday: String(this.getCapabilityValue('route_blocked_time_today') || '0 sec'),
      averageDuration: String(this.getCapabilityValue('route_average_blockage_duration') || '—'),
      longestDuration: String(this.getCapabilityValue('route_longest_blockage_duration') || '—'),
      latest: history.slice(-10).reverse(), byHour, byWeekday,
      currentBlockedSince: Number.isFinite(activeStart) ? new Date(activeStart).toISOString() : '',
      now: new Date(now).toISOString(),
    };
  }

  _trafficLabel(status) {
    const key = `traffic_status.${status}`;
    const value = this.homey.__(key);
    return value === key ? status : value;
  }

  _tokens(result, previousStatus = '') {
    return {
      route_name: this.getName(),
      route_status: this._t(`route_status.${result.status}`, result.status),
      route_status_id: result.status,
      previous_route_status: previousStatus ? this._t(`route_status.${previousStatus}`, previousStatus) : '',
      previous_route_status_id: previousStatus,
      relevant_bridge: result.problemBridge,
      next_opening: result.nextOpening,
      summary: result.summary,
      bridge_count: result.bridgeCount,
      open_bridge_count: result.openCount,
      announced_opening_count: result.announcedCount,
      traffic_status: this._trafficLabel(result.trafficStatus),
      traffic_status_id: result.trafficStatus,
      traffic_summary: result.trafficSummary,
      queue_length_km: Number(result.queueLengthKm || 0),
      aftermath_duration: result.aftermathSeconds > 0 ? this._formatDuration(result.aftermathSeconds) : '—',
      aftermath_seconds: Number(result.aftermathSeconds || 0),
      impact_bridge: result.impactBridge || '—',
      road_clear: ['free','announced'].includes(result.status) && result.trafficStatus === 'clear' ? 'yes' : 'no',
      blockages_today: Number(this.getCapabilityValue('route_blockages_today') || 0),
      blocked_time_today: String(this.getCapabilityValue('route_blocked_time_today') || '0 sec'),
    };
  }

  async refreshRoute() {
    if (this._refreshBusy) return this.getDepartureScanResult();
    this._refreshBusy = true;
    try {
      const now = Date.now();
      const previousStatus = String(this.getCapabilityValue('route_status') || 'unknown');
      const previousTraffic = String(this.getCapabilityValue('route_traffic_status') || 'unknown');
      const previousQueueMeters = Math.max(0, Number(this.getCapabilityValue('route_queue_length') || 0) * 1000);
      const previousAftermathSeconds = Number(this._lastAftermathSeconds);
      const previousPlanSignature = this._lastPlanSignature || String(this.getStoreValue('route_plan_signature') || '');
      const snapshots = this._bridgeSnapshots();
      const readyForFlows = snapshots.length > 0 && snapshots.every(item => !item.missing && item.currentKnown !== false);
      const result = this._calculate(snapshots);

      await this._handleBlockageTransition(previousStatus, result.status, now);
      await this._set('route_status', result.status);
      await this._set('route_problem_bridge', result.problemBridge);
      await this._set('route_next_opening', result.nextOpening);
      await this._set('route_summary', result.summary);
      await this._set('route_bridge_count', Math.max(1, result.bridgeCount));
      await this._set('route_open_count', result.openCount);
      await this._set('route_announced_count', result.announcedCount);
      const queueLengthKm = Number(result.queueLengthKm || 0);
      const aftermathDisplay = result.aftermathSeconds > 0 ? this._formatDuration(result.aftermathSeconds) : '—';
      await this._set('route_traffic_status', result.trafficStatus);
      await this._set('route_traffic_summary', result.trafficSummary);
      await this._set('route_queue_length', queueLengthKm);
      await this._set('route_aftermath_duration', aftermathDisplay);
      await this._syncTrafficPresentation(result.trafficStatus, queueLengthKm, aftermathDisplay);
      await this.setStoreValue('route_plan_signature', result.planSignature);
      this._lastPlanSignature = result.planSignature;

      const statsMinute = Math.floor(now / 60000);
      if (this._lastStatsMinute !== statsMinute || previousStatus !== result.status) {
        this._lastStatsMinute = statsMinute;
        await this._updateHistoryStats(now);
      }

      if (!this._bootSynced) {
        if (readyForFlows) this._bootSynced = true;
        if (result.trafficStatus !== 'unknown') this._trafficBootSynced = true;
        this._lastQueueLengthMeters = Number(result.queueLengthKm || 0) * 1000;
        this._lastAftermathSeconds = Number(result.aftermathSeconds || 0);
        return this._tokens(result, previousStatus);
      }

      const tokens = this._tokens(result, previousStatus);
      if (previousStatus !== result.status) {
        await this.homey.app.triggerRoute('route_status_changed', this, tokens, { previous: previousStatus, current: result.status });
        if (result.status === 'blocked') await this.homey.app.triggerRoute('route_blocked', this, tokens, { previous: previousStatus, current: result.status });
        if (previousStatus === 'blocked' && ['free', 'announced'].includes(result.status)) {
          await this.homey.app.triggerRoute('route_cleared', this, tokens, { previous: previousStatus, current: result.status });
        }
      }

      const previousPlanStart = previousPlanSignature ? Date.parse(previousPlanSignature.split('|')[1] || '') : NaN;
      const previousPlanWasFuture = Number.isFinite(previousPlanStart) && previousPlanStart > now + 60 * 1000;
      if (!previousPlanSignature && result.planSignature) {
        await this.homey.app.triggerRoute('route_planned', this, tokens, { current_plan: result.planSignature });
      } else if (previousPlanSignature && result.planSignature && previousPlanSignature !== result.planSignature) {
        if (previousPlanWasFuture) await this.homey.app.triggerRoute('route_planned_changed', this, tokens, { previous_plan: previousPlanSignature, current_plan: result.planSignature });
        else await this.homey.app.triggerRoute('route_planned', this, tokens, { current_plan: result.planSignature });
      } else if (previousPlanSignature && !result.planSignature && result.status !== 'blocked' && previousPlanWasFuture) {
        await this.homey.app.triggerRoute('route_planned_cancelled', this, tokens, { previous_plan: previousPlanSignature });
      }

      const currentQueueMeters = Math.max(0, Number(result.queueLengthKm || 0) * 1000);
      const currentAftermathSeconds = Math.max(0, Number(result.aftermathSeconds || 0));
      if (!this._trafficBootSynced) {
        if (result.trafficStatus !== 'unknown') this._trafficBootSynced = true;
      } else {
        const trafficTokens = { ...tokens, previous_traffic_status: this._trafficLabel(previousTraffic), previous_traffic_status_id: previousTraffic };
        if (previousTraffic !== result.trafficStatus) {
          await this.homey.app.triggerRoute('route_traffic_changed', this, trafficTokens, { previous: previousTraffic, current: result.trafficStatus });
          const previousQueue = ['queue','residual'].includes(previousTraffic);
          const currentQueue = ['queue','residual'].includes(result.trafficStatus);
          if (!previousQueue && currentQueue) await this.homey.app.triggerRoute('route_traffic_delay', this, trafficTokens, { previous: previousTraffic, current: result.trafficStatus });
          if (result.trafficStatus === 'residual' && previousTraffic !== 'residual') await this.homey.app.triggerRoute('route_queue_residual', this, trafficTokens, { previous: previousTraffic, current: result.trafficStatus });
          if (previousQueue && result.trafficStatus === 'clear') await this.homey.app.triggerRoute('route_traffic_recovered', this, trafficTokens, { previous: previousTraffic, current: result.trafficStatus });
        }
        if (currentQueueMeters > 0 && currentQueueMeters !== previousQueueMeters) {
          await this.homey.app.triggerRoute('route_queue_longer_than', this, trafficTokens, { previous_meters: previousQueueMeters, current_meters: currentQueueMeters });
        }
        if (result.trafficStatus === 'residual' && Number.isFinite(previousAftermathSeconds) && currentAftermathSeconds > previousAftermathSeconds && Math.floor(currentAftermathSeconds/60) !== Math.floor(previousAftermathSeconds/60)) {
          await this.homey.app.triggerRoute('route_aftermath_longer_than', this, trafficTokens, { previous_seconds: previousAftermathSeconds, current_seconds: currentAftermathSeconds });
        }
      }
      this._lastQueueLengthMeters = currentQueueMeters;
      this._lastAftermathSeconds = currentAftermathSeconds;

      if (this.homey.app && typeof this.homey.app.emitDashboardChanged === 'function') this.homey.app.emitDashboardChanged();
      return tokens;
    } finally { this._refreshBusy = false; }
  }

  async getDepartureScanResult() {
    const result = this._calculate(this._bridgeSnapshots());
    return this._tokens(result, String(this.getCapabilityValue('route_status') || 'unknown'));
  }
}

RouteDevice.ROUTE_TICK_MS = ROUTE_TICK_MS;
module.exports = RouteDevice;
