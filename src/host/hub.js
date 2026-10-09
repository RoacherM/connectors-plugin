/**
 * The connector hub: one runtime per stored connector. A `direct` connector's tools are registered
 * on `ctx.tools` as `mcp__<name>__<tool>` while it is enabled and its tools are known; a `search`
 * connector registers none and is reached through `catalog()` / `call()` (see search.js).
 */
import { createHash } from 'node:crypto';
import { exposureOf, toolName } from '../shared/presets.js';
import { createEmailConnection } from './email.js';
import { createMcpConnection } from './mcp.js';
import { publicSpec, secretSpec } from './secretspec.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_TEXT = 200_000;

export const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text'],
  properties: {
    text: { type: 'string' },
    images: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' } },
      },
    },
  },
};
export const render = (_args, value) => [
  { type: 'text', text: value.text },
  ...(value.images ?? []).map((image) => ({ type: 'image', attachment: image })),
];

/** MCP input schemas go to the model as tool parameters; keep them a plain object schema. */
export function sanitizeSchema(schema) {
  const base = schema && typeof schema === 'object' ? structuredClone(schema) : {};
  delete base.$schema;
  delete base.$id;
  base.type = 'object';
  if (!base.properties || typeof base.properties !== 'object') base.properties = {};
  return base;
}

/** Flatten an MCP CallToolResult into model-visible text plus any images. */
export async function convertResult(result, attachments) {
  const parts = [];
  const images = [];
  for (const block of result?.content ?? []) {
    if (block?.type === 'text') parts.push(block.text);
    else if (block?.type === 'image') {
      if (attachments && IMAGE_TYPES.has(block.mimeType)) {
        try {
          const ref = await attachments.saveImage({ data: new Uint8Array(Buffer.from(block.data, 'base64')), mediaType: block.mimeType, name: 'connector-image' });
          images.push({ attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height });
          continue;
        } catch { /* fall through to the text note */ }
      }
      parts.push(`[图片 ${block.mimeType ?? ''}，无法展示]`);
    } else if (block?.type === 'resource') {
      const resource = block.resource ?? {};
      parts.push(resource.text !== undefined ? `[资源 ${resource.uri}]\n${resource.text}` : `[二进制资源 ${resource.uri}（${resource.mimeType ?? '未知类型'}）]`);
    } else if (block?.type === 'resource_link') parts.push(`[链接] ${block.name ?? ''} ${block.uri}`.trim());
    else if (block?.type === 'audio') parts.push('[音频内容，已省略]');
    else if (block) parts.push(JSON.stringify(block));
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  let text = parts.join('\n\n');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…（结果过长，已截断，共 ${text.length} 字）`;
  return { text: text || '(空结果)', ...(images.length ? { images } : {}) };
}

const MAX_INSTRUCTIONS = 8000;

/** The usage notes an MCP server sent at initialize, trimmed and capped; undefined when there are none. */
export function instructionsOf(connection) {
  const raw = typeof connection?.instructions === 'string' ? connection.instructions.trim() : '';
  if (!raw) return undefined;
  return raw.length > MAX_INSTRUCTIONS ? `${raw.slice(0, MAX_INSTRUCTIONS)}\n…（说明过长，已截断）` : raw;
}

/** Statuses that are still waiting on something (the user, a browser login, the network). */
const UNSETTLED = new Set(['needs_secret', 'needs_auth', 'connecting', 'reconnecting', 'disconnected']);

/**
 * @param deps.needsSecret - (connector) → true while the user has not supplied its secret; such a
 *   connector is not connected and contributes no tools until they do.
 */
export function createHub({ ctx, store, secrets, callbackServer, attachments, baseEnv, log = () => {}, factories = {}, needsSecret = async () => false }) {
  const runtimes = new Map();
  const chains = new Map();
  const listeners = new Set();
  let revision = 0;
  const changed = () => { revision++; for (const fn of listeners) fn(); };

  function publicName(connector, raw, taken) {
    let name = toolName(connector.name, raw);
    if (taken.has(name)) name = `${name.slice(0, 51)}_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
    return name;
  }

  /** The tools a runtime can serve now; kept through a reconnect. */
  function liveTools(runtime) {
    const snap = runtime.connection.snapshot();
    // Email tools are static and every call logs in afresh, so they stay available even after a failed check.
    const keep = runtime.connector.enabled && !runtime.needsSecret && (runtime.connector.type === 'email' || snap.status === 'connected' || snap.status === 'reconnecting');
    return keep ? snap.tools : [];
  }

  /** Register exactly the tools a direct connector currently advertises; a search connector registers none. */
  function syncTools(runtime) {
    const tools = exposureOf(runtime.connector) === 'direct' ? liveTools(runtime) : [];
    const wanted = new Map();
    const taken = new Set();
    for (const tool of tools) {
      const name = publicName(runtime.connector, tool.name, taken);
      taken.add(name);
      wanted.set(name, tool);
    }
    for (const [name, entry] of runtime.registered) {
      if (!wanted.has(name) || entry.signature !== JSON.stringify(wanted.get(name))) {
        entry.dispose();
        runtime.registered.delete(name);
      }
    }
    for (const [name, tool] of wanted) {
      if (runtime.registered.has(name)) continue;
      if (ctx.tools.get?.(name) !== undefined) {
        log(`连接器 ${runtime.connector.name}: 工具名 ${name} 已被占用，跳过`);
        continue;
      }
      const connector = runtime.connector;
      const definition = {
        name,
        description: `[连接器 · ${connector.label}] ${tool.description || tool.name}`.slice(0, 4000),
        parameters: sanitizeSchema(tool.inputSchema),
        output: { schema: OUTPUT_SCHEMA, render },
        isConcurrencySafe: () => tool.annotations?.readOnlyHint === true,
        execute: (args, exec) => invoke(runtime, tool.name, args, exec?.signal),
      };
      try {
        const dispose = ctx.effect(() => ctx.tools.register(definition), `dsh-connectors: ${name}`);
        runtime.registered.set(name, { dispose, signature: JSON.stringify(tool) });
      } catch (error) {
        log(`连接器 ${connector.name}: 注册工具 ${name} 失败：${error.message}`);
      }
    }
  }

  /** An enabled connector whose server lists documents for the model (UI-only or email connectors have none). */
  function servesResources(runtime) {
    return runtime.connector.enabled && !runtime.needsSecret
      && runtime.connection.snapshot().documents > 0 && typeof runtime.connection.readResource === 'function';
  }

  function runtimeNamed(connectorName, usable = () => true) {
    const runtime = [...runtimes.values()].find((r) => r.connector.name === connectorName);
    if (!runtime || !usable(runtime)) throw new Error(`没有名为 ${connectorName} 的${usable === servesResources ? '提供文档的' : ''}连接器`);
    return runtime;
  }

  async function invoke(runtime, rawName, args, signal) {
    const result = await runtime.connection.callTool(rawName, args, signal);
    const value = await convertResult(result, attachments);
    if (result?.isError) throw new Error(value.text);
    return value;
  }

  function createRuntime(connector) {
    const runtime = { connector, registered: new Map(), connection: undefined };
    const onChange = () => { syncTools(runtime); changed(); };
    const deps = { connector, secrets, onChange, log };
    runtime.connection = connector.type === 'email'
      ? (factories.email ?? createEmailConnection)(deps)
      : (factories.mcp ?? createMcpConnection)({ ...deps, callbackServer, baseEnv });
    runtimes.set(connector.id, runtime);
    return runtime;
  }

  /** Run lifecycle operations on one connector strictly one after another (start-up vs. user edits). */
  function serial(id, fn) {
    const run = (chains.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    chains.set(id, tail);
    tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
    return run;
  }

  async function stopRuntime(id) {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    runtimes.delete(id);
    for (const entry of runtime.registered.values()) entry.dispose();
    runtime.registered.clear();
    await runtime.connection.disconnect().catch(() => {});
    changed();
  }

  async function startRuntime(connector) {
    await stopRuntime(connector.id);
    const runtime = createRuntime(connector);
    runtime.needsSecret = await needsSecret(connector);
    if (connector.enabled && !runtime.needsSecret) {
      await runtime.connection.connect().catch((error) => log(`连接器 ${connector.name} 连接失败：${error.message}`));
      syncTools(runtime);
    }
    changed();
    return runtime;
  }

  function view(connector) {
    const snap = runtimes.get(connector.id)?.connection.snapshot() ?? { status: 'disconnected', tools: [] };
    const runtime = runtimes.get(connector.id);
    return {
      ...connector,
      exposure: exposureOf(connector),
      toolCount: runtime ? liveTools(runtime).length : 0,
      status: !connector.enabled ? 'disabled' : runtime?.needsSecret ? 'needs_secret' : snap.status,
      secretSpec: publicSpec(secretSpec(connector)),
      error: snap.error,
      authUrl: snap.authUrl,
      server: snap.server,
      tools: snap.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      toolNames: runtime ? [...runtime.registered.keys()] : [],
    };
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get revision() { return revision; },
    async start() {
      const connectors = await store.list();
      await Promise.allSettled(connectors.map((connector) => serial(connector.id, async () => {
        const current = await store.get(connector.id);
        if (current && !runtimes.has(connector.id)) await startRuntime(current);
      })));
    },
    async list() { return (await store.list()).map(view); },
    async get(id) {
      const connector = await store.get(id);
      return connector && view(connector);
    },
    /** Re-read the stored record and (re)connect; used after every edit. */
    reload(id) {
      return serial(id, async () => {
        const connector = await store.get(id);
        if (!connector) { await stopRuntime(id); return undefined; }
        await startRuntime(connector);
        return view(connector);
      });
    },
    connect(id) {
      return serial(id, async () => {
        const connector = await store.get(id);
        if (!connector) return undefined;
        const runtime = runtimes.get(id);
        if (!runtime || !connector.enabled) {
          await startRuntime(connector);
          return view(connector);
        }
        runtime.connector = connector;
        runtime.needsSecret = await needsSecret(connector);
        if (runtime.needsSecret) { changed(); return view(connector); }
        await runtime.connection.disconnect().catch(() => {});
        await runtime.connection.connect();
        syncTools(runtime);
        return view(connector);
      });
    },
    remove(id) { return serial(id, async () => { await stopRuntime(id); changed(); }); },
    /** Apply an edit that changes only how tools are exposed: re-register without reconnecting. */
    resync(id) {
      return serial(id, async () => {
        const connector = await store.get(id);
        if (!connector) { await stopRuntime(id); return undefined; }
        const runtime = runtimes.get(id);
        if (!runtime) { await startRuntime(connector); return view(connector); }
        runtime.connector = connector;
        syncTools(runtime);
        changed();
        return view(connector);
      });
    },
    /** Enabled search connectors that can serve tools now, with their raw MCP tool list. */
    catalog() {
      const entries = [];
      for (const runtime of runtimes.values()) {
        if (exposureOf(runtime.connector) !== 'search') continue;
        const tools = liveTools(runtime);
        const instructions = instructionsOf(runtime.connection);
        if (tools.length) entries.push({ connector: runtime.connector, tools, ...(instructions ? { instructions } : {}), ...(servesResources(runtime) ? { resources: true } : {}) });
      }
      return entries.sort((a, b) => a.connector.name.localeCompare(b.connector.name));
    },
    /** Enabled connectors (direct or search) whose server offers resources (documents) now. */
    resourceConnectors() {
      return [...runtimes.values()].filter(servesResources).map((r) => r.connector).sort((a, b) => a.name.localeCompare(b.name));
    },
    /** Run one raw MCP tool of a search connector, with the same result conversion as a direct tool. */
    call(connectorName, rawName, args, signal) {
      return invoke(runtimeNamed(connectorName), rawName, args, signal);
    },
    listResources(connectorName, signal) {
      return runtimeNamed(connectorName, servesResources).connection.listResources(signal);
    },
    listResourceTemplates(connectorName, signal) {
      return runtimeNamed(connectorName, servesResources).connection.listResourceTemplates(signal);
    },
    /** Enabled direct connectors that can serve tools now and whose server sent usage notes. */
    directNotes() {
      const entries = [];
      for (const runtime of runtimes.values()) {
        if (exposureOf(runtime.connector) !== 'direct' || liveTools(runtime).length === 0) continue;
        const instructions = instructionsOf(runtime.connection);
        if (instructions) entries.push({ connector: runtime.connector, instructions, ...(servesResources(runtime) ? { resources: true } : {}) });
      }
      return entries.sort((a, b) => a.connector.name.localeCompare(b.connector.name));
    },
    readResource(connectorName, uri, signal) {
      return runtimeNamed(connectorName, servesResources).connection.readResource(uri, signal);
    },
    /**
     * Resolve with the connector's view once it stops waiting (connected, failed, disabled or
     * removed), or when `timeoutMs` passes or `signal` aborts — whichever comes first.
     */
    async waitSettled(id, { signal, timeoutMs = 15 * 60 * 1000 } = {}) {
      const settled = async () => {
        const current = await this.get(id);
        return !current || !UNSETTLED.has(current.status) ? { view: current, settled: true } : undefined;
      };
      const first = await settled();
      if (first) return first;
      return new Promise((resolve) => {
        let done = false;
        const finish = async (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', onAbort);
          resolve(result ?? { view: await this.get(id), settled: false });
        };
        const onAbort = () => finish();
        const timer = setTimeout(() => finish(), timeoutMs);
        timer.unref?.();
        const unsubscribe = this.subscribe(() => { settled().then((r) => { if (r) finish(r); }, () => {}); });
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    /** Plain-text directory of connectors for the model. */
    async describe() {
      const list = await this.list();
      if (list.length === 0) return '还没有配置任何连接器。用户可以在左侧栏的「连接器」页面添加 Gmail、GitHub、Notion 等。';
      return list.map((c) => {
        const status = { connected: '已连接', disabled: '已停用', needs_auth: '等待登录授权', needs_secret: '等待用户填写密钥', error: `出错：${c.error ?? ''}`, connecting: '连接中', reconnecting: '重连中', disconnected: '未连接' }[c.status] ?? c.status;
        const tools = c.exposure === 'search'
          ? (c.toolCount ? `\n  工具：按需加载，共 ${c.toolCount} 个，用 connector_search（connector: "${c.name}"）查找，connector_call 调用` : '')
          : c.toolNames.length ? `\n  工具：${c.toolNames.join(', ')}` : '';
        return `- ${c.label}（name: ${c.name}，类型: ${c.type}）— ${status}${tools}`;
      }).join('\n');
    },
    async dispose() {
      await Promise.allSettled([...runtimes.keys()].map((id) => stopRuntime(id)));
    },
  };
}
