'use strict';

function haversineMeters(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2].map(Number);
  if (!values.every(Number.isFinite)) return Infinity;
  const [a,b,c,d] = values; const R = 6371000; const rad = Math.PI / 180;
  const dLat = (c-a)*rad, dLon = (d-b)*rad;
  const x = Math.sin(dLat/2)**2 + Math.cos(a*rad)*Math.cos(c*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function timeValue(value, fallback = 0) { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : fallback; }
function newest(list) {
  return [...list].sort((a,b) => (b.situationVersion-a.situationVersion) || (b.recordVersion-a.recordVersion) || (timeValue(b.situationVersionTime)-timeValue(a.situationVersionTime)))[0] || null;
}
function matchRecords(records, bridge) {
  const code = String(bridge && bridge.isrs || '').trim().toUpperCase();
  const exact = (records || []).filter(r => code && String(r.isrs || '').toUpperCase() === code);
  if (exact.length) return exact;
  return (records || []).filter(r => !r.isrs && haversineMeters(bridge.lat, bridge.lon, r.latitude, r.longitude) <= 250);
}
function deriveBridgeState(records, bridge, nowMs = Date.now()) {
  const matched = matchRecords(records, bridge);
  if (!matched.length) return { seen: false, status: null, matched: [] };
  const active = matched.filter(r => r.state === 'open' && !r.ended && !r.cancelled);
  const planned = matched.filter(r => {
    if (r.state !== 'planned' || r.cancelled || r.ended) return false;
    const end = timeValue(r.end, Infinity); const start = timeValue(r.start, nowMs);
    return end >= nowMs - 5*60*1000 || start >= nowMs - 15*60*1000;
  }).sort((a,b) => timeValue(a.start, Infinity)-timeValue(b.start, Infinity));
  const closed = matched.filter(r => r.state === 'closed');
  let chosen = null; let status = 'unknown';
  if (active.length) { chosen = newest(active); status = 'open'; }
  else if (planned.length) { chosen = planned[0]; status = 'planned'; }
  else if (closed.length) { chosen = newest(closed); status = 'closed'; }
  else { chosen = newest(matched); }
  const nextOpening = planned.length ? planned[0].start : '';
  return {
    seen: true, status, matched, event: chosen,
    nextOpening, plannedStart: planned[0] ? planned[0].start : '', plannedEnd: planned[0] ? planned[0].end : '',
    probability: planned[0] ? planned[0].probability : (chosen ? chosen.probability : '')
  };
}

// Planning feed: missing records are treated conservatively. Two successful missing snapshots
// are needed before an earlier open/planned state is considered closed.
function applySnapshotPolicy(previous, derived) {
  const prev = previous || {};
  if (derived && derived.seen && derived.status) {
    return { ...derived, status: derived.status, seenInNdw: true, missingSnapshots: 0, planningSnapshotKnown: true };
  }
  const seenInNdw = Boolean(prev.seenInNdw);
  let missingSnapshots = seenInNdw ? Number(prev.missingSnapshots || 0) + 1 : 0;
  let status = String(prev.status || 'unknown');
  if (!seenInNdw) status = 'unknown';
  else if ((status === 'open' || status === 'planned') && missingSnapshots >= 2) status = 'closed';
  return {
    ...(derived || {}),
    seen: false,
    status,
    seenInNdw,
    missingSnapshots,
    planningSnapshotKnown: true,
    event: null,
    nextOpening: '',
  };
}

// Current-closures feed: every successfully parsed snapshot is authoritative for the live state.
// If the selected bridge is not present in that successful snapshot, it is not currently open and
// is therefore Closed. "Unknown" is reserved for the period before the first valid snapshot or for
// a real feed/data error. This keeps a newly paired, normally closed bridge useful immediately.
function applyCurrentSnapshotPolicy(previous, derived) {
  const prev = previous || {};
  if (derived && derived.seen && derived.status) {
    return {
      ...derived,
      status: derived.status,
      seenInCurrent: true,
      coverageKnown: true,
      currentSnapshotKnown: true,
      currentMissingSnapshots: 0,
    };
  }
  const seenInCurrent = Boolean(prev.seenInCurrent);
  const currentMissingSnapshots = Number(prev.currentMissingSnapshots || 0) + 1;
  return {
    ...(derived || {}),
    seen: false,
    status: 'closed',
    seenInCurrent,
    coverageKnown: Boolean(prev.coverageKnown || seenInCurrent),
    currentSnapshotKnown: true,
    currentMissingSnapshots,
    event: null,
    nextOpening: '',
  };
}

function mergeBridgeStates(current, planning, previousStatus = 'unknown') {
  const c = current || { status: 'unknown' };
  const p = planning || { status: 'unknown' };

  // The current-closures feed is authoritative for a current open/closed event once the bridge
  // has actually been observed there.
  if (c.status === 'open') {
    return {
      ...p,
      ...c,
      status: 'open',
      nextOpening: p.nextOpening || '',
      plannedStart: p.plannedStart || '',
      plannedEnd: p.plannedEnd || '',
      probability: p.probability || c.probability || '',
      source: 'current',
    };
  }
  if (c.status === 'closed' && c.currentSnapshotKnown) {
    // A successful current snapshot without the bridge means it is not open now. A future
    // announced opening from the planning feed may still be shown.
    if (p.status === 'planned') return { ...p, status: 'planned', source: 'planning' };
    return {
      ...p,
      ...c,
      status: 'closed',
      nextOpening: p.nextOpening || '',
      plannedStart: p.plannedStart || '',
      plannedEnd: p.plannedEnd || '',
      probability: p.probability || '',
      source: 'current',
    };
  }


  // Before the first successful current snapshot, the planning feed remains the fallback.
  if (p.status === 'open' || p.status === 'planned' || p.status === 'closed') {
    return { ...p, status: p.status, source: 'planning' };
  }

  return {
    ...p,
    ...c,
    status: String(previousStatus || 'unknown'),
    source: 'previous',
    nextOpening: p.nextOpening || '',
  };
}

module.exports = {
  haversineMeters,
  matchRecords,
  deriveBridgeState,
  applySnapshotPolicy,
  applyCurrentSnapshotPolicy,
  mergeBridgeStates,
};
