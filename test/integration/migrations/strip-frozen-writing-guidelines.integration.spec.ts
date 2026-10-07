/**
 * INTEGRATION TEST — StripFrozenWritingGuidelines2026100700000000 against real
 * Postgres, through TypeORM's migration runner.
 *
 * Runs in a throwaway schema whose `parameters` table is a copy of the real
 * one (`LIKE public.parameters INCLUDING ALL`: same enum, jsonb, defaults and
 * indexes, no foreign keys). The connection's search_path points at that
 * schema only, so the migration's unqualified statements touch nothing else.
 *
 * Checked: every stored shape at every scope against the runtime matcher, rows
 * the migration must not touch, backups, a second run, rollback of a failing
 * run, down() (including a row saved again after the migration), and running
 * up() again after down().
 *
 * Skips automatically if Postgres isn't reachable.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { StripFrozenWritingGuidelines2026100700000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026100700000000-StripFrozenWritingGuidelines';
import { stripFrozenWritingGuidelines } from '@libs/common/utils/strip-frozen-writing-guidelines';
import {
    matchKnownWritingGuidelines,
    resolveWritingGuidelines,
} from '@libs/common/utils/writing-guidelines';

const PG = {
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: parseInt(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
        10,
    ),
    username:
        process.env.TEST_PG_USER ??
        process.env.API_PG_DB_USERNAME ??
        'kodusdev',
    password:
        process.env.TEST_PG_PASSWORD ??
        process.env.API_PG_DB_PASSWORD ??
        'kodusdev',
    database:
        process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db',
};
const SCHEMA = `mig_wg_${Date.now()}`;
const BACKUP = 'parameters_writing_guidelines_backup';
const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

const dataSource = (searchPath?: string) =>
    new DataSource({
        type: 'postgres',
        ...PG,
        logging: false,
        synchronize: false,
        migrations: [StripFrozenWritingGuidelines2026100700000000],
        migrationsTransactionMode: 'each',
        extra: {
            max: 2,
            ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
        },
    });

async function reachable(): Promise<boolean> {
    const probe = dataSource();
    try {
        await probe.initialize();
        await probe.query('SELECT 1 FROM public.parameters LIMIT 1');
        return true;
    } catch {
        return false;
    } finally {
        if (probe.isInitialized) await probe.destroy();
    }
}

// ---------------------------------------------------------------- fixtures
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

const paragraphs = (text: string) =>
    JSON.stringify({
        type: 'doc',
        content: text.split('\n').map((line) => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : [],
        })),
    });
const editorList = (lines: string[]) =>
    JSON.stringify({
        type: 'doc',
        content: [
            { type: 'paragraph', content: [{ type: 'text', text: lines[0] }] },
            {
                type: 'bulletList',
                content: lines.slice(1).map((item) => {
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

/** Every stored shape of generation.main the matrix seeds, shipped or not. */
const VALUES: Array<[string, unknown]> = [
    ['current plain', CURRENT],
    ['current editor list', editorList(CURRENT.trim().split('\n'))],
    [
        'current without inline-code marks',
        CURRENT.replace('`inline code`', 'inline code'),
    ],
    ['2026-02 paragraphs', paragraphs(D2026)],
    ['2026-02 editor list', editorList(D2026_LINES)],
    ['2026-02 markdown', D2026],
    ['2026-02 * bullets', D2026.replace(/^- /gm, '* ')],
    ['2026-02 __bold__', D2026.replace(/\*\*/g, '__')],
    ['2026-02 blank lines', D2026.replace(/\n/g, '\n\n')],
    ['2026-02 { value }', { value: editorList(D2026_LINES) }],
    ['2026-02 editor object', JSON.parse(editorList(D2026_LINES))],
    ['2025 plain', D2025],
    ['2025 whitespace', `  Detailed   and verifiable\nissue   description \n`],
    ['2025 paragraphs', paragraphs(D2025)],
    ['coach paragraphs', paragraphs(COACH)],
    ['coach plain', COACH],
    ['2025 upper case', D2025.toUpperCase()],
    ['2025 full stop', `${D2025}.`],
    ['2026-02 1-3', D2026.replace('1-2', '1-3')],
    ['2026-02 minus a bullet', D2026_LINES.slice(0, -1).join('\n')],
    [
        '2025 plus a sentence',
        `${D2025}. Always mention the test that would catch it.`,
    ],
    [
        'team text',
        paragraphs(
            'Write like a senior mentor.\nGive one concrete example per finding.',
        ),
    ],
    [
        'unicode team text',
        'Escreva como um mentor sênior — com exemplos concretos. 日本語も',
    ],
    ['empty', ''],
    ['whitespace', '   \n '],
    ['empty editor doc', JSON.stringify({ type: 'doc', content: [] })],
    ['null', null],
    ['number', 42],
    ['object', { foo: 'bar' }],
    ['broken JSON', '{"type":"doc",'],
];

const gen = (main: unknown, extra: Record<string, unknown> = {}) => ({
    v2PromptOverrides: { generation: { main }, ...extra },
});

type Seed = {
    uuid: string;
    configKey: string;
    active: boolean;
    configValue: unknown;
    teamId: string;
};

/** Each value at each scope, plus mixed rows and rows the migration must skip. */
function seedRows(): Seed[] {
    const rows: Seed[] = [];
    const add = (
        configValue: unknown,
        configKey = 'code_review_config',
        active = true,
    ) =>
        rows.push({
            uuid: uuidv4(),
            configKey,
            active,
            configValue,
            teamId: uuidv4(),
        });

    for (const [, main] of VALUES) {
        // global, repository and directory scope, each alone
        add({
            configs: { automatedReviewActive: true, ...gen(main) },
            repositories: [],
        });
        add({
            configs: {},
            repositories: [
                {
                    id: 'r1',
                    name: 'r1',
                    configs: { ...gen(main), reviewOptions: { bug: true } },
                    directories: [],
                },
            ],
        });
        add({
            configs: {},
            repositories: [
                {
                    id: 'r1',
                    name: 'r1',
                    configs: {},
                    directories: [
                        { id: 'd1', path: '/d1', configs: gen(main) },
                    ],
                },
            ],
        });
        // under team guidelines: at repository scope below the global ones,
        // at directory scope below the repository's or the inherited global
        add({
            configs: gen('Team text at global'),
            repositories: [
                { id: 'r1', name: 'r1', configs: gen(main), directories: [] },
            ],
        });
        add({
            configs: {},
            repositories: [
                {
                    id: 'r1',
                    name: 'r1',
                    configs: gen('Repository team text'),
                    directories: [{ id: 'd1', configs: gen(main) }],
                },
            ],
        });
        add({
            configs: gen('Team text at global'),
            repositories: [
                {
                    id: 'r1',
                    name: 'r1',
                    configs: {},
                    directories: [{ id: 'd1', configs: gen(main) }],
                },
            ],
        });
        // next to category descriptions and another generation key
        add({
            configs: {
                v2PromptOverrides: {
                    generation: { main, other: 'keep' },
                    categories: { descriptions: { bug: 'Our bug rules' } },
                },
            },
        });
    }
    // every scope at once, a mix of shipped and custom
    add({
        configs: gen('Team text at global'),
        repositories: [
            {
                id: 'r1',
                configs: gen(paragraphs(D2026)),
                directories: [
                    { id: 'd1', configs: gen(COACH) },
                    { id: 'd2', configs: gen('Directory team text') },
                    { id: 'd3', configs: gen(D2025) },
                ],
            },
            { id: 'r2', configs: gen(`${D2025}.`), directories: [] },
            { id: 'r3', configs: {} },
        ],
    });
    // malformed containers
    add({ configs: null, repositories: null });
    add({ configs: { v2PromptOverrides: { generation: 'not an object' } } });
    add({ repositories: [null, { configs: null, directories: [null] }] });
    add({});
    // rows the migration must never touch
    add({ configs: gen(D2025) }, 'code_review_config', false);
    add({ configs: gen(D2025) }, 'language_config');
    add({ configs: gen(D2025) }, 'platform_configs');
    return rows;
}

/** Independent oracle: the runtime matcher decides what each scope should lose. */
function expectedValue(seed: Seed): unknown {
    if (seed.configKey !== 'code_review_config' || !seed.active)
        return seed.configValue;
    const original = seed.configValue as any;
    const value = JSON.parse(JSON.stringify(seed.configValue));
    const mainOf = (configs: any) => {
        const g = configs?.v2PromptOverrides?.generation;
        return g && typeof g === 'object' && 'main' in g
            ? { value: g.main }
            : undefined;
    };
    // A scope reviews with the nearest value stored above it; a copy goes only
    // when what it would then inherit reads as a default to reviews too.
    const inheritsDefault = (inherited?: { value: unknown }) =>
        !inherited || !resolveWritingGuidelines(inherited.value).isCustom;
    const strip = (configs: any, inherited?: { value: unknown }) => {
        const g = configs?.v2PromptOverrides?.generation;
        if (!g || typeof g !== 'object' || !('main' in g)) return;
        if (matchKnownWritingGuidelines(g.main) === null) return;
        if (!inheritsDefault(inherited)) return;
        delete g.main;
        if (!Object.keys(g).length) delete configs.v2PromptOverrides.generation;
        if (!Object.keys(configs.v2PromptOverrides).length)
            delete configs.v2PromptOverrides;
    };
    if (value && typeof value === 'object') {
        const globalMain = mainOf(original?.configs);
        strip(value.configs);
        const repos = Array.isArray(value.repositories)
            ? value.repositories
            : [];
        repos.forEach((r: any, i: number) => {
            if (!r || typeof r !== 'object') return;
            const repoMain =
                mainOf(original.repositories[i]?.configs) ?? globalMain;
            strip(r.configs, globalMain);
            for (const d of Array.isArray(r.directories) ? r.directories : []) {
                if (d && typeof d === 'object') strip(d.configs, repoMain);
            }
        });
    }
    return value;
}

const canonical = (v: unknown): string =>
    JSON.stringify(v, (_k, x) =>
        x && typeof x === 'object' && !Array.isArray(x)
            ? Object.fromEntries(
                  Object.keys(x)
                      .sort()
                      .map((k) => [k, x[k]]),
              )
            : x,
    );

// ---------------------------------------------------------------- suite
(skipIntegration ? describe.skip : describe)(
    'StripFrozenWritingGuidelines2026100700000000 on Postgres',
    () => {
        let admin: DataSource;
        let ds: DataSource;
        let available = false;
        let seeds: Seed[];
        let log: jest.SpyInstance;

        const current = async () => {
            const rows: Array<{
                uuid: string;
                configValue: unknown;
                updatedAt: Date;
            }> = await ds.query(
                `SELECT uuid, "configValue", "updatedAt" FROM parameters`,
            );
            return new Map(rows.map((r) => [r.uuid, r]));
        };
        const backupExists = async () =>
            (
                await ds.query(
                    `SELECT to_regclass('"${BACKUP}"') IS NOT NULL AS e`,
                )
            )[0].e;

        beforeAll(async () => {
            available = await reachable();
            if (!available) return;
            admin = dataSource();
            await admin.initialize();
            await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
            await admin.query(
                `CREATE TABLE "${SCHEMA}".parameters (LIKE public.parameters INCLUDING ALL)`,
            );
            ds = dataSource(SCHEMA);
            await ds.initialize();
        }, 60_000);

        afterAll(async () => {
            if (!available) return;
            await ds?.destroy();
            await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
            await admin.destroy();
        });

        beforeEach(async () => {
            log = jest
                .spyOn(console, 'log')
                .mockImplementation(() => undefined);
            if (!available) return;
            await ds.query(`DROP TABLE IF EXISTS "${BACKUP}"`);
            await ds.query(`DROP TABLE IF EXISTS migrations`);
            await ds.query(
                `DROP TRIGGER IF EXISTS fail_on_update ON parameters`,
            );
            await ds.query(`DELETE FROM parameters`);
            seeds = seedRows();
            for (const s of seeds) {
                await ds.query(
                    `INSERT INTO parameters (uuid, "configKey", "configValue", active, team_id, "updatedAt")
                     VALUES ($1, $2, $3::jsonb, $4, $5, '2020-01-01')`,
                    [
                        s.uuid,
                        s.configKey,
                        JSON.stringify(s.configValue),
                        s.active,
                        s.teamId,
                    ],
                );
            }
        });
        afterEach(() => log.mockRestore());

        const itPg = (name: string, fn: () => Promise<void>) =>
            it(
                name,
                async () => {
                    if (!available) {
                        console.warn(`skipped (Postgres unreachable): ${name}`);
                        return;
                    }
                    await fn();
                },
                120_000,
            );

        itPg('the oracle covers both outcomes', async () => {
            const changed = seeds.filter(
                (s) => canonical(expectedValue(s)) !== canonical(s.configValue),
            );
            const kept = seeds.filter(
                (s) => canonical(expectedValue(s)) === canonical(s.configValue),
            );
            expect(changed.length).toBeGreaterThan(40);
            expect(kept.length).toBeGreaterThan(40);
        });

        itPg(
            'up() through the runner removes exactly what reviews read as shipped, at every scope',
            async () => {
                await ds.runMigrations();
                const now = await current();

                for (const s of seeds) {
                    const want = expectedValue(s);
                    const row = now.get(s.uuid)!;
                    expect({
                        row: s.uuid,
                        value: canonical(row.configValue),
                    }).toEqual({
                        row: s.uuid,
                        value: canonical(want),
                    });
                    // The pure transform and the oracle agree too.
                    if (s.configKey === 'code_review_config' && s.active) {
                        expect(
                            canonical(
                                stripFrozenWritingGuidelines(s.configValue)
                                    .value,
                            ),
                        ).toBe(canonical(want));
                    }
                    const changed =
                        canonical(want) !== canonical(s.configValue);
                    expect(row.updatedAt.getUTCFullYear() === 2020).toBe(
                        !changed,
                    );
                }

                const backups: Array<{
                    uuid: string;
                    original: unknown;
                    migrated: unknown;
                }> = await ds.query(
                    `SELECT uuid, original, migrated FROM "${BACKUP}"`,
                );
                const changedSeeds = seeds.filter(
                    (s) =>
                        canonical(expectedValue(s)) !==
                        canonical(s.configValue),
                );
                expect(backups.map((b) => b.uuid).sort()).toEqual(
                    changedSeeds.map((s) => s.uuid).sort(),
                );
                for (const b of backups) {
                    const seed = seeds.find((s) => s.uuid === b.uuid)!;
                    expect(canonical(b.original)).toBe(
                        canonical(seed.configValue),
                    );
                    expect(canonical(b.migrated)).toBe(
                        canonical(expectedValue(seed)),
                    );
                }

                const [{ count }] = await ds.query(
                    `SELECT count(*)::int AS count FROM migrations WHERE name = 'StripFrozenWritingGuidelines2026100700000000'`,
                );
                expect(count).toBe(1);
                expect(log).toHaveBeenCalledWith(
                    expect.stringContaining(
                        `updated ${changedSeeds.length} of `,
                    ),
                );
            },
        );

        itPg(
            'a row saved again between its read and its write keeps the newer save',
            async () => {
                const frozen = seeds.filter(
                    (s) =>
                        s.configKey === 'code_review_config' &&
                        s.active &&
                        canonical(expectedValue(s)) !==
                            canonical(s.configValue),
                );
                const [versioned, inPlace] = frozen;
                const newerUuid = uuidv4();
                const newerSave = {
                    configs: gen('Saved after the migration read'),
                };
                const inPlaceEdit = { configs: gen('Edited in place') };

                // A real QueryRunner whose SELECT is followed, before any UPDATE,
                // by a settings save on another connection: the versioned save the
                // app does, and an in-place edit.
                const runner = ds.createQueryRunner();
                const realQuery = runner.query.bind(runner);
                let interfered = false;
                (runner as any).query = async (
                    sql: string,
                    params?: unknown[],
                ) => {
                    const result = await realQuery(sql, params);
                    if (!interfered && /SELECT uuid, "configValue"/.test(sql)) {
                        interfered = true;
                        await ds.query(
                            `UPDATE parameters SET active = false WHERE uuid = $1`,
                            [versioned.uuid],
                        );
                        await ds.query(
                            `INSERT INTO parameters (uuid, "configKey", "configValue", active, team_id)
                         VALUES ($1, 'code_review_config', $2::jsonb, true, $3)`,
                            [
                                newerUuid,
                                JSON.stringify(newerSave),
                                versioned.teamId,
                            ],
                        );
                        await ds.query(
                            `UPDATE parameters SET "configValue" = $1::jsonb WHERE uuid = $2`,
                            [JSON.stringify(inPlaceEdit), inPlace.uuid],
                        );
                    }
                    return result;
                };

                await new StripFrozenWritingGuidelines2026100700000000().up(
                    runner,
                );
                await runner.release();

                const now = await current();
                expect(canonical(now.get(versioned.uuid)!.configValue)).toBe(
                    canonical(versioned.configValue),
                );
                expect(canonical(now.get(newerUuid)!.configValue)).toBe(
                    canonical(newerSave),
                );
                expect(canonical(now.get(inPlace.uuid)!.configValue)).toBe(
                    canonical(inPlaceEdit),
                );
                const backedUp: Array<{ uuid: string }> = await ds.query(
                    `SELECT uuid FROM "${BACKUP}"`,
                );
                expect(backedUp.map((b) => b.uuid)).not.toContain(
                    versioned.uuid,
                );
                expect(backedUp.map((b) => b.uuid)).not.toContain(inPlace.uuid);
                expect(backedUp).toHaveLength(frozen.length - 2);
                expect(log).toHaveBeenLastCalledWith(
                    expect.stringContaining(`updated ${frozen.length - 2} of `),
                );
                expect(log).toHaveBeenLastCalledWith(
                    expect.stringContaining('2 skipped'),
                );
            },
        );

        itPg(
            'no scope of any row changes which guidelines are in effect',
            async () => {
                const mainOf = (configs: any) => {
                    const g = configs?.v2PromptOverrides?.generation;
                    return g && typeof g === 'object' && 'main' in g
                        ? { value: g.main }
                        : undefined;
                };
                const effective = (value: any): string[] => {
                    if (!value || typeof value !== 'object') return [];
                    const resolve = (v?: { value: unknown }) =>
                        resolveWritingGuidelines(v?.value).text;
                    const g = mainOf(value.configs);
                    const out = [resolve(g)];
                    for (const r of Array.isArray(value.repositories)
                        ? value.repositories
                        : []) {
                        if (!r || typeof r !== 'object') continue;
                        const rm = mainOf(r.configs) ?? g;
                        out.push(resolve(rm));
                        for (const d of Array.isArray(r.directories)
                            ? r.directories
                            : []) {
                            if (d && typeof d === 'object')
                                out.push(resolve(mainOf(d.configs) ?? rm));
                        }
                    }
                    return out;
                };

                await ds.runMigrations();
                const now = await current();

                let keptUnderTeam = 0;
                for (const s of seeds) {
                    expect({
                        row: s.uuid,
                        effective: effective(now.get(s.uuid)!.configValue),
                    }).toEqual({
                        row: s.uuid,
                        effective: effective(s.configValue),
                    });
                    keptUnderTeam += stripFrozenWritingGuidelines(s.configValue)
                        .kept.length;
                }
                expect(keptUnderTeam).toBeGreaterThan(20);
                expect(log).toHaveBeenCalledWith(
                    expect.stringContaining(
                        `kept under team guidelines: ${keptUnderTeam}`,
                    ),
                );
            },
        );

        itPg(
            'a second up() changes nothing and keeps the first backup',
            async () => {
                await ds.runMigrations();
                const afterFirst = await current();
                const backupFirst = canonical(
                    await ds.query(
                        `SELECT uuid, original, migrated FROM "${BACKUP}" ORDER BY uuid`,
                    ),
                );

                const runner = ds.createQueryRunner();
                await new StripFrozenWritingGuidelines2026100700000000().up(
                    runner,
                );
                await runner.release();

                const afterSecond = await current();
                for (const [uuid, row] of afterFirst) {
                    expect(canonical(afterSecond.get(uuid)!.configValue)).toBe(
                        canonical(row.configValue),
                    );
                    expect(afterSecond.get(uuid)!.updatedAt.getTime()).toBe(
                        row.updatedAt.getTime(),
                    );
                }
                expect(
                    canonical(
                        await ds.query(
                            `SELECT uuid, original, migrated FROM "${BACKUP}" ORDER BY uuid`,
                        ),
                    ),
                ).toBe(backupFirst);
            },
        );

        itPg(
            'a run that fails part-way rolls back every row and the backup table',
            async () => {
                const target = seeds.filter(
                    (s) =>
                        canonical(expectedValue(s)) !==
                        canonical(s.configValue),
                )[25];
                await ds.query(`
                CREATE OR REPLACE FUNCTION fail_on_update() RETURNS trigger AS $$
                BEGIN
                    IF NEW.uuid = '${target.uuid}' THEN RAISE EXCEPTION 'injected failure'; END IF;
                    RETURN NEW;
                END $$ LANGUAGE plpgsql`);
                await ds.query(
                    `CREATE TRIGGER fail_on_update BEFORE UPDATE ON parameters FOR EACH ROW EXECUTE FUNCTION fail_on_update()`,
                );

                await expect(ds.runMigrations()).rejects.toThrow(
                    /injected failure/,
                );

                const now = await current();
                for (const s of seeds) {
                    expect(canonical(now.get(s.uuid)!.configValue)).toBe(
                        canonical(s.configValue),
                    );
                }
                expect(await backupExists()).toBe(false);
                const [{ count }] = await ds.query(
                    `SELECT count(*)::int AS count FROM migrations`,
                );
                expect(count).toBe(0);
            },
        );

        itPg(
            'down() restores every row exactly, skips a row saved again since, and drops the backup',
            async () => {
                await ds.runMigrations();
                const edited = seeds.find(
                    (s) =>
                        s.active &&
                        s.configKey === 'code_review_config' &&
                        canonical(expectedValue(s)) !==
                            canonical(s.configValue),
                )!;
                const newerSave = {
                    configs: gen('Saved again after the migration'),
                };
                await ds.query(
                    `UPDATE parameters SET "configValue" = $1::jsonb WHERE uuid = $2`,
                    [JSON.stringify(newerSave), edited.uuid],
                );

                await ds.undoLastMigration();

                const now = await current();
                for (const s of seeds) {
                    const want =
                        s.uuid === edited.uuid ? newerSave : s.configValue;
                    expect({
                        row: s.uuid,
                        value: canonical(now.get(s.uuid)!.configValue),
                    }).toEqual({
                        row: s.uuid,
                        value: canonical(want),
                    });
                }
                expect(await backupExists()).toBe(false);
                expect(log).toHaveBeenLastCalledWith(
                    expect.stringContaining('1 left as is'),
                );
                const [{ count }] = await ds.query(
                    `SELECT count(*)::int AS count FROM migrations`,
                );
                expect(count).toBe(0);
            },
        );

        itPg(
            'up() again after down() gives the same result as the first run',
            async () => {
                await ds.runMigrations();
                const first = await current();
                await ds.undoLastMigration();
                await ds.runMigrations();
                const again = await current();
                for (const [uuid, row] of first) {
                    expect(canonical(again.get(uuid)!.configValue)).toBe(
                        canonical(row.configValue),
                    );
                }
            },
        );

        itPg('handles a large table in one pass', async () => {
            await ds.query(`DELETE FROM parameters`);
            const values = [
                paragraphs(D2026),
                'Team text',
                D2025,
                `${D2025}.`,
                editorList(D2026_LINES),
            ];
            const bulk = Array.from({ length: 5000 }, (_, i) => ({
                uuid: uuidv4(),
                teamId: uuidv4(),
                configValue: {
                    configs: gen(values[i % values.length]),
                    repositories: Array.from({ length: 5 }, (_r, j) => ({
                        id: `r${j}`,
                        configs: gen(values[(i + j) % values.length]),
                        directories: [
                            {
                                id: 'd',
                                configs: gen(
                                    values[(i + j + 1) % values.length],
                                ),
                            },
                        ],
                    })),
                },
            }));
            for (let i = 0; i < bulk.length; i += 500) {
                const chunk = bulk.slice(i, i + 500);
                await ds.query(
                    `INSERT INTO parameters (uuid, "configKey", "configValue", active, team_id)
                     SELECT (x->>'uuid')::uuid, 'code_review_config', x->'configValue', true, (x->>'teamId')::uuid
                       FROM jsonb_array_elements($1::jsonb) x`,
                    [JSON.stringify(chunk)],
                );
            }

            const started = Date.now();
            await ds.runMigrations();
            const elapsed = Date.now() - started;

            const now = await current();
            for (const b of bulk) {
                const seed: Seed = {
                    ...b,
                    configKey: 'code_review_config',
                    active: true,
                };
                expect(canonical(now.get(b.uuid)!.configValue)).toBe(
                    canonical(expectedValue(seed)),
                );
            }
            // Not a benchmark; a guard against something quadratic.
            expect(elapsed).toBeLessThan(120_000);
            console.warn(
                `[integration] 5000 rows x 11 scopes migrated in ${elapsed} ms`,
            );
        });
    },
);
