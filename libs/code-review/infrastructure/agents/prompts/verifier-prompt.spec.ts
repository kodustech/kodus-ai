import { buildVerifierPrompt } from './verifier-prompt';

describe('buildVerifierPrompt', () => {
    const { system, prompt } = buildVerifierPrompt('Claim: x', 0);

    it('has the verify check the facts where they are decided', () => {
        expect(system).toMatch(/where they are decided/);
        expect(system).toMatch(/not re-reading the cited lines/);
        expect(prompt).toMatch(/Read where each is decided/);
    });

    it('drops a stated intent, never a security hole, data loss or crash', () => {
        expect(system).toMatch(/the repository states is intended/);
        expect(system).toMatch(
            /Never drop a security hole, data loss or crash for this reason/,
        );
    });

    it('gives six tool steps', () => {
        expect(prompt).toMatch(/up to 6 tool-call steps/);
    });
});
