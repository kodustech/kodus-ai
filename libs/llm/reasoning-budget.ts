/**
 * Largest reasoning budget declared anywhere in the resolved providerOptions.
 * The shape is provider-specific by design (each module owns its namespace), so
 * this reads the fact structurally — any `budgetTokens` / `budget_tokens` at any
 * depth — instead of hardcoding one provider's layout.
 */
export function reasoningBudgetFrom(
    providerOptions: Record<string, unknown> | undefined,
): number | undefined {
    let max: number | undefined;
    const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(
            node as Record<string, unknown>,
        )) {
            if (
                (key === 'budgetTokens' || key === 'budget_tokens') &&
                typeof value === 'number' &&
                Number.isFinite(value)
            ) {
                max = max === undefined ? value : Math.max(max, value);
            }
            visit(value);
        }
    };
    visit(providerOptions);
    return max;
}
