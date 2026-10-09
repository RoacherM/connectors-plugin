/**
 * Connector records (everything except secrets) in one JSON file, written atomically.
 * Secrets live in the DSH credential store, keyed by connector id (see secrets.js).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONNECTOR_TYPES, EMAIL_PROVIDERS, EXPOSURES, NAME_PATTERN, exposureOf } from '../shared/presets.js';
import { normalizeSecretOverrides } from './secretspec.js';

/** `message` is Chinese (what the agent sees); `en` is shown on an English connectors page. */
export class ConnectorError extends Error {
  constructor(message, status = 400, en) { super(message); this.status = status; this.en = en ?? message; }
}

export const defaultDataDir = () => process.env.DSH_CONNECTORS_DIR ?? join(homedir(), '.dsh', 'plugin-data', 'connectors');

const str = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const port = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};

/** Validate and normalize the non-secret part of a connector coming from the UI. */
export function normalizeConnector(input, existing) {
  if (input === null || typeof input !== 'object') throw new ConnectorError('连接器数据无效');
  const type = existing?.type ?? input.type;
  if (!CONNECTOR_TYPES.includes(type)) throw new ConnectorError(`未知的连接器类型：${type}`);
  const name = str(input.name ?? existing?.name, 24);
  if (!NAME_PATTERN.test(name)) throw new ConnectorError('名称只能包含小写字母、数字和短横线，并以字母开头（最多 24 个字符）');
  const label = str(input.label ?? existing?.label, 60) || name;
  const source = input.config ?? {};
  let config;
  if (type === 'email') {
    const provider = EMAIL_PROVIDERS[source.provider] ? source.provider : 'custom';
    const defaults = EMAIL_PROVIDERS[provider];
    const user = str(source.user, 200);
    if (!/^[^\s@]+@[^\s@]+$/.test(user)) throw new ConnectorError('请填写完整的邮箱地址', 400, 'Enter a full email address');
    const imapHost = str(source.imapHost, 200) || defaults.imapHost;
    const smtpHost = str(source.smtpHost, 200) || defaults.smtpHost;
    if (!imapHost) throw new ConnectorError('请填写 IMAP 服务器');
    config = {
      provider, user, imapHost, imapPort: port(source.imapPort, defaults.imapPort),
      smtpHost, smtpPort: port(source.smtpPort, defaults.smtpPort),
      displayName: str(source.displayName, 100) || undefined,
    };
  } else if (type === 'mcp-http') {
    const url = str(source.url, 2000);
    let parsed;
    try { parsed = new URL(url); } catch { throw new ConnectorError('请填写有效的服务器 URL', 400, 'Enter a valid server URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ConnectorError('服务器 URL 必须是 http(s)');
    const auth = ['none', 'oauth', 'headers'].includes(source.auth) ? source.auth : 'oauth';
    config = { url: parsed.href, auth, scope: str(source.scope, 500) || undefined, clientId: str(source.clientId, 500) || undefined };
  } else {
    const command = str(source.command, 500);
    if (!command) throw new ConnectorError('请填写要启动的命令');
    const args = Array.isArray(source.args) ? source.args.map((arg) => String(arg)).slice(0, 64) : [];
    config = { command, args, cwd: str(source.cwd, 1000) || undefined };
  }
  if (input.exposure !== undefined && !EXPOSURES.includes(input.exposure)) throw new ConnectorError(`exposure 只能是 ${EXPOSURES.join(' / ')}`);
  const now = Date.now();
  const secret = input.secret !== undefined ? normalizeSecretOverrides(input.secret) : existing?.secret;
  return {
    ...(secret ? { secret } : {}),
    id: existing?.id ?? 'c-' + randomBytes(6).toString('hex'),
    name, label, type,
    enabled: input.enabled ?? existing?.enabled ?? true,
    exposure: input.exposure ?? exposureOf(existing ?? input),
    preset: existing?.preset ?? (str(input.preset, 40) || undefined),
    config,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function createStore({ dir = defaultDataDir() } = {}) {
  const file = join(dir, 'connectors.json');
  let cache;
  let queue = Promise.resolve();

  async function load() {
    if (cache !== undefined) return cache;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      cache = Array.isArray(parsed.connectors) ? parsed.connectors : [];
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new ConnectorError(`无法读取 ${file}：${error.message}`, 500);
      cache = [];
    }
    return cache;
  }

  async function persist(list) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, connectors: list }, null, 2), { mode: 0o600 });
    await rename(temp, file);
    cache = list;
  }

  /** Serialize every write through one queue so concurrent edits never lose each other. */
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  return {
    file,
    list: async () => [...await load()],
    get: async (id) => (await load()).find((c) => c.id === id),
    save: (input, id) => exclusive(async () => {
      const list = await load();
      const existing = id === undefined ? undefined : list.find((c) => c.id === id);
      if (id !== undefined && existing === undefined) throw new ConnectorError('连接器不存在', 404, 'Connector not found');
      const record = normalizeConnector(input, existing);
      if (list.some((c) => c.id !== record.id && c.name === record.name)) throw new ConnectorError(`已经有一个名为 ${record.name} 的连接器`, 409, `A connector named ${record.name} already exists`);
      await persist(existing ? list.map((c) => (c.id === record.id ? record : c)) : [...list, record]);
      return record;
    }),
    patch: (id, fields) => exclusive(async () => {
      const list = await load();
      const existing = list.find((c) => c.id === id);
      if (existing === undefined) throw new ConnectorError('连接器不存在', 404, 'Connector not found');
      const record = { ...existing, ...fields, updatedAt: Date.now() };
      await persist(list.map((c) => (c.id === id ? record : c)));
      return record;
    }),
    remove: (id) => exclusive(async () => {
      const list = await load();
      if (!list.some((c) => c.id === id)) return false;
      await persist(list.filter((c) => c.id !== id));
      return true;
    }),
  };
}
