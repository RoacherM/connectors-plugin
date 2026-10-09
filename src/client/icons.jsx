/**
 * Line icons (24px grid, 1.7 stroke) and brand logo tiles. Shared in spirit with the scheduler
 * plugin, which carries its own copy so the two bundles stay independent.
 */
import React from 'react';

function Svg({ size = 16, children, className, style, fill = 'none', strokeWidth = 1.7 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}>{children}</svg>
  );
}

export const Icon = {
  plus: (p) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
  x: (p) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>,
  check: (p) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>,
  chevron: (p) => <Svg {...p}><path d="m9.5 6 6 6-6 6" /></Svg>,
  edit: (p) => <Svg {...p}><path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-4-4l-10 10v4Z" /><path d="m13.5 7.5 3 3" /></Svg>,
  trash: (p) => <Svg {...p}><path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" /></Svg>,
  refresh: (p) => <Svg {...p}><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" /></Svg>,
  alert: (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.8v4.9M12 16.2v.01" /></Svg>,
  info: (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.8v.01" /></Svg>,
  external: (p) => <Svg {...p}><path d="M13.5 5H19v5.5M19 5l-8 8M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7h4" /></Svg>,
  key: (p) => <Svg {...p}><circle cx="8" cy="15" r="3.5" /><path d="m10.5 12.5 8-8M16 7l2.5 2.5M14 9l1.5 1.5" /></Svg>,
  logout: (p) => <Svg {...p}><path d="M14 4.5h3.5A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5H14M10 16l4-4-4-4M14 12H4.5" /></Svg>,
  mail: (p) => <Svg {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7.5 8 5.5 8-5.5" /></Svg>,
  globe: (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.6 2.8 2.6 14.2 0 17M12 3.5c-2.6 2.8-2.6 14.2 0 17" /></Svg>,
  terminal: (p) => <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="m7.5 9.5 2.8 2.5-2.8 2.5M12.5 15h4" /></Svg>,
  plug: (p) => <Svg {...p}><path d="M9 7.5V3.5M15 7.5V3.5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0V7.5ZM12 16.5v4" /></Svg>,
  tool: (p) => <Svg {...p}><path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 0-2-2Z" /></Svg>,
  chat: (p) => <Svg {...p}><path d="M5 18.5 3.8 21l3.4-1.3A8.5 8.5 0 1 0 5 18.5Z" /></Svg>,
};

const BRANDS = ['gmail', 'github', 'notion', 'linear'];

/** Which logo a connector, preset, or bare connector name shows. */
export function logoKind(item) {
  if (typeof item === 'string') return BRANDS.includes(item) ? item : 'plug';
  const provider = item?.config?.provider ?? item?.provider;
  if (item?.type === 'email') return provider === 'gmail' ? 'gmail' : provider === 'outlook' ? 'outlook' : 'mail';
  const brand = [item?.preset, item?.id, item?.name].find((v) => BRANDS.includes(v));
  if (brand) return brand;
  if (item?.type === 'mcp-stdio') return 'local';
  if (item?.type === 'mcp-http') return 'remote';
  return 'plug';
}

function GmailMark({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M3.6 19.5h3.2v-7.9L2 8v10a1.5 1.5 0 0 0 1.6 1.5Z" />
      <path fill="#34A853" d="M17.2 19.5h3.2A1.5 1.5 0 0 0 22 18V8l-4.8 3.6v7.9Z" />
      <path fill="#FBBC04" d="M17.2 5.3v6.3L22 8V6.1c0-1.8-2-2.8-3.4-1.7l-1.4.9Z" />
      <path fill="#EA4335" d="M6.8 11.6V5.3L12 9.2l5.2-3.9v6.3L12 15.5l-5.2-3.9Z" />
      <path fill="#C5221F" d="M2 6.1V8l4.8 3.6V5.3l-1.4-.9C4 3.3 2 4.3 2 6.1Z" />
    </svg>
  );
}

function GithubMark({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 1.8a10.2 10.2 0 0 0-3.2 19.9c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.3-.3-4.7-1.1-4.7-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.6 9.6 0 0 1 5.1 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.7.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.7 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.2 10.2 0 0 0 12 1.8Z" />
    </svg>
  );
}

function LinearMark({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="#fff">
      <path d="M3.2 13.9a8.9 8.9 0 0 0 6.9 6.9L3.2 13.9Zm-.2-2.6 9.7 9.7c.8 0 1.6-.2 2.3-.4L3.4 9c-.2.7-.4 1.5-.4 2.3Zm1.2-4.1 12.6 12.6c.6-.4 1.2-.8 1.7-1.3L5.5 5.5c-.5.5-.9 1.1-1.3 1.7Zm2.8-3A9 9 0 0 1 21 12c0 2.4-1 4.6-2.5 6.2L6.9 6.6l.1-2.4Z" />
    </svg>
  );
}

/** A square logo tile; `size` is the tile edge. */
export function Logo({ kind, size = 36 }) {
  const mark = Math.round(size * 0.56);
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.27) };
  switch (kind) {
    case 'gmail': return <span className="ui-logo" style={style}><GmailMark size={mark} /></span>;
    case 'github': return <span className="ui-logo dark" style={style}><GithubMark size={mark} /></span>;
    case 'linear': return <span className="ui-logo" style={{ ...style, background: '#5E6AD2', boxShadow: 'none' }}><LinearMark size={mark} /></span>;
    case 'notion': return <span className="ui-logo notion" style={{ ...style, fontSize: Math.round(size * 0.5) }}>N</span>;
    case 'outlook': return <span className="ui-logo" style={{ ...style, background: '#0F6CBD', color: '#fff', boxShadow: 'none' }}><Icon.mail size={mark} /></span>;
    case 'mail': return <span className="ui-logo tint" style={style}><Icon.mail size={mark} /></span>;
    case 'remote': return <span className="ui-logo tint" style={style}><Icon.globe size={mark} /></span>;
    case 'local': return <span className="ui-logo tint" style={style}><Icon.terminal size={mark} /></span>;
    default: return <span className="ui-logo tint" style={style}><Icon.plug size={mark} /></span>;
  }
}
