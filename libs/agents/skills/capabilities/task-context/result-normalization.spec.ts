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
});
