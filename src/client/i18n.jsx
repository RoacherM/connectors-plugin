/**
 * Page wording in Chinese and English, following DSH's language setting live. `{name}` in a
 * string is replaced from the values passed to t(). Any non-Chinese locale falls back to English.
 */
import React from 'react';

export const DICT = {
  zh: {
    panel: '连接器', title: '连接器',
    intro: '把邮箱、GitHub、Notion 等接进来，它们的能力会变成 Agent 的工具。配置交给 Agent，你只需要在弹出的一行输入框里填密钥。',
    statConnected: '已连接', statTools: '可用工具',
    connected: '已接入', add: '添加', loading: '加载中…',
    emptyTitle: '还没有连接器', emptyBody: '从下面点一个，或者在对话里说「帮我接入 Gmail」。',
    st_connected: '已连接', st_connecting: '连接中', st_reconnecting: '重连中', st_needs_auth: '待登录', st_needs_secret: '待填写密钥',
    st_error: '连接失败', st_disconnected: '未连接', st_disabled: '已停用',
    type_email: '邮箱', 'type_mcp-http': '远程 MCP', 'type_mcp-stdio': '本地 MCP',
    tools: '{n} 个工具', toolsTitle: '{label} 的工具', toolsSub: '{n} 个 · Agent 调用时名为 {prefix}…',
    toolsSubSearch: '{n} 个 · 按需加载：Agent 用 connector_search 查找、connector_call 调用',
    mode_direct: '直接提供', mode_search: '按需加载',
    mode_direct_tip: '每个工具的定义都随每次请求发送。点击改为按需加载：只占两个小工具，Agent 用到时再搜索。',
    mode_search_tip: '工具不进入每次请求，Agent 用 connector_search 查找、connector_call 调用。点击改回直接提供。',
    test: '测试', retry: '重试', rotate: '更换密钥', logout: '退出登录', login: '在浏览器中登录',
    enable: '启用', disable: '停用', delete: '删除', confirmDelete: '确认删除', close: '关闭', cancel: '取消',
    connect: '连接', paste: '粘贴{label}', get: '获取{label}', secret: '密钥', email: '邮箱地址',
    connectTo: '连接 {label}', localOnly: '只保存在本机的 DSH 凭据库，不会进入对话记录。',
    other: '其他服务', otherDesc: '在对话里说「帮我接入 Slack」', added: '已添加',
    appPassword: '应用专用密码', authCode: '授权码',
    preset_gmail: '搜索、阅读、整理和发送邮件', preset_github: '仓库、Issue、PR 与代码搜索',
    preset_notion: '页面与数据库，浏览器登录', preset_linear: 'Issue、项目与周期，浏览器登录', preset_outlook: '个人 Outlook 邮箱',
    help_gmail: '需要先开启两步验证，再到「应用专用密码」生成一个 16 位密码填在这里（不是 Google 账号密码）。',
    help_outlook: '个人 Outlook 账号需开启两步验证后生成应用密码；企业账号通常已禁用密码登录，请改用该服务商的 MCP 连接器。',
    hint_github: '创建一个 fine-grained token，选好仓库，给 Contents / Issues / Pull requests 权限（只读更安全）。',
    card_add: '接入 {label}', card_configuring: '正在配置…', card_need: '需要你的{label}',
    card_login: '在浏览器中登录授权，完成后会自动继续', card_connected: '已连接 · {n} 个工具',
    card_removed: '已删除 {label}', card_failed_add: '接入 {label} 失败', card_failed_remove: '删除 {label} 失败',
  },
  en: {
    panel: 'Connectors', title: 'Connectors',
    intro: 'Bring in email, GitHub, Notion and more — their abilities become tools for the agent. The agent does the setup; you only paste a key into a one-line prompt.',
    statConnected: 'Connected', statTools: 'Tools',
    connected: 'Connected', add: 'Add', loading: 'Loading…',
    emptyTitle: 'No connectors yet', emptyBody: 'Pick one below, or say “connect my Gmail” in chat.',
    st_connected: 'Connected', st_connecting: 'Connecting', st_reconnecting: 'Reconnecting', st_needs_auth: 'Sign-in needed', st_needs_secret: 'Key needed',
    st_error: 'Failed', st_disconnected: 'Disconnected', st_disabled: 'Off',
    type_email: 'Email', 'type_mcp-http': 'Remote MCP', 'type_mcp-stdio': 'Local MCP',
    tools: '{n} tools', toolsTitle: '{label} tools', toolsSub: '{n} · the agent calls them {prefix}…',
    toolsSubSearch: '{n} · on demand: the agent finds them with connector_search and runs them with connector_call',
    mode_direct: 'Direct', mode_search: 'On demand',
    mode_direct_tip: 'Every tool definition is sent with every request. Click to load them on demand: two small tools, searched when needed.',
    mode_search_tip: 'Tools stay out of every request; the agent finds them with connector_search and runs them with connector_call. Click to go back to direct.',
    test: 'Test', retry: 'Retry', rotate: 'Change key', logout: 'Sign out', login: 'Sign in in browser',
    enable: 'Turn on', disable: 'Turn off', delete: 'Delete', confirmDelete: 'Confirm delete', close: 'Close', cancel: 'Cancel',
    connect: 'Connect', paste: 'Paste {label}', get: 'Get {label}', secret: 'key', email: 'Email address',
    connectTo: 'Connect {label}', localOnly: 'Stored only in DSH’s credential store on this computer — never in the chat.',
    other: 'Other services', otherDesc: 'Say “connect Slack” in chat', added: 'Added',
    appPassword: 'app password', authCode: 'authorization code',
    preset_gmail: 'Search, read, organize and send mail', preset_github: 'Repos, issues, PRs and code search',
    preset_notion: 'Pages and databases, browser sign-in', preset_linear: 'Issues, projects and cycles, browser sign-in', preset_outlook: 'Personal Outlook mail',
    help_gmail: 'Turn on 2-Step Verification, then create a 16-character app password and paste it here (not your Google password).',
    help_outlook: 'Personal Outlook accounts need 2-step verification and an app password; work accounts usually block password sign-in — use that provider’s MCP connector instead.',
    hint_github: 'Create a fine-grained token for the repos you want, with Contents / Issues / Pull requests access (read-only is safer).',
    card_add: 'Connect {label}', card_configuring: 'Setting up…', card_need: 'Needs your {label}',
    card_login: 'Sign in in your browser; this continues on its own afterwards', card_connected: 'Connected · {n} tools',
    card_removed: 'Removed {label}', card_failed_add: 'Could not connect {label}', card_failed_remove: 'Could not remove {label}',
  },
};

export const langOf = (active) => (String(active ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

export function translator(lang) {
  const dict = DICT[lang] ?? DICT.en;
  return (key, values = {}) => String(dict[key] ?? DICT.zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => (values[name] ?? ''));
}

/** Connection errors are recorded in Chinese; rewrite the ones we know for an English page. */
const ERRORS_EN = [
  [/不支持 OAuth 自动注册/, () => 'This server does not support automatic OAuth client registration. Use an API token instead: ask the agent to reconnect with token auth, then paste the token into the prompt (GitHub: a Personal Access Token).'],
  [/^OAuth 客户端认证失败|拒绝了客户端（invalid_client）/, () => 'The OAuth server rejected the client (invalid_client): check the client ID / secret, then connect again.'],
  [/^服务器要求认证/, () => 'The server requires authentication: switch to OAuth or provide a token.'],
  [/^(.*)；已重试 (\d+) 次/, (m) => `${localizeError(m[1], 'en')} — retried ${m[2]} times; click Retry to try again.`],
  [/^无法登录 (\S+)：(.*?)(（请确认.*）)?$/, (m) => `Cannot sign in to ${m[1]}: ${m[2]}${m[3] ? ' (use an app password / authorization code and make sure IMAP is on)' : ''}`],
  [/^连接已断开$/, () => 'Connection lost'],
  [/^等待授权超时/, () => 'Timed out waiting for sign-in; connect again.'],
  [/^授权被拒绝：(.*)$/, (m) => `Sign-in was denied: ${m[1]}`],
  [/^缺少 PKCE code verifier/, () => 'The sign-in session expired; connect again.'],
];
export function localizeError(text, lang) {
  if (!text || lang !== 'en') return text;
  for (const [pattern, render] of ERRORS_EN) { const m = pattern.exec(text); if (m) return render(m); }
  return text;
}

const I18n = React.createContext({ lang: 'zh', t: translator('zh') });

/** Wrap a tree so it re-renders when DSH's language changes. `locale` is ctx.locale (may be absent in tests). */
export function withI18n(locale, Component) {
  const subscribe = (fn) => locale?.subscribe?.(fn) ?? (() => {});
  // Subscribe to the locale id itself: a string compares by value, so a new snapshot object never loops.
  const snapshot = () => (locale?.getSnapshot?.() ?? locale?.getLocale?.())?.active ?? '';
  return function Localized(props) {
    const lang = langOf(React.useSyncExternalStore(subscribe, snapshot));
    const value = React.useMemo(() => ({ lang, t: translator(lang) }), [lang]);
    return <I18n.Provider value={value}><Component {...props} /></I18n.Provider>;
  };
}

export const useI18n = () => React.useContext(I18n);
