import { randomBytes } from 'crypto';
import type { ServerResponse } from 'http';

import { PREVIEW_SESSION_PATH, previewEdgePageHeaders, type PreviewSide } from '@libs/runtime/contracts/preview';

// The edge's own pages on a preview host (§8.5). Plain HTML, no third-party
// resource, one inline script by nonce (the starting page's poll). A viewer
// outside the org and a wrong host get the same 404 page: nothing says
// whether the preview exists.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, script?: string): { html: string; nonce: string } {
    const nonce = randomBytes(16).toString('base64');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 16px;background:#101114;color:#e8e8ea}main{max-width:560px;margin:0 auto}h1{font-size:20px;font-weight:600}p{line-height:1.5;color:#b8b8bf}a{color:#8ab4ff}button{font:inherit;padding:8px 16px;border-radius:6px;border:0;background:#8ab4ff;color:#101114;cursor:pointer}</style>
</head><body><main><h1>${esc(title)}</h1>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
    return { html, nonce };
}

export function sendPage(res: ServerResponse, status: number, title: string, body: string, extra: Record<string, string> = {}, script?: string) {
    if (res.headersSent) return res.destroy();
    const { html, nonce } = page(title, body, script);
    res.writeHead(status, { ...previewEdgePageHeaders(nonce), 'content-type': 'text/html; charset=utf-8', ...extra });
    res.end(html);
}

export const notFoundPage = (res: ServerResponse) =>
    sendPage(res, 404, 'Preview not available', '<p>You don’t have access to this preview, or it does not exist. Ask an owner of the organization for access to the repository.</p>');

/** Starting or waking: polls /__kodus/status and reloads into the app when it is ready. */
export const startingPage = (res: ServerResponse, what: string) =>
    sendPage(
        res,
        503,
        'Starting the preview…',
        `<p>${esc(what)} This takes about as long as the Run’s boot. The page reloads when it is ready.</p><p>Previews stop after 15 minutes without use.</p>`,
        { 'retry-after': '5' },
        // The poll ignores a status fetch that fails: the next one runs 3 s later.
        `(function(){var t=setInterval(function(){fetch('/__kodus/status',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(s){if(s.state==='ready'){clearInterval(t);location.reload()}else if(s.state!=='starting'&&s.state!=='sleeping'){clearInterval(t);location.reload()}}).catch(function(){})},3000)})();`,
    );

export const endedPage = (res: ServerResponse, appLink?: string) =>
    sendPage(res, 410, 'This preview has ended', `<p>It was stopped, or it is older than its Run allows.${appLink ? ` <a href="${esc(appLink)}" rel="noopener noreferrer">Open it again from Kodus</a>.` : ''}</p>`);

export const reopenPage = (res: ServerResponse, appLink: string) =>
    sendPage(res, 409, 'Open this preview again from Kodus', `<p>The preview slept long enough that it must be opened again from its Run. <a href="${esc(appLink)}" rel="noopener noreferrer">Open it from Kodus</a>.</p>`);

export const blockedPage = (res: ServerResponse, reason: string) =>
    sendPage(res, 503, 'The preview could not start', `<p>${esc(reason)}</p><p>Reload to try again.</p>`, { 'retry-after': '30' });

/**
 * The prompt before a session opens (#4 of the 2026-11-14 review, §6.5's
 * interstitial): it names what the preview is, and only its button, a POST
 * from this same host, opens the session. A cross-site redirect to the grant
 * URL lands here and sets nothing.
 */
export function confirmPage(res: ServerResponse, v: { repository: string; prNumber?: number; side: PreviewSide; environment: boolean; grant: string; to: string }) {
    if (res.headersSent) return res.destroy();
    const what = v.environment
        ? `the environment of <strong>${esc(v.repository)}</strong>`
        : `<strong>${esc(v.repository)}</strong>${v.prNumber ? ` pull request <strong>#${v.prNumber}</strong>` : ''} (${v.side === 'pr' ? 'the PR version' : 'the base'})`;
    const { html, nonce } = page(
        'Open this preview?',
        `<p>You are opening a preview of unreviewed code from ${what}, hosted by Kodus for its review. Kodus did not write this page, and it may ask for nothing you would not give the owners of that repository.</p>` +
            `<p>Continue only if you opened this preview from Kodus yourself.</p>` +
            `<form method="post" action="${PREVIEW_SESSION_PATH}"><input type="hidden" name="grant" value="${esc(v.grant)}"><input type="hidden" name="to" value="${esc(v.to)}"><button type="submit">Continue to the preview</button></form>`,
    );
    res.writeHead(200, { ...previewEdgePageHeaders(nonce, { form: true }), 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
}
