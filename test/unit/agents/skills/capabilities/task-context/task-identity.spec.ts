import { matchesRequestedTask } from '@libs/agents/skills/capabilities/task-context/task-identity';
import type { TaskContextHints } from '@libs/agents/skills/capabilities/task-context/task-context.types';

const hints = (overrides: Partial<TaskContextHints> = {}): TaskContextHints => ({
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
    ...overrides,
});

describe('matchesRequestedTask', () => {
    it('accepts anything when the PR named no task', () => {
        expect(matchesRequestedTask({ title: 'Some issue' }, hints())).toBe(
            true,
        );
    });

    it('matches a git issue by the number in its url', () => {
        expect(
            matchesRequestedTask(
                {
                    id: '5327004871',
                    title: 'Rate-limit the sender',
                    links: ['https://github.com/acme/repo/issues/993'],
                },
                hints({ issueNumbers: [993] }),
            ),
        ).toBe(true);
    });

    it('rejects a different issue returned by a list tool', () => {
        expect(
            matchesRequestedTask(
                {
                    id: '5327083306',
                    title: 'Persist audit log entries',
                    links: ['https://github.com/acme/repo/issues/995'],
                },
                hints({ issueNumbers: [993] }),
            ),
        ).toBe(false);
    });

    it('does not confuse issue 99 with issue 993', () => {
        expect(
            matchesRequestedTask(
                { links: ['https://github.com/acme/repo/issues/993'] },
                hints({ issueNumbers: [99] }),
            ),
        ).toBe(false);
    });

    it('matches a jira-style key on the id, case-insensitively', () => {
        expect(
            matchesRequestedTask(
                { id: 'proj-42', title: 'Add retries' },
                hints({ issueKeys: ['PROJ-42'] }),
            ),
        ).toBe(true);
    });

    it('rejects a neighbouring key from the same project', () => {
        expect(
            matchesRequestedTask(
                { id: 'PROJ-43', title: 'Add retries' },
                hints({ issueKeys: ['PROJ-42'] }),
            ),
        ).toBe(false);
    });

    it('matches a key quoted in the title when the id is an internal one', () => {
        expect(
            matchesRequestedTask(
                { id: '10432', title: 'PROJ-42: add retries' },
                hints({ issueKeys: ['PROJ-42'] }),
            ),
        ).toBe(true);
    });

    it('matches when the requested link is the task url', () => {
        expect(
            matchesRequestedTask(
                { links: ['https://acme.atlassian.net/browse/PROJ-42'] },
                hints({
                    issueLinks: ['https://acme.atlassian.net/browse/PROJ-42'],
                }),
            ),
        ).toBe(true);
    });

    it('accepts a bare number id when the provider ids issues by number', () => {
        expect(
            matchesRequestedTask({ id: '993' }, hints({ issueNumbers: [993] })),
        ).toBe(true);
    });

    it('ignores a #-prefixed pseudo key and matches on the number instead', () => {
        expect(
            matchesRequestedTask(
                { links: ['https://github.com/acme/repo/issues/993'] },
                hints({ issueKeys: ['#993'], issueNumbers: [993] }),
            ),
        ).toBe(true);
    });
});
