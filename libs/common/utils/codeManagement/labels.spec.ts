import labels from '@libs/automation/infrastructure/adapters/services/processAutomation/config/codeReview/labels.json';

import { getLabelShield, LabelType } from './labels';

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
});
