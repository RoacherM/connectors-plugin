/**
 * On-demand connector tools. Connectors with `exposure: search` register no per-tool definitions;
 * while at least one of them can serve tools, the model gets two small tools instead:
 *   - connector_search: rank their tools by keywords and return compact signatures (complete
 *     input schemas for small tools, or when asked for by name);
 *   - connector_call: run one of them by connector + raw tool name.
 * The usage notes a server sends at initialize (MCP `instructions`, which a direct MCP client puts
 * in the system prompt) ride along with the first search that touches the connector, per agent.
 * The pair is registered only while it has something to find, and re-registered only when the
 * set of searchable connectors changes, so the request prefix stays stable between edits.
 */
import { docsHint } from './documents.js';
import { OUTPUT_SCHEMA, render, sanitizeSchema } from './hub.js';
import { toolName } from '../shared/presets.js';

const INLINE_SCHEMA_CHARS = 1500;
const DESCRIPTION_CHARS = 240;
const SIGNATURE_CHARS = 400;
const BROWSE_LIMIT = 100;

const text = (value) => ({ text: value });

/** Lowercase keyword terms; CJK runs stay whole so they match as substrings. */
export function terms(query) {
  return String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

/** `list_issues`, `notion-search`, `getMe` → their words. */
const nameTokens = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Keyword relevance of one tool: name hits weigh most, description hits count once per term. */
export function score(tool, connector, words) {
  if (words.length === 0) return 0;
  const name = tool.name.toLowerCase();
  const tokens = new Set(nameTokens(tool.name));
  const description = String(tool.description ?? '').toLowerCase();
  // The first sentence is the tool's summary; later sentences mention other tools and caveats.
  const summary = description.split(/[.\n。]/, 1)[0];
  const owner = `${connector.name} ${connector.label ?? ''}`.toLowerCase();
  let total = 0;
  let matched = 0;
  for (const word of words) {
    let hit = 0;
    if (name === word) hit += 20;
    if (tokens.has(word)) hit += 6;
    else if (name.includes(word)) hit += 4;
    if (summary.includes(word)) hit += 3;
    else if (description.includes(word)) hit += 1;
    if (hit === 0 && owner.includes(word)) hit += 0.5;
    if (hit > 0) matched++;
    total += hit;
  }
  if (total === 0) return 0;
  // Tools that match every term rank above tools that match one term many ways;
  // a tool its server marks deprecated yields to its replacement. Only the tool itself counts
  // (its summary, or a sentence opening with "Deprecated"), not one deprecated parameter.
  const ranked = total + (matched === words.length ? 10 : 0);
  const deprecated = /\bdeprecated\b/.test(summary) || /(?:^|[.!\n]\s*)deprecated\b/.test(description);
  return deprecated && !words.includes('deprecated') ? ranked / 2 : ranked;
}

const typeOf = (schema) => {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.slice(0, 6).map((v) => JSON.stringify(v)).join('|') + (schema.enum.length > 6 ? '|…' : '');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.type)) return schema.type.join('|');
  if (schema.type === 'array') return `${typeOf(schema.items)}[]`;
  if (schema.type) return schema.type;
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) return union.slice(0, 3).map(typeOf).join('|') + (union.length > 3 ? '|…' : '');
  return 'any';
};

/** One line of top-level parameters, e.g. `query: string, page_size?: integer`. */
export function signature(inputSchema) {
  const schema = sanitizeSchema(inputSchema);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const parts = Object.entries(schema.properties).map(([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${typeOf(value)}`);
  const line = parts.join(', ') || '(无参数)';
  return line.length > SIGNATURE_CHARS ? `${line.slice(0, SIGNATURE_CHARS)}…` : line;
}

const shorten = (value, max) => {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Find a tool of one connector by raw name, public `mcp__…` name, `connector/tool`, or case-insensitively. */
export function resolveTool(entry, requested) {
  const wanted = String(requested ?? '').trim();
  const bare = wanted.includes('/') ? wanted.slice(wanted.lastIndexOf('/') + 1) : wanted;
  const { tools, connector } = entry;
  return tools.find((t) => t.name === bare)
    ?? tools.find((t) => toolName(connector.name, t.name) === wanted)
    ?? tools.find((t) => t.name.toLowerCase() === bare.toLowerCase());
}

function findEntry(catalog, name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  return catalog.find((e) => e.connector.name === wanted) ?? catalog.find((e) => String(e.connector.label ?? '').toLowerCase() === wanted);
}

/** Missing required or unexpected top-level arguments, checked before the round trip to the server. */
export function argumentProblems(inputSchema, args) {
  const schema = sanitizeSchema(inputSchema);
  const problems = [];
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (args[key] === undefined) problems.push(`缺少必填参数 ${key}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) if (!(key in schema.properties)) problems.push(`未知参数 ${key}`);
  }
  return problems;
}

function describeTool(entry, tool, { full }) {
  const schema = sanitizeSchema(tool.inputSchema);
  const json = JSON.stringify(schema);
  const lines = [
    `### ${entry.connector.name}/${tool.name}${tool.annotations?.readOnlyHint ? '（只读）' : ''}`,
    full ? String(tool.description ?? '').trim() || '—' : shorten(tool.description, DESCRIPTION_CHARS) || '—',
    `参数：${signature(tool.inputSchema)}`,
  ];
  if (full || json.length <= INLINE_SCHEMA_CHARS) lines.push(`input schema: ${json}`);
  else lines.push(`（完整 schema ${json.length} 字符，调用前用 tools: ["${entry.connector.name}/${tool.name}"] 取回）`);
  return lines.join('\n');
}

function catalogLine(entry) {
  return `${entry.connector.name}（${entry.connector.label ?? entry.connector.name}，${entry.tools.length} 个工具）`;
}

/** Identity of one connector's notes: new text after a reconnect counts as unseen. */
const noteKey = (entry) => `${entry.connector.name}\n${entry.instructions}`;

/**
 * Put the server's usage notes of every connector the answer touches in front of it, once per
 * conversation: `seen` holds the notes already delivered and is updated here.
 */
function withNotes(body, entries, { seen, showInstructions }) {
  const notes = [];
  for (const entry of new Set(entries)) {
    if (!entry.instructions) continue;
    const key = noteKey(entry);
    if (seen?.has(key) && !showInstructions) continue;
    seen?.add(key);
    const docs = entry.resources ? `\n${docsHint(entry.connector.name)}` : '';
    notes.push(`## ${entry.connector.name} 使用说明（来自服务器，本会话只附这一次；需要时用 show_instructions: true 重看）\n${entry.instructions}${docs}`);
  }
  return notes.length ? `${notes.join('\n\n')}\n\n${body}` : body;
}

/**
 * Text for one connector_search call. Exported for tests.
 * @param options.seen - Set of notes this conversation already has; omit to always include them.
 */
export function runSearch(catalog, { query, connector, tools, limit, show_instructions: showInstructions } = {}, { seen } = {}) {
  if (catalog.length === 0) return '当前没有可按需搜索的连接器。';
  let scope = catalog;
  if (connector !== undefined && connector !== '') {
    const entry = findEntry(catalog, connector);
    if (!entry) return `没有名为 ${connector} 的按需连接器。可用：${catalog.map(catalogLine).join('；')}`;
    scope = [entry];
  }
  const notes = (body, entries) => withNotes(body, entries, { seen, showInstructions });

  if (Array.isArray(tools) && tools.length) {
    const out = [];
    const touched = [];
    for (const requested of tools.slice(0, 10)) {
      const [owner] = String(requested).includes('/') ? String(requested).split('/') : [];
      const entries = owner ? scope.filter((e) => e.connector.name === owner) : scope;
      const hit = entries.map((e) => ({ entry: e, tool: resolveTool(e, requested) })).find((x) => x.tool);
      if (hit) touched.push(hit.entry);
      out.push(hit ? describeTool(hit.entry, hit.tool, { full: true }) : `### ${requested}\n没有这个工具。用关键词搜索试试。`);
    }
    return notes(out.join('\n\n'), touched);
  }

  const words = terms(query);
  if (words.length === 0 || (words.length === 1 && words[0] === '*')) {
    if (scope.length !== 1) return notes(`请给出关键词，或指定 connector 浏览全部工具。可用：${scope.map(catalogLine).join('；')}`, showInstructions ? scope : []);
    const [entry] = scope;
    const rows = entry.tools.slice(0, BROWSE_LIMIT).map((t) => `- ${t.name} — ${shorten(t.description, 100) || '—'}`);
    return notes([`${catalogLine(entry)}：`, ...rows, entry.tools.length > BROWSE_LIMIT ? `…另有 ${entry.tools.length - BROWSE_LIMIT} 个，用关键词缩小范围` : '', '用 tools: ["<connector>/<tool>"] 取完整 schema，再用 connector_call 调用。'].filter(Boolean).join('\n'), [entry]);
  }

  const max = Math.min(Math.max(Number.isInteger(limit) ? limit : 8, 1), 25);
  const ranked = scope.flatMap((entry) => entry.tools.map((tool) => ({ entry, tool, score: score(tool, entry.connector, words) })))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, max);
  if (ranked.length === 0) {
    return notes(`没有匹配「${query}」的工具。换个关键词（英文工具名通常更准），或指定 connector 并把 query 设为 "*" 浏览全部。可用：${scope.map(catalogLine).join('；')}`, scope.length === 1 ? scope : []);
  }
  return notes([
    ...ranked.map(({ entry, tool }) => describeTool(entry, tool, { full: false })),
    '用 connector_call 调用：{ connector, tool, arguments }。',
  ].join('\n\n'), ranked.map((x) => x.entry));
}

const MAX_SESSIONS = 200;

/**
 * Keep connector_search / connector_call registered exactly while some search connector can
 * serve tools. Returns a disposer.
 */
export function registerSearchTools(ctx, hub, { log = () => {} } = {}) {
  let key;
  let disposers = [];

  // Notes already delivered, per agent (a subagent has its own context, so its own set).
  const seenByAgent = new Map();
  const seenFor = (exec) => {
    const id = exec?.agent?.id;
    if (typeof id !== 'string' || !id) return undefined;
    let seen = seenByAgent.get(id);
    if (!seen) {
      if (seenByAgent.size >= MAX_SESSIONS) seenByAgent.delete(seenByAgent.keys().next().value);
      seen = new Set();
      seenByAgent.set(id, seen);
    }
    return seen;
  };

  const unregister = () => { for (const dispose of disposers) dispose(); disposers = []; };

  function definitions(catalog) {
    const names = catalog.map((e) => e.connector.name);
    const directory = catalog.map((e) => `${e.connector.name}（${e.connector.label ?? e.connector.name}${e.instructions ? '，有使用说明' : ''}）`).join('、');
    const search = {
      name: 'connector_search',
      description: [
        `Find tools of the user's on-demand connectors: ${directory}. Their tools are not listed individually; search them by keywords before using one.`,
        'Returns the best matches with a one-line parameter summary (and the full input schema when it is small). Pass `tools: ["<connector>/<tool>"]` to get complete descriptions and input schemas.',
        'Use `query: "*"` with a connector to browse all its tools. Keywords in English usually match tool names best. Then run a tool with connector_call.',
        'A connector\'s usage notes from its server come with the first search that touches it in this conversation; follow them. Pass `show_instructions: true` to see them again.',
      ].join('\n'),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "create issue", "search pages". "*" lists every tool of `connector`.' },
          connector: { type: 'string', enum: names, description: 'Limit to one connector.' },
          tools: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Exact tools to describe in full, as "<connector>/<tool>".' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Most matches to return (default 8).' },
          show_instructions: { type: 'boolean', description: 'Include the usage notes of the connectors in the answer even if already shown.' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => text(runSearch(hub.catalog(), args, { seen: seenFor(exec) })),
    };

    const lookup = (args) => {
      const catalog = hub.catalog();
      const entry = findEntry(catalog, args?.connector);
      const tool = entry && resolveTool(entry, args?.tool);
      return { catalog, entry, tool };
    };

    const call = {
      name: 'connector_call',
      description: `Run one tool of an on-demand connector (${names.join(', ')}) found with connector_search. \`tool\` is the tool name shown there; \`arguments\` must follow its input schema.`,
      parameters: {
        type: 'object', additionalProperties: false, required: ['connector', 'tool'],
        properties: {
          connector: { type: 'string', enum: names },
          tool: { type: 'string', description: 'Tool name as returned by connector_search.' },
          arguments: { type: 'object', description: 'Arguments for the tool, per its input schema.' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      // Several calls may run together only when the target tool says it changes nothing.
      isConcurrencySafe: (args) => lookup(args).tool?.annotations?.readOnlyHint === true,
      async execute(args, exec) {
        const { catalog, entry, tool } = lookup(args);
        if (!entry) throw new Error(`没有可用的按需连接器 ${args?.connector}。可用：${catalog.map(catalogLine).join('；') || '无'}`);
        if (!tool) {
          const near = runSearch([entry], { query: args?.tool, limit: 5 }, { seen: new Set([noteKey(entry)]) });
          throw new Error(`${entry.connector.name} 没有工具 ${args?.tool}。相近的：\n${near}`);
        }
        const input = args.arguments ?? {};
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('arguments 必须是对象');
        const problems = argumentProblems(tool.inputSchema, input);
        if (problems.length) throw new Error(`${problems.join('；')}。\n${describeTool(entry, tool, { full: true })}`);
        return hub.call(entry.connector.name, tool.name, input, exec?.signal);
      },
    };
    return [search, call];
  }

  function refresh() {
    const catalog = hub.catalog();
    const next = JSON.stringify(catalog.map((e) => [e.connector.name, e.connector.label, Boolean(e.instructions)]));
    if (next === key) return;
    key = next;
    unregister();
    if (catalog.length === 0) return;
    for (const definition of definitions(catalog)) {
      try {
        disposers.push(ctx.effect(() => ctx.tools.register(definition), `dsh-connectors: ${definition.name}`));
      } catch (error) {
        log(`dsh-connectors: 注册 ${definition.name} 失败：${error.message}`);
      }
    }
  }

  const unsubscribe = hub.subscribe(refresh);
  refresh();
  return () => { unsubscribe(); unregister(); };
}
