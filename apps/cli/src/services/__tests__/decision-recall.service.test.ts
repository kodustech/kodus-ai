import { describe, it, expect } from 'vitest';
import {
    CONTEXT_PACK_TOKEN_BUDGET,
    branchRecordShardPath,
    formatDecisions,
    renderContextPack,
    selectContextPackDecisions,
    type LocalDecision,
} from '../decision-recall.service.js';

function d(
    partial: Partial<LocalDecision> & { id: string; decision: string },
): LocalDecision {
    return {
        type: 'implementation_detail',
        source: 'local',
        confidence: 0.5,
        ...partial,
    };
}

describe('decision-recall.service', () => {
    it('shards different branches to different paths', () => {
        const a = branchRecordShardPath('feat/a');
        const b = branchRecordShardPath('feat/b');
        expect(a).not.toBe(b);
        expect(a).toMatch(/^branches\/[0-9a-f]{2}\/[0-9a-f]+\.json$/);
    });

    it('same branch always maps to the same shard', () => {
        expect(branchRecordShardPath('main')).toBe(
            branchRecordShardPath('main'),
        );
    });

    it('context pack is inert when empty', () => {
        expect(renderContextPack([])).toBe('');
    });

    it('selects path-scoped decisions, keeps pins under budget', () => {
        const decisions = [
            d({
                id: 'pin',
                decision: 'must keep',
                paths: ['src/x.ts'],
                confidence: 0.01,
                pinned: true,
            }),
            d({
                id: 'high',
                decision: 'high ' + 'x'.repeat(50),
                paths: ['src/x.ts'],
                confidence: 0.9,
            }),
            d({
                id: 'other',
                decision: 'other area',
                paths: ['src/y.ts'],
                confidence: 0.99,
            }),
        ];
        const pack = selectContextPackDecisions(
            decisions,
            ['src/x.ts'],
            CONTEXT_PACK_TOKEN_BUDGET,
        );
        expect(pack.some((x) => x.id === 'pin')).toBe(true);
        expect(pack.some((x) => x.id === 'other')).toBe(false);
        const text = formatDecisions(pack);
        expect(text).toContain('must keep');
    });
});
