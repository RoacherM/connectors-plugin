/**
 * Visual language: quiet surfaces separated by hairlines rather than boxes, one inverted
 * (label-on-base) accent for primary actions, color only where it carries meaning (status),
 * tabular numerals for times and counts. Every color is a DSH theme token, so dark mode follows.
 */
const T = {
  base: 'var(--dsw-alias-bg-base)', l1: 'var(--dsw-alias-bg-layer-1)', l2: 'var(--dsw-alias-bg-layer-2)', overlay: 'var(--dsw-alias-bg-overlay)',
  line: 'var(--dsw-alias-border-l1)', line2: 'var(--dsw-alias-border-l2)',
  fg: 'var(--dsw-alias-label-primary)', fg2: 'var(--dsw-alias-label-secondary)', fg3: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
  ok: 'var(--dsw-alias-state-success-primary)', warn: 'var(--dsw-alias-state-warn-primary)', err: 'var(--dsw-alias-state-error-primary)', idle: 'var(--dsw-alias-state-idle-primary)',
};
const mix = (color, pct, into = 'transparent') => `color-mix(in srgb, ${color} ${pct}%, ${into})`;

/** Buttons, fields, modal, switch, segmented control, callouts — namespaced by `p`. */
export function baseCss(p) {
  return `
.${p}-page { height:100%; overflow:auto; color:${T.fg}; font-size:13px; line-height:1.5; -webkit-font-smoothing:antialiased; }
.${p}-inner { max-width:940px; margin:0 auto; padding:44px 36px 96px; display:flex; flex-direction:column; gap:32px; }
.${p}-head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; flex-wrap:wrap; }
.${p}-head h1 { margin:0; font-size:28px; font-weight:650; letter-spacing:-.025em; line-height:1.15; }
.${p}-head p { margin:8px 0 0; max-width:540px; color:${T.fg2}; font-size:13.5px; line-height:1.6; }
.${p}-section { display:flex; flex-direction:column; gap:12px; }
.${p}-section-head { display:flex; align-items:baseline; gap:8px; }
.${p}-section-head h2 { margin:0; font-size:13px; font-weight:600; letter-spacing:-.005em; }
.${p}-count { font-size:12px; color:${T.fg3}; font-variant-numeric:tabular-nums; }
.${p}-aside { margin-left:auto; font-size:12px; color:${T.fg3}; }

.${p}-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:32px; padding:0 12px; border-radius:8px; border:none;
  box-shadow:inset 0 0 0 1px ${T.line2}; background:${T.l1}; color:${T.fg}; font:inherit; font-weight:500; cursor:pointer; white-space:nowrap;
  transition:background .12s, box-shadow .12s, color .12s, transform .06s; }
.${p}-btn:hover:not(:disabled) { background:${T.l2}; }
.${p}-btn:active:not(:disabled) { transform:translateY(.5px); }
.${p}-btn:disabled { opacity:.42; cursor:default; }
.${p}-btn.primary { background:${T.fg}; color:${T.base}; box-shadow:0 1px 2px rgba(0,0,0,.12); }
.${p}-btn.primary:hover:not(:disabled) { background:${mix(T.fg, 84, T.base)}; }
.${p}-btn.ghost { background:transparent; box-shadow:none; color:${T.fg2}; }
.${p}-btn.ghost:hover:not(:disabled) { background:${T.l2}; color:${T.fg}; }
.${p}-btn.danger { color:${T.err}; }
.${p}-btn.danger:hover:not(:disabled) { background:${mix(T.err, 10)}; color:${T.err}; }
.${p}-btn.danger-solid { background:${T.err}; color:#fff; box-shadow:none; }
.${p}-btn.danger-solid:hover:not(:disabled) { background:${mix(T.err, 88, '#000')}; }
.${p}-btn.sm { height:28px; padding:0 10px; font-size:12.5px; border-radius:7px; gap:5px; }
.${p}-btn.icon { width:28px; padding:0; }
.${p}-btn:focus-visible, .${p}-focus:focus-visible { outline:none; box-shadow:0 0 0 3px ${mix(T.fg, 16)}; }
.${p}-grow { flex:1; }

.${p}-switch { position:relative; width:30px; height:18px; flex:none; padding:0; border:none; border-radius:999px; background:${mix(T.fg, 16)}; cursor:pointer; transition:background .18s; }
.${p}-switch::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.28); transition:transform .2s cubic-bezier(.3,.7,.4,1.2); }
.${p}-switch.on { background:${T.ok}; }
.${p}-switch.on::after { transform:translateX(12px); }
.${p}-switch:disabled { opacity:.5; cursor:default; }
.${p}-switch:focus-visible { outline:none; box-shadow:0 0 0 3px ${mix(T.fg, 16)}; }

.${p}-status { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:${T.fg2}; white-space:nowrap; }
.${p}-dot { width:7px; height:7px; flex:none; border-radius:50%; background:${T.idle}; }
.${p}-dot.ok { background:${T.ok}; box-shadow:0 0 0 3px ${mix(T.ok, 18)}; }
.${p}-dot.warn { background:${T.warn}; box-shadow:0 0 0 3px ${mix(T.warn, 20)}; }
.${p}-dot.err { background:${T.err}; box-shadow:0 0 0 3px ${mix(T.err, 16)}; }
.${p}-dot.busy { background:${T.warn}; animation:${p}-pulse 1.1s ease-in-out infinite; }
.${p}-sep { width:3px; height:3px; flex:none; border-radius:50%; background:currentColor; opacity:.35; }

.${p}-note { display:flex; gap:9px; align-items:flex-start; padding:10px 12px; border-radius:10px; background:${T.l2}; color:${T.fg2}; font-size:12.5px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
.${p}-note > svg { flex:none; margin-top:2px; }
.${p}-note a { color:${T.fg}; font-weight:500; text-decoration:none; box-shadow:inset 0 -1px 0 ${mix(T.fg, 30)}; }
.${p}-note.err { background:${mix(T.err, 8)}; color:${T.err}; }
.${p}-note.warn { background:${mix(T.warn, 13)}; color:${T.fg}; }
.${p}-note.warn > svg { color:${T.warn}; }
a.${p}-note { text-decoration:none; cursor:pointer; transition:background .12s; }
a.${p}-note.warn:hover { background:${mix(T.warn, 20)}; }

.${p}-field { display:flex; flex-direction:column; gap:6px; min-width:0; }
.${p}-field-label { display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:12.5px; font-weight:500; color:${T.fg2}; }
.${p}-field-label a { display:inline-flex; align-items:center; gap:3px; font-weight:500; color:${T.fg}; text-decoration:none; }
.${p}-field-label a:hover { text-decoration:underline; }
.${p}-hint { font-size:12px; line-height:1.5; color:${T.fg3}; }
.${p}-input { height:34px; padding:0 11px; border:none; border-radius:8px; box-shadow:inset 0 0 0 1px ${T.line2}; background:${T.base}; color:inherit; font:inherit; min-width:0; transition:box-shadow .12s; }
.${p}-input::placeholder { color:${T.fg3}; opacity:.8; }
.${p}-input:hover { box-shadow:inset 0 0 0 1px ${mix(T.fg, 22)}; }
.${p}-input:focus { outline:none; box-shadow:inset 0 0 0 1px ${mix(T.fg, 45)}, 0 0 0 3px ${mix(T.fg, 9)}; }
textarea.${p}-input { height:auto; min-height:96px; padding:9px 11px; resize:vertical; line-height:1.6; }
select.${p}-input { padding-right:28px; appearance:none; background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%); background-position:calc(100% - 15px) 15px,calc(100% - 11px) 15px; background-size:4px 4px; background-repeat:no-repeat; }
.${p}-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.${p}-row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.${p}-row3 { display:grid; grid-template-columns:2fr 1fr; gap:12px; }

.${p}-seg { display:flex; gap:2px; padding:3px; border-radius:10px; background:${T.l2}; }
.${p}-seg button { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px; height:28px; padding:0 10px; border:none; border-radius:7px; background:transparent; color:${T.fg2}; font:inherit; font-size:12.5px; font-weight:500; white-space:nowrap; cursor:pointer; transition:background .12s, color .12s; }
.${p}-seg button:hover { color:${T.fg}; }
.${p}-seg button.on { background:${T.overlay}; color:${T.fg}; box-shadow:0 1px 2px rgba(0,0,0,.07), 0 0 0 .5px ${T.line2}; }
.${p}-seg button:focus-visible { outline:none; box-shadow:0 0 0 2px ${mix(T.fg, 25)}; }

.${p}-details > summary { display:inline-flex; align-items:center; gap:5px; list-style:none; cursor:pointer; color:${T.fg2}; font-size:12.5px; font-weight:500; user-select:none; }
.${p}-details > summary::-webkit-details-marker { display:none; }
.${p}-details > summary:hover { color:${T.fg}; }
.${p}-details > summary svg { transition:transform .15s; }
.${p}-details[open] > summary svg { transform:rotate(90deg); }
.${p}-details-body { margin-top:12px; display:flex; flex-direction:column; gap:12px; }

.${p}-scrim { position:fixed; inset:0; z-index:1000; display:flex; align-items:flex-start; justify-content:center; padding:9vh 16px 4vh; overflow:auto; background:rgba(12,12,16,.34); backdrop-filter:blur(4px); animation:${p}-fade .14s ease-out; }
.${p}-modal { width:min(560px,100%); overflow:hidden; border-radius:16px; background:${T.overlay}; color:${T.fg}; font-size:13px; box-shadow:0 0 0 1px ${T.line}, 0 24px 70px -14px rgba(0,0,0,.35); animation:${p}-rise .2s cubic-bezier(.2,.8,.3,1); }
.${p}-modal-head { display:flex; align-items:center; gap:12px; padding:18px 18px 14px 20px; }
.${p}-modal-head h2 { margin:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }
.${p}-modal-head p { margin:2px 0 0; font-size:12.5px; color:${T.fg2}; line-height:1.45; }
.${p}-modal-body { display:flex; flex-direction:column; gap:16px; padding:6px 20px 20px; }
.${p}-modal-foot { display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:12px 16px 12px 20px; border-top:1px solid ${T.line}; background:${mix(T.l2, 55)}; }
.${p}-modal-foot .${p}-error { margin-right:auto; }
.${p}-error { color:${T.err}; font-size:12.5px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }

.ui-logo { display:inline-flex; flex:none; align-items:center; justify-content:center; background:#fff; color:#1f2328; box-shadow:inset 0 0 0 1px rgba(0,0,0,.08); }
.ui-logo.dark { background:#1f2328; color:#fff; box-shadow:none; }
.ui-logo.tint { background:${T.l2}; color:${T.fg2}; box-shadow:inset 0 0 0 1px ${T.line}; }
.ui-logo.notion { font-family:Georgia,'Times New Roman',serif; font-weight:700; color:#111; }

.${p}-spin { animation:${p}-spin .8s linear infinite; }
@keyframes ${p}-spin { to { transform:rotate(360deg); } }
@keyframes ${p}-pulse { 50% { opacity:.35; } }
@keyframes ${p}-fade { from { opacity:0; } }
@keyframes ${p}-rise { from { opacity:0; transform:translateY(8px) scale(.985); } }
@media (prefers-reduced-motion:reduce) { .${p}-scrim, .${p}-modal, .${p}-spin, .${p}-dot.busy { animation:none; } }
`;
}

export const CSS = baseCss('cx') + `
.cx-stats { display:flex; gap:28px; }
.cx-stat b { display:block; font-size:24px; font-weight:600; letter-spacing:-.03em; line-height:1.1; font-variant-numeric:tabular-nums; }
.cx-stat span { font-size:12px; color:${T.fg3}; }

/* Every card has the same three rows — identity, state, one action line — so the grid stays even. */
.cx-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; }
.cx-card { display:grid; grid-template-rows:40px 18px 34px; gap:14px; padding:16px 16px 12px; border-radius:14px; background:${T.l1}; box-shadow:0 0 0 1px ${T.line}, 0 1px 2px rgba(0,0,0,.03); transition:box-shadow .16s; min-width:0; }
.cx-card:hover { box-shadow:0 0 0 1px ${T.line2}, 0 8px 24px -10px rgba(0,0,0,.14); }
.cx-card.attention { box-shadow:0 0 0 1px ${mix(T.warn, 45)}, 0 8px 24px -12px ${mix(T.warn, 30)}; }
.cx-card-head { display:flex; align-items:center; gap:12px; min-width:0; }
.cx-card.is-off .cx-card-head .ui-logo, .cx-card.is-off .cx-card-title { opacity:.45; }
.cx-card-title { flex:1; min-width:0; }
.cx-name { overflow:hidden; font-size:14px; font-weight:600; letter-spacing:-.01em; text-overflow:ellipsis; white-space:nowrap; }
.cx-sub { margin-top:1px; overflow:hidden; font-size:12px; color:${T.fg2}; text-overflow:ellipsis; white-space:nowrap; }
.cx-meta { display:flex; align-items:center; gap:10px; min-width:0; overflow:hidden; font-size:12px; color:${T.fg2}; white-space:nowrap; }
.cx-meta-err { min-width:0; overflow:hidden; color:${T.err}; text-overflow:ellipsis; }
.cx-linkbtn { display:inline-flex; align-items:center; gap:2px; padding:0; border:none; background:none; color:${T.fg2}; font:inherit; cursor:pointer; }
.cx-linkbtn:hover { color:${T.fg}; }
.cx-linkbtn:disabled { opacity:.5; cursor:default; }
.cx-mode.on { color:${T.ok}; }
.cx-foot { display:flex; align-items:center; gap:2px; min-width:0; margin:0 -6px; }

/* The one-line secret prompt, used on cards, in the quick-add sheet and in the chat tool card. */
.cx-secret { display:flex; flex:1; align-items:center; gap:6px; min-width:0; }
.cx-secret .cx-input { flex:1; height:32px; min-width:0; }
.cx-secret .cx-btn { height:32px; }

.cx-gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; }
.cx-add { display:flex; align-items:center; gap:11px; height:60px; padding:0 12px; border:none; border-radius:12px; background:transparent; box-shadow:inset 0 0 0 1px ${T.line}; color:inherit; font:inherit; text-align:left; cursor:pointer; transition:background .14s, box-shadow .14s; }
.cx-add:hover:not(:disabled) { background:${T.l1}; box-shadow:inset 0 0 0 1px ${T.line2}, 0 6px 18px -10px rgba(0,0,0,.16); }
.cx-add:disabled { cursor:default; }
.cx-add:disabled .ui-logo, .cx-add:disabled .cx-add-text { opacity:.45; }
.cx-add.chat { box-shadow:inset 0 0 0 1px ${T.line2}; background:repeating-linear-gradient(135deg, transparent 0 8px, ${mix(T.l2, 55)} 8px 9px); }
.cx-add-text { flex:1; min-width:0; overflow:hidden; }
.cx-add-name { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; }
.cx-add-desc { margin-top:1px; overflow:hidden; font-size:12px; color:${T.fg2}; text-overflow:ellipsis; white-space:nowrap; }
.cx-add-plus { flex:none; display:flex; color:${T.fg3}; transition:color .14s, transform .14s; }
.cx-add:hover:not(:disabled) .cx-add-plus { color:${T.fg}; transform:scale(1.1); }
.cx-added { display:inline-flex; color:${T.ok}; }

.cx-empty { display:flex; flex-direction:column; align-items:center; gap:4px; padding:36px 20px; border-radius:14px; box-shadow:inset 0 0 0 1px ${T.line}; color:${T.fg2}; text-align:center; }
.cx-empty b { color:${T.fg}; font-size:14px; }

.cx-modal.narrow { width:min(460px,100%); }
.cx-hintline { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; font-size:12.5px; line-height:1.55; color:${T.fg2}; }
.cx-hintline a { display:inline-flex; align-items:center; gap:3px; color:${T.fg}; font-weight:500; text-decoration:none; white-space:nowrap; }
.cx-hintline a:hover { text-decoration:underline; }
.cx-toolrows { display:flex; flex-direction:column; max-height:min(60vh,520px); overflow:auto; margin:0 -20px -20px; padding:0 20px 16px; }
.cx-toolrow { display:grid; grid-template-columns:minmax(150px,38%) 1fr; gap:14px; padding:8px 0; border-top:1px solid ${T.line}; font-size:12.5px; }
.cx-toolrow code { overflow:hidden; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
.cx-toolrow span { overflow:hidden; color:${T.fg2}; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; line-height:1.5; }

.cx-toolcard { display:flex; flex-direction:column; gap:10px; max-width:560px; margin:2px 0; padding:12px 14px; border-radius:12px; background:${T.l1}; box-shadow:0 0 0 1px ${T.line}; }
.cx-toolcard.attention { box-shadow:0 0 0 1px ${mix(T.warn, 50)}, 0 8px 22px -12px ${mix(T.warn, 35)}; }
.cx-toolcard-head { display:flex; align-items:center; gap:12px; min-width:0; }
.cx-toolcard-text { flex:1; min-width:0; }
.cx-toolcard-title { overflow:hidden; font-size:13.5px; font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
.cx-toolcard-sub { margin-top:1px; overflow:hidden; font-size:12px; color:${T.fg2}; text-overflow:ellipsis; white-space:nowrap; }
.cx-toolcard-sub.err { color:${T.err}; white-space:normal; }
`;
