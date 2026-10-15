// Cases: test/evals/business-rules-validation/fixtures/*.json, the fixtures eval-runner.spec.ts runs one test each.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'test/evals/business-rules-validation/fixtures');
const MAX = 160;
const QUALITY = { COMPLETE: 'complete', PARTIAL: 'partially specified', MINIMAL: 'minimally specified', EMPTY: 'empty' };

// The spec's own defaults: a fixture without providerType is a Jira task.
const providerName = (p) => (p || 'jira').charAt(0).toUpperCase() + (p || 'jira').slice(1);

function sentence(fx, withTitle) {
    const input = fx.input || {};
    const out = fx.expectedOutcome || {};
    const quality = ((fx.expectedTrajectory || []).find((t) => t.output && t.output.taskQuality) || {}).output?.taskQuality;
    const task = input.taskContext && typeof input.taskContext === 'object' ? input.taskContext : null;

    if (out.needsMoreInfo) {
        const state = quality ? QUALITY[quality] || quality.toLowerCase() : 'missing';
        return `Skips the analysis and asks for the task when the linked task is ${state}`;
    }

    const parts = ['Runs the full analysis on'];
    if (quality) parts.push(QUALITY[quality] || quality.toLowerCase());
    parts.push(`${providerName(input.providerType)} task${task && task.id ? ` ${task.id}` : ''}`);
    if (withTitle && task && task.title) parts.push(`("${task.title}")`);
    if (/https?:\/\//.test(input.userQuestion || '')) parts.push('linked by URL in the @kody comment');
    const finding = String(out.summaryText || '').match(/^#{3,}\s*([A-Z_]+):\s*(.+)$/m);
    if (finding) parts.push(`and reports ${finding[1]} "${finding[2].trim()}"`);
    if (input.userLanguage && !/^en/i.test(input.userLanguage)) parts.push(`and answers in ${input.userLanguage}`);
    return parts.join(' ');
}

function catalog() {
    return fs
        .readdirSync(DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((file) => {
            const fx = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
            let checks = sentence(fx, true);
            if (checks.length > MAX) checks = sentence(fx, false);
            if (checks.length > MAX) checks = `${checks.slice(0, MAX - 1)}…`;
            return { id: fx.name || file.replace(/\.json$/, ''), checks };
        });
}

module.exports = { catalog };
