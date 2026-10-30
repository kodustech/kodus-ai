// Cases: cases.js `cases`, what run.js runs (prod-shapes/cases/*.js built in), grouped by what each case proves; a -control twin joins its case's group.
const { cases } = require('./cases');
const { loadSpecs } = require('./prod-shapes');

const MAX = 160;
const words = (s) => String(s).replace(/[_-]+/g, ' ');
// The sandbox modes run.js understands (README "What it drives"), in words.
const SANDBOX = [
    [/^alive$/, 'alive'],
    [/^dead$/, 'dead'],
    [/^dies-in-verify$/, 'dies in verify'],
    [/^dies-after-reading:/, 'dies after a read'],
    [/^dead-for:/, 'dead for one file'],
    [/^flaky:/, 'flaky'],
    [/^none$/, 'none'],
];

const specs = new Map(loadSpecs().map((s) => [s.id, s]));
const isProd = (c) => specs.has(c.id);
// The comment the case says Kody posted earlier; the rest of the history is filler.
const earlier = (c) => (c.previousDecisions || []).find((d) => !/^round-a-other-/.test(d.suggestionId)) || (c.previousDecisions || [])[0];
// 'out-of-40': the earlier comment sits behind more newer ones than a review is shown.
const shownCap = (c) => (String(specs.get(c.id)?.historySize).match(/^out-of-(\d+)$/) || [])[1];
const isRepeat = (claim) => claim.expect === 'not_deliver' && /repeat/.test(claim.id);
const isLinked = (claim) => claim.expect === 'deliver_linked' || claim.expect === 'if_delivered_linked';

function groupKey(c) {
    const origin = isProd(c) ? 'prod-' : '';
    if (c.family === 'unread-premise') return 'unread';
    if (c.claims.some(isRepeat)) {
        const who = c.agent === 'kody-rules' ? 'rules' : 'finder';
        const where = shownCap(c) ? 'out-of-history' : earlier(c)?.outcome === 'implemented' ? 'implemented' : 'not-implemented';
        return `${origin}repeat-${who}-${where}`;
    }
    if (c.claims.some(isLinked)) return `${origin}revision`;
    return `${origin}guard`;
}

const distinct = (xs) => [...new Set(xs.filter(Boolean))];
const orList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
// Short ids (U1, R3p, P07); three or more consecutive ones as a range.
function idList(cs) {
    const runs = [];
    for (const id of cs.map((c) => c.id.split('-')[0])) {
        const m = id.match(/^([A-Z])(\d+)$/);
        const last = runs.at(-1);
        if (m && last?.letter === m[1] && last.to + 1 === +m[2]) {
            last.to = +m[2];
            last.ids.push(id);
        } else runs.push(m ? { letter: m[1], to: +m[2], ids: [id] } : { ids: [id] });
    }
    return runs.map((r) => (r.ids.length >= 3 ? `${r.ids[0]}–${r.ids.at(-1)}` : r.ids.join(', '))).join(', ');
}
// The first variant that fits the panel's limit (with its closing period).
const fit = (...variants) => {
    const v = variants.find((x) => x.length < MAX) || variants.at(-1).slice(0, MAX - 2);
    return `${v}.`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const storedAs = (mains) => {
    const statuses = distinct(mains.map((c) => earlier(c) && words(earlier(c).outcome)));
    return statuses.length ? `stored ${orList(statuses)}` : '';
};
const isOutOfHistory = (key) => key.endsWith('-out-of-history');
const isStoredImplemented = (key) => key.endsWith('-implemented') && !key.endsWith('-not-implemented');

function sentence(key, mains, controls) {
    const ids = idList(mains);
    const stored = storedAs(mains);
    const twins = controls.length ? `; ${controls.length === 1 ? 'its -control twin' : `${controls.length} -control twins`} must post it` : '';
    const k = key.replace(/^prod-/, '');
    if (k === 'unread') {
        const modes = distinct(mains.map((c) => (SANDBOX.find(([re]) => re.test(c.sandbox)) || [null, c.sandbox])[1]));
        return fit(
            `Keeps findings on unread code off the PR, posts readable ones; sandbox ${modes.join(', ')} (${ids})`,
            `Keeps findings on unread code off the PR, posts readable ones; sandbox ${modes.join(', ')}`,
            `Keeps findings on unread code off the PR, across ${modes.length} sandbox states (${ids})`,
        );
    }
    if (k.startsWith('repeat-')) {
        const who = k.startsWith('repeat-rules') ? 'a Kody Rule violation' : 'a bug';
        const why = isOutOfHistory(k)
            ? `whose earlier comment fell out of the ${shownCap(mains[0])} a review is shown`
            : `an earlier comment raised, ${isStoredImplemented(k) ? `${stored} though still in the code` : stored}`;
        return fit(`Does not repost ${who} ${why} (${ids})${twins}`, `Does not repost ${who} ${why} (${ids})`);
    }
    if (k === 'revision') {
        return fit(
            `Links a new finding to the earlier Kody suggestion it revises, ${stored} (${ids})${twins}`,
            `Links a new finding to the earlier Kody suggestion it revises (${ids})${twins}`,
            `Links a new finding to the earlier Kody suggestion it revises (${ids})`,
        );
    }
    return fit(
        `Still posts a new problem when an earlier comment, ${stored}, covered a related one (${ids})${twins}`,
        `Still posts a new problem when an earlier comment covered a related one (${ids})${twins}`,
        `Still posts a new problem when an earlier comment covered a related one (${ids})`,
    );
}

const ORDER = ['unread', 'repeat-finder-implemented', 'repeat-finder-not-implemented', 'repeat-finder-out-of-history', 'repeat-rules-implemented', 'repeat-rules-not-implemented', 'repeat-rules-out-of-history', 'revision', 'guard'];
function groupName(key, mains) {
    const origin = key.startsWith('prod-') ? 'Production shapes' : 'Synthetic';
    const k = key.replace(/^prod-/, '');
    if (k === 'unread') return `${origin}: sandbox fails mid-review`;
    if (k === 'revision') return `${origin}: revisions of an earlier suggestion`;
    if (k === 'guard') return `${origin}: guards that must still post`;
    const who = k.startsWith('repeat-rules') ? 'Kody Rules' : 'bug-finder';
    return `${origin}: ${who} repeats, ${isOutOfHistory(k) ? 'out of the history shown' : storedAs(mains)}`;
}

function catalog() {
    const mains = cases.filter((c) => c.family !== 'control');
    const groups = new Map();
    for (const c of mains) {
        const key = groupKey(c);
        if (!groups.has(key)) groups.set(key, { mains: [], controls: [] });
        groups.get(key).mains.push(c);
    }
    const unpaired = [];
    for (const t of cases.filter((c) => c.family === 'control')) {
        const base = t.id.replace(/-control$/, '');
        const main = mains.find((c) => c.id === base) || mains.find((c) => c.id.startsWith(`${base}-`));
        if (main) groups.get(groupKey(main)).controls.push(t);
        else unpaired.push(t);
    }
    const rank = (key) => (key.startsWith('prod-') ? 100 : 0) + (ORDER.indexOf(key.replace(/^prod-/, '')) + 1 || 99);
    const entries = [...groups].sort(([a], [b]) => rank(a) - rank(b)).map(([key, g]) => ({
        id: key,
        group: groupName(key, g.mains),
        count: g.mains.length + g.controls.length,
        checks: sentence(key, g.mains, g.controls),
    }));
    if (unpaired.length) {
        entries.push({
            id: 'control',
            group: 'Controls',
            count: unpaired.length,
            checks: fit(`Posts the problem when no earlier comment exists, in ${plural(unpaired.length, 'control case')} (${unpaired.map((c) => c.id).join(', ')})`),
        });
    }
    return entries;
}

module.exports = { catalog };
