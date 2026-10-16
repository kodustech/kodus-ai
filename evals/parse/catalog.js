// The cases this eval runs (cases.json), grouped: each shape from #2112 over
// every model's output, and each model's recorded runs as it sent them.
const cases = require('./cases.json');
const { SHAPES } = require('./shapes');

function catalog() {
    const groups = new Map();
    for (const c of cases) {
        const model = c.shape === 'as-sent' ? c.id.split('/')[0] : c.id.slice(c.shape.length + 1);
        const key = c.shape === 'as-sent' ? `as-sent/${model}` : c.shape;
        if (!groups.has(key)) groups.set(key, { shape: c.shape, model, count: 0 });
        groups.get(key).count += 1;
    }
    return [...groups].map(([id, g]) => {
        const checks =
            g.shape === 'as-sent'
                ? `Keeps every postable finding ${g.model} wrote on ${g.count} PR${g.count === 1 ? '' : 's'}, and invents none`
                : `${SHAPES[g.shape].checks()}, on ${g.count} model${g.count === 1 ? '' : 's'}' output`;
        return { id, group: g.shape === 'as-sent' ? 'as sent' : 'shape', count: g.count, checks: checks.length > 160 ? `${checks.slice(0, 159)}…` : checks };
    });
}

module.exports = { catalog };
