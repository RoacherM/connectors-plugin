/**
 * connector_resource: list and read the documents (MCP resources) a connector's server offers,
 * such as Cua Driver's `skill://cua-driver/SKILL.md`. Documents can be tens of thousands of
 * characters, so reads come in pages, a long document opens with its outline, and `heading`
 * jumps to one section. The tool is registered only while some enabled connector offers resources,
 * and re-registered only when that set of connectors changes.
 */
import { isModelDocument } from './documents.js';
import { OUTPUT_SCHEMA, render } from './hub.js';

export const DEFAULT_PAGE = 20_000;
const MIN_PAGE = 1_000;
const MAX_PAGE = 60_000;
const OUTLINE_LINES = 80;

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

/** Markdown headings with their character offsets; fenced code blocks are skipped. */
export function headings(text) {
  const found = [];
  let at = 0;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = HEADING.exec(line);
      if (m) found.push({ level: m[1].length, title: m[2].trim(), start: at });
    }
    at += line.length + 1;
  }
  return found;
}

/** The section under the heading that best matches `wanted`: an exact title first, then a substring. */
export function section(text, wanted) {
  const all = headings(text);
  const needle = String(wanted).trim().replace(/^#+\s*/, '').toLowerCase();
  const hit = all.find((h) => h.title.toLowerCase() === needle) ?? all.find((h) => h.title.toLowerCase().includes(needle));
  if (!hit) return undefined;
  const next = all.find((h) => h.start > hit.start && h.level <= hit.level);
  return { title: hit.title, text: text.slice(hit.start, next ? next.start : text.length) };
}

function outline(text) {
  const rows = headings(text).filter((h) => h.level <= 3).map((h) => `${'  '.repeat(h.level - 1)}- ${h.title}`);
  if (rows.length === 0) return '';
  const shown = rows.slice(0, OUTLINE_LINES);
  return ['目录（用 heading 参数直接读某一节）：', ...shown, rows.length > shown.length ? `  …另有 ${rows.length - shown.length} 个标题` : ''].filter(Boolean).join('\n');
}

/** One page of `text` from `offset`, ending on a line break when one is near the end of the window. */
export function page(text, offset, size) {
  const start = Math.min(Math.max(offset, 0), text.length);
  let end = Math.min(start + size, text.length);
  if (end < text.length) {
    const cut = text.lastIndexOf('\n', end);
    if (cut > start + size * 0.8) end = cut + 1;
  }
  return { start, end, body: text.slice(start, end) };
}

/** Model-facing text of one resources/read result. Exported for tests. */
export function renderRead(result, { uri, heading, offset = 0, max_chars: maxChars } = {}) {
  const size = Math.min(Math.max(Number.isInteger(maxChars) ? maxChars : DEFAULT_PAGE, MIN_PAGE), MAX_PAGE);
  const contents = Array.isArray(result?.contents) ? result.contents : [];
  const texts = contents.filter((c) => typeof c?.text === 'string').map((c) => c.text);
  const binaries = contents.filter((c) => typeof c?.blob === 'string').map((c) => `[二进制内容 ${c.uri ?? uri}（${c.mimeType ?? '未知类型'}，${c.blob.length} 个 base64 字符），无法以文本读取]`);
  let text = texts.join('\n\n');
  if (!text) return binaries.join('\n') || `${uri} 没有内容。`;

  let label = uri;
  if (heading !== undefined && heading !== '') {
    const found = section(text, heading);
    if (!found) return `${uri} 里没有标题包含「${heading}」的一节。\n${outline(text) || '这份文档没有标题。'}`;
    text = found.text;
    label = `${uri} § ${found.title}`;
  }

  const { start, end, body } = page(text, Number.isInteger(offset) ? offset : 0, size);
  const parts = [`${label} — 第 ${start}–${end} 字符，共 ${text.length} 字符`];
  if (start === 0 && end < text.length && heading === undefined) {
    const toc = outline(text);
    if (toc) parts.push(toc);
  }
  parts.push(body);
  if (end < text.length) parts.push(`…（还有 ${text.length - end} 字符：下一段用 offset: ${end}${heading !== undefined && heading !== '' ? `，heading 不变` : ''}）`);
  if (binaries.length) parts.push(binaries.join('\n'));
  return parts.join('\n\n');
}

function row(uri, item) {
  const meta = [item.mimeType, Number.isFinite(item.size) ? `${item.size} 字节` : ''].filter(Boolean).join('，');
  const about = item.description ? `：${String(item.description).replace(/\s+/g, ' ').slice(0, 160)}` : '';
  return `- ${uri}${item.name && !uri.endsWith(item.name) ? `（${item.name}）` : ''}${meta ? ` [${meta}]` : ''}${about}`;
}

/**
 * The connector's documents and URI templates, without MCP App UI views (counted, so the list
 * does not look incomplete). Exported for tests.
 */
export function renderList(connector, resources, templates = []) {
  const docs = resources.filter(isModelDocument);
  const tpls = templates.filter(isModelDocument);
  const hidden = resources.length - docs.length + templates.length - tpls.length;
  const note = hidden ? `（另有 ${hidden} 个 MCP App 界面资源，只供能渲染界面的客户端使用，已略去）` : '';
  if (docs.length === 0 && tpls.length === 0) return [`${connector} 没有可读的文档。`, note].filter(Boolean).join('\n');
  const parts = [];
  if (docs.length) parts.push(`${connector} 的文档（${docs.length} 份）：`, ...docs.map((r) => row(r.uri, r)));
  if (tpls.length) parts.push(`URI 模板（${tpls.length} 个，把 {变量} 换成具体值后作为 uri 读取）：`, ...tpls.map((t) => row(t.uriTemplate, t)));
  parts.push(`用 { connector: "${connector}", uri } 读取；长文档分段返回，开头有目录，用 heading 读某一节。`);
  if (note) parts.push(note);
  return parts.join('\n');
}

/** Keep connector_resource registered exactly while some connector offers documents. Returns a disposer. */
export function registerResourceTool(ctx, hub, { log = () => {} } = {}) {
  let key;
  let dispose;

  function definition(names) {
    return {
      name: 'connector_resource',
      description: [
        `Read documents (MCP resources) that connectors provide: ${names.join(', ')}. Without \`uri\`, lists a connector's documents and URI templates; with \`uri\`, reads one in pages of \`max_chars\` (default ${DEFAULT_PAGE}).`,
        'A long document starts with its outline: pass `heading` to read just that section, or `offset` to continue. When a connector\'s usage notes say to read a resource (resources/read, skills/get), use this tool.',
      ].join('\n'),
      parameters: {
        type: 'object', additionalProperties: false, required: ['connector'],
        properties: {
          connector: { type: 'string', enum: names },
          uri: { type: 'string', description: 'Document URI from the list (or a template with its variables filled in), e.g. "skill://cua-driver/SKILL.md". Omit to list.' },
          heading: { type: 'string', description: 'Read only the section under this Markdown heading (exact title or part of it).' },
          offset: { type: 'integer', minimum: 0, description: 'Character offset to start from, as given at the end of the previous page.' },
          max_chars: { type: 'integer', minimum: MIN_PAGE, maximum: MAX_PAGE, description: `Most characters to return (default ${DEFAULT_PAGE}).` },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const name = args?.connector;
        if (!hub.resourceConnectors().some((c) => c.name === name)) {
          throw new Error(`连接器 ${name} 不提供文档。提供文档的：${hub.resourceConnectors().map((c) => c.name).join('、') || '无'}`);
        }
        if (!args.uri) {
          const [resources, templates] = await Promise.all([hub.listResources(name, exec?.signal), hub.listResourceTemplates(name, exec?.signal)]);
          return { text: renderList(name, resources, templates) };
        }
        return { text: renderRead(await hub.readResource(name, args.uri, exec?.signal), args) };
      },
    };
  }

  function refresh() {
    const names = hub.resourceConnectors().map((c) => c.name);
    const next = JSON.stringify(names);
    if (next === key) return;
    key = next;
    dispose?.();
    dispose = undefined;
    if (names.length === 0) return;
    try {
      dispose = ctx.effect(() => ctx.tools.register(definition(names)), 'dsh-connectors: connector_resource');
    } catch (error) {
      log(`dsh-connectors: 注册 connector_resource 失败：${error.message}`);
    }
  }

  const unsubscribe = hub.subscribe(refresh);
  refresh();
  return () => { unsubscribe(); dispose?.(); };
}
