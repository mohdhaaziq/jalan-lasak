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

async function call(path, { method = 'GET', body, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = 'Bearer ' + key;

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

/** Program state everyone shares: points, routes, groups and a version number. */
export const getState = () => call('state');

/** Command centre: replace the points and routes. Resolves to { version }. */
export const putState = (key, { points, routes }) =>
  call('state', { method: 'PUT', key, body: { points, routes } });

/** Command centre: replace the list of groups. Resolves to { version }. */
export const putGroups = (key, groups) =>
  call('groups', { method: 'PUT', key, body: { groups } });

/** Participant: deliver a batch of fixes. Resolves to { version, saved }. */
export const postPositions = (group, device, items) =>
  call('positions', { method: 'POST', body: { group, device, items } });

/** Command centre: every group's latest fix, plus up to `trail` recent ones. */
export const getPositions = (key, trail = 0) =>
  call('positions' + (trail ? `?trail=${trail}` : ''), { key });
