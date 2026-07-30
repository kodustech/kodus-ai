import type { TaskContextNormalized } from '../types';
import {
    isUsableTaskContext,
    looksLikeToolErrorCandidate,
    scoreNormalizedContext,
} from './scoring';

const base = (o: Partial<TaskContextNormalized> = {}): TaskContextNormalized =>
    ({ ...o }) as TaskContextNormalized;

describe('scoring (characterization)', () => {
    it('scoreNormalizedContext weights richer context higher', () => {
        expect(scoreNormalizedContext(base())).toBe(0);
        expect(
            scoreNormalizedContext(base({ title: 't', description: 'd' })),
        ).toBe(7); // 3 + 4
        expect(
            scoreNormalizedContext(
                base({ id: 'i', title: 't', description: 'd', acceptanceCriteria: ['a'], links: ['l'] }),
            ),
        ).toBe(11); // 1+3+4+2+1
    });

    describe('isUsableTaskContext', () => {
        it('is usable when acceptance criteria exist', () => {
            expect(isUsableTaskContext(base({ acceptanceCriteria: ['x'] }))).toBe(true);
        });
        it('is not usable with empty/blank description', () => {
            expect(isUsableTaskContext(base({ description: '  ' }))).toBe(false);
        });
        it('is not usable when description reads like a fetch failure', () => {
            expect(
                isUsableTaskContext(base({ description: 'Failed to fetch (status 404)' })),
            ).toBe(false);
        });
        it('is not usable when description is serialized ADF/card metadata', () => {
            expect(
                isUsableTaskContext(base({ description: '{"type":"inlineCard","attrs":{}}' })),
            ).toBe(false);
        });
        it('is usable for real prose', () => {
            expect(
                isUsableTaskContext(base({ description: 'Add a logout button to the navbar.' })),
            ).toBe(true);
        });
    });

    describe('looksLikeToolErrorCandidate', () => {
        it('flags http error status', () => {
            expect(looksLikeToolErrorCandidate({ status: 404 })).toBe(true);
        });
        it('flags error flags', () => {
            expect(looksLikeToolErrorCandidate({ success: false })).toBe(true);
            expect(looksLikeToolErrorCandidate({ error: true })).toBe(true);
        });
        it('flags error messages', () => {
            expect(looksLikeToolErrorCandidate({ message: 'Not found' })).toBe(true);
        });
        it('passes clean payloads', () => {
            expect(looksLikeToolErrorCandidate({ title: 'My task', status: 200 })).toBe(false);
        });
    });
});
