import { getDefaultKodusConfigFile } from './validateCodeReviewConfigFile';
import {
    samePromptText,
    matchKnownWritingGuidelines,
    resolveWritingGuidelines,
} from './writing-guidelines';
import { alignPromptOverridesWithParent } from '@libs/code-review/application/use-cases/configuration/align-prompt-overrides';

it('recognizes the shipped default after editor serialization including code marks', () => {
    const parent = getDefaultKodusConfigFile();
    const text = parent.v2PromptOverrides.generation.main;
    expect(text).toContain('`inline code`');
    const editor = JSON.stringify({
        type: 'doc',
        content: text
            .trim()
            .split('\n')
            .map((line: string) => ({
                type: 'paragraph',
                content: line
                    .replace(/^- /, '')
                    .replace(/\*\*/g, '')
                    .split(/`([^`]+)`/g)
                    .filter(Boolean)
                    .map((part, index) => ({
                        type: 'text',
                        text: part,
                        ...(index % 2 ? { marks: [{ type: 'code' }] } : {}),
                    })),
            })),
    });
    expect(samePromptText(editor, text)).toBe(true);
    expect(matchKnownWritingGuidelines(editor)).toBe('default-current');
    expect(resolveWritingGuidelines(editor).isCustom).toBe(false);
    const result = alignPromptOverridesWithParent(
        { v2PromptOverrides: { generation: { main: editor } } },
        parent,
    );
    expect(result.config.v2PromptOverrides.generation.main).toBe(text);
    expect(result.alignedPaths).toEqual(['generation.main']);
});

it.each([
    ['Use `count > 10`.', 'Use `count < 10`.'],
    ['Use `UserID`.', 'Use `userId`.'],
    ['Use `a**b**c`.', 'Use `abc`.'],
    ['Use `a_b`.', 'Use `ab`.'],
])('retains edits within inline code: %s versus %s', (parent, edit) => {
    expect(samePromptText(parent, edit)).toBe(false);
});
