import { SkillLoaderService } from './skill-loader.service';

/**
 * Mutation-killing unit tests for the deterministic, pure logic in
 * SkillLoaderService: frontmatter parsing and the normalize/map helpers that
 * translate hyphen-cased YAML frontmatter into the camelCased SkillMeta shape.
 *
 * The service constructor only builds a Nest Logger (no injected deps), so it is
 * instantiated directly; the private helpers are reached via `(svc as any)`.
 */
describe('SkillLoaderService — deterministic logic', () => {
    let svc: SkillLoaderService;

    beforeEach(() => {
        svc = new SkillLoaderService();
        // Silence the informational/warning logs these branches emit.
        jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
        jest.spyOn((svc as any).logger, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const parse = (raw: string) => (svc as any).parseFrontmatter(raw);
    const mapFetcher = (v: unknown) => (svc as any).mapFetcherPolicy(v);
    const mapExec = (v: unknown) => (svc as any).mapExecutionPolicy(v);
    const mapContracts = (v: unknown) => (svc as any).mapContracts(v);
    const normTools = (v: unknown) => (svc as any).normalizeAllowedTools(v);
    const normToolMap = (v: unknown) =>
        (svc as any).normalizeCapabilityToolMap(v);
    const normDefs = (v: unknown) =>
        (svc as any).normalizeCapabilityDefinitions(v);

    // ─── normalizeAllowedTools ──────────────────────────────────────────────
    describe('normalizeAllowedTools', () => {
        it('filters an array to non-empty strings, preserving order and un-trimmed content', () => {
            const result = normTools(['a', '   ', 'b', 123, '', ' c ', null]);
            // Non-string / blank-after-trim entries drop; kept items are NOT
            // trimmed themselves — ' c ' survives verbatim.
            expect(result).toEqual(['a', 'b', ' c ']);
        });

        it('returns an empty array (not undefined) for an empty array input', () => {
            expect(normTools([])).toEqual([]);
        });

        it('splits a whitespace-delimited string on any whitespace run', () => {
            expect(normTools('tool-a   tool-b\ttool-c\ntool-d')).toEqual([
                'tool-a',
                'tool-b',
                'tool-c',
                'tool-d',
            ]);
        });

        it('trims surrounding whitespace of a single-token string', () => {
            expect(normTools('  solo  ')).toEqual(['solo']);
        });

        it('returns undefined for a whitespace-only string', () => {
            expect(normTools('   \t  ')).toBeUndefined();
        });

        it('returns undefined for an empty string', () => {
            expect(normTools('')).toBeUndefined();
        });

        it('returns undefined for non-array, non-string values', () => {
            expect(normTools(123)).toBeUndefined();
            expect(normTools(null)).toBeUndefined();
            expect(normTools(undefined)).toBeUndefined();
            expect(normTools({ a: 1 })).toBeUndefined();
            expect(normTools(true)).toBeUndefined();
        });
    });

    // ─── mapFetcherPolicy ───────────────────────────────────────────────────
    describe('mapFetcherPolicy', () => {
        it('maps hyphen keys to camelCase for a full valid payload', () => {
            expect(
                mapFetcher({
                    'tool-mode': 'any',
                    'allow-without-tools': false,
                }),
            ).toEqual({ toolMode: 'any', allowWithoutTools: false });
        });

        it('maps tool-mode "all" and allow-without-tools true', () => {
            expect(
                mapFetcher({ 'tool-mode': 'all', 'allow-without-tools': true }),
            ).toEqual({ toolMode: 'all', allowWithoutTools: true });
        });

        it('returns an object with undefined fields for an empty object (loose schema)', () => {
            expect(mapFetcher({})).toEqual({
                toolMode: undefined,
                allowWithoutTools: undefined,
            });
        });

        it('returns undefined when tool-mode is not in the enum', () => {
            expect(mapFetcher({ 'tool-mode': 'sometimes' })).toBeUndefined();
        });

        it('returns undefined when allow-without-tools is not a boolean', () => {
            expect(
                mapFetcher({ 'allow-without-tools': 'yes' }),
            ).toBeUndefined();
        });

        it('returns undefined for non-object values', () => {
            expect(mapFetcher(undefined)).toBeUndefined();
            expect(mapFetcher('all')).toBeUndefined();
            expect(mapFetcher(null)).toBeUndefined();
        });
    });

    // ─── mapExecutionPolicy ─────────────────────────────────────────────────
    describe('mapExecutionPolicy', () => {
        it('maps all six hyphen keys to their camelCase counterparts', () => {
            expect(
                mapExec({
                    'on-missing-mcp': 'fallback',
                    'on-mcp-connect-error': 'fail',
                    'fetcher-timeout-ms': 5000,
                    'analyzer-timeout-ms': 6000,
                    'fetcher-max-iterations': 3,
                    'analyzer-max-iterations': 4,
                }),
            ).toEqual({
                onMissingMcp: 'fallback',
                onMcpConnectError: 'fail',
                fetcherTimeoutMs: 5000,
                analyzerTimeoutMs: 6000,
                fetcherMaxIterations: 3,
                analyzerMaxIterations: 4,
            });
        });

        it('returns all-undefined fields for an empty object', () => {
            expect(mapExec({})).toEqual({
                onMissingMcp: undefined,
                onMcpConnectError: undefined,
                fetcherTimeoutMs: undefined,
                analyzerTimeoutMs: undefined,
                fetcherMaxIterations: undefined,
                analyzerMaxIterations: undefined,
            });
        });

        it('accepts 1 as the smallest valid positive-int timeout', () => {
            expect(mapExec({ 'fetcher-timeout-ms': 1 })).toEqual({
                onMissingMcp: undefined,
                onMcpConnectError: undefined,
                fetcherTimeoutMs: 1,
                analyzerTimeoutMs: undefined,
                fetcherMaxIterations: undefined,
                analyzerMaxIterations: undefined,
            });
        });

        it('rejects zero (not positive) — boundary below 1', () => {
            expect(mapExec({ 'fetcher-timeout-ms': 0 })).toBeUndefined();
        });

        it('rejects a negative timeout', () => {
            expect(mapExec({ 'fetcher-timeout-ms': -1 })).toBeUndefined();
        });

        it('rejects a non-integer timeout', () => {
            expect(mapExec({ 'fetcher-timeout-ms': 1.5 })).toBeUndefined();
        });

        it('returns undefined when an enum field is out of range', () => {
            expect(mapExec({ 'on-missing-mcp': 'retry' })).toBeUndefined();
        });

        it('returns undefined for non-object values', () => {
            expect(mapExec(undefined)).toBeUndefined();
            expect(mapExec(42)).toBeUndefined();
        });
    });

    // ─── mapContracts ───────────────────────────────────────────────────────
    describe('mapContracts', () => {
        it('maps both input and output blocks', () => {
            expect(
                mapContracts({
                    input: { 'required-context-fields': ['ctx.a', 'ctx.b'] },
                    output: { 'required-fields': ['out.x'] },
                }),
            ).toEqual({
                input: { requiredContextFields: ['ctx.a', 'ctx.b'] },
                output: { requiredFields: ['out.x'] },
            });
        });

        it('leaves output undefined when only input is present', () => {
            expect(
                mapContracts({
                    input: { 'required-context-fields': ['ctx.a'] },
                }),
            ).toEqual({
                input: { requiredContextFields: ['ctx.a'] },
                output: undefined,
            });
        });

        it('leaves input undefined when only output is present', () => {
            expect(
                mapContracts({ output: { 'required-fields': ['out.x'] } }),
            ).toEqual({
                input: undefined,
                output: { requiredFields: ['out.x'] },
            });
        });

        it('keeps a present-but-empty input block, with undefined fields', () => {
            expect(mapContracts({ input: {} })).toEqual({
                input: { requiredContextFields: undefined },
                output: undefined,
            });
        });

        it('returns both-undefined for an empty object', () => {
            expect(mapContracts({})).toEqual({
                input: undefined,
                output: undefined,
            });
        });

        it('returns undefined when required-context-fields is not an array', () => {
            expect(
                mapContracts({
                    input: { 'required-context-fields': 'ctx.a' },
                }),
            ).toBeUndefined();
        });

        it('returns undefined for non-object values', () => {
            expect(mapContracts(undefined)).toBeUndefined();
            expect(mapContracts('x')).toBeUndefined();
        });
    });

    // ─── normalizeCapabilityToolMap ─────────────────────────────────────────
    describe('normalizeCapabilityToolMap', () => {
        it('normalizes each capability entry (string and array forms)', () => {
            expect(
                normToolMap({ capA: 'tool-1 tool-2', capB: ['tool-3'] }),
            ).toEqual({ capA: ['tool-1', 'tool-2'], capB: ['tool-3'] });
        });

        it('drops entries whose capability key is blank after trim', () => {
            expect(
                normToolMap({ '   ': ['tool-1'], 'capB': ['tool-2'] }),
            ).toEqual({ capB: ['tool-2'] });
        });

        it('drops entries whose tools normalize to empty', () => {
            expect(
                normToolMap({ capA: '   ', capB: [], capC: ['keep'] }),
            ).toEqual({ capC: ['keep'] });
        });

        it('returns undefined when every entry is dropped', () => {
            expect(normToolMap({ 'capA': '   ', '  ': ['x'] })).toBeUndefined();
        });

        it('returns undefined for an empty object', () => {
            expect(normToolMap({})).toBeUndefined();
        });

        it('returns undefined for non-object values', () => {
            expect(normToolMap(undefined)).toBeUndefined();
            expect(normToolMap('x')).toBeUndefined();
            expect(normToolMap(null)).toBeUndefined();
        });
    });

    // ─── normalizeCapabilityDefinitions ─────────────────────────────────────
    describe('normalizeCapabilityDefinitions', () => {
        it('keeps an explicit fixed_tools definition with its tools', () => {
            expect(
                normDefs({
                    capA: { mode: 'fixed_tools', tools: ['t1', 't2'] },
                }),
            ).toEqual({ capA: { mode: 'fixed_tools', tools: ['t1', 't2'] } });
        });

        it('drops the tools field for a provider_dynamic definition', () => {
            expect(
                normDefs({
                    capA: { mode: 'provider_dynamic', tools: ['ignored'] },
                }),
            ).toEqual({ capA: { mode: 'provider_dynamic' } });
        });

        it('keeps a provider_dynamic definition that has no tools', () => {
            expect(normDefs({ capA: { mode: 'provider_dynamic' } })).toEqual({
                capA: { mode: 'provider_dynamic' },
            });
        });

        it('infers fixed_tools when only tools are given (no mode)', () => {
            expect(normDefs({ capA: { tools: 'a b' } })).toEqual({
                capA: { mode: 'fixed_tools', tools: ['a', 'b'] },
            });
        });

        it('infers fixed_tools when mode is invalid but tools are present', () => {
            expect(normDefs({ capA: { mode: 'bogus', tools: ['x'] } })).toEqual(
                { capA: { mode: 'fixed_tools', tools: ['x'] } },
            );
        });

        it('drops a fixed_tools definition with no usable tools', () => {
            expect(
                normDefs({ capA: { mode: 'fixed_tools', tools: [] } }),
            ).toBeUndefined();
            expect(normDefs({ capA: { mode: 'fixed_tools' } })).toBeUndefined();
        });

        it('drops a definition with neither a valid mode nor tools', () => {
            expect(normDefs({ capA: { mode: 'bogus' } })).toBeUndefined();
            expect(normDefs({ capA: { tools: [] } })).toBeUndefined();
            expect(normDefs({ capA: 'not-an-object' })).toBeUndefined();
        });

        it('drops entries whose capability key is blank after trim', () => {
            expect(
                normDefs({
                    '   ': { mode: 'provider_dynamic' },
                    'capB': { mode: 'provider_dynamic' },
                }),
            ).toEqual({ capB: { mode: 'provider_dynamic' } });
        });

        it('returns undefined for an empty object', () => {
            expect(normDefs({})).toBeUndefined();
        });

        it('returns undefined for non-object values', () => {
            expect(normDefs(undefined)).toBeUndefined();
            expect(normDefs('x')).toBeUndefined();
        });
    });

    // ─── parseFrontmatter ───────────────────────────────────────────────────
    describe('parseFrontmatter', () => {
        it('returns the raw string as body with empty meta when there is no frontmatter', () => {
            const raw = 'Just a plain body\nwith no frontmatter.';
            expect(parse(raw)).toEqual({ body: raw, meta: {} });
        });

        it('extracts scalar fields and trims the leading whitespace of the body', () => {
            const raw =
                '---\nname: my-skill\ndescription: A skill\nlicense: MIT\n---\n\n\n  Body content';
            const result = parse(raw);
            expect(result.body).toBe('Body content');
            expect(result.meta.name).toBe('my-skill');
            expect(result.meta.description).toBe('A skill');
            expect(result.meta.license).toBe('MIT');
        });

        it('falls back to empty meta (but keeps the body) when the YAML is malformed', () => {
            // Unterminated quoted scalar makes js-yaml throw.
            const raw = '---\nname: "unterminated\n---\nBODY';
            expect(parse(raw)).toEqual({ body: 'BODY', meta: {} });
        });

        it('falls back to empty meta when a field violates the schema type', () => {
            // `name` must be a string; a number fails safeParse.
            const raw = '---\nname: 123\n---\nBODY';
            expect(parse(raw)).toEqual({ body: 'BODY', meta: {} });
        });

        it('coerces a numeric metadata.version to a string', () => {
            const raw = '---\nmetadata:\n  version: 2\n---\nBODY';
            expect(parse(raw).meta.version).toBe('2');
        });

        it('keeps a string metadata.version verbatim', () => {
            const raw = '---\nmetadata:\n  version: "1.4.0"\n---\nBODY';
            expect(parse(raw).meta.version).toBe('1.4.0');
        });

        it('leaves version undefined when metadata has no version', () => {
            const raw = '---\nmetadata:\n  other: x\n---\nBODY';
            expect(parse(raw).meta.version).toBeUndefined();
        });

        it('parses top-level (legacy) allowed-tools as a whitespace list', () => {
            const raw = '---\nallowed-tools: tool-a tool-b\n---\nBODY';
            expect(parse(raw).meta.allowedTools).toEqual(['tool-a', 'tool-b']);
        });

        it('reads Kodus extensions from metadata.kodus and maps them fully', () => {
            const raw = [
                '---',
                'name: kodus-skill',
                'metadata:',
                '  version: 3',
                '  kodus:',
                '    capabilities:',
                '      - cap-1',
                '    fetcher-policy:',
                '      tool-mode: all',
                '      allow-without-tools: true',
                '    execution-policy:',
                '      on-missing-mcp: fallback',
                '      fetcher-timeout-ms: 5000',
                '    contracts:',
                '      input:',
                '        required-context-fields:',
                '          - ctx.a',
                '    capability-tool-map:',
                '      capX:',
                '        - toolY',
                '    capability-definitions:',
                '      capZ:',
                '        mode: provider_dynamic',
                '    required-mcps:',
                '      - category: task',
                '        label: Task',
                '---',
                'BODY',
            ].join('\n');

            const meta = parse(raw).meta;
            expect(meta.capabilities).toEqual(['cap-1']);
            expect(meta.fetcherPolicy).toEqual({
                toolMode: 'all',
                allowWithoutTools: true,
            });
            expect(meta.executionPolicy).toEqual({
                onMissingMcp: 'fallback',
                onMcpConnectError: undefined,
                fetcherTimeoutMs: 5000,
                analyzerTimeoutMs: undefined,
                fetcherMaxIterations: undefined,
                analyzerMaxIterations: undefined,
            });
            expect(meta.contracts).toEqual({
                input: { requiredContextFields: ['ctx.a'] },
                output: undefined,
            });
            expect(meta.capabilityToolMap).toEqual({ capX: ['toolY'] });
            expect(meta.capabilityDefinitions).toEqual({
                capZ: { mode: 'provider_dynamic' },
            });
            expect(meta.requiredMcps).toEqual([
                { category: 'task', label: 'Task' },
            ]);
        });

        it('prefers metadata.kodus over the legacy top-level key when both are present', () => {
            const raw = [
                '---',
                'fetcher-policy:',
                '  tool-mode: any',
                'metadata:',
                '  kodus:',
                '    fetcher-policy:',
                '      tool-mode: all',
                '---',
                'BODY',
            ].join('\n');
            // kodus wins: 'all', not the top-level 'any'.
            expect(parse(raw).meta.fetcherPolicy).toEqual({
                toolMode: 'all',
                allowWithoutTools: undefined,
            });
        });

        it('falls back to the legacy top-level key when metadata.kodus is absent', () => {
            const raw = [
                '---',
                'fetcher-policy:',
                '  tool-mode: any',
                '---',
                'BODY',
            ].join('\n');
            expect(parse(raw).meta.fetcherPolicy).toEqual({
                toolMode: 'any',
                allowWithoutTools: undefined,
            });
        });

        it('ignores Kodus extensions but keeps spec meta when metadata.kodus fails its schema', () => {
            const raw = [
                '---',
                'name: still-parsed',
                'metadata:',
                '  kodus:',
                '    fetcher-policy:',
                '      tool-mode: not-a-mode',
                '---',
                'BODY',
            ].join('\n');
            const meta = parse(raw).meta;
            // Spec-level field survives; the invalid kodus block is dropped.
            expect(meta.name).toBe('still-parsed');
            expect(meta.fetcherPolicy).toBeUndefined();
        });
    });
});
