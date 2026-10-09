/**
 * Real MCP servers for the tests, built with the official SDK:
 *   - `node servers.mjs stdio` runs a stdio server (spawned by the stdio connector test)
 *   - `startHttpServer()` runs Streamable HTTP, optionally behind a bearer token or a full
 *     OAuth 2.1 authorization server (metadata discovery, dynamic registration, PKCE, refresh).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** @param docs - 'all': documents, a template and a UI view; 'ui-only': just the UI view. */
export function makeServer({ docs = 'all' } = {}) {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' }, { instructions: 'Fixture server for tests.' });
  server.registerTool('echo', { description: 'Echo the text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
  server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: undefined }));
  server.registerTool('fail', { description: 'Always fails' }, async () => ({ isError: true, content: [{ type: 'text', text: 'boom from server' }] }));
  server.registerTool('env', { description: 'Read an environment variable', inputSchema: { name: z.string() } },
    async ({ name }) => ({ content: [{ type: 'text', text: String(process.env[name] ?? '(unset)') }] }));
  server.registerResource('app', 'ui://fixture/app', { description: 'MCP App view', mimeType: 'text/html;profile=mcp-app' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: '<html></html>' }] }));
  if (docs === 'ui-only') return server;
  server.registerResource('note', new ResourceTemplate('doc://fixture/notes/{id}', { list: undefined }), { description: 'One note by id', mimeType: 'text/plain' },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `note ${id}` }] }));
  server.registerResource('guide', 'doc://fixture/GUIDE.md', { title: 'Guide', description: 'How to use the fixture', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }));
  server.registerResource('logo', 'doc://fixture/logo.png', { mimeType: 'image/png' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'image/png', blob: Buffer.from('png-bytes').toString('base64') }] }));
  return server;
}

/** A Markdown document long enough to page, with a fenced line that only looks like a heading. */
export const GUIDE = [
  '# Guide', 'Intro.', '## Setup', 'Install it.', '```sh', '# not a heading', '```',
  '## Usage', ...Array.from({ length: 200 }, (_, i) => `usage line ${i}`), '### Details', 'More detail.',
  '## FAQ', 'Answers.', '',
].join('\n');

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(data));
});

/**
 * @param options.auth - 'none' | 'bearer' (fixed token) | 'oauth'
 */
export async function startHttpServer({ auth = 'none', token = 'secret-token', dcr = true, client } = {}) {
  // `client`: a pre-registered confidential client { id, secret } (any loopback redirect allowed), like a GitHub OAuth app.
  const clients = new Map(client ? [[client.id, { secret: client.secret }]] : []);
  const codes = new Map();
  const accessTokens = new Set(auth === 'bearer' ? [token] : []);
  const stats = { registrations: 0, tokenRequests: 0, mcpRequests: 0 };
  let base;

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const sendJson = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };

    if (auth === 'oauth') {
      if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return sendJson(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return sendJson(200, {
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          ...(dcr ? { registration_endpoint: `${base}/register` } : {}),
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        });
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        const meta = JSON.parse(await readBody(req));
        const clientId = 'client-' + randomBytes(4).toString('hex');
        clients.set(clientId, meta);
        stats.registrations++;
        return sendJson(201, { ...meta, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (url.pathname === '/authorize') {
        // The "user" approves instantly: redirect back with a code bound to the PKCE challenge.
        const client = clients.get(url.searchParams.get('client_id'));
        const redirect = url.searchParams.get('redirect_uri');
        const loopback = /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect ?? '');
        if (!client || (client.redirect_uris ? !client.redirect_uris.includes(redirect) : !loopback)) return sendJson(400, { error: 'invalid_client' });
        const code = 'code-' + randomBytes(4).toString('hex');
        codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect });
        const target = new URL(redirect);
        target.searchParams.set('code', code);
        target.searchParams.set('state', url.searchParams.get('state'));
        res.writeHead(302, { Location: target.href });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        stats.tokenRequests++;
        const form = new URLSearchParams(await readBody(req));
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        const [basicId, basicSecret] = basic ? Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent) : [];
        const caller = clients.get(form.get('client_id') ?? basicId);
        if (caller?.secret && (form.get('client_secret') ?? basicSecret) !== caller.secret) return sendJson(401, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const entry = codes.get(form.get('code'));
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!entry || entry.challenge !== challenge) return sendJson(400, { error: 'invalid_grant' });
          codes.delete(form.get('code'));
        } else if (form.get('grant_type') !== 'refresh_token') return sendJson(400, { error: 'unsupported_grant_type' });
        const access = 'at-' + randomBytes(6).toString('hex');
        accessTokens.add(access);
        return sendJson(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-' + randomBytes(6).toString('hex') });
      }
    }

    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    if (auth !== 'none') {
      const header = req.headers.authorization ?? '';
      if (!accessTokens.has(header.replace(/^Bearer /, ''))) {
        res.writeHead(401, auth === 'oauth' ? { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } : {});
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    }
    stats.mcpRequests++;
    // Stateless mode: a fresh server + transport per request.
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    const raw = req.method === 'POST' ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${httpServer.address().port}`;
  return { url: `${base}/mcp`, base, stats, close: () => new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(r); }) };
}

if (process.argv[2] === 'stdio') {
  const server = makeServer({ docs: process.argv[3] ?? 'all' });
  await server.connect(new StdioServerTransport());
}
