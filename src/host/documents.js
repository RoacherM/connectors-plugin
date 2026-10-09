/**
 * Which MCP resources are documents for the model, shared by the connection (to count them at
 * connect time) and connector_resource (to list them). MCP App UI resources — `ui://…`, served as
 * `text/html;profile=mcp-app` — are views for hosts that render them, not reading material.
 */
export function isModelDocument(resource) {
  const uri = String(resource?.uri ?? resource?.uriTemplate ?? '');
  const mime = String(resource?.mimeType ?? '').toLowerCase();
  return !uri.startsWith('ui://') && !/profile\s*=\s*"?mcp-app/.test(mime);
}

/** JSON-RPC "method not found": a server without resource templates answers templates/list with it. */
export const isMethodNotFound = (error) => error?.code === -32601 || /-32601|method not found|unknown method/i.test(String(error?.message ?? ''));

/** The line appended to a connector's usage notes when it offers documents. */
export const docsHint = (name) => `（这里提到的文档——resources/read、skills/get、skill:// 等——用 connector_resource 读取：先 { connector: "${name}" } 列出，再 { connector, uri } 分段读，heading 可直接读某一节。）`;
