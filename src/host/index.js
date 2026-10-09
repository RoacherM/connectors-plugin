/**
 * Host half of the connectors plugin: stored connectors, their live connections, the tools they
 * contribute to the agent (direct, or on demand through connector_search / connector_call), the
 * settings routes, and a `connectors_list` directory tool.
 * Only `ctx` services are used at runtime — no @deepseek-ai imports — so the bundle binds to
 * whichever DSH build is running.
 */
import { execFile } from 'node:child_process';
import { callbackPort } from './config.js';
import { createHub } from './hub.js';
import { createCallbackServer } from './oauth.js';
import { registerNotesSection } from './notes.js';
import { registerResourceTool } from './resources.js';
import { registerRoutes } from './routes.js';
import { registerSearchTools } from './search.js';
import { hasSecret } from './secretspec.js';
import { registerTools } from './tools.js';
import { createSecrets } from './secrets.js';
import { createStore, defaultDataDir } from './store.js';

export const name = 'dsh-connectors';
export const inject = ['connection', 'tools'];

/** The desktop app starts with launchd's short PATH; stdio servers (npx, uvx…) need the login shell's. */
function loginShellPath() {
  const fallback = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`, '/usr/bin', '/bin'].filter(Boolean).join(':');
  if (process.platform === 'win32') return Promise.resolve(process.env.PATH);
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s" "$PATH"'], { timeout: 5000 }, (error, stdout) => {
      const match = /__PATH__(.*)$/s.exec(String(stdout ?? ''));
      resolve(error || !match ? fallback : `${match[1].trim()}:${fallback}`);
    });
  });
}

export function apply(ctx, config = {}) {
  const log = (message) => ctx.logger?.warn?.(message);
  const dir = config.dataDir ?? defaultDataDir();
  const store = createStore({ dir });
  const secrets = createSecrets({ credentials: ctx.get('credentials'), dir });
  const callbackServer = createCallbackServer({ preferredPort: callbackPort(config), log });
  const baseEnv = {};
  const hub = createHub({
    ctx, store, secrets, callbackServer, attachments: ctx.get('attachments'), baseEnv, log,
    needsSecret: async (connector) => !hasSecret(connector, await secrets.get(connector.id)),
  });

  ctx.effect(() => () => { hub.dispose(); callbackServer.close(); }, 'dsh-connectors: connections');

  registerRoutes(ctx, { store, secrets, hub });

  registerTools(ctx, { store, secrets, hub });

  // connector_search / connector_call, present only while some connector is in search mode.
  ctx.effect(() => registerSearchTools(ctx, hub, { log }), 'dsh-connectors: search tools');
  // connector_resource, present only while some connector's server offers documents.
  ctx.effect(() => registerResourceTool(ctx, hub, { log }), 'dsh-connectors: resource tool');
  // Direct connectors' usage notes in the system prompt (search connectors bring theirs with connector_search).
  registerNotesSection(ctx, hub);

  // Connect in the background: a slow server must not hold up the Host's start.
  loginShellPath().then((path) => { baseEnv.PATH = path; }).finally(() => {
    hub.start().catch((error) => log(`dsh-connectors: 启动连接器失败：${error.message}`));
  });
}
