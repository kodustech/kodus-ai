/**
 * Pick the default tool allow-list for a verification-oriented connection.
 *
 * MCP tools may carry a `readOnlyHint` annotation (surfaced as `readOnly`). When
 * a server annotates *any* of its tools as read-only, we scope the default to
 * those — the agent should only read issues/tickets, not mutate them. When a
 * server annotates none (we can't tell read from write), we fall back to all
 * tools rather than lock the agent out of a working integration.
 */
export function defaultReadOnlyToolSlugs(
    tools: Array<{ slug: string; readOnly?: boolean }>,
): string[] {
    const readOnly = tools.filter((tool) => tool.readOnly);
    return (readOnly.length > 0 ? readOnly : tools).map((tool) => tool.slug);
}
