// Cases: test/evals/business-rules-validation/task-resolution/fixtures/*.json, the fixtures task-resolution.spec.ts runs one test each.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'test/evals/business-rules-validation/task-resolution/fixtures');
const MAX = 160;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

const OUTCOME = {
    validated: 'reads the task and judges the PR',
    silent: 'stays silent on the PR',
    comment: 'comments what the author should fix',
};

// "branch-prefix-issue-confirmed-by-title" → "Branch prefix issue confirmed by title".
const words = (name) => name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

function sentence(fx) {
    const expect = fx.expect || {};
    const parts = [`${words(fx.name)}: ${OUTCOME[expect.outcome] || expect.outcome}`];
    if (Array.isArray(expect.criteria) && expect.criteria.length) {
        parts.push(`with ${expect.criteria.length} criteria read`);
    }
    if (Array.isArray(expect.toolsCalled) && expect.toolsCalled.length) {
        parts.push(`through ${expect.toolsCalled.join(', ')}`);
    }
    return clip(parts.join(' '));
}

function catalog() {
    return fs
        .readdirSync(DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((file) => {
            const fx = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
            return { id: fx.name || file.replace(/\.json$/, ''), checks: sentence(fx) };
        });
}

module.exports = { catalog };
