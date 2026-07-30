/**
 * Tests for concrete agent providers (Bug, Security, Performance).
 * Verifies identity, category label, and category prompt.
 */
import { BugAgentProvider } from '@/code-review/infrastructure/agents/providers/bug-agent.provider';
import { SecurityAgentProvider } from '@/code-review/infrastructure/agents/providers/security-agent.provider';
import { PerformanceAgentProvider } from '@/code-review/infrastructure/agents/providers/performance-agent.provider';
import { GeneralistAgentProvider } from '@/code-review/infrastructure/agents/providers/generalist-agent.provider';
import { resolveSuggestionLabel } from '@/code-review/infrastructure/agents/collaborators/finding-mapper';

function createAgent<T>(AgentClass: new (...args: any[]) => T): T {
    return Object.create(AgentClass.prototype);
}

describe('BugAgentProvider', () => {
    const agent = createAgent(BugAgentProvider);

    it('should have correct identity', () => {
        const identity = (agent as any).getIdentity();
        expect(identity.name).toBe('kodus-bug-review-agent');
        expect(identity.description.toLowerCase()).toContain('bug');
        expect(identity.goal.toLowerCase()).toContain('bug');
        expect(identity.expertise.length).toBeGreaterThan(0);
    });

    it('should return "bug" as category label', () => {
        expect((agent as any).getCategoryLabel()).toBe('bug');
    });

    it('should have category prompt mentioning bug topics', () => {
        const prompt = (agent as any).getCategoryPrompt();
        expect(prompt.toLowerCase()).toContain('logic error');
        expect(prompt.toLowerCase()).toContain('null');
        expect(prompt.toLowerCase()).toContain('race condition');
    });

    it('should explicitly skip non-bug categories', () => {
        const prompt = (agent as any).getCategoryPrompt().toLowerCase();
        expect(prompt).toContain('performance');
        expect(prompt).toContain('security');
    });
});

describe('SecurityAgentProvider', () => {
    const agent = createAgent(SecurityAgentProvider);

    it('should have correct identity', () => {
        const identity = (agent as any).getIdentity();
        expect(identity.name).toBe('kodus-security-review-agent');
        expect(identity.description.toLowerCase()).toContain('security');
        expect(identity.goal.toLowerCase()).toContain('vulnerabilit');
    });

    it('should return "security" as category label', () => {
        expect((agent as any).getCategoryLabel()).toBe('security');
    });

    it('should have category prompt mentioning security topics', () => {
        const prompt = (agent as any).getCategoryPrompt().toLowerCase();
        expect(prompt).toContain('injection');
        expect(prompt).toContain('auth');
        expect(prompt).toContain('data exposure');
    });
});

describe('PerformanceAgentProvider', () => {
    const agent = createAgent(PerformanceAgentProvider);

    it('should have correct identity', () => {
        const identity = (agent as any).getIdentity();
        expect(identity.name).toBe('kodus-performance-review-agent');
        expect(identity.description.toLowerCase()).toContain('performance');
        expect(identity.goal.toLowerCase()).toContain('performance');
    });

    it('should return "performance" as category label', () => {
        expect((agent as any).getCategoryLabel()).toBe('performance');
    });

    it('should have category prompt mentioning performance topics', () => {
        const prompt = (agent as any).getCategoryPrompt().toLowerCase();
        expect(prompt).toContain('n+1');
        expect(prompt).toContain('memory leak');
        expect(prompt).toContain('caching');
    });
});

describe('GeneralistAgentProvider — label preservation on discarded suggestions', () => {
    const agent = createAgent(GeneralistAgentProvider);
    const input = { requestedCategories: undefined } as any;

    // The bug: generalist's discardedByVerify / discardedBySeverity used to be
    // tagged with this.getCategoryLabel() ('generalist'), overwriting the
    // bug/security/performance label the LLM emitted. Downstream filters and
    // the UI rely on the finding-level category, not the agent-level one.
    // resolveSuggestionLabel preserves the original label when it is one of
    // the allowed values and falls back to the first allowed label otherwise.

    // resolveSuggestionLabel moved off the provider into finding-mapper; it now
    // takes a LabelPolicy built from the provider's own policy methods (exactly
    // how base-code-review-agent.provider assembles it before mapping findings).
    const policyFor = (i: any) => ({
        categoryLabel: (agent as any).getCategoryLabel(),
        allowedLabels: (agent as any).getAllowedSuggestionLabels(i),
        supportsMixed: (agent as any).supportsMixedLabels(),
    });
    const resolve = (label: unknown) =>
        resolveSuggestionLabel({ label } as any, policyFor(input));

    it('preserves a "bug" label emitted by the LLM', () => {
        expect(resolve('bug')).toBe('bug');
    });

    it('preserves a "security" label emitted by the LLM', () => {
        expect(resolve('security')).toBe('security');
    });

    it('preserves a "performance" label emitted by the LLM', () => {
        expect(resolve('performance')).toBe('performance');
    });

    it('normalizes case when the LLM returns mixed case', () => {
        expect(resolve('Bug')).toBe('bug');
        expect(resolve('SECURITY')).toBe('security');
    });

    it('never returns "generalist" — not a valid finding label', () => {
        expect(resolve('generalist')).not.toBe('generalist');
    });

    it('falls back to the first allowed category when the label is unknown', () => {
        // GeneralistAgentProvider.getAllowedSuggestionLabels returns
        // ['bug', 'security', 'performance'] by default — so fallback is 'bug'.
        expect(resolve('random-label')).toBe('bug');
        expect(resolve(undefined)).toBe('bug');
        expect(resolve(null)).toBe('bug');
    });

    it('respects requestedCategories when narrowing the allowed set', () => {
        const narrowInput = {
            requestedCategories: ['security', 'performance'],
        } as any;
        const narrowResolve = (label: unknown) =>
            resolveSuggestionLabel({ label } as any, policyFor(narrowInput));

        // bug is out of the allowed set now — must fall back to the first
        // allowed category instead of leaking through.
        expect(narrowResolve('bug')).toBe('security');
        expect(narrowResolve('security')).toBe('security');
        expect(narrowResolve('performance')).toBe('performance');
    });
});

describe('Agent uniqueness', () => {
    it('should have distinct labels', () => {
        const labels = [
            (createAgent(BugAgentProvider) as any).getCategoryLabel(),
            (createAgent(SecurityAgentProvider) as any).getCategoryLabel(),
            (createAgent(PerformanceAgentProvider) as any).getCategoryLabel(),
        ];
        expect(new Set(labels).size).toBe(3);
    });

    it('should have distinct agent names', () => {
        const names = [
            (createAgent(BugAgentProvider) as any).getIdentity().name,
            (createAgent(SecurityAgentProvider) as any).getIdentity().name,
            (createAgent(PerformanceAgentProvider) as any).getIdentity().name,
        ];
        expect(new Set(names).size).toBe(3);
    });
});
