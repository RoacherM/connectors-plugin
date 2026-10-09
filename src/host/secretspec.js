/**
 * The one secret a connector needs from the user, and how it is stored. The agent writes
 * everything else; the user only ever types this value into a one-line prompt.
 *
 *   password — email app password / authorization code → secret.password
 *   header   — API token → secret.headers[header] = prefix + value
 *   env      — stdio server token → secret.env[envKey] = value
 *
 * The spec is derived from the connector type; `connector.secret` only holds overrides
 * (label, hint, url, header, prefix, envKey), so older records get sensible defaults.
 */
import { EMAIL_PROVIDERS, PRESETS } from '../shared/presets.js';

const str = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Validate the overrides the agent (or a preset) passes. */
export function normalizeSecretOverrides(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {
    label: str(input.label, 60), hint: str(input.hint, 400), url: str(input.url, 1000),
    header: str(input.header, 100), prefix: typeof input.prefix === 'string' ? input.prefix.slice(0, 40) : undefined,
    envKey: str(input.envKey ?? input.env_key, 100),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return Object.keys(out).length ? out : undefined;
}

export function secretSpec(connector) {
  // A connector added from a preset (or before overrides existed) inherits the preset's wording.
  const o = connector.secret ?? PRESETS.find((p) => p.id === connector.preset)?.connector.secret ?? {};
  if (connector.type === 'email') {
    const provider = EMAIL_PROVIDERS[connector.config.provider] ?? EMAIL_PROVIDERS.custom;
    return {
      kind: 'password', label: o.label ?? (connector.config.provider === 'gmail' ? '应用专用密码' : '授权码'),
      hint: o.hint ?? provider.help, url: o.url ?? (provider.appPasswordUrl || undefined),
      placeholder: connector.config.provider === 'gmail' ? 'xxxx xxxx xxxx xxxx' : '',
    };
  }
  if (connector.type === 'mcp-http' && connector.config.auth === 'headers') {
    return { kind: 'header', header: o.header ?? 'Authorization', prefix: o.prefix ?? 'Bearer ', label: o.label ?? 'Access Token', hint: o.hint, url: o.url, placeholder: '' };
  }
  if (connector.type === 'mcp-stdio' && o.envKey) {
    return { kind: 'env', envKey: o.envKey, label: o.label ?? o.envKey, hint: o.hint, url: o.url, placeholder: '' };
  }
  return undefined;
}

export function hasSecret(connector, stored) {
  const spec = secretSpec(connector);
  if (!spec) return true;
  if (spec.kind === 'password') return Boolean(stored.password);
  if (spec.kind === 'header') return Boolean(stored.headers?.[spec.header]);
  return Boolean(stored.env?.[spec.envKey]);
}

/** The secret-store fields that hold `value` for this connector. */
export function secretFields(connector, stored, value) {
  const spec = secretSpec(connector);
  const raw = String(value ?? '').trim();
  const fail = (zh, en) => Object.assign(new Error(zh), { en });
  if (!spec) throw fail('这个连接器不需要密钥', 'This connector does not need a secret');
  if (!raw) throw fail(`请填写${spec.label}`, /^[\x20-\x7e]+$/.test(spec.label) ? `Enter the ${spec.label}` : 'Enter the key');
  if (spec.kind === 'password') {
    // Google shows app passwords as four groups of four; the spaces are not part of it.
    return { password: connector.config.provider === 'gmail' ? raw.replace(/\s+/g, '') : raw };
  }
  if (spec.kind === 'header') {
    const token = spec.prefix && raw.toLowerCase().startsWith(spec.prefix.toLowerCase()) ? raw.slice(spec.prefix.length) : raw;
    return { headers: { ...(stored.headers ?? {}), [spec.header]: `${spec.prefix}${token}` } };
  }
  return { env: { ...(stored.env ?? {}), [spec.envKey]: raw } };
}

/** What the page and tool card need to render the prompt (never the value). */
export const publicSpec = (spec) => spec && { kind: spec.kind, label: spec.label, hint: spec.hint, url: spec.url, placeholder: spec.placeholder };
