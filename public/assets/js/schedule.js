/* The schedule: where each group should be by now, and whether it is late.

   In a dead zone a silent phone is normal; a group that has not reached the
   checkpoint it was due at is not. So lateness is judged against the plan
   (each checkpoint's minutes-from-start, and the group's own start time), and
   "reached" is taken from a check-in first, and from any GPS fix within
   REACHED_M of the point as a fallback. */

import { distM } from './geo.js';

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
