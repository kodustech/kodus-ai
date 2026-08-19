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
    });
});
