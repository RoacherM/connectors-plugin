/**
 * Agent-side connector management. The agent writes every setting; the one secret a connector
 * needs is typed by the user into a one-line prompt (the tool card in chat, or the connector's
 * card on the 连接器 page) and goes straight to the credential store — it never enters the
 * conversation. `connectors_add` waits for that prompt, and for an OAuth login, before returning.
 */
import { EXPOSURES, PRESETS } from '../shared/presets.js';
import { secretSpec } from './secretspec.js';

const OUTPUT = {
  schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};
const WAIT_MS = 10 * 60 * 1000;
const PRESET_IDS = PRESETS.map((p) => p.id);

function statusLine(view, settled) {
  if (!view) return '连接器已被删除。';
  switch (view.status) {
    case 'connected': return view.exposure === 'search'
      ? `已连接，${view.toolCount} 个工具按需加载：用 connector_search（connector: "${view.name}"）查找，connector_call 调用`
      : `已连接，共 ${view.toolNames.length} 个工具：${view.toolNames.join(', ')}`;
    case 'error': return `连接失败：${view.error ?? '未知错误'}`;
    case 'disabled': return '已停用。';
    case 'needs_secret': return settled ? '仍在等待用户填写密钥。' : `用户没有在时限内填写${view.secretSpec?.label ?? '密钥'}。之后可以在「连接器」页面的卡片上直接填写，填完即自动连接。`;
    case 'needs_auth': return `用户还没有完成浏览器登录。登录链接：${view.authUrl ?? '（见「连接器」页面）'}；完成后会自动连接。`;
    default: return `状态：${view.status}`;
  }
}

/** Drop the stored secret so the prompt shows again (rotating a key). */
async function forgetSecret(secrets, connector) {
  const spec = secretSpec(connector);
  if (!spec) return;
  const stored = await secrets.get(connector.id);
  if (spec.kind === 'password') await secrets.update(connector.id, { password: undefined });
  else if (spec.kind === 'header') { const headers = { ...(stored.headers ?? {}) }; delete headers[spec.header]; await secrets.update(connector.id, { headers }); }
  else { const env = { ...(stored.env ?? {}) }; delete env[spec.envKey]; await secrets.update(connector.id, { env }); }
}

export function registerTools(ctx, { store, secrets, hub }) {
  const register = (definition) => ctx.effect(() => ctx.tools.register({ output: OUTPUT, ...definition }), `dsh-connectors: ${definition.name}`);

  register({
    name: 'connectors_list',
    description: 'List the user\'s connectors (Gmail, GitHub, Notion, any MCP server…), whether each is connected, and the tool names each provides. Call this when a task involves an external system and you are unsure which connector tools exist.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    isConcurrencySafe: () => true,
    execute: async () => ({ text: await hub.describe() }),
  });

  register({
    name: 'connectors_add',
    description: [
      'Connect an external system for the user, or change an existing connector (same `name`). You configure everything; the user only supplies the one secret, if any.',
      `Known services: preset ${PRESET_IDS.join(' | ')} — nothing else needed, except config.user (the email address) for mail presets; ask the user for the address in chat if you do not know it.`,
      'Anything else: type mcp-http with config { url, auth: "oauth" | "headers" | "none" } (find the service\'s official remote MCP URL; "headers" = API token), or type mcp-stdio with config { command, args[] } (e.g. npx -y <package>) plus secret.env_key when it needs a token in an environment variable. Custom IMAP mail: type email, config { provider: "custom", user, imapHost, imapPort, smtpHost, smtpPort }.',
      '`secret` describes what to ask the user for: label (e.g. "Slack Bot Token"), hint (one sentence on where to get it), url (the page that creates it), header/prefix (default "Authorization" / "Bearer "), env_key.',
      'NEVER ask the user to paste a secret into the chat and never put one in any argument. When a secret is needed this call shows the user a one-line input and waits (up to 10 minutes) for them to fill it in; for OAuth it waits for the browser login. Before calling, tell the user in one sentence what to prepare (e.g. "准备一个 GitHub token，输入框马上弹出"). Pass ask_secret: true to replace an existing secret.',
      '`exposure`: "direct" gives every tool its own definition (sent with every request; fine for a few tools); "search" keeps them out of the request — find them with connector_search and run them with connector_call. Prefer "search" for servers with many or large tools. Change only this on an existing connector by passing name + exposure.',
      'The result says whether it connected and lists the new tools; verify with one harmless read-only call.',
    ].join('\n'),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        preset: { type: 'string', enum: PRESET_IDS },
        type: { type: 'string', enum: ['email', 'mcp-http', 'mcp-stdio'] },
        name: { type: 'string', description: 'Tool prefix: lowercase letters, digits, dashes. Tools become mcp__<name>__<tool>. Defaults to the preset\'s.' },
        label: { type: 'string', description: 'Display name, e.g. "Slack".' },
        config: { type: 'object', description: 'Non-secret settings (see description). For an update, only the fields to change.' },
        secret: {
          type: 'object', additionalProperties: false,
          properties: { label: { type: 'string' }, hint: { type: 'string' }, url: { type: 'string' }, header: { type: 'string' }, prefix: { type: 'string' }, env_key: { type: 'string' } },
        },
        ask_secret: { type: 'boolean', description: 'Ask the user for a new secret even though one is stored.' },
        exposure: { type: 'string', enum: EXPOSURES, description: 'How the tools reach you: "direct" (default for new connectors) or "search" (on demand).' },
      },
    },
    async execute(args, exec) {
      const preset = args.preset ? PRESETS.find((p) => p.id === args.preset) : undefined;
      if (args.preset && !preset) throw new Error(`未知的 preset：${args.preset}`);
      const template = preset?.connector ?? {};
      const name = args.name ?? template.name;
      if (!name) throw new Error('需要 name（或 preset）');
      if (args.exposure !== undefined && !EXPOSURES.includes(args.exposure)) throw new Error(`exposure 只能是 ${EXPOSURES.join(' / ')}`);
      const existing = (await store.list()).find((c) => c.name === name);
      // Only switching direct ↔ search: re-register the tools, keep the live connection.
      const onlyExposure = existing && args.exposure && Object.keys(args).every((key) => key === 'name' || key === 'exposure');
      if (onlyExposure) {
        await store.patch(existing.id, { exposure: args.exposure });
        const view = await hub.resync(existing.id);
        return { text: `已把连接器「${existing.label}」的工具改为${args.exposure === 'search' ? '按需加载' : '直接提供'} — ${statusLine(view, true)}` };
      }
      const type = args.type ?? template.type ?? existing?.type;
      if (existing && type && existing.type !== type) throw new Error(`已有同名的 ${existing.type} 连接器 ${name}，换个名称`);
      const record = await store.save({
        type, name, label: args.label ?? template.label ?? existing?.label,
        preset: preset?.id ?? existing?.preset ?? type,
        config: { ...(existing?.config ?? {}), ...(template.config ?? {}), ...(args.config ?? {}) },
        ...(args.secret ? { secret: args.secret } : template.secret ? { secret: template.secret } : {}),
        ...(args.exposure ? { exposure: args.exposure } : {}),
        ...(existing ? {} : { enabled: true }),
      }, existing?.id);
      if (args.ask_secret) await forgetSecret(secrets, record);
      if (!record.enabled) await store.patch(record.id, { enabled: true });
      let view = await hub.reload(record.id);
      let settled = true;
      if (view.status === 'needs_secret' || view.status === 'needs_auth') {
        ({ view, settled } = await hub.waitSettled(record.id, { signal: exec?.signal, timeoutMs: WAIT_MS }));
      }
      return { text: `${existing ? '已更新' : '已添加'}连接器「${record.label}」（name: ${record.name}）— ${statusLine(view, settled)}` };
    },
  });

  register({
    name: 'connectors_remove',
    description: 'Delete a connector and its stored secret. Only when the user asks to disconnect/remove a service.',
    parameters: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
    async execute(args) {
      const connector = (await store.list()).find((c) => c.name === args.name);
      if (!connector) throw new Error(`没有名为 ${args.name} 的连接器`);
      await store.remove(connector.id);
      await hub.remove(connector.id);
      await secrets.remove(connector.id).catch(() => {});
      return { text: `已删除连接器「${connector.label}」。` };
    },
  });
}
