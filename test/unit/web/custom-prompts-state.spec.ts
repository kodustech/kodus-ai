import {
    buildPromptInitialTextMap,
    normalizePromptFormValues,
    parsePromptFieldValue,
    serializePromptFieldValue,
} from '../../../apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-prompts/_utils/custom-prompts-state';

describe('custom-prompts-state', () => {
    it('prefers saved values and falls back to defaults when the saved field is empty', () => {
        const promptFields = [
            'v2PromptOverrides.generation.main.value',
            'v2PromptOverrides.categories.descriptions.bug.value',
        ];

        const currentValues = {
            v2PromptOverrides: {
                generation: {
                    main: {
                        value: 'Saved prompt',
                    },
                },
                categories: {
                    descriptions: {
                        bug: {
                            value: '',
                        },
                    },
                },
            },
        };

        const defaults = {
            generation: {
                main: 'Default generation',
            },
            categories: {
                descriptions: {
                    bug: 'Default bug',
                },
            },
        };

        expect(
            buildPromptInitialTextMap(promptFields, currentValues, defaults),
        ).toEqual({
            'v2PromptOverrides.generation.main.value': 'Saved prompt',
            'v2PromptOverrides.categories.descriptions.bug.value':
                'Default bug',
        });
    });

    it('parses and serializes prompt values symmetrically', () => {
        const json = {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Hello' }],
                },
            ],
        };

        expect(parsePromptFieldValue(JSON.stringify(json))).toEqual(json);
        expect(serializePromptFieldValue(json)).toBe(JSON.stringify(json));
        expect(serializePromptFieldValue('plain text')).toBe('plain text');
    });

    it('hydrates empty prompt overrides with defaults for the form baseline', () => {
        const currentValues = {
            v2PromptOverrides: {
                generation: {
                    main: {
                        value: '',
                    },
                },
                categories: {
                    descriptions: {
                        bug: {
                            value: 'Existing bug prompt',
                        },
                    },
                },
            },
        };

        const defaults = {
            generation: {
                main: 'Default generation',
            },
            categories: {
                descriptions: {
                    bug: 'Default bug',
                    performance: 'Default performance',
                },
            },
        };

        expect(
            normalizePromptFormValues(currentValues, defaults),
        ).toMatchObject({
            v2PromptOverrides: {
                generation: {
                    main: {
                        value: 'Default generation',
                    },
                },
                categories: {
                    descriptions: {
                        bug: {
                            value: 'Existing bug prompt',
                        },
                        performance: {
                            value: 'Default performance',
                        },
                    },
                },
            },
        });
    });
});
