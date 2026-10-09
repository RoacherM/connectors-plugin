/**
 * Usage notes (MCP `instructions`) of direct connectors, in the system prompt beside DSH's own MCP
 * servers' notes — what the official MCP client does. Search connectors deliver theirs with the
 * first connector_search instead (search.js), so either way the model reads each server's notes.
 * The section text is computed per prompt assembly, so it follows connects, edits and exposure
 * switches; it changes only when a direct connector's notes do.
 */
import { docsHint } from './documents.js';

/** Section text for the given direct-connector notes; empty when there are none. Exported for tests. */
export function notesSection(entries) {
  if (entries.length === 0) return '';
  return [
    '## Connector usage notes',
    ...entries.map((e) => `### 连接器 ${e.connector.name}（${e.connector.label ?? e.connector.name}，工具 mcp__${e.connector.name.replace(/-/g, '_')}__*）\n\n${e.instructions}${e.resources ? `\n${docsHint(e.connector.name)}` : ''}`),
  ].join('\n\n');
}

/** Register the section when the host composes a system prompt; a host without one is left alone. */
export function registerNotesSection(ctx, hub) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'dsh-connectors:usage-notes',
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: () => notesSection(hub.directNotes()),
    });
  });
}
