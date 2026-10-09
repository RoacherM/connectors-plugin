import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { EMAIL_PROVIDERS, PRESETS } from '../src/shared/presets.js';

const require = createRequire(import.meta.url);

async function loadClient(fetchImpl) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:19387/', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = fetchImpl;
  window.fetch = fetchImpl;
  let loaded;
  window.__ModuleLoader__ = { load: ({ factory }) => { loaded = factory((name) => require(name)); } };
  new Function(await readFile(new URL('../client.js', import.meta.url), 'utf8'))();
  const registrations = [];
  const calls = [];
  const listeners = new Set();
  let snap = { active: 'zh-CN', revision: 0 };
  const locale = {
    register: () => () => {}, bind: () => (key) => ({ panel: '连接器' })[key] ?? key,
    getSnapshot: () => snap, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set(active) { snap = { active, revision: snap.revision + 1 }; for (const fn of listeners) fn(); },
  };
  loaded.apply({
    effect: (fn) => fn(),
    get: (name) => ({ uiWorkspace: { startSession: () => calls.push('startSession') }, layout: { selectPanel: (id) => calls.push(['selectPanel', id]) } })[name],
    locale,
    slots: { inject: (name, cb) => cb(), register: (meta, Component) => { registrations.push({ meta, Component }); return () => {}; } },
  });
  return { registrations, calls, locale };
}

const base = { tools: [], toolNames: [], secrets: {}, enabled: true };
const GITHUB = { ...base, id: 'c-1', name: 'github', label: 'GitHub', type: 'mcp-http', preset: 'github', status: 'connected', config: { url: 'https://api.githubcopilot.com/mcp/', auth: 'headers' },
  tools: [{ name: 'get_me', description: 'Who am I' }, { name: 'list_issues', description: 'List issues' }], toolNames: ['mcp__github__get_me', 'mcp__github__list_issues'], secretSpec: { kind: 'header', label: 'Personal Access Token', url: 'https://github.com/settings/personal-access-tokens/new' } };
const SLACK = { ...base, id: 'c-2', name: 'slack', label: 'Slack', type: 'mcp-http', status: 'needs_secret', config: { url: 'https://mcp.slack.com/mcp', auth: 'headers' }, secretSpec: { kind: 'header', label: 'Slack Bot Token', hint: '复制 xoxb- token' } };
const NOTION = { ...base, id: 'c-3', name: 'notion', label: 'Notion', type: 'mcp-http', preset: 'notion', status: 'error', error: '连接已断开；已重试 8 次，点击「重新连接」再试\nstack', config: { url: 'https://mcp.notion.com/mcp', auth: 'oauth' } };

function backend() {
  const requests = [];
  let connectors = [GITHUB, SLACK, NOTION];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push([init.method ?? 'GET', path, body]);
    const ok = (value) => new Response(JSON.stringify(value), { status: 200 });
    if (path === '/api/connectors') return ok({ connectors, presets: PRESETS, emailProviders: EMAIL_PROVIDERS, revision: 1 });
    if (path.endsWith('/wait')) return new Promise(() => {});
    if (path.endsWith('/secret')) {
      if (body.value === 'bad') return new Response(JSON.stringify({ error: 'Token 无效' }), { status: 400 });
      connectors = connectors.map((c) => (c.id === body.id ? { ...c, status: 'connected', toolNames: ['mcp__slack__post'], tools: [{ name: 'post' }] } : c));
      return ok({ connector: connectors.find((c) => c.id === body.id) });
    }
    if (path.endsWith('/exposure')) {
      connectors = connectors.map((c) => (c.id === body.id ? { ...c, exposure: body.exposure, toolCount: c.tools.length, toolNames: body.exposure === 'search' ? [] : c.toolNames } : c));
      return ok({ connector: connectors.find((c) => c.id === body.id) });
    }
    if (path.endsWith('/quick')) {
      const created = { ...base, id: 'c-9', name: 'outlook', label: 'Outlook', type: 'email', preset: 'outlook', status: 'connected', config: { provider: 'outlook', user: body.user } };
      connectors = [...connectors, created];
      return ok({ connector: created });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, requests };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const submit = (form) => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

test('connectors page: even cards, no forms — one line for a key, one line to add a service', async () => {
  const { fetchImpl, requests } = backend();
  const { registrations, calls, locale } = await loadClient(fetchImpl);
  const main = registrations.find((r) => r.meta.name === 'main');
  assert.equal(main.meta.key, 'local-connectors');
  assert.equal(registrations.find((r) => r.meta.name === 'sidebar.panellist').meta.label(), '连接器');
  assert.deepEqual(registrations.filter((r) => r.meta.name === 'tool.call.toolview').map((r) => r.meta.key), ['connectors_add', 'connectors_remove']);

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(main.Component)); await settle(); });

  const cards = [...document.querySelectorAll('.cx-card')];
  assert.equal(cards.length, 3);
  // Same structure in every state: identity, state line, one action line. No tool list inline.
  for (const card of cards) assert.equal(card.children.length, 3);
  assert.equal(document.querySelectorAll('.cx-tool, .cx-tools').length, 0);
  assert.equal(document.querySelectorAll('form').length, 1, 'the only form is the pending key line');
  assert.equal(cards[2].querySelector('.cx-meta-err').textContent, '连接已断开；已重试 8 次，点击「重新连接」再试', 'errors stay on one line');

  // The tool list opens in a sheet instead of growing the card.
  await act(async () => { cards[0].querySelector('.cx-linkbtn').click(); });
  assert.match(document.querySelector('[role="dialog"]').textContent, /get_me.*Who am I/);
  await act(async () => { document.querySelector('[aria-label="关闭"]').click(); });

  // Slack waits for its token: a wrong one is reported in place, a right one connects.
  const line = cards[1].querySelector('.cx-secret');
  assert.equal(line.querySelector('input').placeholder, '粘贴Slack Bot Token');
  await act(async () => { setValue(line.querySelector('input'), 'bad'); submit(line); await settle(); });
  assert.equal(line.querySelector('input').placeholder, 'Token 无效');
  await act(async () => { setValue(line.querySelector('input'), 'xoxb-1'); submit(line); await settle(); });
  assert.deepEqual(requests.filter(([, p]) => p.endsWith('/secret')).at(-1)[2], { id: 'c-2', value: 'xoxb-1' });
  assert.match(document.querySelectorAll('.cx-card')[1].textContent, /已连接/);

  // Rotating GitHub's token swaps its action line for the same one-line prompt.
  const rotate = [...document.querySelectorAll('.cx-card')[0].querySelectorAll('button')].find((b) => b.textContent.includes('更换密钥'));
  await act(async () => { rotate.click(); });
  assert.ok(document.querySelectorAll('.cx-card')[0].querySelector('.cx-secret'));
  assert.equal(document.querySelectorAll('.cx-card')[0].children.length, 3);

  // Direct ↔ on demand is one click in the state line; the tool count stays the same.
  const mode = () => document.querySelectorAll('.cx-card')[0].querySelector('.cx-mode');
  assert.equal(mode().textContent, '直接提供');
  await act(async () => { mode().click(); await settle(); });
  assert.deepEqual(requests.filter(([, p]) => p.endsWith('/exposure')).at(-1)[2], { id: 'c-1', exposure: 'search' });
  assert.equal(mode().textContent, '按需加载');
  assert.equal(mode().getAttribute('aria-pressed'), 'true');
  assert.match(document.querySelectorAll('.cx-card')[0].textContent, /2 个工具/);
  await act(async () => { document.querySelectorAll('.cx-card')[0].querySelector('.cx-linkbtn').click(); });
  assert.match(document.querySelector('[role="dialog"]').textContent, /按需加载：Agent 用 connector_search 查找/);
  await act(async () => { document.querySelector('[aria-label="关闭"]').click(); });
  await act(async () => { mode().click(); await settle(); });
  assert.equal(mode().textContent, '直接提供');

  // Gallery: added services are marked; a mail service asks for address + code on one line.
  const tile = (label) => [...document.querySelectorAll('.cx-add')].find((b) => b.querySelector('.cx-add-name').textContent === label);
  assert.equal(tile('GitHub').disabled, true);
  await act(async () => { tile('Outlook').click(); });
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelectorAll('input').length, 2);
  await act(async () => { setValue(dialog.querySelector('input[type="email"]'), 'me@outlook.com'); setValue(dialog.querySelector('input[type="password"]'), 'abcd'); submit(dialog.querySelector('form')); await settle(); });
  assert.deepEqual(requests.find(([, p]) => p.endsWith('/quick'))[2], { preset: 'outlook', user: 'me@outlook.com', secret: 'abcd' });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.match(document.body.textContent, /me@outlook\.com/);

  // DSH switched to English: the page, statuses, preset blurbs and known errors follow live.
  await act(async () => { locale.set('en-US'); });
  assert.equal(document.querySelector('.cx-head h1').textContent, 'Connectors');
  assert.match(document.querySelectorAll('.cx-card')[0].textContent, /Connected.*Remote MCP.*2 tools/);
  assert.equal(tile('Linear').querySelector('.cx-add-desc').textContent, 'Issues, projects and cycles, browser sign-in');
  assert.ok(tile('Other services'));
  assert.equal(document.querySelectorAll('.cx-card')[2].querySelector('.cx-meta-err').textContent, 'Connection lost — retried 8 times; click Retry to try again.');
  await act(async () => { locale.set('zh-CN'); });

  await act(async () => { tile('其他服务').click(); });
  assert.deepEqual(calls.slice(0, 2), [['selectPanel', null], 'startSession'], 'leave the panel before starting the new session');
  assert.equal(tile('QQ 邮箱'), undefined);
  await act(async () => { root.unmount(); });
});

test('chat card: while connectors_add waits, the key is typed right in the conversation', async () => {
  const { fetchImpl, requests } = backend();
  const { registrations } = await loadClient(fetchImpl);
  const Card = registrations.find((r) => r.meta.key === 'connectors_add').Component;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(Card, { toolName: 'connectors_add', phase: 'start', block: { argsRaw: '{"type":"mcp-http","name":"slack"}' } })); await settle(); });
  assert.match(document.body.textContent, /接入 Slack.*复制 xoxb- token/);
  const line = document.querySelector('.cx-secret');
  await act(async () => { setValue(line.querySelector('input'), 'xoxb-2'); submit(line); await settle(); });
  assert.deepEqual(requests.filter(([, p]) => p.endsWith('/secret')).at(-1)[2], { id: 'c-2', value: 'xoxb-2' });

  const result = { content: [{ type: 'text', text: '已添加连接器「GitHub」（name: github）— 已连接，共 45 个工具：mcp__github__get_me' }], call: { argsRaw: '{"preset":"github"}' } };
  await act(async () => { root.render(React.createElement(Card, { toolName: 'connectors_add', phase: 'result', block: result })); });
  assert.equal(document.querySelector('.cx-toolcard-title').textContent, 'GitHub');
  assert.equal(document.querySelector('.cx-toolcard-sub').textContent, '已连接 · 45 个工具');
  assert.equal(document.querySelector('.cx-secret'), null);
  await act(async () => { root.unmount(); });
});
