import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailConnection } from '../src/host/email.js';

const rfc822 = ({ from, to = 'me@gmail.com', subject, date, body, html, messageId }) => Buffer.from([
  `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${date.toUTCString()}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0',
  html ? 'Content-Type: text/html; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8', '', html ?? body,
].join('\r\n'));

function fixtureMailbox() {
  const day = (h, m) => new Date(Date.UTC(2026, 8, 28, h, m));
  const messages = [
    { uid: 11, internalDate: day(0, 5), flags: new Set(['\\Seen']), from: 'Alice <alice@example.com>', subject: 'Old news', body: 'yesterday stuff', id: '<a@x>' },
    { uid: 12, internalDate: day(1, 30), flags: new Set(), from: 'Bob <bob@example.com>', subject: '周报', body: '本周进展：完成连接器。', id: '<b@x>' },
    { uid: 13, internalDate: day(2, 0), flags: new Set(), from: 'News <news@example.com>', subject: 'Newsletter', html: '<p>Hello<br>World</p><a href="https://x.test">link</a>', id: '<c@x>' },
  ].map((m) => ({ ...m, source: rfc822({ from: m.from, subject: m.subject, date: m.internalDate, body: m.body, html: m.html, messageId: m.id }), envelope: { from: [{ name: m.from.split(' <')[0], address: m.from.match(/<(.+)>/)[1] }], to: [{ address: 'me@gmail.com' }], subject: m.subject } }));
  const calls = [];
  const fakeClient = (options) => ({
    options,
    async connect() { if (options.auth.pass !== 'goodpassword') { const e = new Error('Command failed'); e.responseText = 'Invalid credentials (Failure)'; throw e; } },
    async logout() {},
    async getMailboxLock(path) { calls.push(['lock', path]); return { release() {} }; },
    async status() { return { messages: messages.length }; },
    async search(query) {
      calls.push(['search', query]);
      return messages.filter((m) => (query.seen === false ? !m.flags.has('\\Seen') : true) && (query.since ? m.internalDate >= query.since : true)).map((m) => m.uid);
    },
    async *fetch(uids) { for (const m of messages) if (uids.includes(m.uid)) yield m; },
    async fetchOne(uid) { return messages.find((m) => String(m.uid) === String(uid)); },
    async messageFlagsAdd(range, flags) { calls.push(['flagsAdd', range, flags]); for (const uid of range.split(',')) flags.forEach((f) => messages.find((m) => String(m.uid) === uid)?.flags.add(f)); },
    async messageFlagsRemove(range, flags) { calls.push(['flagsRemove', range, flags]); },
    async messageMove(range, target) { calls.push(['move', range, target]); },
    async list() { return [{ path: 'INBOX', specialUse: '\\Inbox', flags: new Set(), status: { messages: 3, unseen: 2 } }, { path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set() }, { path: '[Gmail]/Trash', specialUse: '\\Trash', flags: new Set() }, { path: '[Gmail]', flags: new Set(['\\Noselect']) }]; },
  });
  return { messages, calls, fakeClient };
}

function connection({ password = 'goodpassword', provider = 'gmail', sent = [] } = {}) {
  const box = fixtureMailbox();
  const conn = createEmailConnection({
    connector: { id: 'c-1', label: 'Gmail', config: { provider, user: 'me@gmail.com', imapHost: provider === 'gmail' ? 'imap.gmail.com' : 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, displayName: 'Me' } },
    secrets: { get: async () => ({ password }) },
    createImap: box.fakeClient,
    createTransport: (options) => ({ sendMail: async (mail) => { sent.push({ options, mail }); return { messageId: '<sent@x>', accepted: mail.to, rejected: [] }; } }),
    timeZone: 'Asia/Shanghai',
  });
  const call = async (name, args) => {
    const result = await conn.callTool(name, args);
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  return { conn, call, box, sent };
}

test('search filters by exact time (not just the IMAP day) and reports local times', async () => {
  const { call, box } = connection();
  const result = await call('search_emails', { since: '2026-09-28T09:00:00+08:00', unread_only: true });
  assert.deepEqual(result.messages.map((m) => m.uid), [13, 12]);
  assert.equal(result.messages[0].received, '2026-09-28 10:00 (Asia/Shanghai)');
  assert.equal(result.messages[1].from, 'Bob <bob@example.com>');
  assert.equal(result.messages[1].unread, true);
  const [, query] = box.calls.find(([kind]) => kind === 'search');
  assert.equal(query.seen, false);
  assert.ok(query.since < new Date('2026-09-28T01:00:00Z'), 'IMAP SINCE is widened by a day');

  const later = await call('search_emails', { since: '2026-09-28T09:45:00+08:00' });
  assert.deepEqual(later.messages.map((m) => m.uid), [13]);
  const limited = await call('search_emails', { limit: 1 });
  assert.deepEqual(limited.messages.map((m) => m.uid), [13]);
  assert.equal(limited.matched, 3);
});

test('include_body and read_email turn HTML into readable text', async () => {
  const { call, box } = connection();
  const result = await call('search_emails', { include_body: true, limit: 2 });
  assert.equal(result.messages[0].body, 'Hello\nWorld\n\nlink [https://x.test]');
  assert.equal(result.messages[1].body, '本周进展：完成连接器。');
  const read = await call('read_email', { uid: 12, mark_read: true });
  assert.equal(read.subject, '周报');
  assert.equal(read.messageId, '<b@x>');
  assert.equal(read.unread, false);
  assert.deepEqual(box.calls.find(([kind]) => kind === 'flagsAdd'), ['flagsAdd', '12', ['\\Seen']]);
  assert.match((await call('read_email', { uid: 99 })).error, /找不到 UID 99/);
});

test('update_emails: Gmail archive goes to All Mail, trash to Trash', async () => {
  const { call, box } = connection();
  assert.deepEqual(await call('update_emails', { uids: [12, 13], action: 'archive' }), { ok: true, action: 'archive', uids: [12, 13] });
  assert.deepEqual(box.calls.at(-1), ['move', '12,13', '[Gmail]/All Mail']);
  await call('update_emails', { uids: [11], action: 'trash' });
  assert.deepEqual(box.calls.at(-1), ['move', '11', '[Gmail]/Trash']);
  assert.match((await call('update_emails', { uids: [], action: 'star' })).error, /uids/);
});

test('send_email replies in thread over SMTPS with the app password', async () => {
  const sent = [];
  const { call } = connection({ sent });
  const result = await call('send_email', { to: ['bob@example.com'], subject: '', body: '收到，谢谢！', reply_to_uid: 12 });
  assert.equal(result.sent, true);
  const [{ options, mail }] = sent;
  assert.deepEqual(options, { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'me@gmail.com', pass: 'goodpassword' } });
  assert.equal(mail.subject, 'Re: 周报');
  assert.equal(mail.inReplyTo, '<b@x>');
  assert.deepEqual(mail.from, { name: 'Me', address: 'me@gmail.com' });
});

test('login failures explain app passwords; gmail_query is Gmail-only; connect() checks the login', async () => {
  const bad = connection({ password: 'wrong' });
  assert.match((await bad.call('search_emails', {})).error, /Invalid credentials.*应用专用密码/);
  assert.equal((await bad.conn.connect()).status, 'error');
  const qq = connection({ provider: 'qq' });
  assert.match((await qq.call('search_emails', { gmail_query: 'is:unread' })).error, /只适用于 Gmail/);
  const good = connection();
  assert.equal((await good.conn.connect()).status, 'connected');
  assert.deepEqual(good.conn.snapshot().tools.map((t) => t.name), ['search_emails', 'read_email', 'update_emails', 'send_email', 'list_mailboxes']);
  const boxes = await good.call('list_mailboxes', {});
  assert.deepEqual(boxes.map((b) => b.path), ['INBOX', '[Gmail]/All Mail', '[Gmail]/Trash']);
});
