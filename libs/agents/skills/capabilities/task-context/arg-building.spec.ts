import { buildTaskContextArgsCandidates } from './arg-building';
import type {
    TaskContextHints,
    TaskContextReadParams,
    TaskContextToolSignature,
} from './task-context.types';

const params = (o: Partial<TaskContextReadParams> = {}): TaskContextReadParams =>
    ({ skillName: 's', organizationId: 'o', teamId: 't', ...o }) as TaskContextReadParams;

const hints = (o: Partial<TaskContextHints> = {}): TaskContextHints => ({
    issueKeys: [],
    issueNumbers: [],
    issueLinks: [],
    explicitIssueKeys: [],
    explicitIssueLinks: [],
    queryText: '',
    urlHosts: [],
    siteUrls: [],
    siteIds: [],
    resourceIds: [],
    ...o,
});

describe('buildTaskContextArgsCandidates (characterization)', () => {
    it('with no signature, builds generic arg candidates from hints tokens', () => {
        const out = buildTaskContextArgsCandidates(
            params(),
            hints({ explicitIssueKeys: ['PROJ-1'] }),
        );
        // PROJ-1 is an issue key → emits id/key/issueKey/... shaped args
        expect(out).toEqual(
            expect.arrayContaining([
                { key: 'PROJ-1' },
                { issueKey: 'PROJ-1' },
            ]),
        );
    });

    it('fills a static param (organizationId) from params', () => {
        const sig: TaskContextToolSignature = {
            requiredParams: ['organizationId'],
            properties: { organizationId: { type: 'string' } },
            normalizedProperties: { organizationid: { type: 'string' } },
        };
        const out = buildTaskContextArgsCandidates(
            params({ organizationId: 'org-42' }),
            hints(),
            sig,
        );
        expect(out).toEqual([{ organizationId: 'org-42' }]);
    });

    it('returns [] when a required param cannot be satisfied', () => {
        const sig: TaskContextToolSignature = {
            requiredParams: ['issueNumber'],
            properties: { issueNumber: { type: 'number' } },
            normalizedProperties: { issuenumber: { type: 'number' } },
        };
        // no issueNumbers in hints → required param unsatisfiable → drop
        const out = buildTaskContextArgsCandidates(params(), hints(), sig);
        expect(out).toEqual([]);
    });

    it('maps an issue-intent string param to the issue keys', () => {
        const sig: TaskContextToolSignature = {
            requiredParams: ['issueKey'],
            properties: { issueKey: { type: 'string' } },
            normalizedProperties: { issuekey: { type: 'string' } },
        };
        const out = buildTaskContextArgsCandidates(
            params(),
            hints({ issueKeys: ['AB-9'] }),
            sig,
        );
        expect(out).toEqual([{ issueKey: 'AB-9' }]);
    });

    describe('tenant-scoped tools (e.g. Atlassian getJiraIssue)', () => {
        const jiraSig: TaskContextToolSignature = {
            requiredParams: ['cloudId', 'issueIdOrKey'],
            properties: {
                cloudId: { type: 'string' },
                issueIdOrKey: { type: 'string' },
            },
            normalizedProperties: {
                cloudid: { type: 'string' },
                issueidorkey: { type: 'string' },
            },
        };

        it('drops the tool when only a bare ticket key is available', () => {
            const out = buildTaskContextArgsCandidates(
                params(),
                hints({ issueKeys: ['CLF-1'] }),
                jiraSig,
            );
            expect(out).toEqual([]);
        });

        it('builds the call once the site id is resolved out-of-band', () => {
            const out = buildTaskContextArgsCandidates(
                params(),
                hints({ issueKeys: ['CLF-1'], siteIds: ['cloud-uuid'] }),
                jiraSig,
            );
            expect(out).toEqual([
                { cloudId: 'cloud-uuid', issueIdOrKey: 'CLF-1' },
            ]);
        });

        it('keeps every resolved site as a candidate, not just the first two', () => {
            const out = buildTaskContextArgsCandidates(
                params(),
                hints({
                    issueKeys: ['CLF-1'],
                    siteIds: ['site-1', 'site-2', 'site-3', 'site-4'],
                }),
                jiraSig,
            );
            expect(out.map((args) => args.cloudId)).toEqual([
                'site-1',
                'site-2',
                'site-3',
                'site-4',
            ]);
        });

        it('bounds the tenant candidates, since each one costs a remote call', () => {
            const out = buildTaskContextArgsCandidates(
                params(),
                hints({
                    issueKeys: ['CLF-1'],
                    siteIds: ['s1', 's2', 's3', 's4'],
                    siteUrls: ['https://a.example', 'https://b.example'],
                    urlHosts: ['c.example', 'd.example'],
                }),
                jiraSig,
            );
            expect(out).toHaveLength(6);
        });

        it('prefers the resolved site id over a host mined from PR prose', () => {
            const out = buildTaskContextArgsCandidates(
                params(),
                hints({
                    issueKeys: ['CLF-1'],
                    siteIds: ['cloud-uuid'],
                    urlHosts: ['unrelated.example.com'],
                }),
                jiraSig,
            );
            expect(out[0]).toEqual({
                cloudId: 'cloud-uuid',
                issueIdOrKey: 'CLF-1',
            });
        });

        it('never stuffs the issue key into a closed-enum param exposed via anyOf (#1760)', () => {
            // Atlassian MCP / Zod expose `responseContentFormat: 'markdown'|'adf'`
            // as an `anyOf` of `const` branches, NOT a top-level `enum` — the
            // closed-enum guard used to miss it, so DEV-5400 was written into
            // responseContentFormat and the tool rejected the call with -32602.
            const sig: TaskContextToolSignature = {
                requiredParams: ['cloudId', 'issueIdOrKey'],
                properties: {
                    cloudId: { type: 'string' },
                    issueIdOrKey: { type: 'string' },
                    responseContentFormat: {
                        anyOf: [
                            { const: 'markdown' },
                            { const: 'adf' },
                        ],
                    },
                },
                normalizedProperties: {
                    cloudid: { type: 'string' },
                    issueidorkey: { type: 'string' },
                    responsecontentformat: {
                        anyOf: [
                            { const: 'markdown' },
                            { const: 'adf' },
                        ],
                    },
                },
            };

            const out = buildTaskContextArgsCandidates(
                params(),
                hints({
                    issueKeys: ['DEV-5400'],
                    siteIds: ['cloud-uuid'],
                }),
                sig,
            );

            // Every candidate must carry the real issue key in the key field,
            // never in responseContentFormat.
            expect(out.length).toBeGreaterThan(0);
            for (const args of out) {
                expect(args.issueIdOrKey).toBe('DEV-5400');
                if ('responseContentFormat' in args) {
                    expect(['markdown', 'adf']).toContain(
                        args.responseContentFormat,
                    );
                }
            }
        });

        it('keeps a closed enum via anyOf over a top-level enum empty (#1760)', () => {
            // A lone `const` param is also a closed value set — must not fall
            // through to generic string handling.
            const sig: TaskContextToolSignature = {
                requiredParams: ['issueKey', 'outputFormat'],
                properties: {
                    issueKey: { type: 'string' },
                    outputFormat: { const: 'markdown' },
                },
                normalizedProperties: {
                    issuekey: { type: 'string' },
                    outputformat: { const: 'markdown' },
                },
            };

            const out = buildTaskContextArgsCandidates(
                params(),
                hints({ issueKeys: ['WWW-2'] }),
                sig,
            );

            expect(out.length).toBeGreaterThan(0);
            for (const args of out) {
                expect(args.issueKey).toBe('WWW-2');
                expect(args.outputFormat).toBe('markdown');
            }
        });

        it('keeps issue keys flowing into a param with const + open string branches', () => {
            // A union like `anyOf: [{type:'string'}, {const:'default'}]` is an
            // OPEN text param (free-form text with a suggested default), not a
            // closed enum. The issue key must still flow through it — treating
            // it as closed would replace the real value with the const.
            const sig: TaskContextToolSignature = {
                requiredParams: ['issueKey', 'format'],
                properties: {
                    issueKey: { type: 'string' },
                    format: {
                        anyOf: [{ type: 'string' }, { const: 'default' }],
                    },
                },
                normalizedProperties: {
                    issuekey: { type: 'string' },
                    format: {
                        anyOf: [{ type: 'string' }, { const: 'default' }],
                    },
                },
            };

            const out = buildTaskContextArgsCandidates(
                params(),
                hints({ issueKeys: ['FMT-7'] }),
                sig,
            );

            expect(out.length).toBeGreaterThan(0);
            for (const args of out) {
                expect(args.issueKey).toBe('FMT-7');
                // Open string param: the const must NOT replace the real
                // value. The issue key flows through because the param is
                // treated as free-form, not narrowed to the const.
                expect(args.format).toBe('FMT-7');
            }
        });
    });
});
