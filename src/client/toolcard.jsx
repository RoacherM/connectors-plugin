/**
 * Chat card for `connectors_add`. While the call runs it watches the connector and, when the
 * Host is waiting for the user, shows the one-line secret prompt (or the login button) right
 * in the conversation. The value goes to the Host's credential store, never into the chat.
 */
import React from 'react';
import { localizeError, useI18n } from './i18n.jsx';
import { Icon, Logo, logoKind } from './icons.jsx';
import { SecretLine, secretText, subtitleOf, useConnectors } from './page.jsx';

const parse = (raw) => { try { return JSON.parse(raw ?? ''); } catch { return {}; } };
const PRESET_NAMES = { gmail: 'gmail', github: 'github', notion: 'notion', linear: 'linear', outlook: 'outlook' };

function LiveCard({ args }) {
  const { t } = useI18n();
  const [{ data }] = useConnectors();
  const name = args.name ?? PRESET_NAMES[args.preset];
  const connector = data?.connectors.find((c) => c.name === name);
  const label = connector?.label ?? args.label ?? name ?? '';
  let sub = t('card_configuring');
  let body = null;
  if (connector?.status === 'needs_secret') {
    const spec = secretText(connector, t);
    sub = spec.hint ?? t('card_need', { label: spec.label });
    body = <SecretLine connector={connector} autoFocus />;
  } else if (connector?.status === 'needs_auth' && connector.authUrl) {
    sub = t('card_login');
    body = <div><a className="cx-btn primary sm" href={connector.authUrl} target="_blank" rel="noreferrer"><Icon.key size={14} />{t('login')}</a></div>;
  } else if (connector?.status === 'connected') sub = t('card_connected', { n: connector.toolNames.length });
  else if (connector) sub = subtitleOf(connector);
  const attention = Boolean(body);
  return (
    <div className={'cx-toolcard' + (attention ? ' attention' : '')}>
      <div className="cx-toolcard-head">
        <Logo kind={logoKind(connector ?? args.preset ?? name)} size={36} />
        <div className="cx-toolcard-text">
          <div className="cx-toolcard-title">{t('card_add', { label })}</div>
          <div className="cx-toolcard-sub">{sub}</div>
        </div>
        {!attention ? <Icon.refresh size={15} className="cx-spin" /> : null}
      </div>
      {body}
    </div>
  );
}

export function ConnectorToolCard(props) {
  const { t, lang } = useI18n();
  const { phase, block, toolName } = props;
  if (phase === 'preparing') return null;
  const args = parse(phase === 'start' ? block.argsRaw : block.call?.argsRaw);
  if (phase === 'start' && toolName === 'connectors_add') return <LiveCard args={args} />;
  // The result text is written for the agent (Chinese); only its structure is read here.
  const text = (block.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  const failed = block.isError === true;
  const name = args.name ?? PRESET_NAMES[args.preset];
  const label = /「(.+?)」/.exec(text)?.[1] ?? args.label ?? name ?? '';
  const tail = text.split('— ').slice(1).join('— ');
  const ok = !failed && /^已连接/.test(tail);
  const count = /共 (\d+) 个工具/.exec(tail)?.[1];
  const removing = toolName === 'connectors_remove';
  const title = failed ? t(removing ? 'card_failed_remove' : 'card_failed_add', { label: args.label ?? name ?? '' }) : removing ? t('card_removed', { label }) : label;
  const sub = failed ? localizeError(text, lang) : ok ? t('card_connected', { n: count }) : localizeError(tail.split('：')[0], lang);
  return (
    <div className="cx-toolcard">
      <div className="cx-toolcard-head">
        <Logo kind={logoKind(args.preset ?? name)} size={36} />
        <div className="cx-toolcard-text">
          <div className="cx-toolcard-title">{title}</div>
          <div className={'cx-toolcard-sub' + (failed ? ' err' : '')} title={text}>{sub}</div>
        </div>
        {ok ? <span className="cx-dot ok" /> : null}
      </div>
    </div>
  );
}
