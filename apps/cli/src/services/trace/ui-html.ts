/**
 * A self-contained, local-only review of captured coding sessions.
 * No CDN, analytics, remote font, or external asset is loaded by the page.
 */
export function renderTraceUiHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<link rel="icon" href="data:," />
<title>Kodus Trace</title>
<style>
/* Hallmark · macrostructure: Narrative Workflow · genre: modern-minimal · theme: Kodus product tokens · tone: technical-utilitarian · anchor hue: orange · nav: N9 edge-aligned · footer: none · enrichment: none · pre-emit critique: P5 H5 E5 S5 R5 V5 · contrast: pass (40–41) · slop: pass (42–49) · mobile: pass (34, 49, 50–57) */
:root {
  color-scheme: dark;
  --color-paper: #101019;
  --color-paper-raised: #181825;
  --color-paper-active: #202032;
  --color-paper-code: #181825;
  --color-rule: #30304b;
  --color-rule-strong: #3d3d5c;
  --color-ink: #f3f3f7;
  --color-ink-secondary: #cdcddf;
  --color-ink-muted: rgba(243, 243, 247, 0.5);
  --color-accent: #f8b76d;
  --color-accent-hover: #ffca8a;
  --color-accent-soft: rgba(248, 183, 109, 0.1);
  --color-accent-ink: #1a0f04;
  --color-secondary: #c9bbf2;
  --color-warning: #f2c631;
  --color-danger: #fa5867;
  --color-success: #42be65;
  --color-focus: #f8b76d;
  --color-logo-orange: hsl(32 91.4% 54.3%);
  --color-logo-red: hsl(0 83.7% 61.6%);
  --color-logo-violet: hsl(255 30.7% 49.2%);
  --font-display: "DM Sans", sans-serif;
  --font-body: "DM Sans", sans-serif;
  --font-mono: "Overpass Mono", monospace;
  --space-3xs: 0.125rem;
  --space-2xs: 0.25rem;
  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;
  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --dur-micro: 120ms;
  --dur-short: 220ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --z-sticky: 200;
}
* { box-sizing: border-box; }
html, body { min-height: 100%; overflow-x: clip; background: var(--color-paper); }
body {
  margin: 0;
  min-width: 0;
  min-height: 100dvh;
  color: var(--color-ink);
  font: 0.9375rem/1.6 var(--font-body);
  -webkit-font-smoothing: antialiased;
}
button { color: inherit; font: inherit; }
button, [href], summary { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 0.125rem solid var(--color-focus); outline-offset: 0.125rem; }
.mono, time, .stat-value { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.app-header {
  min-height: 3.75rem;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  border-bottom: 1px solid var(--color-rule);
  padding-inline: var(--space-md);
  background: var(--color-paper-raised);
  color: var(--color-ink);
}
.brand { min-width: 2.75rem; min-height: 2.75rem; display: grid; place-items: center; border-radius: var(--radius-sm); text-decoration: none; }
.brand-mark { width: 1.75rem; height: 1.75rem; display: block; }
.brand-divider { width: 1px; height: 1.25rem; background: var(--color-rule); }
.product-name { font-family: var(--font-display); font-weight: 700; letter-spacing: -0.025em; white-space: nowrap; }
.product-context { margin-inline-start: auto; color: var(--color-ink-muted); font-size: 0.75rem; white-space: nowrap; }
.review-shell { min-height: calc(100dvh - 3.75rem); }
.session-rail { border-bottom: 1px solid var(--color-rule); background: var(--color-paper-raised); color: var(--color-ink); }
.rail-header { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-md); padding: var(--space-lg) var(--space-md) var(--space-sm); }
.rail-header h1 { margin: 0; font: 700 0.875rem/1.3 var(--font-display); }
.rail-count { color: var(--color-ink-muted); font-size: 0.6875rem; }
.session-list { margin: 0; padding: 0 0 var(--space-sm); list-style: none; display: flex; overflow-x: auto; scrollbar-color: var(--color-rule-strong) transparent; }
.session-item { min-width: min(84vw, 18rem); }
.session-button {
  position: relative;
  width: 100%;
  min-height: 5.25rem;
  border: 0;
  border-inline-end: 1px solid var(--color-rule);
  background: transparent;
  padding: var(--space-sm) var(--space-md);
  text-align: start;
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out);
}
.session-button::after { content: ""; position: absolute; inset: auto var(--space-md) 0; height: 0.125rem; background: transparent; }
.session-button[aria-current="true"] { background: var(--color-paper-active); color: var(--color-ink); }
.session-button[aria-current="true"]::after { background: var(--color-accent); }
.session-branch { display: block; overflow: hidden; color: var(--color-ink); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.session-meta { display: flex; gap: var(--space-xs); margin-top: var(--space-2xs); color: var(--color-ink-muted); font-size: 0.6875rem; white-space: nowrap; }
.session-files { display: block; margin-top: var(--space-2xs); overflow: hidden; color: var(--color-ink-muted); font: 0.6875rem/1.4 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.review { min-width: 0; }
.review-document { width: min(100%, 72rem); margin-inline: auto; padding: var(--space-lg) var(--space-md) var(--space-3xl); }
.back-button { min-height: 2.75rem; border: 0; background: transparent; padding: 0; color: var(--color-ink-muted); font-size: 0.75rem; font-weight: 650; white-space: nowrap; cursor: pointer; }
.session-overview { border-radius: var(--radius-md); background: var(--color-paper-raised); padding: var(--space-lg); color: var(--color-ink); }
.session-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-lg); }
.session-title { min-width: 0; margin: 0; color: var(--color-ink); font: 700 clamp(1.65rem, 5vw, 2.5rem)/1.12 var(--font-display); letter-spacing: -0.045em; overflow-wrap: anywhere; }
.session-subtitle { margin: var(--space-xs) 0 0; color: var(--color-ink-muted); font-size: 0.8125rem; }
.session-state { flex: none; border: 1px solid var(--color-rule-strong); border-radius: 999px; padding: var(--space-2xs) var(--space-sm); color: var(--color-ink-secondary); font-size: 0.6875rem; white-space: nowrap; }
.stat-line { display: flex; flex-wrap: wrap; gap: var(--space-lg); margin-top: var(--space-md); }
.stat { min-width: 3.5rem; }
.stat-value { display: block; color: var(--color-ink-secondary); font-size: 0.8125rem; }
.stat-label { display: block; color: var(--color-ink-muted); font-size: 0.6875rem; }
.notice { margin: var(--space-lg) 0 0; border: 1px solid var(--color-rule-strong); background: var(--color-paper-active); padding: var(--space-sm) var(--space-md); color: var(--color-ink-secondary); font-size: 0.75rem; }
.review-heading { margin: var(--space-xl) 0 var(--space-md); font: 700 1.125rem/1.3 var(--font-display); letter-spacing: -0.02em; }
.turn { position: relative; border-radius: var(--radius-md); background: var(--color-paper-raised); padding: var(--space-lg); color: var(--color-ink); }
.turn + .turn { margin-top: var(--space-md); }
.turn-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-md); margin-bottom: var(--space-lg); }
.turn-number { color: var(--color-accent); font: 650 0.6875rem/1 var(--font-mono); }
.turn-head time { color: var(--color-ink-muted); font-size: 0.6875rem; white-space: nowrap; }
.turn-section + .turn-section { margin-top: var(--space-xl); }
.turn-label { margin: 0 0 var(--space-sm); color: var(--color-ink-muted); font-size: 0.6875rem; font-weight: 700; }
.prompt { max-width: 54rem; color: var(--color-ink-secondary); }
.response { max-width: 58rem; color: var(--color-ink-secondary); }
.markdown { min-width: 0; overflow-wrap: anywhere; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown p { margin: 0 0 var(--space-md); }
.markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: var(--space-lg) 0 var(--space-xs); color: var(--color-ink); font: 700 1rem/1.4 var(--font-display); font-style: normal; }
.markdown ul, .markdown ol { margin: 0 0 var(--space-md); padding-inline-start: var(--space-lg); }
.markdown li + li { margin-top: var(--space-2xs); }
.markdown strong { color: var(--color-ink); font-weight: 750; }
.markdown em { color: var(--color-ink-secondary); }
.markdown code { border: 1px solid var(--color-rule); border-radius: var(--radius-sm); background: var(--color-paper-code); padding: 0 var(--space-2xs); color: var(--color-accent); font: 0.8125rem/1.5 var(--font-mono); }
.markdown pre { margin: 0 0 var(--space-md); border-block: 1px solid var(--color-rule); background: var(--color-paper-code); padding: var(--space-md); overflow-x: auto; white-space: pre; }
.markdown pre code { border: 0; background: transparent; padding: 0; color: var(--color-ink-secondary); }
.markdown blockquote { margin: 0 0 var(--space-md); border-inline-start: 1px solid var(--color-accent); padding-inline-start: var(--space-md); color: var(--color-ink-muted); }
.activity-summary { min-height: 2.75rem; display: flex; align-items: center; gap: var(--space-xs); color: var(--color-ink-secondary); font-size: 0.75rem; font-weight: 650; cursor: pointer; list-style: none; white-space: nowrap; }
.activity-summary::-webkit-details-marker { display: none; }
.activity-summary::before { content: "+"; width: 1rem; color: var(--color-accent); font: 1rem/1 var(--font-mono); }
.activity[open] .activity-summary::before { content: "−"; }
.activity-counts { color: var(--color-ink-muted); font-weight: 500; }
.activity-groups { margin-top: var(--space-sm); }
.activity-group { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: var(--space-md); padding: var(--space-sm) 0; }
.activity-group + .activity-group { border-top: 1px solid var(--color-rule); }
.activity-group-title { color: var(--color-ink-muted); font: 0.6875rem/1.6 var(--font-mono); }
.activity-list { min-width: 0; margin: 0; padding: 0; list-style: none; color: var(--color-ink-secondary); font: 0.75rem/1.6 var(--font-mono); }
.activity-list li { overflow-wrap: anywhere; }
.activity-list li + li { margin-top: var(--space-xs); }
.decision-section { margin-top: var(--space-xl); }
.section-intro { max-width: 48rem; margin: var(--space-xs) 0 var(--space-xl); color: var(--color-ink-muted); }
.decision-list { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--space-sm); }
.decision { border-radius: var(--radius-md); background: var(--color-paper-raised); padding: var(--space-lg); color: var(--color-ink); }
.decision-title { margin: 0; color: var(--color-ink); font: 650 1rem/1.5 var(--font-display); }
.decision-rationale { max-width: 52rem; margin: var(--space-xs) 0 0; color: var(--color-ink-secondary); }
.decision-meta { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-sm); margin-top: var(--space-sm); color: var(--color-ink-muted); font-size: 0.6875rem; }
.scope { border: 1px solid var(--color-rule); border-radius: var(--radius-sm); padding: 0 var(--space-xs); color: var(--color-secondary); font-family: var(--font-mono); }
.technical { margin-top: var(--space-xl); border-radius: var(--radius-md); background: var(--color-paper-raised); padding-inline: var(--space-md); color: var(--color-ink); }
.technical summary { min-height: 3.5rem; display: flex; align-items: center; gap: var(--space-xs); color: var(--color-ink-muted); font-size: 0.75rem; font-weight: 650; cursor: pointer; list-style: none; white-space: nowrap; }
.technical summary::-webkit-details-marker { display: none; }
.technical summary::before { content: "+"; color: var(--color-accent); font-family: var(--font-mono); }
.technical[open] summary::before { content: "−"; }
.technical-grid { margin: 0 0 var(--space-xl); display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: var(--space-xs) var(--space-md); }
.technical-grid dt { color: var(--color-ink-muted); font-size: 0.6875rem; }
.technical-grid dd { min-width: 0; margin: 0; color: var(--color-ink-secondary); font: 0.6875rem/1.6 var(--font-mono); overflow-wrap: anywhere; }
.empty-state { min-height: 22rem; display: grid; place-items: center; padding: var(--space-xl); text-align: center; }
.empty-state > div { max-width: 34rem; }
.empty-symbol { margin-bottom: var(--space-md); color: var(--color-accent); font: 1.25rem/1 var(--font-mono); }
.empty-state h2 { margin: 0 0 var(--space-xs); font: 700 1rem/1.4 var(--font-display); }
.empty-state p { margin: 0; color: var(--color-ink-muted); font-size: 0.8125rem; }
.empty-state code { color: var(--color-accent); font-family: var(--font-mono); }
.loading-line { width: 8rem; height: 0.1875rem; overflow: hidden; background: var(--color-rule); }
.loading-line::after { content: ""; display: block; width: 40%; height: 100%; background: var(--color-accent); animation: loading 1.1s var(--ease-out) infinite alternate; }
@keyframes loading { to { transform: translateX(150%); } }
@media (hover: hover) and (pointer: fine) {
  .brand:hover, .session-button:hover { background: var(--color-paper-active); }
  .back-button:hover, .activity-summary:hover, .technical summary:hover { color: var(--color-ink); }
}
.session-button:active, .back-button:active, summary:active { transform: translateY(1px); }
.session-button:disabled, .back-button:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
.activity-summary[aria-disabled="true"], .technical summary[aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; transform: none; }
.session-button[data-state="loading"], .back-button[data-state="loading"] { cursor: wait; }
.activity-summary[data-state="loading"], .technical summary[data-state="loading"] { cursor: wait; }
.session-button[data-state="error"], .back-button[data-state="error"] { color: var(--color-danger); }
.activity-summary[data-state="error"], .technical summary[data-state="error"] { color: var(--color-danger); }
.session-button[data-state="success"], .back-button[data-state="success"] { color: var(--color-success); }
.activity-summary[data-state="success"], .technical summary[data-state="success"] { color: var(--color-success); }
@media (min-width: 60rem) {
  .review-shell { display: grid; grid-template-columns: 17rem minmax(0, 1fr); }
  .session-rail { position: sticky; top: 0; z-index: var(--z-sticky); height: calc(100dvh - 3.75rem); border-inline-end: 1px solid var(--color-rule); border-bottom: 0; overflow-y: auto; scrollbar-color: var(--color-rule-strong) transparent; }
  .rail-header { position: sticky; top: 0; z-index: var(--z-sticky); background: var(--color-paper-raised); }
  .session-list { display: block; overflow-x: visible; }
  .session-item { min-width: 0; }
  .session-button { border-inline-end: 0; border-bottom: 1px solid var(--color-rule); }
  .session-button::after { inset: 0 auto 0 0; width: 0.1875rem; height: auto; }
  .review-document { padding-inline: clamp(var(--space-xl), 6vw, var(--space-3xl)); }
  .back-button { display: none; }
}
@media (max-width: 59.999rem) {
  .review-shell[data-mobile-view="review"] .session-rail { display: none; }
  .review-shell[data-mobile-view="sessions"] .review { display: none; }
  .back-button { display: inline-flex; align-items: center; margin-bottom: var(--space-md); }
}
@media (max-width: 26rem) {
  .product-context { display: none; }
  .session-title-row { display: block; }
  .session-state { display: inline-block; margin-top: var(--space-sm); }
  .activity-group { grid-template-columns: 1fr; gap: var(--space-2xs); }
  .technical-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
</style>
</head>
<body>
<header class="app-header">
  <a class="brand" href="#/" aria-label="Kodus Trace home">
    <svg class="brand-mark" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path d="M10.92 16.42 15.08 11.42 16.59 9.59c.01 0 1.57-1.86 3.46-4.13 1.89-2.28 3.54-4.25 3.68-4.39a4.45 4.45 0 0 1 2.83-1.01c1.36.15 2.43 1.01 2.82 2.28.18.57.2 1.24.04 1.83-.15.58-.5 1.19-1.15 1.95-.25.3-7.31 8.79-7.39 8.89-.05.07-.05.07.24.4.15.19 1.27 1.5 2.48 2.94 5.72 6.77 5.27 6.22 5.5 6.67.6 1.14.55 2.45-.13 3.47a3.8 3.8 0 0 1-.88.89c-.6.41-1.19.6-1.9.6-.88 0-1.58-.28-2.3-.91-.26-.24-.9-.95-1.07-1.19-.33-.49-.21-1.19.26-1.55.39-.3.96-.32 1.36-.04.07.05.29.28.49.5.2.23.42.48.5.55.48.42 1.04.43 1.46.02.38-.36.42-.89.1-1.36-.11-.17-1.97-2.38-5.92-7.05-1.02-1.2-2.06-2.43-2.31-2.73-.54-.62-.6-.74-.61-1.11 0-.27.07-.49.2-.68.09-.12 7.47-9.01 8.14-9.8.58-.69.73-.98.71-1.37-.02-.35-.2-.63-.5-.79-.11-.06-.17-.07-.48-.07-.34 0-.37.01-.56.1-.11.06-.25.16-.31.22-.06.07-.83.99-1.72 2.06-5.31 6.4-16.77 20.14-16.93 20.3-.23.24-.41.36-.63.42-.48.14-1.05-.04-1.34-.43-.15-.2-.23-.43-.28-.75-.02-.16-.03-3.38-.02-9.5.01-8.89.01-9.26.06-9.43.18-.52.6-.83 1.12-.83.28 0 .49.07.8.28.45.3.66.53 2.44 2.63 1.98 2.34 3.02 3.61 3.1 3.78.06.14.07.22.07.45 0 .25-.01.3-.1.48-.12.26-.31.45-.57.57-.18.09-.23.1-.48.1-.24 0-.3-.02-.46-.09-.1-.05-.22-.12-.27-.16-.05-.04-.63-.72-1.29-1.51-.66-.79-1.4-1.68-1.65-1.97l-.45-.53-.01 3.2v6.42l4.16-4.99Z" fill="url(#logo-a)"/>
      <path d="M.24 4.23C.83 1.9 2.64.31 5.04.04a6.2 6.2 0 0 1 4.31 1.34c.3.26 4.33 4.83 6.56 7.43.36.43.66.78.67.78l-1.5 1.84-.12-.15c-.5-.61-3-3.48-6.47-7.44-.63-.72-.9-.95-1.36-1.18-1.32-.65-3.07-.31-3.96.77-.49.59-.73 1.24-.8 2.15-.05.71-.05 18.73 0 19.05.08.45.2.83.36 1.18.52 1.07 1.39 1.7 2.54 1.84 1.02.13 1.9-.18 2.76-.96.22-.21 1.23-1.38 2.97-3.47.74-.87 1.41-1.67 1.51-1.76.59-.59 1.59-.36 1.88.43.1.25.09.64-.03.96-.05.11-.47.64-1.3 1.62-1.45 1.73-2.64 3.13-3.02 3.56-1.32 1.47-3.11 2.21-4.9 2.02a7.17 7.17 0 0 1-2.45-.81 6.65 6.65 0 0 1-2.01-2.24 6.31 6.31 0 0 1-.66-2.65C-.01 23.61-.01 12.9.03 8.47c.02-3.51.02-3.49.21-4.24Z" fill="url(#logo-b)"/>
      <defs><linearGradient id="logo-a" x1="29.5" y1="15" x2="4.4" y2="15.2" gradientUnits="userSpaceOnUse"><stop stop-color="var(--color-logo-orange)"/><stop offset=".48" stop-color="var(--color-logo-red)"/><stop offset=".69" stop-color="var(--color-logo-violet)"/><stop offset="1" stop-color="var(--color-logo-red)"/></linearGradient><linearGradient id="logo-b" x1="16.6" y1="15" x2="0" y2="15" gradientUnits="userSpaceOnUse"><stop stop-color="var(--color-logo-orange)"/><stop offset=".48" stop-color="var(--color-logo-red)"/><stop offset=".65" stop-color="var(--color-logo-violet)"/><stop offset="1" stop-color="var(--color-logo-red)"/></linearGradient></defs>
    </svg>
  </a>
  <span class="brand-divider" aria-hidden="true"></span>
  <span class="product-name">Kodus Trace</span>
  <span class="product-context">Session review</span>
</header>
<main class="review-shell" id="app" data-mobile-view="sessions" aria-live="polite">
  <aside class="session-rail" data-region="sessions"><div class="empty-state"><div><div class="loading-line" aria-label="Loading sessions"></div></div></div></aside>
  <section class="review" data-region="review"><div class="empty-state"><div><h2>Select a session</h2><p>Review what you asked, what the agent did, and what Trace learned.</p></div></div></section>
</main>
<script>
const app = document.getElementById('app');
let sessions = [];
let selectedSessionId = '';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function fmtDate(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtShortDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function agentName(value) { return ({ 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex' })[value] || value || 'Unknown agent'; }
function titleCase(value) { return String(value || 'other').replaceAll('_', ' ').replace(/\\b\\w/g, (letter) => letter.toUpperCase()); }
function compactNumber(value) { return new Intl.NumberFormat([], { notation: 'compact' }).format(Number(value) || 0); }
function inlineMarkdown(value) {
  const code = [];
  let text = esc(value).replace(/\x60([^\x60\\n]+)\x60/g, (_match, content) => {
    const index = code.push(content) - 1;
    return '@@KODUSINLINECODE' + index + '@@';
  });
  text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>').replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>').replace(/(^|[^_])_([^_\\n]+)_(?!_)/g, '$1<em>$2</em>');
  return text.replace(/@@KODUSINLINECODE(\\d+)@@/g, (_match, index) => '<code>' + code[Number(index)] + '</code>');
}
function renderMarkdown(value) {
  const lines = String(value || '').replace(/\\r\\n?/g, '\\n').split('\\n');
  const output = [];
  let paragraph = [];
  let listType = '';
  let listItems = [];
  let codeLines = [];
  let inCode = false;
  const flushParagraph = () => { if (paragraph.length) output.push('<p>' + inlineMarkdown(paragraph.join(' ')) + '</p>'); paragraph = []; };
  const flushList = () => { if (listItems.length) output.push('<' + listType + '>' + listItems.map((item) => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</' + listType + '>'); listType = ''; listItems = []; };
  for (const line of lines) {
    if (/^\x60{3}/.test(line)) {
      flushParagraph(); flushList();
      if (inCode) { output.push('<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>'); codeLines = []; }
      inCode = !inCode; continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    const heading = line.match(/^(#{1,4})\\s+(.+)$/);
    const unordered = line.match(/^[-*]\\s+(.+)$/);
    const ordered = line.match(/^\\d+[.)]\\s+(.+)$/);
    const quote = line.match(/^>\\s?(.+)$/);
    if (!line.trim()) { flushParagraph(); flushList(); }
    else if (heading) { flushParagraph(); flushList(); const level = heading[1].length; output.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>'); }
    else if (unordered || ordered) { flushParagraph(); const nextType = unordered ? 'ul' : 'ol'; if (listType && listType !== nextType) flushList(); listType = nextType; listItems.push((unordered || ordered)[1]); }
    else if (quote) { flushParagraph(); flushList(); output.push('<blockquote>' + inlineMarkdown(quote[1]) + '</blockquote>'); }
    else { flushList(); paragraph.push(line.trim()); }
  }
  if (inCode) output.push('<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>');
  flushParagraph(); flushList(); return output.join('');
}
async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Local request failed with status ' + response.status);
  return response.json();
}
function region(name) { return app.querySelector('[data-region="' + name + '"]'); }
function empty(title, copy, symbol) {
  return '<div class="empty-state"><div><div class="empty-symbol" aria-hidden="true">' + esc(symbol || '⌁') + '</div><h2>' + esc(title) + '</h2><p>' + copy + '</p></div></div>';
}
function showMobile(view) { app.dataset.mobileView = view; }
function renderSessions() {
  const rail = region('sessions');
  if (!sessions.length) {
    rail.innerHTML = '<header class="rail-header"><h1>Sessions</h1><span class="rail-count mono">0</span></header>' + empty('No sessions captured', 'Run <code>kodus trace enable</code>, then use your coding agent in this repository.', '&gt;_');
    return;
  }
  rail.innerHTML = '<header class="rail-header"><h1>Sessions</h1><span class="rail-count mono">' + sessions.length + '</span></header><ul class="session-list">' + sessions.map((session) => '<li class="session-item"><button class="session-button" type="button" data-session-id="' + esc(session.sessionId) + '" aria-current="' + String(session.sessionId === selectedSessionId) + '"><span class="session-branch">' + esc(session.branch || 'Unknown branch') + '</span><span class="session-meta"><span>' + esc(agentName(session.agentType)) + '</span><span>·</span><time>' + fmtShortDate(session.startedAt || session.updatedAt) + '</time><span>·</span><span>' + (Number(session.turnCount) || 0) + ' turn' + (Number(session.turnCount) === 1 ? '' : 's') + '</span></span><span class="session-files">' + (esc((session.filesTouched || []).slice(0, 3).join(', ')) || 'No files changed') + '</span></button></li>').join('') + '</ul>';
  rail.querySelectorAll('[data-session-id]').forEach((button) => button.addEventListener('click', () => selectSession(button.dataset.sessionId)));
}
function activityGroup(title, items) {
  if (!items.length) return '';
  return '<div class="activity-group"><div class="activity-group-title">' + esc(title) + '</div><ul class="activity-list">' + items.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></div>';
}
function renderTurn(turn, index) {
  const tools = (turn.toolCalls || []).map((call) => (call.toolName || 'Tool') + (call.summary || call.fileAffected ? ' · ' + (call.summary || call.fileAffected) : ''));
  const commands = turn.commands || [];
  const files = [...(turn.filesModified || []).map((file) => titleCase(file.action || 'Modified') + ' · ' + file.path), ...(turn.filesRead || []).map((file) => 'Read · ' + file)];
  const countParts = [];
  if (tools.length) countParts.push(tools.length + ' tool' + (tools.length === 1 ? '' : 's'));
  if (commands.length) countParts.push(commands.length + ' command' + (commands.length === 1 ? '' : 's'));
  if (files.length) countParts.push(files.length + ' file event' + (files.length === 1 ? '' : 's'));
  const activity = countParts.length ? '<section class="turn-section"><details class="activity"><summary class="activity-summary">Agent activity <span class="activity-counts">' + esc(countParts.join(' · ')) + '</span></summary><div class="activity-groups">' + activityGroup('Tools', tools) + activityGroup('Commands', commands) + activityGroup('Files', files) + '</div></details></section>' : '';
  return '<article class="turn"><header class="turn-head"><span class="turn-number">Turn ' + (index + 1) + '</span><time>' + fmtDate(turn.startedAt || turn.endedAt) + '</time></header>' +
    (turn.prompt ? '<section class="turn-section"><h3 class="turn-label">You asked</h3><div class="prompt markdown">' + renderMarkdown(turn.prompt) + '</div></section>' : '') + activity +
    (turn.response ? '<section class="turn-section"><h3 class="turn-label">Agent response</h3><div class="response markdown">' + renderMarkdown(turn.response) + '</div></section>' : '') + '</article>';
}
function renderDecisions(decisions) {
  if (!decisions.length) return '<section class="decision-section"><h2 class="review-heading">What Trace learned</h2><p class="section-intro">No durable decision was extracted from this session.</p></section>';
  return '<section class="decision-section"><h2 class="review-heading">What Trace learned</h2><p class="section-intro">These are the durable decisions Trace associated with this session. They can be recalled later from the CLI and used when reviewing related code.</p><ul class="decision-list">' + decisions.map((decision) => '<li class="decision"><h3 class="decision-title">' + esc(decision.decision) + '</h3>' + (decision.rationale ? '<p class="decision-rationale">' + esc(decision.rationale) + '</p>' : '') + '<div class="decision-meta"><span>' + esc(titleCase(decision.type)) + '</span>' + (decision.scope || []).map((scope) => '<span class="scope">' + esc(scope) + '</span>').join('') + '</div></li>').join('') + '</ul></section>';
}
function renderReview(session, decisions) {
  const review = region('review');
  const turns = session.turns || [];
  const tools = turns.reduce((total, turn) => total + (turn.toolCalls || []).length, 0);
  const commands = turns.reduce((total, turn) => total + (turn.commands || []).length, 0);
  const files = new Set(turns.flatMap((turn) => [...(turn.filesModified || []).map((file) => file.path), ...(turn.filesRead || [])]));
  const tokens = turns.reduce((total, turn) => total + Number(turn.tokenUsage?.inputTokens || 0) + Number(turn.tokenUsage?.outputTokens || 0), 0);
  const notice = Number(session.corruptLines) > 0 ? '<p class="notice">' + Number(session.corruptLines) + ' unreadable line' + (Number(session.corruptLines) === 1 ? ' was' : 's were') + ' skipped. Everything recoverable is shown.</p>' : '';
  const state = session.endedAt ? 'Completed' : 'In progress';
  review.innerHTML = '<div class="review-document"><button class="back-button" type="button" data-back>← Sessions</button><header class="session-overview"><div class="session-title-row"><div><h1 class="session-title">' + esc(session.branch || 'Unknown branch') + '</h1><p class="session-subtitle">' + esc(agentName(session.agentType)) + ' · ' + fmtDate(session.startedAt) + '</p></div><span class="session-state">' + state + '</span></div><div class="stat-line" aria-label="Session summary"><span class="stat"><span class="stat-value">' + turns.length + '</span><span class="stat-label">turns</span></span><span class="stat"><span class="stat-value">' + tools + '</span><span class="stat-label">tools</span></span><span class="stat"><span class="stat-value">' + commands + '</span><span class="stat-label">commands</span></span><span class="stat"><span class="stat-value">' + files.size + '</span><span class="stat-label">files</span></span></div>' + notice + '</header><section><h2 class="review-heading">What happened</h2>' + (turns.length ? turns.map(renderTurn).join('') : empty('No completed turns', 'This session ended before a complete turn was recorded.', '0')) + '</section>' + renderDecisions(decisions) + '<details class="technical"><summary>Technical details</summary><dl class="technical-grid"><dt>Session ID</dt><dd>' + esc(session.sessionId) + '</dd><dt>Base commit</dt><dd>' + esc(session.baseCommit || 'Not captured') + '</dd><dt>CLI version</dt><dd>' + esc(session.cliVersion || 'Not captured') + '</dd><dt>Tokens</dt><dd>' + compactNumber(tokens) + '</dd><dt>Finished</dt><dd>' + fmtDate(session.endedAt) + '</dd></dl></details></div>';
  review.querySelector('[data-back]')?.addEventListener('click', () => { showMobile('sessions'); history.replaceState(null, '', '#/'); });
}
async function selectSession(sessionId) {
  if (!sessionId) return;
  selectedSessionId = sessionId;
  renderSessions();
  showMobile('review');
  region('review').innerHTML = empty('Loading session', 'Reading the captured session record.', '···');
  history.replaceState(null, '', '#/session/' + encodeURIComponent(sessionId));
  try {
    const data = await getJson('/api/sessions/' + encodeURIComponent(sessionId));
    if (!data.session) { region('review').innerHTML = empty('Session not found', 'This record is no longer available.', '404'); return; }
    renderReview(data.session, data.decisions || []);
  } catch (error) {
    region('review').innerHTML = empty('Could not load session', esc(error instanceof Error ? error.message : 'Unknown error'), '!');
  }
}
async function boot() {
  try {
    const data = await getJson('/api/sessions');
    sessions = data.sessions || [];
    const hashMatch = location.hash.match(/^#\\/session\\/(.+)$/);
    selectedSessionId = hashMatch ? decodeURIComponent(hashMatch[1]) : sessions[0]?.sessionId || '';
    renderSessions();
    if (selectedSessionId) await selectSession(selectedSessionId);
    else { showMobile('sessions'); region('review').innerHTML = empty('No session selected', 'Capture a session to review what you and the agent did.', '⌁'); }
  } catch (error) {
    region('sessions').innerHTML = '<header class="rail-header"><h1>Sessions</h1></header>' + empty('Could not load Trace', esc(error instanceof Error ? error.message : 'Unknown error'), '!');
  }
}
window.addEventListener('hashchange', () => {
  const match = location.hash.match(/^#\\/session\\/(.+)$/);
  if (match && decodeURIComponent(match[1]) !== selectedSessionId) void selectSession(decodeURIComponent(match[1]));
  if (!match) showMobile('sessions');
});
boot();
</script>
</body>
</html>`;
}
