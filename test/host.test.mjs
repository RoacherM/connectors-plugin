import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as source from '../src/host/index.js';
import { normalizeConnector } from '../src/host/store.js';
import { parsePairs } from '../src/host/routes.js';
import { convertResult, instructionsOf, sanitizeSchema } from '../src/host/hub.js';
import { argumentProblems, runSearch, score, signature, terms } from '../src/host/search.js';
import { headings, page, renderList, renderRead, section } from '../src/host/resources.js';
import { isMethodNotFound, isModelDocument } from '../src/host/documents.js';
import { notesSection } from '../src/host/notes.js';
import { toolName } from '../src/shared/presets.js';
import { GUIDE, startHttpServer } from './fixtures/servers.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/servers.mjs', import.meta.url));

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function until(check, { timeout = 10_000, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A fake DSH Host context: routes, tool registry, credential records, effects. */
async function mount({ plugin = source, dir, records = new Map() } = {}) {
  const sections = new Map();
  dir ??= await mkdtemp(join(tmpdir(), 'dsh-connectors-'));
  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const credentials = {
    readRecord: async (key) => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, structuredClone(next));
      return records.get(key);
    },
    deleteRecord: async (key) => { records.delete(key); },
  };
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return () => dispose?.(); },
    get: (name) => ({ credentials })[name],
    // A host that composes a system prompt; the sections are rendered by the tests.
    inject: (deps, fn) => fn({ systemPrompt: { getSectionOrder: () => 100, section: (sec) => { sections.set(sec.name, sec); return () => sections.delete(sec.name); } } }),
    connection: { fetch: { register: (route) => { assert.ok(!routes.has(route.path), 'duplicate route ' + route.path); routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: {
      register: (tool) => { assert.ok(!tools.has(tool.name), 'duplicate tool ' + tool.name); tools.set(tool.name, tool); return () => tools.delete(tool.name); },
      get: (name) => tools.get(name),
    },
  };
  plugin.apply(ctx, { dataDir: dir, oauthCallbackPort: await freePort() });
  const call = async (method, path, body, query = {}) => {
    const url = new URL('http://dsh.internal' + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const route = routes.get(path.split("?")[0]);
    assert.ok(route, 'no route ' + path);
    assert.ok(route.methods.includes(method), `${method} not allowed on ${path}`);
    const response = await route.fetch(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }));
    const data = await response.json();
    return { status: response.status, data };
  };
  const exec = (name, args = {}) => tools.get(name).execute(args, { signal: new AbortController().signal });
  const unmount = async () => { for (const d of disposers.reverse()) await d?.(); };
  const prompt = (name) => sections.get(name)?.text() ?? '';
  return { ctx, call, tools, exec, records, dir, unmount, prompt };
}

test('connector records are validated and normalized', () => {
  assert.throws(() => normalizeConnector({ type: 'mcp-http', name: 'Bad Name', config: { url: 'https://x' } }), /名称/);
  assert.throws(() => normalizeConnector({ type: 'mcp-http', name: 'ok', config: { url: 'ftp://x' } }), /http/);
  assert.throws(() => normalizeConnector({ type: 'email', name: 'mail', config: { provider: 'gmail', user: 'nope' } }), /邮箱地址/);
  const gmail = normalizeConnector({ type: 'email', name: 'gmail', config: { provider: 'gmail', user: 'me@gmail.com' } });
  assert.equal(gmail.config.imapHost, 'imap.gmail.com');
  assert.equal(gmail.config.smtpPort, 465);
  assert.match(gmail.id, /^c-[0-9a-f]{12}$/);
  const stdio = normalizeConnector({ type: 'mcp-stdio', name: 'fs', config: { command: 'npx', args: ['-y', 'x'] } });
  assert.deepEqual(stdio.config.args, ['-y', 'x']);
  // The type of an existing connector never changes on edit.
  assert.equal(normalizeConnector({ type: 'email', name: 'fs', config: { command: 'uvx' } }, stdio).type, 'mcp-stdio');
});

test('helpers: header/env parsing, tool naming, schema and result conversion', async () => {
  assert.deepEqual(parsePairs('Authorization: Bearer a:b\n# comment\n\nX-Y: 1', ':'), { Authorization: 'Bearer a:b', 'X-Y': '1' });
  assert.deepEqual(parsePairs('A=1\nB=x=y', '='), { A: '1', B: 'x=y' });
  assert.throws(() => parsePairs('novalue', '='), /无法解析/);
  assert.equal(toolName('my-mail', 'search.emails'), 'mcp__my_mail__search_emails');
  assert.ok(toolName('x', 'a'.repeat(100)).length <= 64);
  assert.deepEqual(sanitizeSchema({ $schema: 'x', properties: { a: { type: 'string' } } }), { type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(sanitizeSchema(undefined), { type: 'object', properties: {} });
  const value = await convertResult({ content: [{ type: 'text', text: 'hi' }, { type: 'resource_link', uri: 'file:///a', name: 'a' }, { type: 'audio', data: '', mimeType: 'audio/wav' }] });
  assert.equal(value.text, 'hi\n\n[链接] a file:///a\n\n[音频内容，已省略]');
  assert.equal((await convertResult({ content: [], structuredContent: { n: 1 } })).text, '{\n  "n": 1\n}');
});

test('stdio connector: connects, registers tools, passes secret env, reports errors, disables and deletes', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const saved = await host.call('POST', '/api/connectors/save', {
    connector: { type: 'mcp-stdio', name: 'fx', label: 'Fixture', config: { command: process.execPath, args: [FIXTURE, 'stdio'] } },
    secrets: { env: 'FIXTURE_VAR=from-secret' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const { connector } = saved.data;
  assert.equal(connector.status, 'connected', connector.error);
  assert.deepEqual(connector.toolNames.sort(), ['mcp__fx__add', 'mcp__fx__echo', 'mcp__fx__env', 'mcp__fx__fail']);
  assert.deepEqual(connector.secrets.env, ['FIXTURE_VAR']);
  // Secrets are in the credential store, never in connectors.json.
  assert.deepEqual(host.records.get(`dsh-connectors/${connector.id}`).payload.env, { FIXTURE_VAR: 'from-secret' });

  assert.match(host.tools.get('mcp__fx__echo').description, /^\[连接器 · Fixture\] Echo/);
  assert.equal(host.tools.get('mcp__fx__echo').isConcurrencySafe(), true);
  assert.equal(host.tools.get('mcp__fx__add').isConcurrencySafe(), false);
  assert.deepEqual(await host.exec('mcp__fx__echo', { text: 'hi' }), { text: 'echo: hi' });
  assert.equal((await host.exec('mcp__fx__add', { a: 2, b: 40 })).text, '42');
  assert.equal((await host.exec('mcp__fx__env', { name: 'FIXTURE_VAR' })).text, 'from-secret');
  await assert.rejects(host.exec('mcp__fx__fail'), /boom from server/);

  const listed = await host.exec('connectors_list');
  assert.match(listed.text, /Fixture（name: fx，类型: mcp-stdio）— 已连接/);
  assert.match(listed.text, /mcp__fx__echo/);

  const off = await host.call('POST', '/api/connectors/toggle', { id: connector.id, enabled: false });
  assert.equal(off.data.connector.status, 'disabled');
  assert.equal(host.tools.has('mcp__fx__echo'), false);
  const on = await host.call('POST', '/api/connectors/toggle', { id: connector.id, enabled: true });
  assert.equal(on.data.connector.status, 'connected');
  assert.equal(host.tools.has('mcp__fx__echo'), true);

  const dupe = await host.call('POST', '/api/connectors/save', { connector: { type: 'mcp-stdio', name: 'fx', config: { command: 'x' } } });
  assert.equal(dupe.status, 409);

  await host.call('POST', '/api/connectors/delete', { id: connector.id });
  assert.equal(host.tools.has('mcp__fx__echo'), false);
  assert.equal(host.records.has(`dsh-connectors/${connector.id}`), false);
  assert.deepEqual((await host.call('GET', '/api/connectors')).data.connectors, []);
});

test('stdio connector with a bad command reports the failure instead of hanging', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const { data } = await host.call('POST', '/api/connectors/save', { connector: { type: 'mcp-stdio', name: 'bad', config: { command: '/nonexistent/mcp-server' } } });
  assert.equal(data.connector.status, 'error');
  assert.ok(data.connector.error);
  assert.deepEqual(data.connector.toolNames, []);
});

test('remote connector with a bearer header; without it the server refuses', async (t) => {
  const server = await startHttpServer({ auth: 'bearer', token: 'tok-123' });
  const host = await mount();
  t.after(async () => { await host.unmount(); await server.close(); });
  const denied = await host.call('POST', '/api/connectors/save', { connector: { type: 'mcp-http', name: 'remote', config: { url: server.url, auth: 'none' } } });
  assert.equal(denied.data.connector.status, 'error');
  const { data } = await host.call('POST', '/api/connectors/save', {
    id: denied.data.connector.id,
    connector: { type: 'mcp-http', name: 'remote', config: { url: server.url, auth: 'headers' } },
    secrets: { headers: 'Authorization: Bearer tok-123' },
  });
  assert.equal(data.connector.status, 'connected', data.connector.error);
  assert.deepEqual(data.connector.secrets.headers, ['Authorization']);
  assert.equal((await host.exec('mcp__remote__echo', { text: 'over http' })).text, 'echo: over http');
});

test('remote connector with OAuth: discovery, dynamic registration, PKCE, loopback callback, reuse after restart', async (t) => {
  const server = await startHttpServer({ auth: 'oauth' });
  const records = new Map();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-connectors-'));
  const host = await mount({ dir, records });
  t.after(async () => { await host.unmount(); await server.close(); });

  const { data } = await host.call('POST', '/api/connectors/save', { connector: { type: 'mcp-http', name: 'oauthy', label: 'OAuthy', config: { url: server.url, auth: 'oauth' } } });
  const id = data.connector.id;
  assert.equal(data.connector.status, 'needs_auth', data.connector.error);
  const authUrl = new URL(data.connector.authUrl);
  assert.equal(authUrl.origin, server.base);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authUrl.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(server.stats.registrations, 1);

  // Play the browser: the authorization server redirects to our loopback listener.
  const approve = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(approve.status, 302);
  const callback = await fetch(approve.headers.get('location'));
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /授权完成/);

  const connected = await until(async () => {
    const list = (await host.call('GET', '/api/connectors')).data.connectors;
    return list.find((c) => c.id === id && c.status === 'connected');
  }, { what: 'OAuth connection' });
  assert.equal(connected.secrets.oauth, true);
  assert.equal((await host.exec('mcp__oauthy__echo', { text: 'authorized' })).text, 'echo: authorized');
  assert.ok(records.get(`dsh-connectors/${id}`).payload.oauth.tokens.access_token.startsWith('at-'));

  // A replayed callback (a reloaded tab) does nothing and says the login already went through.
  const replay = await fetch(approve.headers.get('location'));
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /已经授权过了/);
  assert.equal((await host.call('GET', '/api/connectors')).data.connectors.find((c) => c.id === id).status, 'connected');

  // "Restart": a fresh Host with the same stores connects straight away with the saved tokens.
  await host.unmount();
  const again = await mount({ dir, records });
  t.after(again.unmount);
  const restored = await until(async () => (await again.call('GET', '/api/connectors')).data.connectors.find((c) => c.status === 'connected'), { what: 'restored connection' });
  assert.equal(restored.id, id);
  assert.equal(server.stats.registrations, 1, 'no second client registration');
  assert.equal((await again.exec('mcp__oauthy__add', { a: 1, b: 1 })).text, '2');

  // Logging out forgets the tokens and asks for a new login.
  const out = await again.call('POST', '/api/connectors/logout', { id });
  assert.equal(out.data.connector.status, 'needs_auth');
  assert.equal(out.data.connector.secrets.oauth, false);
});

test('OAuth: a newer login supersedes an unfinished one; the stale callback cannot change the status', async (t) => {
  const server = await startHttpServer({ auth: 'oauth' });
  const host = await mount();
  t.after(async () => { await host.unmount(); await server.close(); });
  const status = async () => (await host.call('GET', '/api/connectors')).data.connectors[0];

  const { data } = await host.call('POST', '/api/connectors/save', { connector: { type: 'mcp-http', name: 'oauthy', config: { url: server.url, auth: 'oauth' } } });
  assert.equal(data.connector.status, 'needs_auth');
  const firstUrl = data.connector.authUrl;
  // The user clicks 「连接」 again before finishing the first login.
  const second = await host.call('POST', '/api/connectors/connect', { id: data.connector.id });
  assert.equal(second.data.connector.status, 'needs_auth');
  assert.notEqual(second.data.connector.authUrl, firstUrl);

  // Finishing the first, superseded login explains itself and leaves the connector waiting.
  const stale = await fetch((await fetch(firstUrl, { redirect: 'manual' })).headers.get('location'));
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /已断开或被重新配置|已被新的登录请求取代/);
  assert.equal((await status()).status, 'needs_auth');

  // The current login completes, and its page reports the real outcome of the token exchange.
  const callback = await fetch((await fetch(second.data.connector.authUrl, { redirect: 'manual' })).headers.get('location'));
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /授权完成/);
  assert.equal((await status()).status, 'connected', (await status()).error);
  assert.equal((await host.exec('mcp__oauthy__echo', { text: 'fresh' })).text, 'echo: fresh');

  // Switching the connector away from OAuth while a login is pending cancels that login too.
  await host.call('POST', '/api/connectors/logout', { id: data.connector.id });
  const pendingUrl = (await status()).authUrl;
  assert.ok(pendingUrl);
  await host.call('POST', '/api/connectors/save', {
    id: data.connector.id, connector: { type: 'mcp-http', name: 'oauthy', config: { url: server.url, auth: 'none' } },
  });
  const settled = await status();
  const late = await fetch((await fetch(pendingUrl, { redirect: 'manual' })).headers.get('location'));
  assert.equal(late.status, 409);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await status()).status, settled.status, 'a late callback must not change the status');
});

test('long-poll wakes up when a connector changes', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const { data: first } = await host.call('GET', '/api/connectors');
  const waiting = host.call('GET', '/api/connectors/wait', undefined, { revision: String(first.revision) });
  await new Promise((r) => setTimeout(r, 50));
  await host.call('POST', '/api/connectors/save', { connector: { type: 'mcp-stdio', name: 'bad', config: { command: '/nonexistent' } } });
  const { data } = await waiting;
  assert.ok(data.revision > first.revision);
});

test('the bundled dist/host.js loads and registers the same surface', async (t) => {
  const bundle = await import('../dist/host.js');
  assert.equal(bundle.name, 'dsh-connectors');
  const host = await mount({ plugin: bundle });
  t.after(host.unmount);
  assert.ok(host.tools.has('connectors_list'));
  const { data } = await host.call('POST', '/api/connectors/save', {
    connector: { type: 'mcp-stdio', name: 'fx', config: { command: process.execPath, args: [FIXTURE, 'stdio'] } },
  });
  assert.equal(data.connector.status, 'connected', data.connector.error);
  assert.equal((await host.exec('mcp__fx__echo', { text: 'bundled' })).text, 'echo: bundled');
});

test('connectors_add: the agent configures, the user only types the secret into the prompt', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const pending = host.exec('connectors_add', {
    type: 'mcp-stdio', name: 'fx', label: 'Fixture', config: { command: process.execPath, args: [FIXTURE, 'stdio'] },
    secret: { env_key: 'FIXTURE_VAR', label: 'Fixture Token', url: 'https://example.com/tokens' },
  });
  // While the tool waits, the connector asks for exactly one value and exposes no tools.
  const waiting = await until(async () => (await host.call('GET', '/api/connectors')).data.connectors.find((c) => c.status === 'needs_secret'), { what: 'secret prompt' });
  assert.deepEqual(waiting.secretSpec, { kind: 'env', label: 'Fixture Token', url: 'https://example.com/tokens', placeholder: '' });
  assert.equal(host.tools.has('mcp__fx__echo'), false);
  const bad = await host.call('POST', '/api/connectors/secret', { id: waiting.id, value: '  ' });
  assert.equal(bad.status, 400);
  const filled = await host.call('POST', '/api/connectors/secret', { id: waiting.id, value: 'one' });
  assert.equal(filled.data.connector.status, 'connected');
  const done = await pending;
  assert.match(done.text, /^已添加连接器「Fixture」（name: fx）— 已连接，共 4 个工具/);
  assert.equal((await host.exec('mcp__fx__env', { name: 'FIXTURE_VAR' })).text, 'one');
  assert.equal(host.records.get(`dsh-connectors/${waiting.id}`).payload.env.FIXTURE_VAR, 'one');

  // Rotating the key asks again; nothing else changes.
  const rotating = host.exec('connectors_add', { name: 'fx', ask_secret: true });
  await until(async () => (await host.call('GET', '/api/connectors')).data.connectors.find((c) => c.status === 'needs_secret'), { what: 'second prompt' });
  await host.call('POST', '/api/connectors/secret', { id: waiting.id, value: 'two' });
  assert.match((await rotating).text, /^已更新.*已连接/);
  assert.equal((await host.exec('mcp__fx__env', { name: 'FIXTURE_VAR' })).text, 'two');
  assert.equal((await host.call('GET', '/api/connectors')).data.connectors.length, 1);

  // The user walks away: the call returns (it never hangs the turn) and says where to finish.
  const controller = new AbortController();
  const abandoned = host.tools.get('connectors_add').execute({ name: 'fx', ask_secret: true }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.match((await abandoned).text, /没有在时限内填写Fixture Token.*「连接器」页面/);

  assert.match((await host.exec('connectors_remove', { name: 'fx' })).text, /已删除/);
  assert.equal(host.tools.has('mcp__fx__echo'), false);
  await assert.rejects(host.exec('connectors_add', { type: 'email', name: 'x', config: { provider: 'gmail', user: 'nope' } }), /邮箱地址/);
});

test('one-click presets: mail waits for its app password without touching the network; duplicates are refused', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const { data } = await host.call('POST', '/api/connectors/quick', { preset: 'gmail', user: 'me@gmail.com' });
  assert.equal(data.connector.status, 'needs_secret');
  assert.equal(data.connector.secretSpec.label, '应用专用密码');
  assert.equal(data.connector.secretSpec.url, 'https://myaccount.google.com/apppasswords');
  assert.equal(host.tools.has('mcp__gmail__search_emails'), false, 'no tools until the password is in');
  assert.equal((await host.call('POST', '/api/connectors/quick', { preset: 'gmail', user: 'me@gmail.com' })).status, 409);
  assert.equal((await host.call('POST', '/api/connectors/quick', { preset: 'nope' })).status, 404);
  const dup = await host.call('POST', '/api/connectors/quick?lang=en', { preset: 'gmail', user: 'me@gmail.com' });
  assert.equal(dup.data.error, 'Gmail is already added');
  assert.equal((await host.call('POST', '/api/connectors/secret?lang=en', { id: data.connector.id, value: ' ' })).data.error, 'Enter the key');
  const listed = await host.exec('connectors_list');
  assert.match(listed.text, /等待用户填写密钥/);
});

test('OAuth server without dynamic registration (GitHub-style): explains the fix, then works with a pre-registered client id + secret', async (t) => {
  const server = await startHttpServer({ auth: 'oauth', dcr: false, client: { id: 'my-app', secret: 's3cret' } });
  const records = new Map();
  const host = await mount({ records });
  t.after(async () => { await host.unmount(); await server.close(); });
  const first = await host.call('POST', '/api/connectors/save', { connector: { type: 'mcp-http', name: 'gh', config: { url: server.url, auth: 'oauth' } } });
  assert.equal(first.data.connector.status, 'error');
  assert.match(first.data.connector.error, /不支持 OAuth 自动注册/);
  assert.match(first.data.connector.error, /Personal Access Token/);

  const { data } = await host.call('POST', '/api/connectors/save', {
    id: first.data.connector.id,
    connector: { type: 'mcp-http', name: 'gh', config: { url: server.url, auth: 'oauth', clientId: 'my-app' } },
    secrets: { clientSecret: 's3cret' },
  });
  assert.equal(data.connector.status, 'needs_auth', data.connector.error);
  assert.equal(data.connector.secrets.clientSecret, true);
  assert.equal(new URL(data.connector.authUrl).searchParams.get('client_id'), 'my-app');
  const approve = await fetch(data.connector.authUrl, { redirect: 'manual' });
  await fetch(approve.headers.get('location'));
  await until(async () => (await host.call('GET', '/api/connectors')).data.connectors.find((c) => c.status === 'connected'), { what: 'OAuth with client secret' });
  assert.equal((await host.exec('mcp__gh__echo', { text: 'ok' })).text, 'echo: ok');
  assert.equal(server.stats.registrations, 0);
  assert.equal(records.get(`dsh-connectors/${data.connector.id}`).payload.clientSecret, 's3cret');

  // A wrong secret is reported as a client authentication problem, not a hang.
  const wrong = await host.call('POST', '/api/connectors/save', {
    id: data.connector.id,
    connector: { type: 'mcp-http', name: 'gh', config: { url: server.url, auth: 'oauth', clientId: 'my-app' } },
    secrets: { clientSecret: 'nope' },
  });
  assert.equal(wrong.data.connector.status, 'needs_auth');
  const again = await fetch(wrong.data.connector.authUrl, { redirect: 'manual' });
  await fetch(again.headers.get('location'));
  const failed = await until(async () => (await host.call('GET', '/api/connectors')).data.connectors.find((c) => c.status === 'error'), { what: 'client auth failure' });
  assert.match(failed.error, /Client ID \/ Client Secret|invalid_client/);
});

test('exposure: direct by default, legacy deferLoading means search, unknown values are refused', () => {
  const base = { type: 'mcp-stdio', name: 'fs', config: { command: 'npx' } };
  assert.equal(normalizeConnector(base).exposure, 'direct');
  assert.equal(normalizeConnector(base, { ...normalizeConnector(base), exposure: undefined, deferLoading: true }).exposure, 'search');
  assert.equal(normalizeConnector({ ...base, exposure: 'search' }).exposure, 'search');
  assert.equal(normalizeConnector({ name: 'fs', config: base.config }, normalizeConnector({ ...base, exposure: 'search' })).exposure, 'search', 'an edit keeps the mode');
  assert.equal('deferLoading' in normalizeConnector(base), false);
  assert.throws(() => normalizeConnector({ ...base, exposure: 'lazy' }), /exposure/);
});

test('connector_search ranking, signatures and full schemas', () => {
  const tool = (name, description, inputSchema = { type: 'object', properties: {} }, annotations) => ({ name, description, inputSchema, annotations });
  const catalog = [
    { connector: { name: 'linear', label: 'Linear' }, tools: [
      tool('list_issues', 'List issues in the workspace', { type: 'object', required: ['team'], properties: { team: { type: 'string' }, limit: { type: 'number' }, state: { enum: ['open', 'closed'] } } }, { readOnlyHint: true }),
      tool('save_issue', 'Create or update an issue'),
      tool('list_projects', 'List projects'),
    ] },
    { connector: { name: 'notion', label: 'Notion' }, tools: [
      tool('notion-search', '搜索页面与数据库'),
      tool('notion-query-data-sources', 'Query a database', { type: 'object', properties: { big: { type: 'string', description: 'x'.repeat(3000) } } }),
    ] },
  ];
  assert.deepEqual(terms('Create  issue, 页面'), ['create', 'issue', '页面']);
  const issue = terms('create issue');
  assert.ok(score(catalog[0].tools[1], catalog[0].connector, issue) > score(catalog[0].tools[0], catalog[0].connector, issue), 'all terms beat one term');
  const old = tool('create_issue_label', 'Create a label. Deprecated: use save_issue_label.');
  assert.ok(score(old, catalog[0].connector, issue) < score(catalog[0].tools[1], catalog[0].connector, issue), 'deprecated tools yield to their replacement');
  const param = tool('get_issue_state', 'Read the issue state. `capture_mode` is deprecated and ignored.');
  const plain = tool('get_issue_state', 'Read the issue state.');
  assert.equal(score(param, catalog[0].connector, issue), score(plain, catalog[0].connector, issue), 'a deprecated parameter does not demote the tool');
  const aside = tool('create_attachment', 'Attach a file to an existing issue. It only creates the attachment.');
  assert.ok(score(aside, catalog[0].connector, issue) < score(catalog[0].tools[1], catalog[0].connector, issue), 'the summary sentence outweighs later mentions');
  assert.equal(signature(catalog[0].tools[0].inputSchema), 'team: string, limit?: number, state?: "open"|"closed"');
  assert.deepEqual(argumentProblems({ type: 'object', required: ['team'], additionalProperties: false, properties: { team: {} } }, { x: 1 }), ['缺少必填参数 team', '未知参数 x']);

  const found = runSearch(catalog, { query: 'issue' });
  assert.match(found, /^### linear\/save_issue\n/, 'an exact word in the name ranks first');
  assert.match(found, /### linear\/list_issues（只读）/);
  assert.doesNotMatch(found, /notion/);
  assert.match(found, /input schema: \{"type":"object","required":\["team"\]/, 'small schemas come inline');
  assert.match(runSearch(catalog, { query: '页面' }), /notion\/notion-search/, 'CJK keywords match descriptions');
  const big = runSearch(catalog, { query: 'query database' });
  assert.match(big, /完整 schema \d+ 字符/);
  assert.doesNotMatch(big, /x{100}/, 'large schemas are not inlined');
  assert.match(runSearch(catalog, { tools: ['notion/notion-query-data-sources'] }), /x{3000}/, 'asked by name, the full schema comes back');
  assert.match(runSearch(catalog, { tools: ['mcp__linear__save_issue'] }), /### linear\/save_issue/, 'public names resolve too');
  assert.match(runSearch(catalog, { connector: 'linear', query: '*' }), /linear（Linear，3 个工具）：\n- list_issues/);
  assert.match(runSearch(catalog, { query: '*' }), /指定 connector/);
  assert.match(runSearch(catalog, { query: 'zzz' }), /没有匹配「zzz」/);
  assert.match(runSearch(catalog, { connector: 'nope', query: 'x' }), /没有名为 nope/);
  assert.equal(runSearch(catalog, { query: 'list', limit: 1 }).split('### ').length - 1, 1);
  assert.equal(runSearch([], { query: 'x' }), '当前没有可按需搜索的连接器。');
});

test('search exposure: no per-tool definitions, two small tools that find and run them; switching keeps the connection', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  assert.equal(host.tools.has('connector_search'), false, 'nothing to search yet');
  const { data } = await host.call('POST', '/api/connectors/save', {
    connector: { type: 'mcp-stdio', name: 'fx', label: 'Fixture', exposure: 'search', config: { command: process.execPath, args: [FIXTURE, 'stdio'] } },
  });
  const { connector } = data;
  assert.equal(connector.status, 'connected', connector.error);
  assert.equal(connector.exposure, 'search');
  assert.equal(connector.toolCount, 4);
  assert.deepEqual(connector.toolNames, []);
  assert.deepEqual([...host.tools.keys()].filter((n) => n.startsWith('mcp__')), []);
  assert.ok(host.tools.has('connector_search') && host.tools.has('connector_call'));
  assert.match(host.tools.get('connector_search').description, /fx（Fixture，有使用说明）/);
  assert.deepEqual(host.tools.get('connector_call').parameters.properties.connector.enum, ['fx']);

  const found = await host.exec('connector_search', { query: 'echo text' });
  assert.match(found.text, /\n\n### fx\/echo（只读）\nEcho the text back\n参数：text: string/);
  assert.deepEqual(await host.exec('connector_call', { connector: 'fx', tool: 'echo', arguments: { text: 'hi' } }), { text: 'echo: hi' });
  assert.equal((await host.exec('connector_call', { connector: 'fx', tool: 'mcp__fx__add', arguments: { a: 2, b: 40 } })).text, '42');
  await assert.rejects(host.exec('connector_call', { connector: 'fx', tool: 'add', arguments: { a: 2 } }), /缺少必填参数 b[\s\S]*input schema/);
  await assert.rejects(host.exec('connector_call', { connector: 'fx', tool: 'ech' }), /没有工具 ech。相近的：[\s\S]*fx\/echo/);
  await assert.rejects(host.exec('connector_call', { connector: 'fx', tool: 'fail' }), /boom from server/);
  await assert.rejects(host.exec('connector_call', { connector: 'zz', tool: 'echo' }), /没有可用的按需连接器 zz/);
  const call = host.tools.get('connector_call');
  assert.equal(call.isConcurrencySafe({ connector: 'fx', tool: 'echo' }), true);
  assert.equal(call.isConcurrencySafe({ connector: 'fx', tool: 'add' }), false);
  assert.match((await host.exec('connectors_list')).text, /按需加载，共 4 个/);

  // Settings page: switch to direct without a reconnect; the pair goes away with the last search connector.
  const direct = await host.call('POST', '/api/connectors/exposure', { id: connector.id, exposure: 'direct' });
  assert.equal(direct.data.connector.exposure, 'direct');
  assert.equal(host.tools.has('mcp__fx__echo'), true);
  assert.equal(host.tools.has('connector_search'), false);
  assert.equal((await host.call('POST', '/api/connectors/exposure', { id: connector.id, exposure: 'lazy' })).status, 400);

  // The agent switches back with name + exposure only.
  const back = await host.exec('connectors_add', { name: 'fx', exposure: 'search' });
  assert.match(back.text, /改为按需加载 — 已连接，4 个工具按需加载/);
  assert.equal(host.tools.has('mcp__fx__echo'), false);
  assert.equal(host.tools.has('connector_search'), true);

  await host.call('POST', '/api/connectors/toggle', { id: connector.id, enabled: false });
  assert.equal(host.tools.has('connector_search'), false, 'a disabled connector has nothing to search');
});

test('server instructions ride along with the first search that touches the connector', () => {
  const tool = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: {} } });
  const cua = { connector: { name: 'cua', label: 'Cua Driver' }, instructions: 'Call get_window_state before clicking.', tools: [tool('click', 'Click an element'), tool('get_window_state', 'Read a window')] };
  const linear = { connector: { name: 'linear', label: 'Linear' }, tools: [tool('list_issues', 'List issues')] };
  const catalog = [cua, linear];
  const seen = new Set();
  const first = runSearch(catalog, { query: 'click' }, { seen });
  assert.match(first, /^## cua 使用说明（来自服务器[^\n]*\nCall get_window_state before clicking\.\n\n### cua\/click/);
  assert.doesNotMatch(runSearch(catalog, { query: 'window' }, { seen }), /使用说明/, 'once per conversation');
  assert.match(runSearch(catalog, { query: 'window', show_instructions: true }, { seen }), /^## cua 使用说明/, 'asked for again');
  assert.doesNotMatch(runSearch(catalog, { query: 'issues' }, { seen: new Set() }), /使用说明/, 'only connectors in the answer');
  assert.match(runSearch(catalog, { tools: ['cua/click'] }, { seen: new Set() }), /^## cua 使用说明/, 'by-name lookups count too');
  assert.match(runSearch(catalog, { connector: 'cua', query: '*' }, { seen: new Set() }), /^## cua 使用说明/, 'browsing counts too');
  assert.match(runSearch(catalog, { query: 'click' }), /^## cua 使用说明/, 'no agent id: always included');
  assert.match(runSearch([{ ...cua, instructions: 'New notes after an upgrade.' }], { query: 'click' }, { seen }), /New notes after an upgrade/, 'changed notes are new');
  assert.equal(instructionsOf({ instructions: '   ' }), undefined);
  assert.equal(instructionsOf({}), undefined);
  assert.match(instructionsOf({ instructions: 'x'.repeat(9000) }), /^x{8000}\n…（说明过长，已截断）$/);
});

test('search exposure: the fixture server\'s instructions reach each agent once', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const { data } = await host.call('POST', '/api/connectors/save', {
    connector: { type: 'mcp-stdio', name: 'fx', label: 'Fixture', exposure: 'search', config: { command: process.execPath, args: [FIXTURE, 'stdio'] } },
  });
  assert.equal(data.connector.status, 'connected', data.connector.error);
  const search = host.tools.get('connector_search');
  assert.match(search.description, /fx（Fixture，有使用说明）/);
  assert.ok('show_instructions' in search.parameters.properties);
  const as = (id, args) => search.execute(args, { signal: new AbortController().signal, agent: { id } });
  assert.match((await as('a1', { query: 'echo' })).text, /^## fx 使用说明[^\n]*\nFixture server for tests\.\n（这里提到的文档[^\n]*connector_resource[^\n]*\n\n### fx\/echo/);
  assert.doesNotMatch((await as('a1', { query: 'add' })).text, /使用说明/);
  assert.match((await as('a2', { query: 'add' })).text, /^## fx 使用说明/, 'a subagent has its own context');
  assert.match((await as('a1', { query: 'add', show_instructions: true })).text, /^## fx 使用说明/);
  await assert.rejects(host.tools.get('connector_call').execute({ connector: 'fx', tool: 'ech' }, { agent: { id: 'a3' } }), (error) => !/使用说明/.test(error.message));
});

test('reading documents: outline, pages that end on a line, sections by heading, binary content', () => {
  assert.deepEqual(headings(GUIDE).map((h) => `${h.level}:${h.title}`), ['1:Guide', '2:Setup', '2:Usage', '3:Details', '2:FAQ'], 'fenced lines are not headings');
  const usage = section(GUIDE, 'usage');
  assert.equal(usage.title, 'Usage');
  assert.match(usage.text, /^## Usage\n[\s\S]*### Details\nMore detail\.\n$/, 'a section keeps its subsections and stops at the next sibling');
  assert.equal(section(GUIDE, '## FAQ').text, '## FAQ\nAnswers.\n');
  assert.equal(section(GUIDE, 'nothing'), undefined);
  const p = page(GUIDE, 0, 1000);
  assert.ok(p.end < 1000 && p.end > 800 && GUIDE[p.end - 1] === '\n', 'pages end on a line break');

  const doc = { contents: [{ uri: 'doc://g', text: GUIDE }] };
  const first = renderRead(doc, { uri: 'doc://g', max_chars: 1000 });
  assert.match(first, new RegExp(`^doc://g — 第 0–${p.end} 字符，共 ${GUIDE.length} 字符\\n\\n目录（用 heading 参数直接读某一节）：\\n- Guide\\n  - Setup\\n  - Usage\\n    - Details\\n  - FAQ\\n\\n# Guide`));
  assert.match(first, new RegExp(`下一段用 offset: ${p.end}）$`));
  const next = renderRead(doc, { uri: 'doc://g', max_chars: 1000, offset: p.end });
  assert.doesNotMatch(next, /目录/, 'the outline comes only with the first page');
  assert.ok(next.includes(GUIDE.slice(p.end, p.end + 50)));
  assert.match(renderRead(doc, { uri: 'doc://g', heading: 'faq' }), /^doc:\/\/g § FAQ — 第 0–16 字符，共 16 字符\n\n## FAQ\nAnswers\.\n$/);
  assert.match(renderRead(doc, { uri: 'doc://g', heading: 'install' }), /没有标题包含「install」[\s\S]*- Setup/);
  assert.match(renderRead({ contents: [{ uri: 'doc://b', mimeType: 'image/png', blob: 'AAAA' }] }, { uri: 'doc://b' }), /二进制内容 doc:\/\/b（image\/png，4 个 base64 字符）/);
  assert.equal(renderRead({ contents: [] }, { uri: 'doc://e' }), 'doc://e 没有内容。');
});

test('connector_resource lists and reads a connector\'s documents, direct or on demand', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  assert.equal(host.tools.has('connector_resource'), false, 'no documents yet');
  const { data } = await host.call('POST', '/api/connectors/save', {
    connector: { type: 'mcp-stdio', name: 'fx', label: 'Fixture', config: { command: process.execPath, args: [FIXTURE, 'stdio'] } },
  });
  assert.equal(data.connector.status, 'connected', data.connector.error);
  const tool = host.tools.get('connector_resource');
  assert.ok(tool, 'a direct connector offers its documents too');
  assert.deepEqual(tool.parameters.properties.connector.enum, ['fx']);

  const listed = await host.exec('connector_resource', { connector: 'fx' });
  assert.match(listed.text, /^fx 的文档（2 份）：\n- doc:\/\/fixture\/GUIDE\.md（guide） \[text\/markdown\]：How to use the fixture\n- doc:\/\/fixture\/logo\.png/);
  assert.match(listed.text, /URI 模板（1 个，把 \{变量\} 换成具体值后作为 uri 读取）：\n- doc:\/\/fixture\/notes\/\{id\}（note） \[text\/plain\]：One note by id/);
  assert.doesNotMatch(listed.text, /ui:\/\//, 'MCP App views are not documents');
  assert.match(listed.text, /另有 1 个 MCP App 界面资源/);
  assert.match((await host.exec('connector_resource', { connector: 'fx', uri: 'doc://fixture/notes/42' })).text, /\n\nnote 42$/, 'a filled-in template reads like any document');
  const first = await host.exec('connector_resource', { connector: 'fx', uri: 'doc://fixture/GUIDE.md', max_chars: 1000 });
  assert.match(first.text, /^doc:\/\/fixture\/GUIDE\.md — 第 0–\d+ 字符，共 \d+ 字符\n\n目录/);
  assert.match((await host.exec('connector_resource', { connector: 'fx', uri: 'doc://fixture/GUIDE.md', heading: 'Details' })).text, /§ Details[\s\S]*More detail\./);
  assert.match((await host.exec('connector_resource', { connector: 'fx', uri: 'doc://fixture/logo.png' })).text, /二进制内容/);
  await assert.rejects(host.exec('connector_resource', { connector: 'fx', uri: 'doc://fixture/none' }), /./);
  await assert.rejects(host.exec('connector_resource', { connector: 'zz' }), /连接器 zz 不提供文档/);

  // On demand: the usage notes point at the tool.
  await host.call('POST', '/api/connectors/exposure', { id: data.connector.id, exposure: 'search' });
  assert.match((await host.exec('connector_search', { query: 'echo' })).text, /用 connector_resource 读取：先 \{ connector: "fx" \} 列出/);
  assert.ok(host.tools.has('connector_resource'));

  await host.call('POST', '/api/connectors/toggle', { id: data.connector.id, enabled: false });
  assert.equal(host.tools.has('connector_resource'), false, 'gone with the last connector that has documents');
});

test('documents for the model: UI views are not documents; templates are listed; notes section text', () => {
  assert.equal(isModelDocument({ uri: 'skill://cua-driver/SKILL.md', mimeType: 'text/markdown' }), true);
  assert.equal(isModelDocument({ uri: 'ui://github-mcp-server/get-me', mimeType: 'text/html;profile=mcp-app' }), false);
  assert.equal(isModelDocument({ uri: 'https://x/app', mimeType: 'text/html; profile="mcp-app"' }), false);
  assert.equal(isModelDocument({ uriTemplate: 'repo://{owner}/{repo}/contents{/path*}' }), true);
  assert.equal(isMethodNotFound({ code: -32601, message: 'x' }), true);
  assert.equal(isMethodNotFound(new Error('MCP error -32601: Unknown method: resources/templates/list')), true);
  assert.equal(isMethodNotFound(new Error('timeout')), false);

  const ui = { uri: 'ui://g/get-me', name: 'get_me_ui', mimeType: 'text/html;profile=mcp-app' };
  assert.equal(renderList('github', [ui, ui]), 'github 没有可读的文档。\n（另有 2 个 MCP App 界面资源，只供能渲染界面的客户端使用，已略去）');
  assert.match(renderList('github', [ui], [{ uriTemplate: 'repo://{owner}/{repo}/contents{/path*}', name: 'repo_contents' }]),
    /^URI 模板（1 个[^\n]*\n- repo:\/\/\{owner\}\/\{repo\}\/contents\{\/path\*\}（repo_contents）\n用 \{ connector: "github", uri \} 读取/);

  assert.equal(notesSection([]), '');
  const text = notesSection([
    { connector: { name: 'my-mail', label: 'Mail' }, instructions: 'Search before reading.' },
    { connector: { name: 'cua', label: 'Cua Driver' }, instructions: 'Snapshot first.', resources: true },
  ]);
  assert.match(text, /^## Connector usage notes\n\n### 连接器 my-mail（Mail，工具 mcp__my_mail__\*）\n\nSearch before reading\.\n\n### 连接器 cua/);
  assert.match(text, /Snapshot first\.\n（这里提到的文档[^\n]*connector_resource/);
  assert.doesNotMatch(text.split('### 连接器 cua')[0], /connector_resource/, 'the docs hint only where there are documents');
});

test('usage notes reach the model in both modes: system prompt when direct, first search when on demand', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const NOTES = 'dsh-connectors:usage-notes';
  assert.equal(host.prompt(NOTES), '');
  const { data } = await host.call('POST', '/api/connectors/save', {
    connector: { type: 'mcp-stdio', name: 'fx', label: 'Fixture', config: { command: process.execPath, args: [FIXTURE, 'stdio'] } },
  });
  assert.equal(data.connector.status, 'connected', data.connector.error);
  assert.match(host.prompt(NOTES), /### 连接器 fx（Fixture，工具 mcp__fx__\*）\n\nFixture server for tests\.\n（这里提到的文档[^\n]*connector_resource/);

  await host.call('POST', '/api/connectors/exposure', { id: data.connector.id, exposure: 'search' });
  assert.equal(host.prompt(NOTES), '', 'on demand: out of the system prompt');
  assert.match((await host.exec('connector_search', { query: 'echo' })).text, /^## fx 使用说明[^\n]*\nFixture server for tests\./);

  await host.call('POST', '/api/connectors/exposure', { id: data.connector.id, exposure: 'direct' });
  assert.match(host.prompt(NOTES), /Fixture server for tests\./);
  await host.call('POST', '/api/connectors/toggle', { id: data.connector.id, enabled: false });
  assert.equal(host.prompt(NOTES), '', 'a disabled connector has no notes');
});

test('a server whose only resources are MCP App views does not count as offering documents', async (t) => {
  const host = await mount();
  t.after(host.unmount);
  const { data } = await host.call('POST', '/api/connectors/save', {
    connector: { type: 'mcp-stdio', name: 'uionly', config: { command: process.execPath, args: [FIXTURE, 'stdio', 'ui-only'] } },
  });
  assert.equal(data.connector.status, 'connected', data.connector.error);
  assert.equal(host.tools.has('mcp__uionly__echo'), true);
  assert.equal(host.tools.has('connector_resource'), false);
  assert.doesNotMatch(host.prompt('dsh-connectors:usage-notes'), /connector_resource/, 'no docs hint either');
});
