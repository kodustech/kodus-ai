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
});
