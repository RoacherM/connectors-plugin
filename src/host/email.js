/**
 * Built-in email connector over IMAP (read/search/flag/move) and SMTP (send), shaped like an
 * MCP server so the hub treats it the same way: `tools` plus `callTool(name, args)` returning
 * `{ content: [{ type: 'text', text }] }`. Each call opens a short IMAP session; nothing stays
 * logged in between calls, so an idle connector costs nothing and never goes stale.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

const MAX_LIST = 100;
const BODY_PREVIEW = 1500;
const BODY_FULL = 20_000;

const TOOLS = [
  {
    name: 'search_emails',
    description: 'Search the mailbox, newest first. Combine filters freely. Use `since` with the time of the previous check to get only new mail. For Gmail, `gmail_query` accepts the same syntax as the Gmail search box (e.g. "is:unread category:primary newer_than:1d").',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        mailbox: { type: 'string', description: 'Mailbox/folder, default INBOX.' },
        since: { type: 'string', description: 'Only mail received at or after this time (ISO 8601, e.g. 2026-09-28T08:00:00+08:00 or 2026-09-28).' },
        before: { type: 'string', description: 'Only mail received before this time (ISO 8601).' },
        unread_only: { type: 'boolean', description: 'Only unread mail.' },
        from: { type: 'string', description: 'Sender address or name contains this.' },
        to: { type: 'string', description: 'Recipient contains this.' },
        subject: { type: 'string', description: 'Subject contains this.' },
        text: { type: 'string', description: 'Header or body contains this.' },
        gmail_query: { type: 'string', description: 'Gmail only: raw Gmail search query (X-GM-RAW).' },
        limit: { type: 'integer', description: `Most messages to return (default 20, max ${MAX_LIST}).` },
        include_body: { type: 'boolean', description: `Include the first ${BODY_PREVIEW} characters of each body, so you can summarize without reading one by one.` },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_email',
    description: 'Read one message in full: headers, plain-text body (HTML converted to text) and attachment list.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['uid'],
      properties: {
        uid: { type: 'integer', description: 'Message UID from search_emails.' },
        mailbox: { type: 'string', description: 'Mailbox the UID belongs to, default INBOX.' },
        mark_read: { type: 'boolean', description: 'Also mark it as read (default false).' },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'update_emails',
    description: 'Change messages: mark read/unread, star/unstar, archive (Gmail: remove from inbox), move to trash, or move to another mailbox.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['uids', 'action'],
      properties: {
        uids: { type: 'array', items: { type: 'integer' }, description: 'Message UIDs.' },
        mailbox: { type: 'string', description: 'Mailbox the UIDs belong to, default INBOX.' },
        action: { type: 'string', enum: ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'trash', 'move'] },
        target_mailbox: { type: 'string', description: 'Destination for action "move".' },
      },
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'send_email',
    description: 'Send an email from this account. To reply, pass reply_to_uid so threading headers and "Re:" subject are set.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text body (Markdown is sent as-is).' },
        html: { type: 'string', description: 'Optional HTML body; the plain body stays as the text alternative.' },
        reply_to_uid: { type: 'integer', description: 'UID (in INBOX unless reply_mailbox is given) of the message being replied to.' },
        reply_mailbox: { type: 'string' },
      },
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'list_mailboxes',
    description: 'List mailboxes/folders (Gmail labels) with their special use (Inbox, Sent, Trash, All Mail…) and unread counts.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

function parseTime(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} 不是有效的时间：${value}`);
  return date;
}

const addressList = (field) => (field?.value ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
const envelopeAddresses = (list) => (list ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function bodyOf(parsed, max) {
  const body = (parsed.text && parsed.text.trim()) ? parsed.text : parsed.html ? htmlToText(parsed.html) : '';
  const clean = body.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > max ? `${clean.slice(0, max)}\n…（已截断，共 ${clean.length} 字）` : clean;
}

/** `connector.config` has the servers; `secrets.password` the app password / authorization code. */
export function createEmailConnection({ connector, secrets, onChange = () => {}, createImap, createTransport, timeZone }) {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const state = { status: 'disconnected', error: undefined, account: undefined };
  const set = (fields) => { Object.assign(state, fields); onChange(); };
  const cfg = connector.config;
  const isGmail = cfg.provider === 'gmail' || /gmail\.com$/i.test(cfg.imapHost);

  const localTime = (date) => {
    if (!date) return undefined;
    const d = new Date(date);
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return `${parts} (${zone})`;
  };

  async function password() {
    const secret = await secrets.get(connector.id);
    if (!secret.password) throw new Error(`连接器 ${connector.label} 还没有填写应用专用密码 / 授权码`);
    return secret.password;
  }

  async function withImap(fn) {
    const client = (createImap ?? ((options) => new ImapFlow(options)))({
      host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993,
      auth: { user: cfg.user, pass: await password() }, logger: false,
      socketTimeout: 60_000, greetingTimeout: 20_000,
    });
    try {
      await client.connect();
    } catch (error) {
      const detail = error?.responseText ?? error?.response ?? error?.message ?? String(error);
      const hint = /auth|login|credential|password|Invalid/i.test(detail) ? '（请确认使用的是应用专用密码 / 授权码，并已开启 IMAP）' : '';
      throw new Error(`无法登录 ${cfg.imapHost}：${detail}${hint}`);
    }
    try { return await fn(client); } finally { await client.logout().catch(() => client.close?.()); }
  }

  async function withMailbox(client, mailbox, fn) {
    const lock = await client.getMailboxLock(mailbox || 'INBOX');
    try { return await fn(); } finally { lock.release(); }
  }

  async function specialMailbox(client, use) {
    const boxes = await client.list();
    return boxes.find((box) => box.specialUse === use)?.path;
  }

  async function searchEmails(args) {
    const since = parseTime(args.since, 'since');
    const before = parseTime(args.before, 'before');
    const limit = Math.min(MAX_LIST, Math.max(1, Number.isInteger(args.limit) ? args.limit : 20));
    const mailbox = args.mailbox || 'INBOX';
    return withImap((client) => withMailbox(client, mailbox, async () => {
      const query = {};
      // IMAP SINCE/BEFORE have day granularity; exact times are filtered on internalDate below.
      if (since) query.since = new Date(since.getTime() - 24 * 3600 * 1000);
      if (before) query.before = new Date(before.getTime() + 24 * 3600 * 1000);
      if (args.unread_only) query.seen = false;
      if (args.from) query.from = args.from;
      if (args.to) query.to = args.to;
      if (args.subject) query.subject = args.subject;
      if (args.text) query.text = args.text;
      if (args.gmail_query) {
        if (!isGmail) throw new Error('gmail_query 只适用于 Gmail');
        query.gmraw = args.gmail_query;
      }
      if (Object.keys(query).length === 0) query.all = true;
      const uids = (await client.search(query, { uid: true })) || [];
      const newestFirst = [...uids].sort((a, b) => b - a);
      const messages = [];
      // Fetch in pages from the newest end until `limit` messages pass the exact time filter.
      for (let offset = 0; offset < newestFirst.length && messages.length < limit; offset += limit * 2) {
        const page = newestFirst.slice(offset, offset + limit * 2);
        const fetched = [];
        for await (const msg of client.fetch(page, { uid: true, envelope: true, flags: true, internalDate: true, size: true, ...(args.include_body ? { source: true } : {}) }, { uid: true })) fetched.push(msg);
        fetched.sort((a, b) => b.uid - a.uid);
        for (const msg of fetched) {
          const received = msg.internalDate ? new Date(msg.internalDate) : undefined;
          if (since && received && received < since) continue;
          if (before && received && received >= before) continue;
          const item = {
            uid: msg.uid,
            received: localTime(received),
            from: envelopeAddresses(msg.envelope?.from),
            to: envelopeAddresses(msg.envelope?.to),
            subject: msg.envelope?.subject ?? '(无主题)',
            unread: !msg.flags?.has('\\Seen'),
            starred: msg.flags?.has('\\Flagged') || undefined,
          };
          if (args.include_body && msg.source) {
            const parsed = await simpleParser(msg.source);
            item.body = bodyOf(parsed, BODY_PREVIEW);
            if (parsed.attachments?.length) item.attachments = parsed.attachments.map((a) => a.filename ?? a.contentType);
          }
          messages.push(item);
          if (messages.length >= limit) break;
        }
      }
      return { account: cfg.user, mailbox, matched: uids.length, returned: messages.length, now: localTime(new Date()), messages };
    }));
  }

  async function readEmail(args) {
    const mailbox = args.mailbox || 'INBOX';
    return withImap((client) => withMailbox(client, mailbox, async () => {
      const msg = await client.fetchOne(String(args.uid), { uid: true, source: true, flags: true, internalDate: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`在 ${mailbox} 里找不到 UID ${args.uid} 的邮件`);
      const parsed = await simpleParser(msg.source);
      if (args.mark_read) await client.messageFlagsAdd(String(args.uid), ['\\Seen'], { uid: true });
      return {
        uid: args.uid, mailbox,
        received: localTime(msg.internalDate),
        from: addressList(parsed.from), to: addressList(parsed.to), cc: addressList(parsed.cc) || undefined,
        subject: parsed.subject ?? '(无主题)', messageId: parsed.messageId,
        unread: args.mark_read ? false : !msg.flags?.has('\\Seen'),
        attachments: parsed.attachments?.map((a) => ({ name: a.filename ?? '(未命名)', type: a.contentType, bytes: a.size })) ?? [],
        body: bodyOf(parsed, BODY_FULL),
      };
    }));
  }

  async function updateEmails(args) {
    const uids = (Array.isArray(args.uids) ? args.uids : []).filter((uid) => Number.isInteger(uid));
    if (uids.length === 0) throw new Error('uids 不能为空');
    const range = uids.join(',');
    const mailbox = args.mailbox || 'INBOX';
    return withImap((client) => withMailbox(client, mailbox, async () => {
      const opts = { uid: true };
      switch (args.action) {
        case 'mark_read': await client.messageFlagsAdd(range, ['\\Seen'], opts); break;
        case 'mark_unread': await client.messageFlagsRemove(range, ['\\Seen'], opts); break;
        case 'star': await client.messageFlagsAdd(range, ['\\Flagged'], opts); break;
        case 'unstar': await client.messageFlagsRemove(range, ['\\Flagged'], opts); break;
        case 'archive': {
          const target = isGmail ? await specialMailbox(client, '\\All') : (await specialMailbox(client, '\\Archive')) ?? 'Archive';
          if (!target) throw new Error('找不到归档文件夹');
          await client.messageMove(range, target, opts);
          break;
        }
        case 'trash': {
          const target = await specialMailbox(client, '\\Trash');
          if (!target) throw new Error('找不到废纸篓文件夹');
          await client.messageMove(range, target, opts);
          break;
        }
        case 'move':
          if (!args.target_mailbox) throw new Error('move 需要 target_mailbox');
          await client.messageMove(range, args.target_mailbox, opts);
          break;
        default: throw new Error(`未知操作：${args.action}`);
      }
      return { ok: true, action: args.action, uids };
    }));
  }

  async function sendEmail(args) {
    const to = Array.isArray(args.to) ? args.to : [args.to].filter(Boolean);
    if (to.length === 0) throw new Error('to 不能为空');
    let subject = String(args.subject ?? '');
    const headers = {};
    if (Number.isInteger(args.reply_to_uid)) {
      const original = await readEmail({ uid: args.reply_to_uid, mailbox: args.reply_mailbox });
      if (original.messageId) { headers.inReplyTo = original.messageId; headers.references = original.messageId; }
      if (!/^re:/i.test(subject)) subject = `Re: ${subject || original.subject}`;
    }
    const transporter = (createTransport ?? nodemailer.createTransport)({
      host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpPort === 465,
      auth: { user: cfg.user, pass: await password() },
    });
    const info = await transporter.sendMail({
      from: cfg.displayName ? { name: cfg.displayName, address: cfg.user } : cfg.user,
      to, cc: args.cc, bcc: args.bcc, subject, text: String(args.body ?? ''), html: args.html, ...headers,
    });
    return { sent: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  }

  async function listMailboxes() {
    return withImap(async (client) => {
      const boxes = await client.list({ statusQuery: { unseen: true, messages: true } });
      return boxes.filter((box) => !box.flags?.has('\\Noselect')).map((box) => ({
        path: box.path, specialUse: box.specialUse, messages: box.status?.messages, unread: box.status?.unseen,
      }));
    });
  }

  const handlers = { search_emails: searchEmails, read_email: readEmail, update_emails: updateEmails, send_email: sendEmail, list_mailboxes: listMailboxes };

  return {
    async connect() {
      set({ status: 'connecting', error: undefined });
      try {
        await withImap(async (client) => { await client.status('INBOX', { messages: true }); });
        set({ status: 'connected', error: undefined, account: cfg.user });
      } catch (error) {
        set({ status: 'error', error: error.message });
      }
      return this.snapshot();
    },
    async disconnect() { set({ status: 'disconnected', error: undefined }); },
    async callTool(name, args) {
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`未知工具：${name}`);
      try {
        const result = text(await handler(args ?? {}));
        if (state.status !== 'connected') set({ status: 'connected', error: undefined });
        return result;
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    },
    snapshot() {
      return {
        status: state.status, error: state.error,
        server: { name: `${cfg.imapHost} · ${cfg.user}` },
        tools: TOOLS.map((tool) => ({ ...tool })),
      };
    },
  };
}

export const EMAIL_TOOLS = TOOLS;
