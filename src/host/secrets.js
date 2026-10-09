/**
 * Per-connector secrets (mail password, request headers, stdio env, OAuth client + tokens)
 * as one grant record in the DSH credential store: `dsh-connectors/<connector id>`.
 * Without a credential service (tests, headless hosts) a 0600 JSON file stands in.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SCOPE = 'dsh-connectors';
const keyOf = (id) => `${SCOPE}/${id}`;

function fileBackend(dir) {
  const file = join(dir, 'secrets.json');
  let queue = Promise.resolve();
  const read = async () => {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
  };
  return {
    async read(id) { return (await read())[id]; },
    modify(id, mutate) {
      const run = queue.then(async () => {
        const all = await read();
        const next = await mutate(all[id]);
        if (next === undefined) delete all[id]; else all[id] = next;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file + '.tmp', JSON.stringify(all), { mode: 0o600 });
        await rename(file + '.tmp', file);
        return next;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

function credentialBackend(credentials) {
  return {
    async read(id) {
      const record = await credentials.readRecord(keyOf(id));
      return record?.kind === 'grant' && record.payload && typeof record.payload === 'object' ? record.payload : undefined;
    },
    async modify(id, mutate) {
      let result;
      let removed = false;
      await credentials.modifyRecord(keyOf(id), async (current) => {
        const payload = current?.kind === 'grant' && current.payload && typeof current.payload === 'object' ? current.payload : undefined;
        result = await mutate(payload);
        if (result === undefined) { removed = true; return undefined; }
        return { kind: 'grant', payload: result };
      });
      if (removed) await credentials.deleteRecord(keyOf(id));
      return result;
    },
  };
}

export function createSecrets({ credentials, dir }) {
  const backend = credentials?.modifyRecord ? credentialBackend(credentials) : fileBackend(dir);
  return {
    get: async (id) => (await backend.read(id)) ?? {},
    /** Shallow-merge fields; a field set to `undefined` is removed. */
    update: (id, fields) => backend.modify(id, async (current) => {
      const next = { ...(current ?? {}) };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete next[key]; else next[key] = value;
      }
      return next;
    }),
    remove: (id) => backend.modify(id, async () => undefined),
  };
}
