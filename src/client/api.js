/** Language for Host error messages; set by the page from DSH's locale. */
let lang = 'zh';
export const setApiLang = (value) => { lang = value; };

const url = (path, query = {}) => {
  const target = new URL('api/connectors' + path, document.baseURI);
  if (lang === 'en') target.searchParams.set('lang', 'en');
  for (const [key, value] of Object.entries(query)) if (value !== undefined) target.searchParams.set(key, value);
  return target;
};

async function call(method, path, { body, query, signal } = {}) {
  const init = { method, credentials: 'same-origin', signal, headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const response = await fetch(url(path, query), init);
  let data;
  try { data = await response.json(); } catch { data = undefined; }
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
}

export const api = {
  list: () => call('GET', ''),
  wait: (revision, signal) => call('GET', '/wait', { query: { revision }, signal }),
  secret: (id, value) => call('POST', '/secret', { body: { id, value } }),
  quick: (preset, fields) => call('POST', '/quick', { body: { preset, ...fields } }),
  connect: (id) => call('POST', '/connect', { body: { id } }),
  toggle: (id, enabled) => call('POST', '/toggle', { body: { id, enabled } }),
  exposure: (id, exposure) => call('POST', '/exposure', { body: { id, exposure } }),
  logout: (id) => call('POST', '/logout', { body: { id } }),
  remove: (id) => call('POST', '/delete', { body: { id } }),
};
