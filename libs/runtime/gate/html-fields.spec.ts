import { assetShape, HTML_MARKUP_FIELD, HTML_TEXT_FIELD, HTML_TEXT_MAX_CHARS, htmlFields, htmlShape, isHtmlResponse } from './html-fields';

// An HTML page compared by what a reader sees (its visible text) and by the
// shape of its markup, with what differs per build or per request set aside
// (planner-eval.md, option C, measured on the recorded kr-* pages).

/** A page shaped like demo-nextjs under `next dev`: chunk scripts, flight data in inline scripts, a per-request id. */
function nextPage(opts: { features?: string[]; chunks?: string[]; flight?: number; requestId?: string; className?: string; nonce?: string } = {}): string {
    const features = opts.features ?? ['Multi-stage Docker build for optimal image size', 'Production-ready configuration', 'Security best practices (non-root user)'];
    const chunks = opts.chunks ?? ['app_layout_tsx_0541e2aa._.js', 'app_page_tsx_d4005f96._.js', '62cdd_next_dist_client_components_builtin_global-error_0541e2aa.js'];
    const flight = Array.from({ length: opts.flight ?? 3 }, (_, i) => `<script>self.__next_f.push([1,"chunk ${i} of the flight data"])</script>`).join('');
    return [
        '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>',
        '<link rel="stylesheet" href="/_next/static/chunks/%5Broot-of-the-server%5D__28bc9c2a._.css" data-precedence="next_static/chunks/[root-of-the-server]__28bc9c2a._.css"/>',
        ...chunks.map((c) => `<script src="/_next/static/chunks/${c}" async=""${opts.nonce ? ` nonce="${opts.nonce}"` : ''}></script>`),
        '<title>Next.js Docker Example</title></head>',
        `<body class="geist_a71539c9-module__T19VSG__variable"><main><h1 id="main-heading">Next.js &amp; Docker</h1>`,
        `<ul class="${opts.className ?? 'list-disc list-inside'}">${features.map((f) => `<li>${f}</li>`).join('')}</ul>`,
        '<p>Count: <!-- -->4</p></main>',
        `<script>self.__next_r="${opts.requestId ?? '109JB9rHd-gi_bAJVaYEW'}"</script>`,
        flight,
        '</body></html>',
    ].join('');
}

describe('htmlShape: the visible text', () => {
    it('is one line per block, entities decoded, without script, style, template or noscript content or comments', () => {
        const page =
            '<html><head><title>Shop</title><style>p{color:red}</style></head><body>' +
            '<h1>Cart &amp; checkout</h1><p>Total:   <b>3</b>\n items</p><template><p>hidden</p></template>' +
            '<noscript>enable JS</noscript><script>var x = "<p>not text</p>"</script><p>a<!-- -->b</p></body></html>';
        expect(htmlShape(page).text).toBe(['Shop', 'Cart & checkout', 'Total: 3 items', 'ab'].join('\n'));
    });

    it('a text past HTML_TEXT_MAX_CHARS is cut, with a digest of all of it, so a change past the cut still differs', () => {
        const long = (tail: string) => `<p>${'word '.repeat(HTML_TEXT_MAX_CHARS / 5)}</p><p>${tail}</p>`;
        const a = htmlShape(long('end one')).text;
        const b = htmlShape(long('end two')).text;
        expect(a.length).toBeLessThan(HTML_TEXT_MAX_CHARS + 200);
        expect(a).not.toBe(b);
        expect(a.slice(0, HTML_TEXT_MAX_CHARS)).toBe(b.slice(0, HTML_TEXT_MAX_CHARS));
    });
});

describe('htmlFields: per-build and per-request noise is not a difference', () => {
    const fieldsOf = (page: string) => htmlFields(page);

    it('another build of the same page: other chunk hashes, the async chunks in another order (demo-nextjs#3 under next dev)', () => {
        const a = fieldsOf(nextPage());
        const b = fieldsOf(nextPage({ chunks: ['62cdd_next_dist_client_components_builtin_global-error_9f00aa11.js', 'app_layout_tsx_77aa3b21._.js', 'app_page_tsx_0c0ffee1._.js'] }));
        expect(b).toEqual(a);
    });

    it('another request: a per-request id, a nonce, the flight data cut into another number of inline scripts', () => {
        const a = fieldsOf(nextPage({ nonce: 'r4nd0m1' }));
        const b = fieldsOf(nextPage({ nonce: 'Zz9xQ2', requestId: 'sX4lSiNKMhHIhenGWRT9c', flight: 5 }));
        expect(b).toEqual(a);
    });

    it('a CSRF token in a hidden input or a meta tag, an SRI digest, a query string on an asset', () => {
        const page = (token: string, v: string) =>
            `<html><head><meta name="csrf-token" content="${token}"><link rel="stylesheet" href="/assets/index-DiwrgTda.css?v=${v}" integrity="sha384-${v}"></head>` +
            `<body><form action="/orders" method="post"><input type="hidden" name="_csrf" value="${token}"><input name="quantity"></form></body></html>`;
        expect(fieldsOf(page('abc123', '1'))).toEqual(fieldsOf(page('zzz999', '2')));
    });

    it('an asset URL keeps its words and loses its hashes', () => {
        expect(assetShape('/_next/static/chunks/app_page_tsx_d4005f96._.js')).toBe('/_next/static/chunks/app_page_tsx_#._.js');
        expect(assetShape('/assets/index-DiwrgTda.js')).toBe('/assets/index-#.js');
        expect(assetShape('/_app/immutable/entry/start.BxYz12aB.js?v=3')).toBe('/_app/immutable/entry/start.#.js');
        expect(assetShape('/img/a-1x.png 1x, /img/a-2x.png 2x')).toBe('/img/a-#.png #,/img/a-#.png #');
    });
});

describe('htmlFields: what the page shows and its markup', () => {
    it('a reworded line changes only the text', () => {
        const a = htmlFields(nextPage());
        const b = htmlFields(nextPage({ features: ['Multi-stage Docker build for optimal image size', 'Production configuration, ready to deploy', 'Security best practices (non-root user)'] }));
        expect(b[HTML_MARKUP_FIELD]).toBe(a[HTML_MARKUP_FIELD]);
        expect(b[HTML_TEXT_FIELD]).not.toBe(a[HTML_TEXT_FIELD]);
        expect(b[HTML_TEXT_FIELD]).toContain('Production configuration, ready to deploy');
    });

    it('a class, a form field name, a link target or one more element changes only the markup', () => {
        const a = htmlFields(nextPage());
        expect(htmlFields(nextPage({ className: 'list-none' }))[HTML_MARKUP_FIELD]).not.toBe(a[HTML_MARKUP_FIELD]);
        expect(htmlFields(nextPage({ className: 'list-none' }))[HTML_TEXT_FIELD]).toBe(a[HTML_TEXT_FIELD]);
        const form = (name: string, href: string) => htmlFields(`<html><body><form action="/orders"><input name="${name}"></form><a href="${href}">Orders</a></body></html>`);
        expect(form('qty', '/orders')[HTML_MARKUP_FIELD]).not.toBe(form('quantity', '/orders')[HTML_MARKUP_FIELD]);
        expect(form('qty', '/orders')[HTML_MARKUP_FIELD]).not.toBe(form('qty', '/orders/1')[HTML_MARKUP_FIELD]);
        expect(htmlFields('<ul><li>a</li></ul>')[HTML_MARKUP_FIELD]).not.toBe(htmlFields('<ul><li>a</li><li></li></ul>')[HTML_MARKUP_FIELD]);
    });
});

describe('isHtmlResponse', () => {
    it('reads the content type, and only without one the first bytes', () => {
        expect(isHtmlResponse({ 'Content-Type': 'text/html; charset=utf-8' }, '')).toBe(true);
        expect(isHtmlResponse({ 'content-type': 'text/plain' }, '<!DOCTYPE html><html></html>')).toBe(false);
        expect(isHtmlResponse({}, '\n<!doctype html><html></html>')).toBe(true);
        expect(isHtmlResponse({}, '<p>10</p>')).toBe(false);
        expect(isHtmlResponse(undefined, '{"html":"<html>"}')).toBe(false);
    });
});
