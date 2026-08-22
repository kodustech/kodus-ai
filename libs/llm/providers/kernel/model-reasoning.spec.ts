import { reasoningConfigForModel } from './model-reasoning';

const shape = (m: string) => {
    const rc = reasoningConfigForModel(m);
    if (!rc) return 'none';
    return rc.type === 'budget' ? 'budget' : `${rc.type}:${rc.options.join('/')}`;
};

describe('reasoningConfigForModel — single family source', () => {
    describe('Claude: which thinks + which shape', () => {
        it.each([
            // Pre-thinking Claude (thinking started at 3.7) → none
            ['claude-3-5-sonnet', 'none'],
            ['claude-3-5-sonnet-20241022', 'none'],
            ['claude-3-haiku', 'none'],
            ['claude-3-opus', 'none'],
            // 3.7 through 4.5 → budget
            ['claude-3-7-sonnet', 'budget'],
            ['claude-opus-4-1', 'budget'],
            ['claude-sonnet-4-5', 'budget'],
            ['claude-opus-4-5', 'budget'],
            // 4.6+, 5.x, Fable/Mythos → adaptive
            ['claude-opus-4-6', 'adaptive:low/medium/high'],
            ['claude-opus-4-7', 'adaptive:low/medium/high'],
            ['claude-opus-4-8', 'adaptive:low/medium/high'], // was wrongly budget
            ['claude-opus-5', 'adaptive:low/medium/high'],
            ['claude-sonnet-5', 'adaptive:low/medium/high'],
            ['claude-fable-5', 'adaptive:low/medium/high'],
            // Bedrock/Vertex decorations resolve the same
            ['claude-opus-4-8-20250101', 'adaptive:low/medium/high'],
            ['anthropic.claude-sonnet-4-5', 'budget'],
        ])('%s → %s', (model, expected) => {
            expect(shape(model)).toBe(expected);
        });
    });

    describe('Gemini: 2.5 budget, 3.x level', () => {
        it.each([
            ['gemini-2.5-pro', 'budget'],
            ['gemini-2.5-flash', 'budget'],
            ['gemini-3.1-pro-preview', 'level:low/medium/high'], // was wrongly none
            ['gemini-3.5-flash', 'level:low/medium/high'],
            ['gemini-2.0-flash', 'none'],
        ])('%s → %s', (model, expected) => {
            expect(shape(model)).toBe(expected);
        });
    });

    describe('OpenAI: level; non-reasoners none', () => {
        it.each([
            ['o1-mini', 'level:low/medium/high'],
            ['o3', 'level:low/medium/high'],
            ['gpt-5', 'level:medium/high'],
            ['o4-mini-deep-research', 'level:low/medium/high'],
            ['gpt-4o', 'none'],
            ['gpt-3.5-turbo', 'none'],
            ['deepseek-chat', 'none'],
        ])('%s → %s', (model, expected) => {
            expect(shape(model)).toBe(expected);
        });
    });
});
