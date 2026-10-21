import {
    planStructuredCall,
    NON_REASONING_TRAITS,
    type ModelReasoningTraits,
    type StructuredCallPlan,
} from './reasoning-traits';

const traits = (o: Partial<ModelReasoningTraits> = {}): ModelReasoningTraits => ({
    ...NON_REASONING_TRAITS,
    ...o,
});

describe('planStructuredCall — the whole structured decision, pure', () => {
    it('response_format modes are always fine (no forced tool_choice sent)', () => {
        for (const mode of ['json_schema', 'json_object'] as const) {
            expect(
                planStructuredCall(mode, traits({ thinksByDefault: true, forcedToolChoiceRejectsThinking: true })),
            ).toBe<StructuredCallPlan>('as-is');
        }
    });

    it("tool-use + provider that can't force tool_choice (GLM) → reroute-json", () => {
        expect(
            planStructuredCall('none', traits({ supportsForcedToolChoice: false })),
        ).toBe<StructuredCallPlan>('reroute-json');
    });

    it('tool-use + forced tool_choice does NOT reject thinking (DeepSeek) → as-is', () => {
        expect(
            planStructuredCall('none', traits({ thinksByDefault: true, forcedToolChoiceRejectsThinking: false })),
        ).toBe<StructuredCallPlan>('as-is');
    });

    it('tool-use + rejects thinking + CAN disable (Kimi k2.6, Claude-5) → suppress-thinking', () => {
        expect(
            planStructuredCall(
                'none',
                traits({ thinksByDefault: true, forcedToolChoiceRejectsThinking: true, canDisableThinking: true }),
            ),
        ).toBe<StructuredCallPlan>('suppress-thinking');
    });

    it('tool-use + rejects thinking + CANNOT disable (k2.7-code, k3, Fable) → reroute-json', () => {
        expect(
            planStructuredCall(
                'none',
                traits({ thinksByDefault: true, forcedToolChoiceRejectsThinking: true, canDisableThinking: false }),
            ),
        ).toBe<StructuredCallPlan>('reroute-json');
    });

    it('a non-reasoning provider (default traits) is always as-is', () => {
        expect(planStructuredCall('none', NON_REASONING_TRAITS)).toBe('as-is');
        expect(planStructuredCall('json_schema', NON_REASONING_TRAITS)).toBe('as-is');
    });

    it('undefined structuredOutput is treated as tool-use (the conservative branch)', () => {
        expect(
            planStructuredCall(undefined, traits({ forcedToolChoiceRejectsThinking: true, canDisableThinking: false })),
        ).toBe<StructuredCallPlan>('reroute-json');
    });

    // The load-bearing INVARIANT: no configuration can leave an always-thinking,
    // forced-tool_choice model on a path that 400s. It must always reroute.
    it('INVARIANT: always-thinking + forced tool_choice never resolves to as-is/suppress', () => {
        const alwaysThinking = traits({
            thinksByDefault: true,
            canDisableThinking: false,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: true,
        });
        expect(planStructuredCall('none', alwaysThinking)).toBe('reroute-json');
    });
});
