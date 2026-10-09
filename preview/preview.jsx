// Design preview: the real page and chat card against mock data, for headless-Chrome screenshots.
//   node preview/build.mjs && open "preview/index.html?theme=dark"   (&quick=qq, &tools=1, &card=1)
import React from 'react';
import { createRoot } from 'react-dom/client';
import { makeConnectorsPage } from '../src/client/page.jsx';
import { ConnectorToolCard as RawCard } from '../src/client/toolcard.jsx';
import { withI18n } from '../src/client/i18n.jsx';
import { CSS } from '../src/client/styles.js';
import { EMAIL_PROVIDERS, PRESETS } from '../src/shared/presets.js';

const tools = (names) => names.map((name) => ({ name, description: `${name.replace(/_/g, ' ')} — what this tool does for the agent.` }));
const GH_TOOLS = ['add_issue_comment', 'create_branch', 'create_pull_request', 'get_file_contents', 'get_me', 'list_commits', 'list_issues', 'list_pull_requests', 'merge_pull_request', 'search_code', 'search_issues', 'search_repositories'];
const CONNECTORS = [
  { id: 'c-1', name: 'gmail', label: 'Gmail', type: 'email', preset: 'gmail', enabled: true, status: 'connected', config: { provider: 'gmail', user: 'sir.housir@gmail.com' },
    tools: tools(['search_emails', 'read_email', 'update_emails', 'send_email', 'list_mailboxes']), toolNames: new Array(5).fill('x'), secrets: { password: true }, secretSpec: { kind: 'password', label: '应用专用密码' } },
  { id: 'c-2', name: 'github', label: 'GitHub', type: 'mcp-http', preset: 'github', enabled: true, status: 'connected', config: { url: 'https://api.githubcopilot.com/mcp/', auth: 'headers' },
    tools: tools(GH_TOOLS), toolNames: new Array(45).fill('x'), secrets: {}, secretSpec: { kind: 'header', label: 'Personal Access Token', url: 'https://github.com' } },
  { id: 'c-3', name: 'slack', label: 'Slack', type: 'mcp-http', enabled: true, status: 'needs_secret', config: { url: 'https://mcp.slack.com/mcp', auth: 'headers' }, tools: [], toolNames: [], secrets: {},
    secretSpec: { kind: 'header', label: 'Slack Bot Token', hint: '在 api.slack.com/apps 创建应用并安装到工作区后，复制 xoxb- 开头的 token。', url: 'https://api.slack.com/apps' } },
  { id: 'c-4', name: 'notion', label: 'Notion', type: 'mcp-http', preset: 'notion', enabled: true, status: 'needs_auth', authUrl: 'https://mcp.notion.com/authorize', config: { url: 'https://mcp.notion.com/mcp', auth: 'oauth' }, tools: [], toolNames: [], secrets: {} },
  { id: 'c-5', name: 'linear', label: 'Linear', type: 'mcp-http', preset: 'linear', enabled: true, status: 'error', error: 'fetch failed（getaddrinfo ENOTFOUND mcp.linear.app）\nmore detail', config: { url: 'https://mcp.linear.app/mcp', auth: 'oauth' }, tools: [], toolNames: [], secrets: {} },
  { id: 'c-6', name: 'files', label: '本地文件系统', type: 'mcp-stdio', enabled: false, status: 'disabled', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/Documents'] }, tools: [], toolNames: [], secrets: {} },
];

const params = new URLSearchParams(location.search);
window.fetch = async (url) => {
  const path = new URL(url, location.href).pathname;
  if (path.endsWith('/wait')) return new Promise(() => {});
  return new Response(JSON.stringify({ connectors: params.has('empty') ? [] : CONNECTORS, presets: PRESETS, emailProviders: EMAIL_PROVIDERS, revision: 1 }));
};

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);
if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
const locale = { getSnapshot: () => ({ active: params.get('lang') ?? 'zh-CN' }), subscribe: () => () => {} };
const Page = makeConnectorsPage({ locale });
function Cards() {
  const result = { content: [{ type: 'text', text: '已添加连接器「GitHub」（name: github）— 已连接，共 45 个工具：mcp__github__get_me, …' }], call: { argsRaw: '{"preset":"github"}' } };
  return (
    <div style={{ padding: 40, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
      <ConnectorToolCard toolName="connectors_add" phase="start" block={{ argsRaw: '{"type":"mcp-http","name":"slack","label":"Slack"}' }} />
      <ConnectorToolCard toolName="connectors_add" phase="start" block={{ argsRaw: '{"preset":"notion"}' }} />
      <ConnectorToolCard toolName="connectors_add" phase="result" block={result} />
    </div>
  );
}
const ConnectorToolCard = withI18n(locale, RawCard);
createRoot(document.getElementById('root')).render(params.has('card') ? <Cards /> : <Page />);
setTimeout(() => {
  if (params.has('quick')) [...document.querySelectorAll('.cx-add')].find((b) => b.textContent.startsWith('Outlook'))?.click();
  if (params.has('tools')) [...document.querySelectorAll('.cx-linkbtn')][1]?.click();
}, 300);
