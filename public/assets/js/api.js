/* The app's HTTP surface — see functions/api/[[route]].js for the server side.
   Every call throws ApiError on a non-2xx response, with the server's
   Bahasa message when it sent one, so callers can show it directly. */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BASE = 'api/';

async function call(path, { method = 'GET', body, key, pin, groupPin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = 'Bearer ' + key;
  else if (pin) headers['X-Marshal-Pin'] = pin;
  else if (groupPin) headers['X-Group-Pin'] = groupPin;

  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
  } catch {
    throw new ApiError(0, 'Tiada talian ke pelayan.');
  }

  let data = null;
  try { data = await response.json(); } catch { /* non-JSON body */ }

  if (!response.ok) {
    throw new ApiError(response.status, (data && data.error) || `Ralat ${response.status}`);
  }
  return data;
}

/**
 * Program state: points, routes, groups and a version number. Who asks decides
 * how many checkpoints come back — { key } or { pin } (marshal) get them all,
 * { groupPin } gets the ones revealed to that group, nothing gets MULA only.
 */
export const getState = (auth = {}) => call('state', auth);

/** Command centre: replace the points and routes. Resolves to { version }. */
export const putState = (key, { points, routes }) =>
  call('state', { method: 'PUT', key, body: { points, routes } });

/** Command centre: replace the list of groups. Resolves to { version, groups: [{ id, pin }] }. */
export const putGroups = (key, groups) =>
  call('groups', { method: 'PUT', key, body: { groups } });

/**
 * Deliver a batch of fixes for a group. A participant phone proves itself
 * with the group's PIN; the command centre (typing in an SMS) with its key.
 * Resolves to { version, saved }.
 */
export const postPositions = (group, device, items, { pin, key } = {}) =>
  call('positions', { method: 'POST', key, body: { group, pin, device, items } });

/** Participant: log in with the group's PIN. Resolves to { id, name, startedAt }. */
export const loginGroup = (pin) =>
  call('groups/login', { method: 'POST', body: { pin } });

/**
 * Every group's latest fix, plus up to `trail` recent ones. The command
 * centre passes its key; a marshal phone passes { pin } instead and gets
 * the same answer without the groups' PINs.
 */
export const getPositions = (key, trail = 0, { pin } = {}) =>
  call('positions' + (trail ? `?trail=${trail}` : ''), { key, pin });

/** Command centre: every stored fix of one group, oldest first, optionally since a time (ms). */
export const getTrack = (key, group, since = 0) =>
  call('track?group=' + encodeURIComponent(group) + (since ? '&since=' + since : ''), { key });

/** Command centre: the SMS fallback number and/or the marshal PIN. */
export const putSettings = (key, settings) =>
  call('settings', { method: 'PUT', key, body: settings });

/**
 * Record groups arriving at points. Proven by the command-centre key or the
 * marshal PIN. items: [{ group, point, at?, note? }]. Resolves to
 * { version, saved, started } where started maps group → clock start it set.
 */
export async function postCheckins({ key, pin, groupPin, device, items, verify = false }) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  else if (pin) headers['X-Marshal-Pin'] = pin;
  else if (groupPin) headers['X-Group-Pin'] = groupPin;   // items: [{ point, code, at }] for this group
  let response;
  try {
    response = await fetch(BASE + 'checkins', {
      method: 'POST', headers, body: JSON.stringify(verify ? { device, verify: true } : { device, items }), cache: 'no-store'
    });
  } catch {
    throw new ApiError(0, 'Tiada talian ke pelayan.');
  }
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON body */ }
  if (!response.ok) throw new ApiError(response.status, (data && data.error) || `Ralat ${response.status}`);
  return data;
}
