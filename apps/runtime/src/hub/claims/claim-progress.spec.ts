import { ClaimProgressBook } from './claim-progress';

// A setup the hub stops at its ceiling hears no claim.failed: the worker reads
// where its boot was from the last progress the cell sent.
describe('a claim\'s progress', () => {
    it('keeps where the boot spent its time so far, the latest the cell sent, for its own org only', () => {
        const book = new ClaimProgressBook();
        const at = new Date('2026-11-11T12:30:00.000Z');
        book.record('claim-1', 'org-1', { phase: 'compose', state: 'started', at: at.toISOString(), phases: [{ name: 'yarn install', ms: 600_000, running: true }] }, at);
        const later = [{ name: 'yarn install', ms: 1_005_300 }, { name: 'export layers', ms: 900_000, running: true as const }];
        book.record('claim-1', 'org-1', { phase: 'compose', state: 'started', at: at.toISOString(), lines: ['#12 exporting layers'] }, at);
        book.record('claim-1', 'org-1', { phase: 'compose', state: 'started', at: at.toISOString(), phases: later }, at);
        expect(book.get('claim-1', 'org-1')?.bootPhases).toEqual(later);
        expect(book.get('claim-1', 'org-2')).toBeNull();
    });
});
