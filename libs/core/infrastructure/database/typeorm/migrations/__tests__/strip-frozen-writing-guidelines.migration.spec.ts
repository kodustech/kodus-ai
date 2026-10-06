/**
 * Strips stored copies of shipped writing guidelines (#1822) from
 * code_review_config. Drives the pure transform over every stored shape, checks
 * the frozen matcher against the runtime one, and runs up()/down() against an
 * in-memory QueryRunner.
 */
import type { QueryRunner } from 'typeorm';
import { StripFrozenWritingGuidelines2026100500000000 } from '../2026100500000000-StripFrozenWritingGuidelines';
import {
    matchFrozenWritingGuidelines,
    stripFrozenWritingGuidelines,
} from '@libs/common/utils/strip-frozen-writing-guidelines';
import { matchKnownWritingGuidelines } from '@libs/common/utils/writing-guidelines';

const CURRENT =
    'Each suggestion is shown as a title, then this text. The title already names the problem.\n- **Don\'t repeat the title**: open with why the problem matters, not what it is.\n- **Two sentences at most**: one on the impact, one on what to change.\n- **No code blocks**: the fix is shown separately; name identifiers in `inline code` only.\n- **No conversational filler**: avoid "I noticed that", "It seems like", "You should consider".\n- **Strictly technical, active voice**: "The function leaks memory", not "Memory is leaked by the function".\n';
const D2025 = 'Detailed and verifiable issue description';
const D2026_LINES = [
    'Detailed and verifiable issue description',
    '- **No conversational filler**: Avoid phrases like "I noticed that," "It seems like," or "You should consider."',
    '- **Execute "Brevity First"**: Eliminate all introductory pleasantries. Start descriptions with the noun of the error (e.g., "Memory leak," "Null pointer dereference," "Timing attack").',
    '- **Direct addressing**: State the problem immediately, followed by the technical cause.',
    '- **Strictly technical**: Use only domain-specific terminology. If a bug is a race condition, start with "Race condition identified in..."',
    '- **Use Active Voice**: "The function leaks memory" instead of "Memory is leaked by the function."',
    '- **Sentence cap**: Limit the description to 1-2 high-impact sentences.',
];
const D2026 = D2026_LINES.join('\n');
const COACH =
    'Adopt a coaching tone: - Explain briefly the why behind each issue. - Suggest how to validate (tests/checks). - Prefer concise examples. - Avoid nitpicks and group by priority.';

/** Editor JSON as the settings page stores it: one paragraph per line. */
const paragraphs = (text: string) =>
    JSON.stringify({
        type: 'doc',
        content: text.split('\n').map((line) => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : [],
        })),
    });

/** Editor JSON with a bullet list and bold labels, the way the UI saves a list. */
const editorList = (lines: string[]) => {
    const [intro, ...items] = lines;
    return JSON.stringify({
        type: 'doc',
        content: [
            { type: 'paragraph', content: [{ type: 'text', text: intro }] },
            {
                type: 'bulletList',
                content: items.map((item) => {
                    const m = item.match(/^- \*\*(.+?)\*\*(.*)$/);
                    return {
                        type: 'listItem',
                        content: [
                            {
                                type: 'paragraph',
                                content: m
                                    ? [
                                          {
                                              type: 'text',
                                              marks: [{ type: 'bold' }],
                                              text: m[1],
                                          },
                                          { type: 'text', text: m[2] },
                                      ]
                                    : [
                                          {
                                              type: 'text',
                                              text: item.replace(/^- /, ''),
                                          },
                                      ],
                            },
                        ],
                    };
                }),
            },
        ],
    });
};

const gen = (main: unknown, extra: Record<string, unknown> = {}) => ({
    v2PromptOverrides: { generation: { main }, ...extra },
});
const config = (
    configs: Record<string, unknown> = {},
    repositories: unknown[] = [],
) => ({
    id: 'global',
    name: 'Global',
    isSelected: true,
    configs: { automatedReviewActive: true, ...configs },
    repositories,
});
const repo = (
    id: string,
    configs: Record<string, unknown> = {},
    directories: unknown[] = [],
) => ({
    id,
    name: `repo-${id}`,
    isSelected: true,
    configs,
    directories,
});
const dir = (id: string, configs: Record<string, unknown> = {}) => ({
    id,
    path: `/dir-${id}`,
    configs,
});

/** Values a stored generation.main can hold, and whether each is a shipped text. */
const values: Array<[string, unknown, string | null]> = [
    ['current default, plain', CURRENT, 'default-current'],
    [
        'current default, trailing newline trimmed',
        CURRENT.trim(),
        'default-current',
    ],
    [
        'current default, editor list with bold',
        editorList(CURRENT.trim().split('\n')),
        'default-current',
    ],
    [
        'current default, inline code unmarked',
        CURRENT.replace('`inline code`', 'inline code'),
        'default-current',
    ],
    ['2026-02, editor paragraphs', paragraphs(D2026), 'default-2026-02'],
    [
        '2026-02, editor list and bold',
        editorList(D2026_LINES),
        'default-2026-02',
    ],
    ['2026-02, markdown', D2026, 'default-2026-02'],
    ['2026-02, * bullets', D2026.replace(/^- /gm, '* '), 'default-2026-02'],
    ['2026-02, __bold__', D2026.replace(/\*\*/g, '__'), 'default-2026-02'],
    [
        '2026-02, blank lines between items',
        D2026.replace(/\n/g, '\n\n'),
        'default-2026-02',
    ],
    [
        '2026-02, wrapped in { value }',
        { value: editorList(D2026_LINES) },
        'default-2026-02',
    ],
    [
        '2026-02, editor JSON object (not a string)',
        JSON.parse(editorList(D2026_LINES)),
        'default-2026-02',
    ],
    ['2025, plain', D2025, 'default-2025'],
    [
        '2025, extra whitespace and line breaks',
        `  Detailed   and verifiable\nissue   description \n`,
        'default-2025',
    ],
    ['2025, editor paragraphs', paragraphs(D2025), 'default-2025'],
    ['coach preset, editor paragraphs', paragraphs(COACH), 'preset-coach'],
    // Edits: case, punctuation and digits are the team's own words.
    ['2025, upper case', D2025.toUpperCase(), null],
    ['2025, full stop added', `${D2025}.`, null],
    ['2026-02, 1-2 changed to 1-3', D2026.replace('1-2', '1-3'), null],
    ['2026-02, one bullet removed', D2026_LINES.slice(0, -1).join('\n'), null],
    [
        '2025 plus an appended sentence',
        `${D2025}. Always mention the test that would catch it.`,
        null,
    ],
    [
        'team-written text',
        paragraphs(
            'Write like a senior mentor.\nGive one concrete example per finding.',
        ),
        null,
    ],
    ['empty string', '', null],
    ['whitespace only', '   \n ', null],
    [
        'empty editor document',
        JSON.stringify({ type: 'doc', content: [] }),
        null,
    ],
    ['null', null, null],
    ['a number', 42, null],
    ['an unrelated object', { foo: 'bar' }, null],
    ['malformed JSON that looks like JSON', '{"type":"doc",', null],
];

describe('matchFrozenWritingGuidelines', () => {
    it.each(values)('%s', (_name, value, expected) => {
        expect(matchFrozenWritingGuidelines(value)).toBe(expected);
    });

    it.each(values)('agrees with the runtime matcher: %s', (_name, value) => {
        // The migration must remove exactly what reviews already read as a
        // shipped default, no more and no less.
        expect(matchFrozenWritingGuidelines(value)).toBe(
            matchKnownWritingGuidelines(value),
        );
    });
});

describe('stripFrozenWritingGuidelines', () => {
    it('leaves a config with no overrides untouched', () => {
        const value = config();
        expect(stripFrozenWritingGuidelines(value)).toEqual({
            value,
            removed: [],
        });
    });

    it('removes a shipped copy and the containers it leaves empty', () => {
        const result = stripFrozenWritingGuidelines(
            config(gen(editorList(D2026_LINES))),
        );
        expect(result.value).toEqual(config());
        expect(result.removed).toEqual([
            { level: 'global', match: 'default-2026-02' },
        ]);
    });

    it('keeps an edited copy, an empty value and a non-string value', () => {
        for (const main of [`${D2025}.`, '', null, { foo: 'bar' }]) {
            const value = config(gen(main));
            expect(stripFrozenWritingGuidelines(value)).toEqual({
                value,
                removed: [],
            });
        }
    });

    it('keeps category descriptions next to a removed copy', () => {
        const result = stripFrozenWritingGuidelines(
            config({
                v2PromptOverrides: {
                    generation: { main: D2025 },
                    categories: { descriptions: { bug: 'Our bug rules' } },
                },
            }),
        );
        expect(result.value).toEqual(
            config({
                v2PromptOverrides: {
                    categories: { descriptions: { bug: 'Our bug rules' } },
                },
            }),
        );
    });

    it('keeps other keys under generation', () => {
        const result = stripFrozenWritingGuidelines(
            config({
                v2PromptOverrides: {
                    generation: { main: D2025, other: 'keep me' },
                },
            }),
        );
        expect(result.value).toEqual(
            config({ v2PromptOverrides: { generation: { other: 'keep me' } } }),
        );
    });

    it('handles repository and directory levels independently of the global one', () => {
        const result = stripFrozenWritingGuidelines(
            config(gen('Team text at global'), [
                repo('r1', gen(paragraphs(D2026)), [
                    dir('d1', gen(COACH)),
                    dir('d2', gen('Directory team text')),
                ]),
                repo('r2', { automatedReviewActive: false, ...gen(D2025) }),
                repo('r3'),
            ]),
        );
        expect(result.value).toEqual(
            config(gen('Team text at global'), [
                repo('r1', {}, [
                    dir('d1', {}),
                    dir('d2', gen('Directory team text')),
                ]),
                repo('r2', { automatedReviewActive: false }),
                repo('r3'),
            ]),
        );
        expect(result.removed).toEqual([
            { level: 'repository r1', match: 'default-2026-02' },
            { level: 'directory d1 in repository r1', match: 'preset-coach' },
            { level: 'repository r2', match: 'default-2025' },
        ]);
    });

    it('does not mutate its input', () => {
        const value = config(gen(D2025), [repo('r1', gen(D2025))]);
        const before = JSON.stringify(value);
        stripFrozenWritingGuidelines(value);
        expect(JSON.stringify(value)).toBe(before);
    });

    it('tolerates missing, null and malformed containers', () => {
        for (const value of [
            null,
            undefined,
            {},
            { configs: null },
            { configs: { v2PromptOverrides: null } },
            { configs: { v2PromptOverrides: { generation: 'not an object' } } },
            { repositories: null },
            {
                repositories: [
                    null,
                    { configs: null, directories: [null, { configs: null }] },
                ],
            },
            { repositories: 'not an array' },
        ]) {
            expect(() => stripFrozenWritingGuidelines(value)).not.toThrow();
            expect(stripFrozenWritingGuidelines(value).removed).toEqual([]);
        }
    });

    it('is idempotent', () => {
        const once = stripFrozenWritingGuidelines(
            config(gen(D2025), [repo('r1', gen(COACH))]),
        );
        const twice = stripFrozenWritingGuidelines(once.value);
        expect(twice).toEqual({ value: once.value, removed: [] });
    });
});

interface Row {
    uuid: string;
    configKey: string;
    active: boolean;
    configValue: unknown;
}

/**
 * In-memory QueryRunner for the statements the migration issues: the backup
 * table DDL, the SELECT of active rows, the backup INSERT, the UPDATE of
 * parameters, and down()'s restore and DROP. jsonb is returned parsed.
 */
function makeQueryRunner(rows: Row[], afterSelect?: (rows: Row[]) => void) {
    const backup = new Map<string, { original: unknown; migrated: unknown }>();
    let backupExists = false;
    const statements: string[] = [];
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        statements.push(s);
        if (/^CREATE TABLE IF NOT EXISTS/i.test(s)) {
            backupExists = true;
            return [];
        }
        if (/^SELECT uuid, "configValue" FROM "parameters"/i.test(s)) {
            const read = rows
                .filter((r) => r.configKey === 'code_review_config' && r.active)
                .map((r) => ({
                    uuid: r.uuid,
                    configValue: clone(r.configValue),
                }));
            afterSelect?.(rows);
            return read;
        }
        if (/^INSERT INTO/i.test(s)) {
            const [uuid, original, migrated] = params as [
                string,
                string,
                string,
            ];
            if (!backup.has(uuid)) {
                backup.set(uuid, {
                    original: JSON.parse(original),
                    migrated: JSON.parse(migrated),
                });
            }
            return [];
        }
        if (/^WITH changed AS \( UPDATE "parameters"/i.test(s)) {
            const [value, uuid, expected] = params as [string, string, string];
            const row = rows.find(
                (r) =>
                    r.uuid === uuid &&
                    r.configKey === 'code_review_config' &&
                    r.active &&
                    JSON.stringify(r.configValue) ===
                        JSON.stringify(JSON.parse(expected)),
            );
            if (!row) return [];
            row.configValue = JSON.parse(value);
            return [{ uuid }];
        }
        if (/^SELECT b.uuid/i.test(s)) {
            if (!backupExists) return [];
            return [...backup.entries()].map(([uuid, b]) => ({
                uuid,
                original: clone(b.original),
                migrated: clone(b.migrated),
                current: clone(
                    rows.find((r) => r.uuid === uuid)?.configValue ?? null,
                ),
            }));
        }
        if (
            /^UPDATE "parameters" .* WHERE uuid = \$2 AND "configValue" = \$3::jsonb$/i.test(
                s,
            )
        ) {
            const [original, uuid, migrated] = params as [
                string,
                string,
                string,
            ];
            const row = rows.find((r) => r.uuid === uuid);
            if (
                row &&
                JSON.stringify(row.configValue) ===
                    JSON.stringify(JSON.parse(migrated))
            ) {
                row.configValue = JSON.parse(original);
            }
            return [];
        }
        if (/^DROP TABLE IF EXISTS/i.test(s)) {
            backupExists = false;
            backup.clear();
            return [];
        }
        if (/^SELECT to_regclass/i.test(s)) {
            return [{ exists: backupExists }];
        }
        throw new Error(`unexpected statement: ${s}`);
    });
    return {
        queryRunner: { query } as unknown as QueryRunner,
        rows,
        backup,
        statements,
    };
}

const row = (
    uuid: string,
    configValue: unknown,
    extra: Partial<Row> = {},
): Row => ({
    uuid,
    configKey: 'code_review_config',
    active: true,
    configValue,
    ...extra,
});

describe('StripFrozenWritingGuidelines migration', () => {
    let log: jest.SpyInstance;
    beforeEach(() => {
        log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => log.mockRestore());

    const seed = () => [
        row('frozen-global', config(gen(editorList(D2026_LINES)))),
        row('frozen-repo', config(gen('Team text'), [repo('r1', gen(D2025))])),
        row('custom', config(gen(`${D2025}.`))),
        row('no-overrides', config()),
        row('inactive', config(gen(D2025)), { active: false }),
        row('other-key', config(gen(D2025)), { configKey: 'language_config' }),
    ];

    it('up(): strips frozen copies, keeps everything else, backs up only changed rows', async () => {
        const { queryRunner, rows, backup } = makeQueryRunner(seed());
        const original = JSON.parse(JSON.stringify(rows));

        await new StripFrozenWritingGuidelines2026100500000000().up(
            queryRunner,
        );

        const byId = Object.fromEntries(
            rows.map((r) => [r.uuid, r.configValue]),
        );
        const before = Object.fromEntries(
            original.map((r: Row) => [r.uuid, r.configValue]),
        );
        expect(byId['frozen-global']).toEqual(config());
        expect(byId['frozen-repo']).toEqual(
            config(gen('Team text'), [repo('r1')]),
        );
        for (const id of ['custom', 'no-overrides', 'inactive', 'other-key']) {
            expect(byId[id]).toEqual(before[id]);
        }
        expect([...backup.keys()].sort()).toEqual([
            'frozen-global',
            'frozen-repo',
        ]);
        expect(backup.get('frozen-global')?.original).toEqual(
            before['frozen-global'],
        );
        expect(log).toHaveBeenCalledWith(
            expect.stringContaining('updated 2 of 4'),
        );
    });

    it('up(): a second run changes nothing and keeps the first backup', async () => {
        const { queryRunner, rows, backup } = makeQueryRunner(seed());
        const migration = new StripFrozenWritingGuidelines2026100500000000();
        await migration.up(queryRunner);
        const afterFirst = JSON.stringify(rows);
        const firstBackup = JSON.stringify([...backup.entries()]);

        await migration.up(queryRunner);

        expect(JSON.stringify(rows)).toBe(afterFirst);
        expect(JSON.stringify([...backup.entries()])).toBe(firstBackup);
        expect(log).toHaveBeenLastCalledWith(
            expect.stringContaining('updated 0 of 4'),
        );
    });

    it('up(): skips a row saved again between its read and its write, without a backup', async () => {
        const target = 'frozen-global';
        const { queryRunner, rows, backup } = makeQueryRunner(seed(), (all) => {
            // A settings save deactivates the version and inserts a new one;
            // an in-place edit changes the value. Both must win.
            all.find((r) => r.uuid === target)!.active = false;
            all.find((r) => r.uuid === 'frozen-repo')!.configValue = config(
                gen('Edited in place'),
            );
        });

        await new StripFrozenWritingGuidelines2026100500000000().up(
            queryRunner,
        );

        expect(rows.find((r) => r.uuid === target)!.configValue).toEqual(
            original(seed(), target),
        );
        expect(rows.find((r) => r.uuid === 'frozen-repo')!.configValue).toEqual(
            config(gen('Edited in place')),
        );
        expect(backup.size).toBe(0);
        expect(log).toHaveBeenLastCalledWith(
            expect.stringContaining('updated 0 of 4'),
        );
        expect(log).toHaveBeenLastCalledWith(
            expect.stringContaining('2 skipped'),
        );
    });

    it('down(): restores every changed row exactly and drops the backup', async () => {
        const { queryRunner, rows, backup } = makeQueryRunner(seed());
        const original = JSON.parse(JSON.stringify(rows));
        const migration = new StripFrozenWritingGuidelines2026100500000000();

        await migration.up(queryRunner);
        await migration.down(queryRunner);

        expect(rows).toEqual(original);
        expect(backup.size).toBe(0);
    });

    it('down(): leaves a row alone when it changed after the migration', async () => {
        const { queryRunner, rows } = makeQueryRunner(seed());
        const migration = new StripFrozenWritingGuidelines2026100500000000();
        await migration.up(queryRunner);
        const edited = config(gen('Edited after the migration'));
        rows.find((r) => r.uuid === 'frozen-global')!.configValue = edited;

        await migration.down(queryRunner);

        expect(
            rows.find((r) => r.uuid === 'frozen-global')!.configValue,
        ).toEqual(edited);
        expect(rows.find((r) => r.uuid === 'frozen-repo')!.configValue).toEqual(
            original(seed(), 'frozen-repo'),
        );
        expect(log).toHaveBeenLastCalledWith(
            expect.stringContaining('1 left as is'),
        );
    });

    it('down(): is a no-op when there is no backup table', async () => {
        const { queryRunner, rows } = makeQueryRunner(seed());
        const before = JSON.stringify(rows);
        await new StripFrozenWritingGuidelines2026100500000000().down(
            queryRunner,
        );
        expect(JSON.stringify(rows)).toBe(before);
    });
});

function original(rows: Row[], uuid: string) {
    return rows.find((r) => r.uuid === uuid)!.configValue;
}
