function extractCallGraph(value) {
    if (typeof value === 'string') {
        const match = value.match(/<CallGraph>[\s\S]*?<\/CallGraph>/);
        if (match) {
            return match[0];
        }
        try {
            return extractCallGraph(JSON.parse(value));
        } catch {
            return null;
        }
    }

    if (!value || typeof value !== 'object') {
        return null;
    }

    for (const nested of Object.values(value)) {
        const graph = extractCallGraph(nested);
        if (graph) {
            return graph;
        }
    }
    return null;
}

function applyCallGraphVariant(vars, variant) {
    const copy = { ...vars };
    if (variant === 'off') {
        delete copy.callGraph;
        return copy;
    }
    if (variant === 'captured') {
        return copy;
    }
    if (variant === 'required') {
        if (
            typeof copy.callGraph !== 'string' ||
            !copy.callGraph.includes('<CallGraph>')
        ) {
            throw new Error(
                `${copy.caseId || 'unknown case'} has no captured call graph`,
            );
        }
        return copy;
    }
    throw new Error(`unknown call graph variant: ${variant}`);
}

module.exports = { extractCallGraph, applyCallGraphVariant };
