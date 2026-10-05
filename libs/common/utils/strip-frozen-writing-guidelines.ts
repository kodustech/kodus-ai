/**
 * Frozen matcher and transform for the StripFrozenWritingGuidelines migration
 * (2026100500000000). Kept out of the migrations folder because TypeORM loads
 * every export of a migration file as a migration.
 *
 * The texts and the rule mirror `writing-guidelines.ts` as of the migration and
 * must not follow later changes: an install that upgrades later has to remove
 * what was shipped up to then. A spec checks they still agree with the runtime
 * matcher.
 */
const SHIPPED_WRITING_GUIDELINES: ReadonlyArray<{
    name: string;
    text: string;
}> = [
    {
        name: 'default-current',
        text: 'Each suggestion is shown as a title, then this text. The title already names the problem.\n- **Don\'t repeat the title**: open with why the problem matters, not what it is.\n- **Two sentences at most**: one on the impact, one on what to change.\n- **No code blocks**: the fix is shown separately; name identifiers in `inline code` only.\n- **No conversational filler**: avoid "I noticed that", "It seems like", "You should consider".\n- **Strictly technical, active voice**: "The function leaks memory", not "Memory is leaked by the function".\n',
    },
    { name: 'default-2025', text: 'Detailed and verifiable issue description' },
    {
        name: 'default-2026-02',
        text: `Detailed and verifiable issue description
- **No conversational filler**: Avoid phrases like "I noticed that," "It seems like," or "You should consider."
- **Execute "Brevity First"**: Eliminate all introductory pleasantries. Start descriptions with the noun of the error (e.g., "Memory leak," "Null pointer dereference," "Timing attack").
- **Direct addressing**: State the problem immediately, followed by the technical cause.
- **Strictly technical**: Use only domain-specific terminology. If a bug is a race condition, start with "Race condition identified in..."
- **Use Active Voice**: "The function leaks memory" instead of "Memory is leaked by the function."
- **Sentence cap**: Limit the description to 1-2 high-impact sentences.`,
    },
    {
        name: 'preset-coach',
        text: 'Adopt a coaching tone: - Explain briefly the why behind each issue. - Suggest how to validate (tests/checks). - Prefer concise examples. - Avoid nitpicks and group by priority.',
    },
];

type EditorNode = {
    type?: string;
    text?: string;
    content?: EditorNode[];
    attrs?: Record<string, unknown>;
};

/** Plain text of editor (Tiptap) JSON, as the settings page stores it. */
function editorText(node: EditorNode): string {
    let out = '';
    const walk = (n: EditorNode | undefined): void => {
        if (!n || typeof n !== 'object') return;
        switch (n.type) {
            case 'text':
                out += typeof n.text === 'string' ? n.text : '';
                return;
            case 'hardBreak':
                out += '\n';
                return;
            case 'paragraph':
            case 'heading':
                n.content?.forEach(walk);
                out += '\n';
                return;
            case 'mcpMention': {
                const attrs = n.attrs ?? {};
                out +=
                    typeof attrs.resolvedOutput === 'string'
                        ? attrs.resolvedOutput
                        : `@mcp<${typeof attrs.app === 'string' ? attrs.app : ''}|${typeof attrs.tool === 'string' ? attrs.tool : ''}>`;
                return;
            }
            default:
                if (Array.isArray(n.content)) n.content.forEach(walk);
        }
    };
    walk(node);
    return out.replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** The text of a stored value: a string, editor JSON (string or object), or a `{ value }` wrapper. */
function storedText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && 'value' in (value as object)) {
        return storedText((value as { value?: unknown }).value);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object') {
                    return editorText(parsed as EditorNode).trim();
                }
            } catch {
                // Not JSON after all: the text is the string itself.
            }
        }
        return value.trim();
    }
    if (typeof value === 'object')
        return editorText(value as EditorNode).trim();
    return '';
}

/** Ignores list markers, bold and inline-code markup and whitespace; keeps case and punctuation. */
function fingerprint(text: string): string {
    return text
        .replace(/^[ \t]{0,3}[-+*][ \t]+/gm, '')
        .replace(/(?<![\p{L}\p{N}_])\*\*([^\n]+?)\*\*(?![\p{L}\p{N}_])/gu, '$1')
        .replace(/(?<![\p{L}\p{N}_])__([^\n]+?)__(?![\p{L}\p{N}_])/gu, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

const SHIPPED_FINGERPRINTS = SHIPPED_WRITING_GUIDELINES.map((s) => ({
    name: s.name,
    print: fingerprint(s.text),
}));

/** Which shipped text a stored value is, or null for anything a team wrote. */
export function matchFrozenWritingGuidelines(value: unknown): string | null {
    const print = fingerprint(storedText(value));
    if (!print) return null;
    return SHIPPED_FINGERPRINTS.find((s) => s.print === print)?.name ?? null;
}

type Removal = { level: string; match: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/** Removes a shipped generation.main from one scope's configs, pruning what it empties. */
function stripScope(configs: unknown, level: string, removed: Removal[]): void {
    if (!isRecord(configs)) return;
    const overrides = configs.v2PromptOverrides;
    if (!isRecord(overrides)) return;
    const generation = overrides.generation;
    if (!isRecord(generation) || !('main' in generation)) return;

    const match = matchFrozenWritingGuidelines(generation.main);
    if (!match) return;

    delete generation.main;
    if (Object.keys(generation).length === 0) delete overrides.generation;
    if (Object.keys(overrides).length === 0) delete configs.v2PromptOverrides;
    removed.push({ level, match });
}

/**
 * The config without shipped copies of the writing guidelines, at the global,
 * repository and directory scopes, and what was removed where. Does not mutate
 * its input.
 */
export function stripFrozenWritingGuidelines(configValue: unknown): {
    value: unknown;
    removed: Removal[];
} {
    if (!isRecord(configValue)) return { value: configValue, removed: [] };
    const value = JSON.parse(JSON.stringify(configValue));
    const removed: Removal[] = [];

    stripScope(value.configs, 'global', removed);
    const repositories = Array.isArray(value.repositories)
        ? value.repositories
        : [];
    for (const repository of repositories) {
        if (!isRecord(repository)) continue;
        stripScope(repository.configs, `repository ${repository.id}`, removed);
        const directories = Array.isArray(repository.directories)
            ? repository.directories
            : [];
        for (const directory of directories) {
            if (!isRecord(directory)) continue;
            stripScope(
                directory.configs,
                `directory ${directory.id} in repository ${repository.id}`,
                removed,
            );
        }
    }

    return removed.length
        ? { value, removed }
        : { value: configValue, removed };
}

/** JSON with object keys sorted, so jsonb read back in any key order compares equal. */
export function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, v) =>
        isRecord(v)
            ? Object.fromEntries(
                  Object.keys(v)
                      .sort()
                      .map((k) => [k, v[k]]),
              )
            : v,
    );
}

/** The config with every v2PromptOverrides removed, to check nothing else changed. */
export function withoutPromptOverrides(configValue: unknown): string {
    const copy = JSON.parse(JSON.stringify(configValue ?? null));
    const drop = (configs: unknown) => {
        if (isRecord(configs)) delete configs.v2PromptOverrides;
    };
    if (isRecord(copy)) {
        drop(copy.configs);
        for (const repository of Array.isArray(copy.repositories)
            ? copy.repositories
            : []) {
            if (!isRecord(repository)) continue;
            drop(repository.configs);
            for (const directory of Array.isArray(repository.directories)
                ? repository.directories
                : []) {
                if (isRecord(directory)) drop(directory.configs);
            }
        }
    }
    return canonical(copy);
}
