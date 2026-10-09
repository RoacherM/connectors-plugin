import React from 'react';
import { api, setApiLang } from './api.js';
import { localizeError, useI18n, withI18n } from './i18n.jsx';
import { Icon, Logo, logoKind } from './icons.jsx';

const TONE = { connected: 'ok', connecting: 'busy', reconnecting: 'busy', needs_auth: 'warn', needs_secret: 'warn', error: 'err' };

/** Live connector list: long-polls the Host and re-reads on every change. */
export function useConnectors({ live = true } = {}) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const reload = React.useCallback(async () => {
    try { setState({ loading: false, error: null, data: await api.list() }); } catch (error) { setState((s) => ({ ...s, loading: false, error: error.message })); }
  }, []);
  React.useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    (async () => {
      await reload();
      let revision = -1;
      while (alive && live) {
        try {
          const next = await api.wait(revision, controller.signal);
          if (!alive) return;
          if (next.revision !== revision) { revision = next.revision; await reload(); }
        } catch {
          if (!alive) return;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [reload, live]);
  return [state, reload];
}

/**
 * What to call the connector's secret and where to get it, in the page language. Known services
 * use the page dictionary; an agent-described secret keeps the wording the agent wrote.
 */
export function secretText(connector, t) {
  const spec = connector.secretSpec ?? {};
  if (connector.type === 'email') {
    const provider = connector.config?.provider;
    return { ...spec, label: t(provider === 'gmail' || provider === 'outlook' ? 'appPassword' : 'authCode'), hint: ['gmail', 'outlook'].includes(provider) ? t('help_' + provider) : spec.hint };
  }
  if (connector.preset === 'github') return { ...spec, hint: t('hint_github') };
  return { ...spec, label: spec.label ?? t('secret') };
}

function Switch({ on, onChange, label, disabled }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={'cx-switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;
}

function Status({ status }) {
  const { t } = useI18n();
  return <span className="cx-status"><span className={'cx-dot ' + (TONE[status] ?? '')} />{t('st_' + status)}</span>;
}

function Modal({ title, subtitle, logo, narrow, onClose, children }) {
  const { t } = useI18n();
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="cx-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'cx-modal' + (narrow ? ' narrow' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="cx-modal-head">
          {logo}
          <div className="cx-grow"><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
          <button type="button" className="cx-btn ghost icon" aria-label={t('close')} onClick={onClose}><Icon.x size={16} /></button>
        </div>
        <div className="cx-modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Two-step destructive button: first click arms it, a second within 4 s confirms. */
function ConfirmDelete({ onConfirm, disabled }) {
  const { t } = useI18n();
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  if (armed) return <button type="button" className="cx-btn sm danger-solid" disabled={disabled} onClick={() => { setArmed(false); onConfirm(); }}>{t('confirmDelete')}</button>;
  return <button type="button" className="cx-btn ghost sm icon danger" title={t('delete')} aria-label={t('delete')} disabled={disabled} onClick={() => setArmed(true)}><Icon.trash size={15} /></button>;
}

/**
 * The only thing a user ever types: one secret, on one line. The value goes to the Host's
 * credential store and is never shown again. A failure replaces the placeholder.
 */
export function SecretLine({ connector, onDone, onCancel, autoFocus = false }) {
  const { t } = useI18n();
  const spec = secretText(connector, t);
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  async function submit(e) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true); setError(null);
    try { await api.secret(connector.id, value); setValue(''); onDone?.(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="cx-secret" onSubmit={submit}>
      <input className="cx-input cx-mono" type="password" value={value} autoFocus={autoFocus} autoComplete="new-password" spellCheck={false}
        aria-label={spec.label} aria-invalid={Boolean(error)} title={error ?? spec.hint ?? ''}
        style={error ? { boxShadow: 'inset 0 0 0 1px var(--dsw-alias-state-error-primary)' } : undefined}
        placeholder={error ?? t('paste', { label: spec.label })} onChange={(e) => { setValue(e.target.value); setError(null); }} />
      {spec.url ? <a className="cx-btn ghost sm icon" href={spec.url} target="_blank" rel="noreferrer" title={t('get', { label: spec.label })} aria-label={t('get', { label: spec.label })}><Icon.external size={14} /></a> : null}
      <button type="submit" className="cx-btn primary sm" disabled={busy || !value.trim()}>{busy ? <Icon.refresh size={14} className="cx-spin" /> : t('connect')}</button>
      {onCancel ? <button type="button" className="cx-btn ghost sm icon" aria-label={t('cancel')} onClick={onCancel}><Icon.x size={14} /></button> : null}
    </form>
  );
}

/** Tools the connector serves now, whether registered one by one or found on demand. */
export const toolCountOf = (connector) => connector.toolCount ?? connector.toolNames?.length ?? 0;

export function subtitleOf(connector) {
  if (connector.type === 'email') return connector.config.user;
  if (connector.type === 'mcp-http') return connector.config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return [connector.config.command, ...(connector.config.args ?? [])].join(' ');
}

function ConnectorCard({ connector, onChanged, onShowTools }) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = React.useState(null);
  const [rotating, setRotating] = React.useState(false);
  const [error, setError] = React.useState(null);
  const run = (label, fn) => async () => {
    setBusy(label); setError(null);
    try { await fn(); await onChanged(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const { status } = connector;
  const toolCount = toolCountOf(connector);
  const onDemand = connector.exposure === 'search';
  const problem = error ?? (status === 'error' ? localizeError(connector.error, lang) : null);
  const asking = connector.enabled && (status === 'needs_secret' || rotating);
  const remove = <ConfirmDelete disabled={busy !== null} onConfirm={run('delete', () => api.remove(connector.id))} />;

  let foot;
  if (asking) {
    foot = <SecretLine connector={connector} autoFocus={rotating} onDone={() => { setRotating(false); onChanged(); }} onCancel={rotating ? () => setRotating(false) : undefined} />;
  } else if (connector.enabled && status === 'needs_auth' && connector.authUrl) {
    foot = <>
      <a className="cx-btn primary sm" href={connector.authUrl} target="_blank" rel="noreferrer"><Icon.key size={14} />{t('login')}</a>
      <span className="cx-grow" />{remove}
    </>;
  } else {
    foot = <>
      {connector.enabled ? (
        <button type="button" className="cx-btn ghost sm" disabled={busy !== null} onClick={run('connect', () => api.connect(connector.id))}>
          <Icon.refresh size={14} className={busy === 'connect' ? 'cx-spin' : undefined} />{status === 'connected' ? t('test') : t('retry')}
        </button>
      ) : null}
      {connector.enabled && connector.secretSpec ? <button type="button" className="cx-btn ghost sm" onClick={() => setRotating(true)}><Icon.key size={14} />{t('rotate')}</button> : null}
      {connector.type === 'mcp-http' && connector.config.auth === 'oauth' && connector.secrets?.oauth ? (
        <button type="button" className="cx-btn ghost sm" disabled={busy !== null} onClick={run('logout', () => api.logout(connector.id))}><Icon.logout size={14} />{t('logout')}</button>
      ) : null}
      <span className="cx-grow" />{remove}
    </>;
  }

  return (
    <article className={'cx-card' + (connector.enabled ? '' : ' is-off') + (asking || (connector.enabled && status === 'needs_auth') ? ' attention' : '')}>
      <div className="cx-card-head">
        <Logo kind={logoKind(connector)} size={40} />
        <div className="cx-card-title">
          <div className="cx-name">{connector.label}</div>
          <div className="cx-sub" title={subtitleOf(connector)}>{subtitleOf(connector)}</div>
        </div>
        <Switch on={connector.enabled} label={connector.enabled ? t('disable') : t('enable')} disabled={busy !== null} onChange={(on) => run('toggle', () => api.toggle(connector.id, on))()} />
      </div>
      <div className="cx-meta">
        <Status status={status} />
        {problem ? <span className="cx-meta-err" title={problem}>{problem.split('\n')[0]}</span> : <>
          <span className="cx-sep" />
          <span>{t('type_' + connector.type)}</span>
          {toolCount ? <>
            <span className="cx-sep" />
            <button type="button" className="cx-linkbtn" onClick={() => onShowTools(connector)}>{t('tools', { n: toolCount })}<Icon.chevron size={12} /></button>
          </> : null}
          {connector.enabled ? <>
            <span className="cx-sep" />
            <button type="button" className={'cx-linkbtn cx-mode' + (onDemand ? ' on' : '')} disabled={busy !== null} aria-pressed={onDemand}
              title={onDemand ? t('mode_search_tip') : t('mode_direct_tip')}
              onClick={run('exposure', () => api.exposure(connector.id, onDemand ? 'direct' : 'search'))}>{onDemand ? t('mode_search') : t('mode_direct')}</button>
          </> : null}
        </>}
      </div>
      <div className="cx-foot">{foot}</div>
    </article>
  );
}

function ToolsSheet({ connector, onClose }) {
  const { t } = useI18n();
  const tools = connector.tools ?? [];
  return (
    <Modal title={t('toolsTitle', { label: connector.label })}
      subtitle={connector.exposure === 'search' ? t('toolsSubSearch', { n: toolCountOf(connector) }) : t('toolsSub', { n: toolCountOf(connector), prefix: `mcp__${connector.name.replace(/-/g, '_')}__` })}
      logo={<Logo kind={logoKind(connector)} size={36} />} onClose={onClose}>
      <div className="cx-toolrows">
        {tools.map((tool) => <div key={tool.name} className="cx-toolrow"><code title={tool.name}>{tool.name}</code><span title={tool.description}>{tool.description || '—'}</span></div>)}
      </div>
    </Modal>
  );
}

/** Adding a known service: one line — the address and/or the secret — and nothing else. */
function QuickAdd({ preset, providers, onClose, onAdded }) {
  const { t } = useI18n();
  const template = preset.connector;
  const isMail = template.type === 'email';
  const provider = isMail ? providers?.[template.config.provider] : undefined;
  const { label: secretLabel, hint } = secretText({ ...template, preset: preset.id, secretSpec: template.secret }, t);
  const url = isMail ? provider?.appPasswordUrl : template.secret?.url;
  const [user, setUser] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { connector } = await api.quick(preset.id, { user: isMail ? user : undefined, secret });
      onAdded(connector);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal narrow title={t('connectTo', { label: preset.label })} logo={<Logo kind={logoKind(preset.connector)} size={36} />} onClose={onClose}>
      <div className="cx-hintline">
        <span>{hint}</span>
        {url ? <a href={url} target="_blank" rel="noreferrer">{t('get', { label: secretLabel })}<Icon.external size={12} /></a> : null}
      </div>
      <form className="cx-secret" onSubmit={submit}>
        {isMail ? <input className="cx-input" type="email" required autoFocus value={user} onChange={(e) => setUser(e.target.value)} placeholder={t('email')} aria-label={t('email')} autoComplete="off" /> : null}
        <input className="cx-input cx-mono" type="password" required autoFocus={!isMail} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={secretLabel} aria-label={secretLabel} autoComplete="new-password" spellCheck={false} />
        <button type="submit" className="cx-btn primary" disabled={busy}>{busy ? <Icon.refresh size={14} className="cx-spin" /> : t('connect')}</button>
      </form>
      {error ? <div className="cx-error">{error}</div> : <div className="cx-hint">{t('localOnly')}</div>}
    </Modal>
  );
}

const needsInput = (preset) => preset.connector.type === 'email' || preset.connector.config.auth === 'headers';

export function makeConnectorsPage({ startChat = () => {}, locale } = {}) {
  function ConnectorsPage() {
    const { t, lang } = useI18n();
    setApiLang(lang);
    const [{ loading, error, data }, reload] = useConnectors();
    const [dialog, setDialog] = React.useState(null);
    const [pageError, setPageError] = React.useState(null);
    const connectors = data?.connectors ?? [];
    const close = React.useCallback(() => setDialog(null), []);
    const connected = connectors.filter((c) => c.status === 'connected').length;
    const toolCount = connectors.reduce((n, c) => n + toolCountOf(c), 0);
    const addedNames = new Set(connectors.map((c) => c.name));

    const pick = async (preset) => {
      setPageError(null);
      if (needsInput(preset)) { setDialog({ kind: 'quick', preset }); return; }
      try { await api.quick(preset.id, {}); await reload(); } catch (e) { setPageError(e.message); }
    };

    return (
      <div className="cx-page" lang={lang === 'en' ? 'en' : 'zh-CN'}>
        <div className="cx-inner">
          <header className="cx-head">
            <div>
              <h1>{t('title')}</h1>
              <p>{t('intro')}</p>
            </div>
            {connectors.length ? (
              <div className="cx-stats">
                <div className="cx-stat"><b>{connected}</b><span>{t('statConnected')}</span></div>
                <div className="cx-stat"><b>{toolCount}</b><span>{t('statTools')}</span></div>
              </div>
            ) : null}
          </header>

          {error || pageError ? <div className="cx-note err"><Icon.alert size={14} /><span>{error ?? pageError}</span></div> : null}

          <section className="cx-section">
            <div className="cx-section-head"><h2>{t('connected')}</h2><span className="cx-count">{connectors.length || ''}</span></div>
            {loading ? <div className="cx-empty">{t('loading')}</div> : connectors.length === 0 ? (
              <div className="cx-empty"><b>{t('emptyTitle')}</b><span>{t('emptyBody')}</span></div>
            ) : (
              <div className="cx-grid">
                {connectors.map((connector) => (
                  <ConnectorCard key={connector.id} connector={connector} onChanged={reload} onShowTools={(c) => setDialog({ kind: 'tools', connector: c })} />
                ))}
              </div>
            )}
          </section>

          <section className="cx-section">
            <div className="cx-section-head"><h2>{t('add')}</h2></div>
            <div className="cx-gallery">
              {(data?.presets ?? []).map((preset) => {
                const added = addedNames.has(preset.connector.name);
                return (
                  <button key={preset.id} type="button" className="cx-add cx-focus" disabled={added} onClick={() => pick(preset)}>
                    <Logo kind={logoKind(preset.connector)} size={32} />
                    <span className="cx-add-text">
                      <span className="cx-add-name">{preset.label}</span>
                      <span className="cx-add-desc">{added ? t('added') : t('preset_' + preset.id)}</span>
                    </span>
                    <span className={added ? 'cx-added' : 'cx-add-plus'} aria-hidden="true">{added ? <Icon.check size={15} /> : <Icon.plus size={15} />}</span>
                  </button>
                );
              })}
              <button type="button" className="cx-add chat cx-focus" onClick={startChat}>
                <span className="ui-logo tint" style={{ width: 32, height: 32, borderRadius: 9 }}><Icon.chat size={17} /></span>
                <span className="cx-add-text">
                  <span className="cx-add-name">{t('other')}</span>
                  <span className="cx-add-desc">{t('otherDesc')}</span>
                </span>
                <span className="cx-add-plus" aria-hidden="true"><Icon.chevron size={15} /></span>
              </button>
            </div>
          </section>
        </div>

        {dialog?.kind === 'tools' ? <ToolsSheet connector={connectors.find((c) => c.id === dialog.connector.id) ?? dialog.connector} onClose={close} /> : null}
        {dialog?.kind === 'quick' ? <QuickAdd preset={dialog.preset} providers={data?.emailProviders} onClose={close} onAdded={async () => { close(); await reload(); }} /> : null}
      </div>
    );
  }
  return withI18n(locale, ConnectorsPage);
}
