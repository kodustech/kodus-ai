import {
    collectSurface,
    detectLanguages,
    isSkippedPath,
    matchesGlob,
    MAX_HITS_PER_PATTERN,
    parseRgOutput,
    planBatches,
} from './collect-surface';
import { LANGUAGE_SURFACES } from './languages';
import { GrepFn, LanguageSurface } from './surface.types';
import { createFakeGrep, createRipgrep, hasRipgrep } from './testing/fake-grep';

describe('parseRgOutput', () => {
    it('parses path:line:text and strips a leading ./', () => {
        expect(
            parseRgOutput(
                './src/a.ts:12:  const x = 1;\nsrc/b.py:3:print(x)\n',
            ),
        ).toEqual([
            { file: 'src/a.ts', line: 12, text: 'const x = 1;' },
            { file: 'src/b.py', line: 3, text: 'print(x)' },
        ]);
    });

    it('splits on the first :<digits>: so colons in the text and path survive', () => {
        expect(
            parseRgOutput('weird:name.ts:7:const url = "http://h:80/x:1:y";'),
        ).toEqual([
            {
                file: 'weird:name.ts',
                line: 7,
                text: 'const url = "http://h:80/x:1:y";',
            },
        ]);
    });

    it('returns nothing for no matches, errors and empty output', () => {
        expect(parseRgOutput('No matches found.')).toEqual([]);
        expect(parseRgOutput('Error: regex parse error')).toEqual([]);
        expect(parseRgOutput('')).toEqual([]);
    });

    it('skips lines that are not matches and strips CRLF', () => {
        expect(
            parseRgOutput(
                'bin/x: binary file matches (found "\\0" byte around offset 4)\r\nsrc/a.ts:1:hit\r\n',
            ),
        ).toEqual([{ file: 'src/a.ts', line: 1, text: 'hit' }]);
    });

    it('trims text to 300 chars', () => {
        const [hit] = parseRgOutput(`a.ts:1:${'x'.repeat(1000)}`);
        expect(hit.text).toHaveLength(300);
    });
});

describe('isSkippedPath', () => {
    it.each([
        'src/__tests__/a.ts',
        'test/a.py',
        'spec/models/user_spec.rb',
        'src/a.spec.ts',
        'pkg/a_test.go',
        'tests/test_views.py',
        'node_modules/x/index.js',
        'vendor/github.com/x/y.go',
        'dist/main.js',
        'build/out.js',
        'public/app.min.js',
        'src/test/java/com/acme/UserServiceTest.java',
        'fixtures/a.rb',
        'deps/plug/lib/plug.ex',
    ])('skips %s', (p) => expect(isSkippedPath(p)).toBe(true));

    it.each([
        'src/app.ts',
        'app/controllers/users_controller.rb',
        'src/main/java/com/acme/Contest.java',
        'lib/builder.ex',
        'cmd/server/main.go',
        'src/latest/x.py',
        // A tracked app under target/ (RealVuln's realvuln-python-app).
        'target/project/controllers/search.py',
    ])('keeps %s', (p) => expect(isSkippedPath(p)).toBe(false));
});

describe('matchesGlob', () => {
    it.each([
        ['src/a.tsx', '*.{ts,tsx,js}', true],
        ['src/a.rs', '*.{ts,tsx,js}', false],
        ['config/routes.rb', 'routes.rb', true],
        ['config/myroutes.rb', 'routes.rb', false],
        ['conf/routes', '{routes,*.routes}', true],
        ['conf/api.routes', '{routes,*.routes}', true],
        ['vendor/a/b.go', 'vendor/**', true],
        ['src/gen/x.go', '**/gen/*.go', true],
        ['gen/x.go', '**/gen/*.go', true],
    ])('%s ~ %s = %s', (path, glob, expected) =>
        expect(matchesGlob(path, glob)).toBe(expected),
    );
});

describe('detectLanguages', () => {
    it('detects by extension and marker files, ignoring vendored/test paths, in surface order', () => {
        expect(
            detectLanguages([
                'src/index.ts',
                'web/app.jsx',
                'scripts/deploy.sh',
                'go.mod',
                'native/lib.h',
                'mix.exs',
                'api/Api.csproj',
                'node_modules/left-pad/index.js',
                'vendor/foo/bar.php',
                'tests/test_x.py',
            ]),
        ).toEqual(['typescript', 'go', 'c', 'csharp', 'elixir', 'bash']);
    });

    it('returns nothing for an empty or unknown listing', () => {
        expect(detectLanguages([])).toEqual([]);
        expect(detectLanguages(['README.md', 'LICENSE'])).toEqual([]);
    });
});

const MINI: LanguageSurface = {
    language: 'mini',
    glob: '*.mini',
    extraGlobs: [
        {
            glob: 'routes.mini',
            patterns: [
                {
                    id: 'mini.routes',
                    role: 'entry_point',
                    regex: String.raw`^route `,
                },
            ],
        },
    ],
    patterns: [
        { id: 'mini.get', role: 'entry_point', regex: String.raw`\bGET\(` },
        { id: 'mini.post', role: 'entry_point', regex: String.raw`\bPOST\(` },
        { id: 'mini.guard', role: 'auth_check', regex: String.raw`\bguard\(` },
        {
            id: 'mini.exec',
            role: 'sink',
            regex: String.raw`\bexec\(`,
            vulnClass: 'injection',
            cwe: 'CWE-78',
        },
        {
            id: 'mini.fetch',
            role: 'sink',
            regex: String.raw`\bfetch\(`,
            vulnClass: 'ssrf',
            cwe: 'CWE-918',
        },
        {
            id: 'mini.shell-fetch',
            role: 'sink',
            regex: String.raw`\bexec\(fetch\(`,
            vulnClass: 'injection',
            cwe: 'CWE-78',
        },
    ],
};

const MINI_FILES = {
    'src/app.mini': [
        'GET(/users) guard(admin)',
        'POST(/run)',
        'exec(fetch(url))',
        'nothing here',
    ].join('\n'),
    'src/other.mini': 'fetch(x)',
    'routes.mini': 'route /a',
    'src/app.spec.mini': 'exec(x)',
    'vendor/lib.mini': 'exec(y)',
    'gen/out.mini': 'exec(z)',
    'src/app.txt': 'exec(no)',
};

describe('collectSurface', () => {
    const run = (
        files: Record<string, string>,
        grep: GrepFn = createFakeGrep(files),
        extra: Partial<Parameters<typeof collectSurface>[1]> = {},
    ) =>
        collectSurface(grep, {
            languages: ['mini'],
            surfaces: [MINI],
            ...extra,
        });

    it('attributes a search to one pattern without re-testing repository text', async () => {
        const grep = createFakeGrep(MINI_FILES);
        await run(MINI_FILES, grep);
        expect(grep.calls.map(c => c.pattern)).toEqual([...MINI.patterns, ...MINI.extraGlobs![0].patterns].map(p => p.regex));
    });

    it('attributes each line to every pattern it matches and aggregates per file', async () => {
        const map = await run(MINI_FILES, undefined, {
            excludeGlobs: ['gen/**'],
        });
        expect(map.languages).toEqual(['mini']);
        expect(map.errors).toEqual([]);
        expect(
            map.hits.map((h) => `${h.file}:${h.line}:${h.patternId}`).sort(),
        ).toEqual(
            [
                'routes.mini:1:mini.routes',
                'src/app.mini:1:mini.get',
                'src/app.mini:1:mini.guard',
                'src/app.mini:2:mini.post',
                'src/app.mini:3:mini.exec',
                'src/app.mini:3:mini.fetch',
                'src/app.mini:3:mini.shell-fetch',
                'src/other.mini:1:mini.fetch',
            ].sort(),
        );
        const exec = map.hits.find((h) => h.patternId === 'mini.exec');
        expect(exec).toMatchObject({
            role: 'sink',
            vulnClass: 'injection',
            cwe: 'CWE-78',
            language: 'mini',
            text: 'exec(fetch(url))',
        });
        expect(map.files['src/app.mini']).toEqual({
            entryPoints: 2,
            authChecks: 1,
            sinks: 3,
            classes: ['injection', 'ssrf'],
        });
        expect(map.files['src/other.mini']).toEqual({
            entryPoints: 0,
            authChecks: 0,
            sinks: 1,
            classes: ['ssrf'],
        });
    });

    it('skips test, vendored and excluded paths', async () => {
        const map = await run(MINI_FILES, undefined, {
            excludeGlobs: ['gen/**'],
        });
        const files = Object.keys(map.files);
        expect(files).not.toContain('src/app.spec.mini');
        expect(files).not.toContain('vendor/lib.mini');
        expect(files).not.toContain('gen/out.mini');
    });

    it('ignores languages that were not requested', async () => {
        const grep = createFakeGrep(MINI_FILES);
        const map = await collectSurface(grep, {
            languages: ['python'],
            surfaces: [MINI],
        });
        expect(grep.calls).toEqual([]);
        expect(map).toEqual({ languages: [], hits: [], files: {}, errors: [] });
    });

    it('records an Error: answer for one role and still collects the others', async () => {
        const fake = createFakeGrep(MINI_FILES);
        const grep = Object.assign(
            async (pattern: string, path: string, glob?: string) =>
                pattern.includes('guard')
                    ? 'Error: regex parse error: repetition operator missing expression'
                    : fake(pattern, path, glob),
            { calls: fake.calls },
        );
        const map = await run(MINI_FILES, grep);
        expect(map.errors).toEqual([
            {
                language: 'mini',
                patternIds: ['mini.guard'],
                message:
                    'Error: regex parse error: repetition operator missing expression',
            },
        ]);
        expect(map.hits.some((h) => h.role === 'auth_check')).toBe(false);
        expect(map.hits.some((h) => h.role === 'sink')).toBe(true);
    });

    it('never throws when grep rejects', async () => {
        const grep = async () => {
            throw new Error('sandbox gone');
        };
        const map = await run(MINI_FILES, grep);
        expect(map.hits).toEqual([]);
        expect(map.errors).toHaveLength(MINI.patterns.length + MINI.extraGlobs![0].patterns.length);
        expect(map.errors[0].message).toBe('grep failed: sandbox gone');
    });

    it(`caps hits per pattern at ${MAX_HITS_PER_PATTERN} and reports the truncation`, async () => {
        const files = {
            'big.mini': Array.from(
                { length: MAX_HITS_PER_PATTERN + 5 },
                () => 'exec(a)',
            ).join('\n'),
        };
        const map = await run(files);
        expect(
            map.hits.filter((h) => h.patternId === 'mini.exec'),
        ).toHaveLength(MAX_HITS_PER_PATTERN);
        expect(map.errors).toEqual([
            {
                language: 'mini',
                patternIds: ['mini.exec'],
                message: `truncated: kept ${MAX_HITS_PER_PATTERN} hits, dropped 5`,
            },
        ]);
    });

    it('keeps a file whose every hit fell past the cap as a candidate', async () => {
        const files = {
            'a.mini': Array.from(
                { length: MAX_HITS_PER_PATTERN },
                () => 'exec(a)',
            ).join('\n'),
            'b.mini': 'exec(b)',
        };
        const map = await run(files);

        expect(
            map.hits.filter((h) => h.patternId === 'mini.exec'),
        ).toHaveLength(MAX_HITS_PER_PATTERN);
        expect(Object.keys(map.files).sort()).toEqual(['a.mini', 'b.mini']);
        expect(map.files['b.mini'].sinks).toBe(1);
    });

    it('scans a multi-language repo with the real surfaces', async () => {
        const files = {
            'src/routes.ts':
                "app.get('/users/:id', async (req, res) => {\n  const u = await User.findById(req.params.id);\n  res.json(u);\n});",
            'api/views.py':
                'def detail(request, pk):\n    os.system("ls " + request.GET["d"])',
            'README.md': "app.get('/x', h)",
        };
        const map = await collectSurface(createFakeGrep(files), {
            languages: detectLanguages(Object.keys(files)),
        });
        expect(map.languages).toEqual(['typescript', 'python']);
        expect(map.errors).toEqual([]);
        expect(map.files['src/routes.ts']).toMatchObject({
            entryPoints: 1,
            classes: ['authz'],
        });
        expect(map.files['api/views.py']).toMatchObject({
            entryPoints: 1,
            classes: ['injection'],
        });
        expect(map.files['README.md']).toBeUndefined();
    });

    (hasRipgrep() ? it : it.skip)(
        'surfaces a regex ripgrep rejects (valid in JS, not in Rust) as an error',
        async () => {
            const bad: LanguageSurface = {
                ...MINI,
                extraGlobs: [],
                patterns: [
                    ...MINI.patterns,
                    // A bare `{` is a literal in JS but a parse error in Rust.
                    { id: 'mini.bad', role: 'auth_check', regex: 'guard{' },
                ],
            };
            const rg = createRipgrep(MINI_FILES);
            try {
                const map = await collectSurface(rg.grep, {
                    languages: ['mini'],
                    surfaces: [bad],
                });
                expect(map.errors).toHaveLength(1);
                expect(map.errors[0].patternIds).toEqual([
                    'mini.bad',
                ]);
                expect(map.errors[0].message).toMatch(/^Error:/);
                expect(map.hits.some((h) => h.patternId === 'mini.exec')).toBe(
                    true,
                );
            } finally {
                rg.cleanup();
            }
        },
    );

    it('runs exactly one grep per real pattern', () => {
        const ts = LANGUAGE_SURFACES.find(s => s.language === 'typescript')!;
        expect(planBatches(ts).map(b => b.patterns)).toEqual(ts.patterns.map(p => [p]));
    });
});

describe('bounded tracked-source searches', () => {
    (hasRipgrep() ? it : it.skip)('ignores repository ignore rules, preserves Unicode hits and skips large vendor bundles', async () => {
        const rg = createRipgrep({
            '.rgignore': 'api/\n', '.ignore': 'api/\n',
            'api/views.py': 'def visão_pedido(request):\n    return request.GET["q"]',
            'vendor/lib/bundle.py': 'x'.repeat(7 * 1024 * 1024),
        });
        try {
            const map = await collectSurface(rg.grep, {languages: ['python']});
            expect(map.hits.some(h => h.file === 'api/views.py' && h.role === 'entry_point')).toBe(true);
            expect(map.hits.some(h => h.file.startsWith('vendor/'))).toBe(false);
            expect(map.errors).toEqual([]);
        } finally { rg.cleanup(); }
    });
    (hasRipgrep() ? it : it.skip)('does not re-test a hostile SQL line with V8', async () => {
        const rg = createRipgrep({'app/views.py': '"' + 'select a from b {x} '.repeat(260)});
        const start = performance.now();
        try {
            await collectSurface(rg.grep, {languages: ['python']});
            expect(performance.now() - start).toBeLessThan(2000);
        } finally { rg.cleanup(); }
    });
    it('does not exclude real nested build/deps/vendor packages', () => {
        for (const file of ['cmd/build/main.go', 'internal/deps/resolver.go', 'pkg/vendor/client.go']) {
            expect(isSkippedPath(file)).toBe(false);
        }
        expect(isSkippedPath('vendor/library.go')).toBe(true);
    });
});
