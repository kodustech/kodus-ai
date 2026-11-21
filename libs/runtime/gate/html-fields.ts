import { createHash } from 'crypto';

import { Parser } from 'htmlparser2';

// An HTML page compared the way a reader and a form see it, not byte by byte
// (planner-eval.md, "Intended changes on an HTML page", option C). Two fields
// replace the whole-body digest:
//
// - `html.text`: the visible text, one line per block element, whitespace
//   collapsed, without script, style, template or noscript content. A text
//   change the diff spells out is explained line by line, as a browser
//   probe's expectText value is (intended-change.ts).
// - `html.markup.sha256`: the digest of the tag skeleton: every tag with its
//   attributes, text and comments removed, and what differs per build or per
//   request set aside (below). A markup change (an attribute, a class, a
//   link, a form field's name) moves it and stays a finding: the diff never
//   explains a digest.
//
// Set aside, measured on the recorded kr-* pages (planner-eval.md):
// - content hashes and build ids in what `script` and `link` tags load and in
//   asset URLs (`src`, `srcset`, `poster`), and their query strings;
// - the order of a run of adjacent asset tags: `next dev` emits the same
//   async chunks in another order from one build to the next (demo-nextjs#3);
// - how many inline scripts a run of them is cut into: the React flight data
//   is flushed in chunks whose count follows timing and text length;
// - `nonce`, `integrity`, and CSRF tokens in a hidden input or a meta tag.
// Inline script and style content is never compared (Next's `__NEXT_DATA__`
// and flight data, Remix and SvelteKit hydration state carry build ids), nor
// are comments (React's `<!-- -->` text separators). A change only there is
// not seen by an HTTP probe; a browser probe reads what the page does with it.

export const HTML_TEXT_FIELD = 'html.text';
export const HTML_MARKUP_FIELD = 'html.markup.sha256';

/** Characters of visible text kept in the field; past it the rest is kept as a digest line, so a change there still differs. */
export const HTML_TEXT_MAX_CHARS = 16 * 1024;

/** Elements whose content is not visible text. */
const HIDDEN_CONTENT = new Set(['script', 'style', 'template', 'noscript']);

/** Elements that start a new line of text, as a browser lays them out. */
const BLOCK = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup',
    'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre', 'section', 'select',
    'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul',
]);

/** Elements without content: the parser closes them at once, and the skeleton keeps only their start tag. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Attributes whose value differs per request or per build and never per behavior. */
const VOLATILE_ATTRIBUTES = new Set(['nonce', 'integrity']);

/** Attributes that name a resource the page loads (an image, a video's poster), not where a user goes. */
const ASSET_ATTRIBUTES = new Set(['src', 'srcset', 'poster', 'data-src', 'data-srcset', 'imagesrcset']);
/** Elements that load code or styles: every attribute value of theirs is read as an asset URL. */
const LOADER_ELEMENTS = new Set(['script', 'link']);

const CSRF_NAME = /csrf|xsrf|authenticity_token|requestverificationtoken|__requestdigest/i;

/**
 * A piece of an asset URL between separators that is a content hash or a
 * build id: it has a digit, or both cases (Next's hex chunk suffixes, Vite's
 * base64url `index-DiwrgTda`, SvelteKit's `start.BxYz12aB`, a build-id
 * directory). Lowercase words (`app`, `layout`, `webpack`) stay, so a chunk
 * keeps its name.
 */
const looksLikeHash = (piece: string) => /\d/.test(piece) || (/[a-z]/.test(piece) && /[A-Z]/.test(piece));

/** An asset URL with its per-build parts set aside: query and fragment dropped, hash-like pieces replaced. */
export function assetShape(url: string): string {
    return url
        .split(',')
        .map((part) =>
            part
                .trim()
                .replace(/[?#]\S*/, '')
                .replace(/[A-Za-z0-9]+/g, (piece) => (looksLikeHash(piece) ? '#' : piece)),
        )
        .join(',');
}

/** One attribute as the skeleton keeps it. */
function attributeShape(tag: string, name: string, value: string, attribs: Record<string, string>): string {
    if (VOLATILE_ATTRIBUTES.has(name)) return name;
    if (ASSET_ATTRIBUTES.has(name) || LOADER_ELEMENTS.has(tag)) return `${name}=${JSON.stringify(assetShape(value))}`;
    // A CSRF token: in a hidden input's value, or a meta tag's content.
    if (name === 'value' && tag === 'input' && CSRF_NAME.test(attribs.name ?? '')) return name;
    if (name === 'content' && tag === 'meta' && CSRF_NAME.test(attribs.name ?? '')) return name;
    return `${name}=${JSON.stringify(value)}`;
}

/** Whether a response is an HTML page: its content type says so, or, without one, its first bytes do. */
export function isHtmlResponse(headers: Record<string, string> | undefined, body: string): boolean {
    const type = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    if (type) return /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type);
    // Leading comments are skipped one at a time: a nested lazy repeat over them backtracks exponentially.
    let rest = body.slice(0, 4096).trimStart();
    while (rest.startsWith('<!--')) {
        const end = rest.indexOf('-->', 4);
        if (end < 0) return false;
        rest = rest.slice(end + 3).trimStart();
    }
    return /^<(!doctype\s+html|html[\s>])/i.test(rest);
}

export interface HtmlShape {
    /** The visible text, one line per block, cut to HTML_TEXT_MAX_CHARS with a digest line for the rest. */
    text: string;
    /** The normalized tag skeleton, one tag per line (its digest is the compared field). */
    skeleton: string;
}

/** A skeleton token: a tag, an asset loader (sorted within its run) or an inline script (a run of equal ones counts once). */
interface Token {
    tag: string;
    kind: 'tag' | 'asset' | 'inline';
}

/** Runs of adjacent asset loaders sorted, runs of equal inline scripts folded into one. */
function settle(tokens: Token[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; ) {
        const t = tokens[i];
        let j = i + 1;
        if (t.kind === 'asset') {
            while (j < tokens.length && tokens[j].kind === 'asset') j++;
            out.push(...tokens.slice(i, j).map((x) => x.tag).sort());
        } else {
            while (t.kind === 'inline' && j < tokens.length && tokens[j].kind === 'inline' && tokens[j].tag === t.tag) j++;
            out.push(t.tag);
        }
        i = j;
    }
    return out;
}

/** The visible text and the normalized tag skeleton of an HTML page. */
export function htmlShape(body: string): HtmlShape {
    const lines: string[] = [];
    let line = '';
    const flush = () => {
        const l = line.replace(/\s+/g, ' ').trim();
        if (l) lines.push(l);
        line = '';
    };
    const tokens: Token[] = [];
    /** The open script's start tag: it becomes one token with its end tag. */
    let script: Token | undefined;
    let hidden = 0;
    const parser = new Parser(
        {
            onopentag(name, attribs) {
                const attrs = Object.keys(attribs)
                    .sort()
                    .map((k) => attributeShape(name, k, attribs[k], attribs));
                const tag = `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
                if (name === 'script') script = { tag: `${tag}</script>`, kind: 'src' in attribs ? 'asset' : 'inline' };
                else tokens.push({ tag, kind: name === 'link' ? 'asset' : 'tag' });
                if (HIDDEN_CONTENT.has(name)) hidden++;
                if (BLOCK.has(name)) flush();
            },
            onclosetag(name) {
                if (name === 'script' && script) {
                    tokens.push(script);
                    script = undefined;
                } else if (!VOID.has(name)) tokens.push({ tag: `</${name}>`, kind: 'tag' });
                if (HIDDEN_CONTENT.has(name)) hidden = Math.max(0, hidden - 1);
                if (BLOCK.has(name)) flush();
            },
            ontext(data) {
                if (!hidden) line += data;
            },
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
    );
    parser.write(body);
    parser.end();
    flush();
    let text = lines.join('\n');
    if (text.length > HTML_TEXT_MAX_CHARS) {
        const all = createHash('sha256').update(text).digest('hex');
        text = `${text.slice(0, HTML_TEXT_MAX_CHARS)}\n[text cut at ${HTML_TEXT_MAX_CHARS} of ${text.length} characters; sha256 of all: ${all}]`;
    }
    return { text, skeleton: settle(tokens).join('\n') };
}

/** The compared fields of an HTML page: its visible text and its skeleton's digest. */
export function htmlFields(body: string): Record<string, string> {
    const { text, skeleton } = htmlShape(body);
    return { [HTML_TEXT_FIELD]: text, [HTML_MARKUP_FIELD]: createHash('sha256').update(skeleton).digest('hex') };
}
