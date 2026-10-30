jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { shardViolationsWireSchema } from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge';
import {
    planStructuredCall,
    resolveCompatibleReasoningTraits,
} from './providers/kernel/reasoning-traits';
import { captureByokWire } from './testing/byok-wire';
import './providers';

/**
 * Production 2026-09-29/30: on MiniMax's Anthropic endpoint, every Kody Rules
 * shard call went out with the `json` tool forced (`tool_choice: any`) and
 * `thinking: disabled`, and MiniMax-M3 answered all of them with nothing — an
 * empty assistant message, 6 output tokens (Langfuse: 37 of 37 for the org,
 * zero tool calls). The same shards re-asked as plain JSON text came back with
 * a valid `{"violations":[]}`. So M3 is asked for JSON in the text from the
 * first call, and is not sent a `disabled` it was never shown to accept.
 */
describe('MiniMax-M3 structured calls', () => {
    const slot = {
        provider: 'anthropic_compatible',
        model: 'MiniMax-M3',
        baseURL: 'https://api.minimax.io/anthropic',
        apiKey: 'k',
    } as any;

    it('plans a JSON-in-text call, not a forced tool', () => {
        expect(
            planStructuredCall('none', resolveCompatibleReasoningTraits('MiniMax-M3')),
        ).toBe('reroute-json');
    });

    it('sends no forced tool and no thinking toggle on the Anthropic endpoint', async () => {
        const wire = await captureByokWire(slot, {
            schema: shardViolationsWireSchema as any,
            cannedText: '{"violations":[]}',
        });
        expect(wire.body?.tool_choice).toBeUndefined();
        expect(wire.body?.tools ?? []).toEqual([]);
        expect(wire.body?.thinking).toBeUndefined();
    });

    it('leaves MiniMax-M2 as it was: the effort brand, forced tool allowed', () => {
        expect(
            planStructuredCall('none', resolveCompatibleReasoningTraits('MiniMax-M2')),
        ).toBe('as-is');
    });
});
