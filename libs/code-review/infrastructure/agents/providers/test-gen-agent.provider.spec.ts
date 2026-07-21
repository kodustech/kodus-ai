import { TestGenAgentProvider } from '@libs/code-review/infrastructure/agents/providers/test-gen-agent.provider';

describe('TestGenAgentProvider', () => {
    let provider: TestGenAgentProvider;

    beforeEach(() => {
        provider = new TestGenAgentProvider(
            {} as any, // promptRunnerService
            {} as any, // permissionValidationService
            {} as any, // observabilityService
        );
    });

    const identity = () => (provider as any).getIdentity();
    const categoryPrompt = () => (provider as any).getCategoryPrompt({} as any);
    const categoryLabel = () => (provider as any).getCategoryLabel();

    describe('identity', () => {
        it('is the test-gen agent with a proposal (not execution) goal', () => {
            const id = identity();
            expect(id.name).toBe('kodus-test-gen-agent');
            expect(id.goal.toLowerCase()).toContain('propose');
            expect(Array.isArray(id.expertise)).toBe(true);
            expect(id.expertise.length).toBeGreaterThan(0);
        });
    });

    describe('category label', () => {
        it('is a distinct test_generation label (not a bug/security severity bucket)', () => {
            expect(categoryLabel()).toBe('test_generation');
        });
    });

    describe('category prompt', () => {
        it('instructs the agent to PROPOSE a test and to NOT run it', () => {
            const p = categoryPrompt().toLowerCase();
            expect(p).toContain('propose');
            expect(p).toContain('do not run');
        });

        it('targets new/changed under-tested functions and skips trivial code', () => {
            const p = categoryPrompt().toLowerCase();
            expect(p).toContain('new function');
            expect(p).toContain('skip');
            expect(p).toContain('trivial');
        });

        it('requires investigation before proposing (grep existing tests, detect framework)', () => {
            const p = categoryPrompt().toLowerCase();
            expect(p).toContain('grep');
            expect(p).toContain('framework');
            // must confirm the gap is real, not blindly propose
            expect(p).toContain('untested');
        });

        it('anchors the suggestion to the changed function, not a placeholder', () => {
            const p = categoryPrompt().toLowerCase();
            expect(p).toContain('relevantfile');
            expect(p).toContain('not a placeholder');
        });

        it('asks for the full test body in a fenced code block', () => {
            const p = categoryPrompt().toLowerCase();
            expect(p).toContain('fenced code block');
            expect(p).toContain('test body');
        });

        it('does not leak input state across calls (stateless prompt)', () => {
            const a = categoryPrompt();
            const b = categoryPrompt();
            expect(a).toBe(b);
        });
    });
});
