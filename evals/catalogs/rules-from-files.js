// Cases: the `id`/`title` of the Scenario each E2E file under tests/e2e/scenarios exports, parsed from source (its .js imports do not resolve as plain node).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = [
    'tests/e2e/scenarios/kody-rules-file-sync.ts',
    'tests/e2e/scenarios/kody-rules-lifecycle.ts',
    'tests/e2e/scenarios/rule-file-detection.ts',
];
const MAX = 160;

function field(block, name, file) {
    const m = block.match(new RegExp(`\\b${name}:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
    if (!m) throw new Error(`${file}: no ${name} in its exported Scenario`);
    return m[2].replace(/\\(.)/g, '$1');
}

// "A .kody/rules file syncs…" -> "Verifies that a .kody/rules file syncs…";
// "Repo-synced rule lifecycle: …" -> "Verifies the repo-synced rule lifecycle: …".
function verifies(title) {
    const lowered = title.replace(/^([A-Z])([a-z]*)(?=[\s-])/, (_, a, b) => a.toLowerCase() + b);
    return title.includes(':') ? `Verifies the ${lowered}` : `Verifies that ${lowered}`;
}

function catalog() {
    return FILES.map((file) => {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const at = source.search(/export const \w+\s*:\s*Scenario\s*=\s*\{/);
        if (at < 0) throw new Error(`${file}: no exported Scenario`);
        const block = source.slice(at);
        const id = field(block, 'id', file);
        const checks = verifies(field(block, 'title', file));
        return { id, checks: checks.length > MAX ? `${checks.slice(0, MAX - 1)}…` : checks };
    });
}

module.exports = { catalog };
