// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseEmbedder, applyEmbedder } = require('./embedder');

describe('evals/shared/embedder', () => {
    const saved = process.env.API_OPEN_AI_API_KEY;
    afterEach(() => {
        if (saved === undefined) delete process.env.API_OPEN_AI_API_KEY;
        else process.env.API_OPEN_AI_API_KEY = saved;
    });

    it('keeps the platform key by default', () => {
        process.env.API_OPEN_AI_API_KEY = 'sk-test';
        const embedder = parseEmbedder(undefined);
        applyEmbedder(embedder);
        expect(embedder).toBe('platform');
        expect(process.env.API_OPEN_AI_API_KEY).toBe('sk-test');
    });

    it('removes the platform key for none, as a self-hosted install without it', () => {
        process.env.API_OPEN_AI_API_KEY = 'sk-test';
        applyEmbedder(parseEmbedder('none'));
        expect(process.env.API_OPEN_AI_API_KEY).toBeUndefined();
    });

    it('refuses any other value', () => {
        expect(() => parseEmbedder('bedrock')).toThrow(
            'unknown --embedder=bedrock',
        );
    });
});
