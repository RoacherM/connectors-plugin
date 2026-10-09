/**
 * Browser half: a "连接器" entry in the left sidebar opening the connectors page, and the chat
 * card that shows the one-line secret prompt while the agent's connectors_add call waits.
 */
import React from 'react';
import { DICT, withI18n } from './i18n.jsx';
import { makeConnectorsPage } from './page.jsx';
import { ConnectorToolCard } from './toolcard.jsx';
import { CSS } from './styles.js';

const PKG = '@local/dsh-connectors';
const NS = 'local-connectors';
const PANEL_ID = 'local-connectors';

export const inject = ['slots', 'locale'];

function ConnectorsIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 7V3M15 7V3" />
      <path d="M6 7h12v4a6 6 0 0 1-12 0V7Z" />
      <path d="M12 17v4" />
    </svg>
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh: { panel: DICT.zh.panel }, en: { panel: DICT.en.panel } }), 'dsh-connectors: dictionary');
  const t = ctx.locale.bind(NS);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = PKG;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'dsh-connectors: styles');
  const startChat = () => {
    // Leave the panel first; navigating afterwards would supersede the new session and reopen the current one.
    ctx.get('layout')?.selectPanel(null);
    ctx.get('uiWorkspace')?.startSession();
  };
  const ConnectorsPage = makeConnectorsPage({ startChat, locale: ctx.locale });
  const ToolCard = withI18n(ctx.locale, ConnectorToolCard);
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, ConnectorsPage)), 'dsh-connectors: page');
  for (const name of ['connectors_add', 'connectors_remove']) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name, locale: NS }, ToolCard)), 'dsh-connectors: tool card ' + name);
  }
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 13, locale: NS, label: () => t('panel'),
  }, ConnectorsIcon)), 'dsh-connectors: sidebar entry');
}
