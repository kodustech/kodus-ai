import labels from '@libs/automation/infrastructure/adapters/services/processAutomation/config/codeReview/labels.json';

import { getLabelShield, getSuggestionShield, LabelType } from './labels';

describe('labels', () => {
    it('has a labels.json entry for every LabelType', () => {
        const types = new Set(labels.map((label) => label.type));
        for (const type of Object.values(LabelType)) {
            expect(types).toContain(type);
        }
    });

    it('renders a shield for custom agent findings', () => {
        expect(labels.find((l) => l.type === 'custom_agent')).toMatchObject({
            name: 'Custom Agent',
        });
        expect(getLabelShield(LabelType.CUSTOM_AGENT)).toBe(
            '![Custom Agent](https://img.shields.io/badge/Custom_Agent-304FFE)',
        );
    });

    describe('getSuggestionShield', () => {
        it("shows a custom agent's own name and color", () => {
            expect(
                getSuggestionShield({
                    label: LabelType.CUSTOM_AGENT,
                    customAgent: { name: 'Ledger-Rules v2', color: '#7B1FA2' },
                }),
            ).toBe(
                '![Ledger-Rules v2](https://img.shields.io/badge/Ledger--Rules_v2-7B1FA2)',
            );
        });

        it('falls back to blue for a color it cannot put in a URL', () => {
            expect(
                getSuggestionShield({
                    label: LabelType.CUSTOM_AGENT,
                    customAgent: { name: 'Docs', color: 'red)](http://x' },
                }),
            ).toBe('![Docs](https://img.shields.io/badge/Docs-304FFE)');
        });

        it('escapes a name that would break the badge', () => {
            const shield = getSuggestionShield({
                label: LabelType.CUSTOM_AGENT,
                customAgent: { name: 'A [b](c) / d_e' },
            });
            expect(shield).toBe(
                '![A b(c) / d_e](https://img.shields.io/badge/A_%5Bb%5D(c)_%2F_d__e-304FFE)',
            );
        });

        it("keeps the label's tag for every other finding", () => {
            expect(getSuggestionShield({ label: LabelType.BUG })).toBe(
                getLabelShield(LabelType.BUG),
            );
            expect(getSuggestionShield({ label: LabelType.CUSTOM_AGENT })).toBe(
                getLabelShield(LabelType.CUSTOM_AGENT),
            );
        });
    });
});
