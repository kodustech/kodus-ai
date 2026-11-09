import { bugHistoryLens, formatPastBugs, selectPastBugs, type PastBug } from './bug-history';

const bug = (summary: string, createdAt: string, extra: Partial<PastBug> = {}): PastBug => ({
    file: 'a.ts',
    label: 'bug',
    summary,
    content: `${summary}. Full text.`,
    createdAt,
    ...extra,
});

describe('bug history', () => {
    it('picks the past bugs closest to the diff, ties to the most recent', () => {
        const pool = [
            bug('Webhook reply error swallowed', '2026-10-01'),
            bug('Unbounded pagination query', '2026-10-02'),
            bug('Webhook reply error swallowed', '2026-10-03'),
        ];
        const picked = selectPastBugs(pool, '+ try { await postWebhookReply() } catch { swallowed }', 2);
        expect(picked.map((b) => b.createdAt)).toEqual(['2026-10-03', '2026-10-01']);
    });

    it('returns nothing when no past bug shares a word with the diff', () => {
        expect(selectPastBugs([bug('Unbounded query', '2026-10-01')], '+ const x = 1')).toEqual([]);
    });

    it('formats the full text or the summary, with the code it pointed at', () => {
        const b = bug('Missing timeout', '2026-10-01', { existingCode: 'await fetch(url)' });
        expect(formatPastBugs([b], 'full')).toContain('Missing timeout. Full text.');
        expect(formatPastBugs([b], 'summary')).not.toContain('Full text.');
        expect(formatPastBugs([b], 'summary')).toContain('await fetch(url)');
    });

    it('names the two passes apart', () => {
        expect(bugHistoryLens([], 'full').id).toBe('bug-history');
        expect(bugHistoryLens([], 'summary').id).toBe('bug-history-short');
    });
});
