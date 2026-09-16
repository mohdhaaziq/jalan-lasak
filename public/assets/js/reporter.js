/* The participant phone's position reporter.

   Safety rules, in order of what they protect against:
   - A fix is *sampled* every SAMPLE_MS while the app is open, cheaply, with
     getCurrentPosition rather than a permanent watch.
   - A fix is *sent* when SOS is on, when 5 minutes have passed, or when the
     phone has moved ≥ 30 m and 2 minutes have passed. A group that stops
     moving is exactly the one the command centre wants a steady signal from,
     so the long interval is the ceiling, not the rule.
   - Fixes that cannot be delivered (no signal on the trail) queue on the
     phone with their original timestamps and go out together when a signal
     returns, so the command centre sees the whole trail, not a gap.
   - Coming back to the foreground samples and flushes immediately: the
     browser suspends timers while the screen is off, and this is the first
     chance to catch up.

   The reporter never touches the DOM. It reports through callbacks. */

import { distM } from './geo.js';
import { postPositions, ApiError } from './api.js';
import { loadQueue, saveQueue } from './store.js';

export const SAMPLE_MS = 60 * 1000;
export const SEND_MOVING_MS = 2 * 60 * 1000;
export const SEND_STILL_MS = 5 * 60 * 1000;
export const MOVED_M = 30;
const QUEUE_LIMIT = 500;
const BATCH = 200;

export function createReporter({ getGroup, getDevice, onFix, onStatus, onGroupMissing, onVersion }) {
  let queue = loadQueue();
  let timer = null;
  let sos = false;
  let lastFix = null;
  let lastSent = null;        // { at, lat, lng }
  let lastDelivered = null;   // ms epoch of the last successful POST
  let flushing = false;
  let lastError = '';

  const status = () => onStatus && onStatus({
    running: timer !== null,
    sos,
    queued: queue.length,
    lastFixAt: lastFix ? lastFix.at : null,
    lastDeliveredAt: lastDelivered,
    error: lastError
  });

  async function batteryLevel() {
    try {
      if (!navigator.getBattery) return null;
      const b = await navigator.getBattery();
      return typeof b.level === 'number' ? b.level : null;
    } catch {
      return null;
    }
  }

  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('GPS tidak disokong'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, maximumAge: 20 * 1000, timeout: 25 * 1000
      });
    });
  }

  function shouldSend(fix) {
    if (sos) return true;
    if (!lastSent) return true;
    const since = fix.at - lastSent.at;
    if (since >= SEND_STILL_MS) return true;
    return since >= SEND_MOVING_MS && distM(lastSent, fix) >= MOVED_M;
  }

  function enqueue(fix) {
    queue.push({ lat: fix.lat, lng: fix.lng, acc: fix.acc, battery: fix.battery, sos: sos ? 1 : 0, at: fix.at });
    if (queue.length > QUEUE_LIMIT) queue = queue.slice(-QUEUE_LIMIT);
    saveQueue(queue);
    lastSent = { at: fix.at, lat: fix.lat, lng: fix.lng };
  }

  async function sample({ force = false } = {}) {
    let fix;
    try {
      const pos = await locate();
      fix = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        acc: pos.coords.accuracy,
        at: Date.now(),
        battery: await batteryLevel()
      };
    } catch (err) {
      lastError = 'GPS: ' + (err.message || 'gagal');
      status();
      return null;
    }
    lastFix = fix;
    lastError = '';
    if (onFix) onFix(fix);
    if (force || shouldSend(fix)) enqueue(fix);
    status();
    await flush();
    return fix;
  }

  async function flush() {
    if (flushing || !queue.length) return;
    const group = getGroup();
    const device = getDevice();
    if (!group || !device) return;
    if (!navigator.onLine) {
      lastError = 'Tiada talian — ' + queue.length + ' dlm giliran';
      status();
      return;
    }
    flushing = true;
    try {
      while (queue.length) {
        const items = queue.slice(0, BATCH);
        const result = await postPositions(group, device, items);
        queue = queue.slice(items.length);
        saveQueue(queue);
        lastDelivered = Date.now();
        lastError = '';
        if (onVersion && typeof result.version === 'number') onVersion(result.version);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // The group was deleted at the command centre; fixes for it are useless.
        queue = [];
        saveQueue(queue);
        lastError = err.message;
        if (onGroupMissing) onGroupMissing();
      } else {
        lastError = err.message || 'Gagal hantar';
      }
    } finally {
      flushing = false;
      status();
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible' && timer !== null) sample();
  }

  function start() {
    if (timer !== null) return;
    timer = setInterval(() => sample(), SAMPLE_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', flush);
    sample();
    status();
  }

  function stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', flush);
    status();
  }

  /** Raise or clear SOS. Either way a fix goes out at once. */
  async function setSOS(on) {
    sos = !!on;
    status();
    await sample({ force: true });
  }

  return {
    start, stop, flush, setSOS,
    sendNow: () => sample({ force: true }),
    isRunning: () => timer !== null,
    isSOS: () => sos,
    queued: () => queue.length
  };
}
