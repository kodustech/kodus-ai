/**
 * Parses a varlock-style .env.schema and returns annotated items.
 *
 * Recognises both standard varlock decorators (@required, @optional,
 * @sensitive, @type) and Kodus-specific metadata in plain comments:
 *
 *   # kodus: audience=cloud,self-hosted,both
 *   # kodus: installer-default="value"
 *   # kodus: category=name      (used in section headers)
 */

import { readFileSync } from 'node:fs';

export type Audience = 'cloud' | 'self-hosted' | 'both' | 'self-hosted-enterprise';

export type SchemaItem = {
    name: string;
    value: string;
    description: string[];
    required: boolean;
    sensitive: boolean;
    type?: string;
    audience: Audience[];
    category: string;
    installerDefault?: string;
    installerComment: boolean;
    // Method the installer's generate-secrets.sh should use to produce a
    // value for this key. Set via `kodus: autogen=hex32|base64-32|base64url-32|
    // mirror:OTHER_VAR`. Read by generate.ts → schema-vars.sh →
    // generate-secrets.sh. Only set on keys the installer can produce
    // unattended (NOT DB passwords / API keys, which the operator owns).
    autogen?: string;
    section: string;
};

export type SchemaSection = {
    title: string;
    category: string;
    items: SchemaItem[];
};

const SECTION_RE = /^#\s*=+\s*$/;
const KODUS_META_RE = /^\s*kodus:\s*(.*)$/;

export function parseSchema(path: string): SchemaSection[] {
    const text = readFileSync(path, 'utf-8');
    const lines = text.split('\n');

    const sections: SchemaSection[] = [];
    let currentSection: SchemaSection | null = null;
    let pendingDescription: string[] = [];
    let pendingDecorators = '';
    let pendingKodus: Record<string, string> = {};
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Section header: "# === ..." \n "# Title" \n [optional "# kodus: category=..."] \n "# === ..."
        if (SECTION_RE.test(line)) {
            const titleLine = lines[i + 1] ?? '';
            let metaIdx = i + 2;
            let metaLine = lines[metaIdx] ?? '';
            let endIdx = metaIdx;
            // Look for an optional "# kodus: category=..." line.
            const stripped = stripCommentPrefix(metaLine);
            const kodusMatch = stripped.match(KODUS_META_RE);
            if (kodusMatch) {
                endIdx = metaIdx + 1;
            } else {
                endIdx = metaIdx;
            }
            const closer = lines[endIdx] ?? '';
            if (SECTION_RE.test(closer)) {
                const title = stripCommentPrefix(titleLine).trim();
                let category = slug(title);
                if (kodusMatch) {
                    const meta = parseKodusMeta(kodusMatch[1]);
                    if (meta.category) category = meta.category;
                }
                currentSection = { title, category, items: [] };
                sections.push(currentSection);
                resetBuffers();
                i = endIdx + 1;
                continue;
            }
        }

        // Blank line: reset buffers.
        if (!line.trim()) {
            resetBuffers();
            i += 1;
            continue;
        }

        if (line.startsWith('#')) {
            const stripped = stripCommentPrefix(line);
            const kodusMatch = stripped.match(KODUS_META_RE);
            if (kodusMatch) {
                Object.assign(pendingKodus, parseKodusMeta(kodusMatch[1]));
            } else if (stripped.includes('@')) {
                pendingDecorators += ' ' + stripped;
            } else {
                pendingDescription.push(stripped);
            }
            i += 1;
            continue;
        }

        // Variable line: NAME=value
        const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        if (match && currentSection) {
            const [, name, rawValue] = match;
            const item: SchemaItem = {
                name,
                value: stripQuotes(rawValue),
                description: pendingDescription.slice(),
                required: /@required\b/.test(pendingDecorators),
                sensitive: /@sensitive\b/.test(pendingDecorators),
                type: matchDecorator(pendingDecorators, 'type'),
                audience: parseAudience(pendingKodus.audience),
                category: currentSection.category,
                installerDefault: pendingKodus['installer-default'],
                installerComment:
                    (pendingKodus['installer-comment'] ?? '').toLowerCase() ===
                    'true',
                autogen: pendingKodus.autogen,
                section: currentSection.title,
            };
            currentSection.items.push(item);
            resetBuffers();
        }

        i += 1;
    }

    return sections;

    function resetBuffers() {
        pendingDescription = [];
        pendingDecorators = '';
        pendingKodus = {};
    }
}

function stripCommentPrefix(line: string): string {
    return line.replace(/^#\s?/, '');
}

function matchDecorator(text: string, name: string): string | undefined {
    const re = new RegExp(`@${name}=(\\([^)]*\\)|"[^"]*"|[^\\s]+)`);
    const m = text.match(re);
    if (!m) return undefined;
    return stripQuotes(m[1]);
}

function parseKodusMeta(blob: string): Record<string, string> {
    // Parse `key=value key="quoted value" key=val` into a record.
    const out: Record<string, string> = {};
    const re = /(\S+?)=("[^"]*"|\S+)/g;
    let m;
    while ((m = re.exec(blob))) {
        out[m[1]] = stripQuotes(m[2]);
    }
    return out;
}

function stripQuotes(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseAudience(value: string | undefined): Audience[] {
    if (!value) return ['both'];
    return value.split(',').map((v) => v.trim()) as Audience[];
}

function slug(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

export function flatten(sections: SchemaSection[]): SchemaItem[] {
    return sections.flatMap((s) => s.items);
}

export function includesAudience(item: SchemaItem, audience: Audience): boolean {
    // self-hosted-enterprise is a TAG (shows EE badge in docs).
    // - Alone → docs-only (no template).
    // - Combined with cloud / self-hosted / both → also appears in those templates.
    const others = (item.audience as string[]).filter(
        (a) => a !== 'self-hosted-enterprise',
    );
    if (others.length === 0) return false;
    return others.includes('both') || others.includes(audience as string);
}

export function isEnterprise(item: SchemaItem): boolean {
    return item.audience.includes('self-hosted-enterprise');
}
