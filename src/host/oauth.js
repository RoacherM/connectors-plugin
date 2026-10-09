/**
 * OAuth 2.1 for remote MCP servers, as the MCP authorization spec describes it: discovery,
 * dynamic client registration and PKCE are done by the SDK's `auth()`; this file supplies the
 * storage (DSH credential store) and a loopback redirect listener.
 *
 * The redirect goes to a small HTTP server on 127.0.0.1 rather than to DSH's own web server,
 * because the login page opens in the system browser, which has no DSH session cookie.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const PREFERRED_PORT = 33418;
const IDLE_CLOSE_MS = 15 * 60 * 1000;
/** How long the callback page waits for the token exchange before answering the browser. */
const FINISH_WAIT_MS = 60 * 1000;
/** How long a used or cancelled `state` is remembered, so a reloaded callback tab shows what happened. */
const REMEMBER_MS = 30 * 60 * 1000;

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;color:#333">
<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`;
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** One loopback listener shared by every connector's login; each attempt waits on its own `state`. */
export function createCallbackServer({ preferredPort = PREFERRED_PORT, log = () => {} } = {}) {
  let server;
  let port;
  let starting;
  let idleTimer;
  const pending = new Map();
  /** state → { ok, message, at } for logins that already ended (used, denied, cancelled, superseded). */
  const finished = new Map();
  /** state → resolve() of the page waiting for `settle(state)`. */
  const settling = new Map();

  function scheduleIdleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (pending.size === 0 && settling.size === 0) close(); }, IDLE_CLOSE_MS);
    idleTimer.unref?.();
  }

  function remember(state, ok, message) {
    const now = Date.now();
    for (const [key, entry] of finished) if (now - entry.at > REMEMBER_MS) finished.delete(key);
    finished.set(state, { ok, message, at: now });
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    const state = url.searchParams.get('state') ?? '';
    const waiter = pending.get(state);
    const send = (status, title, body) => response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page(title, body));
    if (waiter === undefined) {
      const past = finished.get(state);
      if (past?.ok) send(200, '✅ 已经授权过了', '这次登录已经完成，可以关闭这个页面。');
      else if (past) send(409, '这次授权已经结束', `${escapeHtml(past.message)}<br>如需重试，请回到 DeepSeek Harness 的连接器页面重新点击「连接」。`);
      else send(400, '授权链接已失效', '这个登录请求已不存在（可能已被新的登录取代，或 DeepSeek Harness 重启过）。请回到连接器页面重新点击「连接」。');
      return;
    }
    pending.delete(state);
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      const reason = url.searchParams.get('error_description') ?? error ?? '没有收到授权码';
      remember(state, false, `授权被拒绝：${reason}`);
      waiter.reject(new Error(`授权被拒绝：${reason}`));
      send(400, '授权未完成', escapeHtml(reason));
      scheduleIdleClose();
      return;
    }
    // Answer only once the connection has traded the code for tokens, so the page tells the truth.
    let timer;
    const outcome = await Promise.race([
      new Promise((resolve) => { settling.set(state, resolve); waiter.resolve(code); }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: undefined }), FINISH_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    settling.delete(state);
    if (outcome.ok === true) send(200, '✅ 授权完成', '可以关闭这个页面，回到 DeepSeek Harness。');
    else if (outcome.ok === false) send(502, '授权失败', `${escapeHtml(outcome.message)}<br>请回到 DeepSeek Harness 的连接器页面重新点击「连接」。`);
    else send(202, '已收到授权', '正在完成连接，请回到 DeepSeek Harness 查看连接器状态。');
    scheduleIdleClose();
  }

  function listen(onPort) {
    return new Promise((resolve, reject) => {
      const candidate = createServer((request, response) => {
        handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end(); });
      });
      candidate.once('error', reject);
      candidate.listen(onPort, '127.0.0.1', () => { candidate.off('error', reject); resolve(candidate); });
    });
  }

  async function ensure() {
    if (server) return port;
    starting ??= (async () => {
      try { server = await listen(preferredPort); } catch (error) {
        log(`OAuth 回调端口 ${preferredPort} 不可用（${error.code ?? error.message}），改用随机端口`);
        server = await listen(0);
      }
      server.unref?.();
      port = server.address().port;
      scheduleIdleClose();
      return port;
    })().finally(() => { starting = undefined; });
    return starting;
  }

  function close() {
    clearTimeout(idleTimer);
    for (const waiter of pending.values()) waiter.reject(new Error('授权已取消'));
    pending.clear();
    for (const resolve of settling.values()) resolve({ ok: undefined });
    settling.clear();
    finished.clear();
    server?.close();
    server = undefined;
    port = undefined;
  }

  return {
    ensure,
    get port() { return port; },
    redirectUrl: (p = port ?? preferredPort) => `http://127.0.0.1:${p}/callback`,
    /** Resolve with the authorization code delivered for `state`, or reject on denial/timeout. */
    wait(state, timeoutMs = 10 * 60 * 1000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(state);
          remember(state, false, '等待授权超时');
          reject(new Error('等待授权超时，请重新连接'));
        }, timeoutMs);
        timer.unref?.();
        pending.set(state, {
          resolve: (code) => { clearTimeout(timer); resolve(code); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
      });
    },
    /** Report how the login that received `state`'s code ended; the waiting callback page shows it. */
    settle(state, error) {
      const message = error ? (error.message ?? String(error)) : '';
      remember(state, !error, message);
      settling.get(state)?.({ ok: !error, message });
      settling.delete(state);
    },
    /** Abandon the login waiting on `state`; its page, if opened later, says why. */
    cancel(state, reason = '授权已取消') {
      const waiter = pending.get(state);
      pending.delete(state);
      if (waiter) remember(state, false, reason);
      waiter?.reject(new Error(reason));
    },
    close,
  };
}

/**
 * The SDK's OAuthClientProvider for one connector. Everything it persists goes into the
 * connector's secret record under `oauth`. `onRedirect(url, state)` is called when the user
 * has to log in; the caller shows the URL and waits on the callback server.
 */
export function createAuthProvider({ connector, secrets, redirectUrl, onRedirect, clientSecret }) {
  let state;
  // The verifier of the login this provider started. The stored copy is shared by every attempt
  // of the connector, so a second login would otherwise break the first one's token exchange.
  let verifier;
  let clientRejected = false;
  const read = async () => (await secrets.get(connector.id)).oauth ?? {};
  const write = async (fields) => {
    const current = await read();
    await secrets.update(connector.id, { oauth: { ...current, ...fields } });
  };
  return {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() {
      return {
        client_name: 'DeepSeek Harness',
        client_uri: 'https://github.com/deepseek-ai/deepseek-harness',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none',
        ...(connector.config.scope ? { scope: connector.config.scope } : {}),
      };
    },
    state() {
      state = randomBytes(16).toString('hex');
      return state;
    },
    async clientInformation() {
      // A client the user registered themselves (servers without dynamic registration, e.g. GitHub) wins.
      if (connector.config.clientId) {
        return clientSecret
          ? { client_id: connector.config.clientId, client_secret: clientSecret, token_endpoint_auth_method: 'client_secret_post' }
          : { client_id: connector.config.clientId };
      }
      const stored = (await read()).clientInformation;
      // A registration made for another loopback port would fail the redirect check: register again.
      if (stored && Array.isArray(stored.redirect_uris) && !stored.redirect_uris.includes(redirectUrl)) return undefined;
      return stored;
    },
    saveClientInformation: (clientInformation) => write({ clientInformation }),
    tokens: async () => (await read()).tokens,
    saveTokens: (tokens) => write({ tokens, savedAt: Date.now() }),
    redirectToAuthorization: (url) => onRedirect(url, state),
    saveCodeVerifier: (codeVerifier) => { verifier = codeVerifier; return write({ codeVerifier }); },
    async codeVerifier() {
      const current = verifier ?? (await read()).codeVerifier;
      // The SDK wipes credentials on invalid_client and retries; the missing verifier is only a symptom.
      if (!current && clientRejected) throw new Error('OAuth 服务器拒绝了客户端（invalid_client）：请检查 Client ID / Client Secret 是否正确，然后点「连接」重新登录');
      if (!current) throw new Error('缺少 PKCE code verifier，请重新连接');
      return current;
    },
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope === 'all' || scope === 'client') clientRejected = true;
      if (scope === 'all') await secrets.update(connector.id, { oauth: undefined });
      else if (scope === 'client') await write({ clientInformation: undefined });
      else if (scope === 'tokens') await write({ tokens: undefined });
      else if (scope === 'verifier') await write({ codeVerifier: undefined });
    },
  };
}
