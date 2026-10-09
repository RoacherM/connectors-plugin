/**
 * One live MCP connection per connector: Streamable HTTP (falling back to legacy SSE) or stdio,
 * with OAuth for remote servers, tool discovery, list-changed refresh and reconnect with backoff.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { isMethodNotFound, isModelDocument } from './documents.js';
import { createAuthProvider } from './oauth.js';

const CLIENT_INFO = { name: 'deepseek-harness-connectors', version: '0.1.0' };
const CALL_TIMEOUT_MS = 120_000;
const MAX_RECONNECTS = 8;

const errorText = (error) => {
  const message = error?.message ?? String(error);
  return error?.cause?.message && !message.includes(error.cause.message) ? `${message}（${error.cause.message}）` : message;
};

/** Turn SDK auth failures the user can fix into instructions. */
export function explain(message, redirectUrl) {
  if (/dynamic client registration/i.test(message)) {
    return '这个服务器不支持 OAuth 自动注册客户端：请改用 API Token 认证——让 Agent 用 auth: "headers" 重新接入，然后在弹出的输入框里填 Token（GitHub 用 Personal Access Token）。';
  }
  if (/invalid_client|client authentication failed/i.test(message)) return `OAuth 客户端认证失败：请检查 Client ID / Client Secret 是否正确（${message}）`;
  return message;
}

/** Page through tools/list; the SDK caps nothing here, so we do (a runaway cursor chain stops at 50 pages). */
async function listAllTools(client) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/**
 * Every resource (`kind: 'resources'`) or resource template (`'templates'`) a server lists; a runaway
 * cursor chain stops at 50 pages. A server without templates answers "method not found": none.
 */
async function listAll(client, kind, signal) {
  const items = [];
  let cursor;
  try {
    for (let page = 0; page < 50; page++) {
      const params = cursor ? { cursor } : undefined;
      const options = { signal, timeout: CALL_TIMEOUT_MS };
      const result = kind === 'templates' ? await client.listResourceTemplates(params, options) : await client.listResources(params, options);
      items.push(...((kind === 'templates' ? result.resourceTemplates : result.resources) ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  } catch (error) {
    if (kind === 'templates' && isMethodNotFound(error)) return [];
    throw error;
  }
  return items;
}

/**
 * @param deps.connector - the stored record (type mcp-http or mcp-stdio).
 * @param deps.secrets - secret store; reads `headers`, `env` and `oauth` for this connector.
 * @param deps.callbackServer - loopback OAuth redirect listener.
 * @param deps.baseEnv - environment for stdio servers (the user's login-shell PATH matters for npx/uvx).
 * @param deps.onChange - called whenever status or tools change.
 */
export function createMcpConnection({ connector, secrets, callbackServer, baseEnv = {}, onChange = () => {}, log = () => {} }) {
  const state = { status: 'disconnected', error: undefined, tools: [], authUrl: undefined, server: undefined, instructions: undefined, documents: 0 };
  let client;
  let transport;
  let closing = false;
  let generation = 0;
  let reconnectTimer;
  let reconnects = 0;
  let pendingAuth;
  // The browser login in progress: only the latest one may change the status.
  let loginAttempt = 0;
  let loginState;
  let stderrTail = '';

  const set = (fields) => { Object.assign(state, fields); onChange(); };

  async function makeHttpTransport(kind) {
    const secret = await secrets.get(connector.id);
    const headers = connector.config.auth === 'headers' && secret.headers && typeof secret.headers === 'object' ? secret.headers : {};
    let authProvider;
    if (connector.config.auth === 'oauth') {
      const port = await callbackServer.ensure();
      authProvider = createAuthProvider({
        connector, secrets, redirectUrl: callbackServer.redirectUrl(port), clientSecret: secret.clientSecret,
        onRedirect: (url, oauthState) => { pendingAuth = { url: String(url), state: oauthState }; },
      });
    }
    const url = new URL(connector.config.url);
    const options = { authProvider, requestInit: { headers } };
    return kind === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
  }

  async function makeStdioTransport() {
    const secret = await secrets.get(connector.id);
    const env = { ...getDefaultEnvironment(), ...baseEnv, ...(secret.env && typeof secret.env === 'object' ? secret.env : {}) };
    const created = new StdioClientTransport({
      command: connector.config.command, args: connector.config.args ?? [], env,
      cwd: connector.config.cwd, stderr: 'pipe',
    });
    created.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });
    return created;
  }

  async function open(kind) {
    const mine = ++generation;
    transport = connector.type === 'mcp-stdio' ? await makeStdioTransport() : await makeHttpTransport(kind);
    const created = new Client(CLIENT_INFO, { capabilities: {} });
    // Only a connection that actually came up can be "lost": a transport closed by a failed
    // handshake (e.g. the 401 that starts a browser login) must not trigger a reconnect, or every
    // retry would start a new login and invalidate the page the user is looking at.
    transport.onclose = () => { if (mine === generation && !closing && client === created) lost(new Error('连接已断开')); };
    await created.connect(transport);
    client = created;
    const capabilities = created.getServerCapabilities() ?? {};
    const tools = capabilities.tools ? await listAllTools(created) : [];
    if (capabilities.tools?.listChanged) {
      created.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try { set({ tools: await listAllTools(created) }); } catch (error) { log(`${connector.name}: 刷新工具列表失败：${errorText(error)}`); }
      });
    }
    const documents = capabilities.resources ? await countDocuments(created) : 0;
    if (capabilities.resources?.listChanged) {
      created.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        if (client === created) set({ documents: await countDocuments(created) });
      });
    }
    reconnects = 0;
    set({
      status: 'connected', error: undefined, authUrl: undefined, tools, documents,
      server: created.getServerVersion(), instructions: created.getInstructions?.(),
    });
  }

  /** Documents and templates meant for the model; a server whose listing fails offers none. */
  async function countDocuments(live) {
    try {
      const [resources, templates] = await Promise.all([listAll(live, 'resources'), listAll(live, 'templates')]);
      return resources.filter(isModelDocument).length + templates.filter(isModelDocument).length;
    } catch (error) {
      log(`${connector.name}: 读取文档列表失败：${errorText(error)}`);
      return 0;
    }
  }

  /** Wait for the browser login, trade the code for tokens, then connect for real. */
  function awaitLogin(authTransport) {
    const { url, state: oauthState } = pendingAuth;
    pendingAuth = undefined;
    // Waiting for the user is not a lost connection: nothing may reconnect (and restart the login) meanwhile.
    clearTimeout(reconnectTimer);
    abandonLogin('已被新的登录请求取代');
    const mine = ++loginAttempt;
    loginState = oauthState;
    const current = () => mine === loginAttempt && !closing;
    set({ status: 'needs_auth', authUrl: url, error: undefined });
    let gotCode = false;
    callbackServer.wait(oauthState).then(
      async (code) => {
        gotCode = true;
        if (!current()) throw new Error('这次登录已被取消或被新的登录取代');
        set({ status: 'connecting', authUrl: undefined });
        await authTransport.finishAuth(code);
        if (!current()) throw new Error('这次登录已被取消或被新的登录取代');
        await open('http');
        if (mine === loginAttempt) loginState = undefined;
        callbackServer.settle(oauthState);
      },
    ).catch((error) => {
      const message = explain(errorText(error), callbackServer.redirectUrl());
      if (gotCode) callbackServer.settle(oauthState, new Error(message));
      if (!current()) return;
      loginState = undefined;
      transport?.close().catch(() => {});
      set({ status: 'error', error: message, authUrl: undefined });
    });
  }

  /** Stop waiting for an unfinished browser login, so a late callback cannot change the status. */
  function abandonLogin(reason) {
    loginAttempt++;
    if (loginState) callbackServer.cancel(loginState, reason);
    loginState = undefined;
  }

  async function connect() {
    if (state.status === 'connected' || state.status === 'connecting') return snapshot();
    closing = false;
    pendingAuth = undefined;
    clearTimeout(reconnectTimer);
    stderrTail = '';
    set({ status: 'connecting', error: undefined });
    try {
      await open('http');
    } catch (error) {
      if (error instanceof UnauthorizedError || pendingAuth) {
        if (pendingAuth) awaitLogin(transport);
        else set({ status: 'error', error: '服务器要求认证：请把认证方式改为 OAuth 或填写请求头' });
        return snapshot();
      }
      // Servers that predate Streamable HTTP answer the initialize POST with 4xx: try the old SSE transport.
      if (connector.type === 'mcp-http' && /\b(40[45]|405)\b|Not Found|Method Not Allowed/i.test(errorText(error))) {
        try { await open('sse'); return snapshot(); } catch (sseError) { error = sseError; }
      }
      const detail = stderrTail.trim() ? `\n${stderrTail.trim().split('\n').slice(-5).join('\n')}` : '';
      await transport?.close().catch(() => {});
      set({ status: 'error', error: explain(errorText(error), callbackServer?.redirectUrl()) + detail });
    }
    return snapshot();
  }

  function lost(error) {
    client = undefined;
    if (reconnects >= MAX_RECONNECTS) {
      set({ status: 'error', error: `${errorText(error)}；已重试 ${MAX_RECONNECTS} 次，点击「重新连接」再试` });
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** reconnects++);
    set({ status: 'reconnecting', error: errorText(error) });
    reconnectTimer = setTimeout(() => {
      set({ status: 'disconnected' });
      connect().catch(() => {});
    }, delay);
    reconnectTimer.unref?.();
  }

  async function disconnect() {
    closing = true;
    generation++;
    abandonLogin('连接器已断开或被重新配置');
    clearTimeout(reconnectTimer);
    const closingTransport = transport;
    client = undefined;
    transport = undefined;
    await closingTransport?.close().catch(() => {});
    set({ status: 'disconnected', tools: [], documents: 0, authUrl: undefined, error: undefined });
  }

  /** The live client, reconnecting once if the connection dropped. */
  async function ready() {
    if (client === undefined) {
      if (state.status === 'needs_auth') throw new Error(`连接器 ${connector.label} 需要先在「连接器」页面完成登录授权`);
      await connect();
      if (client === undefined) throw new Error(`连接器 ${connector.label} 不可用：${state.error ?? state.status}`);
    }
    return client;
  }

  async function callTool(name, args, signal) {
    return (await ready()).callTool({ name, arguments: args ?? {} }, undefined, { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
  }

  async function listResources(signal) {
    return listAll(await ready(), 'resources', signal);
  }

  async function listResourceTemplates(signal) {
    return listAll(await ready(), 'templates', signal);
  }

  async function readResource(uri, signal) {
    return (await ready()).readResource({ uri }, { signal, timeout: CALL_TIMEOUT_MS });
  }

  function snapshot() {
    return {
      status: state.status, error: state.error, authUrl: state.authUrl, documents: state.documents,
      server: state.server ? { name: state.server.name, version: state.server.version } : undefined,
      tools: state.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, annotations: tool.annotations })),
    };
  }

  return { connect, disconnect, callTool, listResources, listResourceTemplates, readResource, snapshot, get instructions() { return state.instructions; } };
}
