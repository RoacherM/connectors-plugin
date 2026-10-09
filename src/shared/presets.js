/**
 * Connector catalog shared by the Host and the settings page. A preset only pre-fills the
 * add form; the saved connector is an ordinary record the user can edit afterwards.
 */

export const CONNECTOR_TYPES = ['email', 'mcp-http', 'mcp-stdio'];

/**
 * How a connector's tools reach the model:
 *   - direct: every tool is its own `mcp__<name>__<tool>` definition, sent with every request;
 *   - search: no per-tool definitions; the model finds them with `connector_search` and runs
 *     them through `connector_call`, so the request carries two small tools however many there are.
 */
export const EXPOSURES = ['direct', 'search'];

/** A record saved before `exposure` existed asked for on-demand tools with `deferLoading`. */
export const exposureOf = (connector) => (EXPOSURES.includes(connector?.exposure) ? connector.exposure : connector?.deferLoading ? 'search' : 'direct');

/** Mail providers the email connector knows the servers of. `appPasswordUrl` is where the user makes a login secret. */
export const EMAIL_PROVIDERS = {
  gmail: {
    label: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    help: '需要先开启两步验证，再到「应用专用密码」生成一个 16 位密码填在这里（不是 Google 账号密码）。',
  },
  qq: {
    label: 'QQ 邮箱', imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465,
    appPasswordUrl: 'https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/authorizationCode',
    help: '在 QQ 邮箱「设置 → 账号」开启 IMAP/SMTP 服务并生成授权码，填在这里。',
  },
  163: {
    label: '网易 163 邮箱', imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465,
    appPasswordUrl: 'https://mail.163.com',
    help: '在 163 邮箱「设置 → POP3/SMTP/IMAP」开启 IMAP 服务并获取授权码，填在这里。',
  },
  outlook: {
    label: 'Outlook / Microsoft 365', imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587,
    appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    help: '个人 Outlook 账号需开启两步验证后生成应用密码；企业账号通常已禁用密码登录，请改用该服务商的 MCP 连接器。',
  },
  custom: { label: '其他 IMAP 邮箱', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, appPasswordUrl: '', help: '填写邮箱服务商提供的 IMAP/SMTP 服务器与授权码。' },
};

/**
 * One-click connectors. Everything but the user's secret (and, for mail, the address) is
 * known in advance, so adding one is a single line of input — or none for OAuth services.
 */
const mail = (provider, name, label, description) => ({
  id: provider === 'gmail' ? 'gmail' : provider, label, description, askUser: true,
  connector: { type: 'email', name, label, config: { provider } },
});
export const PRESETS = [
  mail('gmail', 'gmail', 'Gmail', '搜索、阅读、整理和发送邮件'),
  {
    id: 'github', label: 'GitHub', description: '仓库、Issue、PR 与代码搜索',
    connector: {
      type: 'mcp-http', name: 'github', label: 'GitHub', config: { url: 'https://api.githubcopilot.com/mcp/', auth: 'headers' },
      secret: { label: 'Personal Access Token', url: 'https://github.com/settings/personal-access-tokens/new', hint: '创建一个 fine-grained token，选好仓库，给 Contents / Issues / Pull requests 权限（只读更安全）。' },
    },
  },
  { id: 'notion', label: 'Notion', description: '页面与数据库，浏览器登录', connector: { type: 'mcp-http', name: 'notion', label: 'Notion', config: { url: 'https://mcp.notion.com/mcp', auth: 'oauth' } } },
  { id: 'linear', label: 'Linear', description: 'Issue、项目与周期，浏览器登录', connector: { type: 'mcp-http', name: 'linear', label: 'Linear', config: { url: 'https://mcp.linear.app/mcp', auth: 'oauth' } } },
  mail('outlook', 'outlook', 'Outlook', '个人 Outlook 邮箱'),
];

/** Tool-name prefix segment: lowercase letters, digits and dashes, starting with a letter. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

export function slugify(value) {
  const slug = String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '');
  return slug.slice(0, 24) || 'connector';
}

/** The model-facing name of one connector tool; stable as long as the connector name and raw tool name are. */
export function toolName(connectorName, rawName) {
  const safe = String(rawName).replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `mcp__${connectorName.replace(/-/g, '_')}__${safe}`;
  return full.length <= 64 ? full : full.slice(0, 64);
}
