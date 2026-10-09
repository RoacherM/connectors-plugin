/**
 * Authenticated `/api/connectors/*` routes for the settings page, registered through
 * `ctx.connection.fetch` so DSH's cookie and origin checks run first. Secret values only
 * ever travel browser → Host; reads report which secrets are set, never their values.
 */
import { EMAIL_PROVIDERS, EXPOSURES, PRESETS } from '../shared/presets.js';
import { secretFields } from './secretspec.js';
import { ConnectorError } from './store.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function body(request) {
  try { return await request.json(); } catch { throw new ConnectorError('请求体不是有效的 JSON', 400, 'The request body is not valid JSON'); }
}

/** "Key: Value" lines → object (headers), or "KEY=VALUE" lines → object (env). */
export function parsePairs(text, separator) {
  const result = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(separator);
    if (at <= 0) throw new ConnectorError(`无法解析这一行：${trimmed.slice(0, 60)}（格式应为 KEY${separator === ':' ? ': ' : '='}VALUE）`);
    result[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return result;
}

/**
 * Save a connector and its secrets, then (re)connect it. Shared by the settings page and the
 * `connectors_add` tool. `input` is { id?, connector, secrets?: { password, headers, env, resetOAuth } }.
 */
export async function saveConnector({ store, secrets, hub }, input) {
  const record = await store.save(input.connector ?? {}, input.id || undefined);
  const provided = input.secrets ?? {};
  const fields = {};
  if (typeof provided.password === 'string' && provided.password.trim() !== '') {
    // Google shows app passwords as four groups of four; the spaces are not part of it.
    fields.password = record.config.provider === 'gmail' ? provided.password.replace(/\s+/g, '') : provided.password.trim();
  }
  if (typeof provided.headers === 'string') fields.headers = Object.keys(parsePairs(provided.headers, ':')).length ? parsePairs(provided.headers, ':') : undefined;
  if (typeof provided.env === 'string') fields.env = Object.keys(parsePairs(provided.env, '=')).length ? parsePairs(provided.env, '=') : undefined;
  if (typeof provided.clientSecret === 'string' && provided.clientSecret.trim() !== '') fields.clientSecret = provided.clientSecret.trim();
  if (record.type === 'mcp-http' && !record.config.clientId) fields.clientSecret = undefined;
  // A changed server or client means old OAuth tokens belong to someone else.
  if (input.id && record.type === 'mcp-http' && (provided.resetOAuth || fields.clientSecret)) fields.oauth = undefined;
  if (Object.keys(fields).length) await secrets.update(record.id, fields);
  const view = await hub.reload(record.id);
  const warning = record.type === 'email' && !(await secrets.get(record.id)).password ? '已保存，但还没有填写应用专用密码 / 授权码' : undefined;
  return { view, warning };
}

/** Store the one secret the connector asked for, then connect. Anyone waiting (connectors_add) wakes up via the hub. */
export async function provideSecret({ store, secrets, hub }, id, value) {
  const connector = await store.get(id);
  if (!connector) throw new ConnectorError('连接器不存在', 404, 'Connector not found');
  let fields;
  try { fields = secretFields(connector, await secrets.get(id), value); } catch (error) { throw new ConnectorError(error.message, 400, error.en); }
  await secrets.update(id, fields);
  if (!connector.enabled) await store.patch(id, { enabled: true });
  return hub.reload(id);
}

/** One-click add from the gallery: the preset has everything except the address and secret. */
export async function addPreset(deps, presetId, { user, secret } = {}) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new ConnectorError('未知的连接器', 404, 'Unknown connector');
  const taken = new Set((await deps.store.list()).map((c) => c.name));
  if (taken.has(preset.connector.name)) throw new ConnectorError(`${preset.label} 已经添加过了`, 409, `${preset.label} is already added`);
  const template = preset.connector;
  const record = await deps.store.save({ ...template, preset: preset.id, config: { ...template.config, ...(user ? { user } : {}) } });
  if (typeof secret === 'string' && secret.trim()) return provideSecret(deps, record.id, secret);
  return deps.hub.reload(record.id);
}

async function secretStatus(secrets, id) {
  const secret = await secrets.get(id);
  return {
    password: Boolean(secret.password),
    headers: secret.headers ? Object.keys(secret.headers) : [],
    env: secret.env ? Object.keys(secret.env) : [],
    oauth: Boolean(secret.oauth?.tokens),
    clientSecret: Boolean(secret.clientSecret),
  };
}

export function registerRoutes(ctx, { store, secrets, hub }) {
  const withSecrets = async (view) => view && ({ ...view, secrets: await secretStatus(secrets, view.id) });
  const requireId = (input) => {
    if (typeof input?.id !== 'string' || input.id === '') throw new ConnectorError('缺少连接器 id', 400, 'Missing connector id');
    return input.id;
  };

  const routes = [
    ['GET', '/api/connectors', async () => json({
      connectors: await Promise.all((await hub.list()).map(withSecrets)),
      presets: PRESETS, emailProviders: EMAIL_PROVIDERS, revision: hub.revision,
    })],
    // Long-poll: answers as soon as any connector changes (status, tools, edits), or after ~5 s.
    ['GET', '/api/connectors/wait', async (request, url) => {
      const since = Number(url.searchParams.get('revision') ?? -1);
      if (hub.revision === since) {
        await new Promise((resolve) => {
          const timer = setTimeout(done, 5_000);
          const unsubscribe = hub.subscribe(done);
          request.signal?.addEventListener('abort', done, { once: true });
          function done() { clearTimeout(timer); unsubscribe(); resolve(); }
        });
      }
      return json({ revision: hub.revision });
    }],
    ['POST', '/api/connectors/save', async (request) => {
      const input = await body(request);
      const { view, warning } = await saveConnector({ store, secrets, hub }, input);
      return json({ connector: await withSecrets(view), ...(warning ? { warning } : {}) });
    }],
    ['POST', '/api/connectors/secret', async (request) => {
      const input = await body(request);
      return json({ connector: await withSecrets(await provideSecret({ store, secrets, hub }, requireId(input), input.value)) });
    }],
    ['POST', '/api/connectors/quick', async (request) => {
      const input = await body(request);
      return json({ connector: await withSecrets(await addPreset({ store, secrets, hub }, String(input.preset ?? ''), input)) });
    }],
    ['POST', '/api/connectors/connect', async (request) => {
      const id = requireId(await body(request));
      const view = await hub.connect(id);
      if (!view) throw new ConnectorError('连接器不存在', 404, 'Connector not found');
      return json({ connector: await withSecrets(view) });
    }],
    ['POST', '/api/connectors/toggle', async (request) => {
      const input = await body(request);
      const id = requireId(input);
      await store.patch(id, { enabled: input.enabled === true });
      return json({ connector: await withSecrets(await hub.reload(id)) });
    }],
    // Direct ↔ on-demand tools: only the registrations change, the connection stays up.
    ['POST', '/api/connectors/exposure', async (request) => {
      const input = await body(request);
      const id = requireId(input);
      if (!EXPOSURES.includes(input.exposure)) throw new ConnectorError(`exposure 只能是 ${EXPOSURES.join(' / ')}`, 400, `exposure must be ${EXPOSURES.join(' or ')}`);
      await store.patch(id, { exposure: input.exposure });
      return json({ connector: await withSecrets(await hub.resync(id)) });
    }],
    ['POST', '/api/connectors/logout', async (request) => {
      const id = requireId(await body(request));
      await secrets.update(id, { oauth: undefined });
      return json({ connector: await withSecrets(await hub.reload(id)) });
    }],
    ['POST', '/api/connectors/delete', async (request) => {
      const id = requireId(await body(request));
      await store.remove(id);
      await hub.remove(id);
      await secrets.remove(id).catch(() => {});
      return json({ deleted: true });
    }],
  ];

  for (const [method, path, fn] of routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods: [method], requestBody: 'buffered',
      fetch: async (request) => {
        try { return await fn(request, new URL(request.url)); } catch (error) {
          const message = new URL(request.url).searchParams.get('lang') === 'en' && error?.en ? error.en : error?.message ?? String(error);
          return json({ error: message }, error instanceof ConnectorError ? error.status : 500);
        }
      },
    }), 'dsh-connectors: ' + path);
  }
}
