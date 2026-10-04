// Short ids select a case, never another id sharing its numeric prefix.
function selectCases(cases, selector) {
    if (!selector) return cases;
    const ids = selector.split(',').map((id) => id.trim());
    const matches = (c, id) => c.id === id || c.id.startsWith(`${id}-`);
    for (const id of ids) {
        if (!cases.some((c) => matches(c, id)))
            throw new Error(`Unknown case: ${id}`);
    }
    return cases.filter((c) => ids.some((id) => matches(c, id)));
}
module.exports = { selectCases };
