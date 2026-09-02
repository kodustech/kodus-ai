import { extractTaskContextFromToolResult } from './result-normalization';

describe('extractTaskContextFromToolResult (characterization)', () => {
    it('normalizes a Jira-ish payload (key/summary/ADF description)', () => {
        const payload = {
            issue: {
                key: 'PROJ-12',
                fields: {
                    summary: 'Add logout button',
                    description: {
                        type: 'doc',
                        content: [
                            {
                                type: 'paragraph',
                                content: [
                                    { type: 'text', text: 'Revoke sessions on logout.' },
                                ],
                            },
                        ],
                    },
                },
            },
        };
        const out = extractTaskContextFromToolResult(payload);
        expect(out?.id).toBe('PROJ-12');
        expect(out?.title).toBe('Add logout button');
        expect(out?.description).toContain('Revoke sessions on logout');
    });

    it('picks the richest candidate by score', () => {
        const payload = {
            results: [
                { title: 'Thin' },
                {
                    key: 'AB-1',
                    title: 'Rich',
                    description: 'Full description here',
                    acceptanceCriteria: ['a', 'b'],
                },
            ],
        };
        const out = extractTaskContextFromToolResult(payload);
        expect(out?.title).toBe('Rich');
        expect(out?.acceptanceCriteria).toEqual(['a', 'b']);
    });

    it('drops error-envelope payloads (404) and returns undefined', () => {
        const payload = { status: 404, message: 'Not found' };
        expect(extractTaskContextFromToolResult(payload)).toBeUndefined();
    });

    it('returns undefined when nothing has core content', () => {
        expect(extractTaskContextFromToolResult({ foo: 'bar' })).toBeUndefined();
    });

    // An MCP tool that fails answers with a normal response carrying
    // isError/structuredContent rather than throwing, so the envelope has to be
    // recognized or its fields get mined as if they were task content.
    it('drops an MCP error envelope even when it carries a title-ish field', () => {
        const payload = {
            isError: true,
            content: [{ type: 'text', text: 'upstream exploded' }],
            structuredContent: {
                success: false,
                data: null,
                title: 'KODUS_GET_ISSUE',
            },
        };

        expect(extractTaskContextFromToolResult(payload)).toBeUndefined();
    });

    it('drops a structuredContent failure envelope', () => {
        const payload = {
            structuredContent: {
                success: false,
                count: 0,
                data: [],
                title: 'Issues',
                description: 'could not be listed',
            },
        };

        expect(extractTaskContextFromToolResult(payload)).toBeUndefined();
    });

    it('still reads task content out of a successful structuredContent result', () => {
        const payload = {
            structuredContent: {
                success: true,
                data: {
                    number: 993,
                    title: 'Rate-limit the sender',
                    body: 'Cap outbound notifications at ten per second.',
                },
            },
        };

        const out = extractTaskContextFromToolResult(payload);
        expect(out?.title).toBe('Rate-limit the sender');
        expect(out?.description).toContain('ten per second');
    });
});
