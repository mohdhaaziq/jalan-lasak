/* The schedule: where each group should be by now, and whether it is late.

   In a dead zone a silent phone is normal; a group that has not reached the
   checkpoint it was due at is not. So lateness is judged against the plan
   (each checkpoint's minutes-from-start, and the group's own start time), and
   "reached" is taken from a check-in first, and from any GPS fix within
   REACHED_M of the point as a fallback. */

import { distM, remainingAlong } from './geo.js';

export const REACHED_M = 100;
export const LATE_WARN_MS = 0;
export const LATE_BAD_MS = 15 * 60 * 1000;

/**
 * @param group  { startedAt, checkins: [{point, at}], trail: [[lat,lng,at]], last }
 * @param points ordered program points, each maybe with etaMin
 * @returns { started, reached: Map<pointId,{at,how}>, next, done, lateMs }
 *   next: { point, expectedAt } for the first scheduled checkpoint not yet
 *   reached (expectedAt null when the group has not started); lateMs > 0
 *   means overdue at `next`.
 */
export function scheduleFor(group, points, now = Date.now()) {
  const reached = new Map();
  for (const c of group.checkins || []) {
    if (!reached.has(c.point) || c.at < reached.get(c.point).at) reached.set(c.point, { at: c.at, how: 'checkin' });
  }
  const fixes = (group.trail || []).map((t) => ({ lat: t[0], lng: t[1], at: t[2] }));
  if (group.last) fixes.push({ lat: group.last.lat, lng: group.last.lng, at: group.last.at });
  for (const p of points) {
    if (reached.has(p.id)) continue;
    const hit = fixes.find((f) => distM(f, p) <= REACHED_M);
    if (hit) reached.set(p.id, { at: hit.at, how: 'gps' });
  }

  const scheduled = points.filter((p) => p.type !== 'start' && Number.isFinite(p.etaMin));
  const pending = scheduled.find((p) => !reached.has(p.id)) || null;
  const started = Number.isFinite(group.startedAt);

  let next = null;
  let lateMs = 0;
  if (pending) {
    const expectedAt = started ? group.startedAt + pending.etaMin * 60000 : null;
    next = { point: pending, expectedAt };
    if (expectedAt !== null) lateMs = now - expectedAt;
  }
  return { started, reached, next, done: scheduled.length > 0 && !pending, lateMs };
}

export const PACE_WINDOW_MS = 20 * 60 * 1000;   // speed is averaged over the last 20 minutes of fixes
export const OFF_ROUTE_M = 300;                  // farther than this from the route: measure straight to the point
const MIN_PACE_SPAN_MS = 3 * 60 * 1000;
const MOVING_MPS = 0.15;                         // below ~0.5 km/h the group is standing still

/**
 * How the group is actually doing: the distance still to walk to `target`
 * (the next unreached point unless one is given) — along the route that
 * ends there when the group is on it, straight otherwise — and the pace
 * over the last PACE_WINDOW_MS, so the command centre can say "about 14
 * minutes to Checkpoint 2" from the group's own speed, not the plan.
 * @returns null when there is nothing to estimate, else
 *   { target, remainingM, viaRoute, speedMps, moving, etaMs|null, spanMs }
 */
export function paceEstimate(group, points, routes, status, now = Date.now(), target = null) {
  if (!group.last) return null;
  const next = target || points.find((p) => p.type !== 'start' && !status.reached.has(p.id)) || null;
  if (!next) return null;
  const pos = { lat: group.last.lat, lng: group.last.lng };

  // Distance left: along a route into `next` if the group is on one.
  let remainingM = distM(pos, next);
  let viaRoute = false;
  for (const r of routes || []) {
    if (r.to !== next.id) continue;
    const along = remainingAlong(r.latlngs, pos);
    if (along && along.offM <= OFF_ROUTE_M) {
      remainingM = along.remainingM;
      viaRoute = true;
      break;
    }
  }

  // Pace: path length over the recent fixes divided by their time span.
  const fixes = (group.trail || []).map((t) => ({ lat: t[0], lng: t[1], at: t[2] }));
  fixes.push({ lat: group.last.lat, lng: group.last.lng, at: group.last.at });
  fixes.sort((a, b) => a.at - b.at);
  const since = group.last.at - PACE_WINDOW_MS;
  let recent = fixes.filter((f) => f.at >= since);
  if (recent.length < 2 || recent[recent.length - 1].at - recent[0].at < MIN_PACE_SPAN_MS) recent = fixes.slice(-12);
  let dist = 0;
  for (let i = 1; i < recent.length; i++) dist += distM(recent[i - 1], recent[i]);
  const spanMs = recent.length >= 2 ? recent[recent.length - 1].at - recent[0].at : 0;
  const speedMps = spanMs >= MIN_PACE_SPAN_MS ? dist / (spanMs / 1000) : null;
  const moving = speedMps !== null && speedMps >= MOVING_MPS;
  const etaMs = moving ? remainingM / speedMps * 1000 : null;
  return { target: next, remainingM, viaRoute, speedMps, moving, etaMs, spanMs };
}

/** "≈ 14 min ke Checkpoint 2 · 1.2 km · 4.8 km/j", or why there is no estimate. */
export function paceLabel(est, pointName) {
  if (!est) return '';
  const name = pointName ? pointName(est.target) : est.target.name;
  const km = est.remainingM >= 1000 ? (est.remainingM / 1000).toFixed(2) + ' km' : Math.round(est.remainingM) + ' m';
  if (est.speedMps === null) return km + ' ke ' + name + (est.viaRoute ? ' ikut laluan' : '') + ' · kelajuan belum diketahui';
  if (!est.moving) return 'Berhenti · ' + km + ' ke ' + name;
  const min = Math.max(1, Math.round(est.etaMs / 60000));
  return '≈ ' + min + ' min ke ' + name + ' · ' + km + (est.viaRoute ? ' ikut laluan' : '') +
    ' · ' + (est.speedMps * 3.6).toFixed(1) + ' km/j';
}

/** 'bad' | 'warn' | 'ok' | null (nothing scheduled or not started). */
export function lateness(status) {
  if (!status.next || status.next.expectedAt === null) return null;
  if (status.lateMs >= LATE_BAD_MS) return 'bad';
  if (status.lateMs > LATE_WARN_MS) return 'warn';
  return 'ok';
}

/** "+90 min" before a group starts, "11:30" once it has. */
export function etaLabel(point, startedAt) {
  if (!Number.isFinite(point.etaMin)) return '';
  if (!Number.isFinite(startedAt)) return '+' + point.etaMin + ' min';
  return new Date(startedAt + point.etaMin * 60000).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' });
}
