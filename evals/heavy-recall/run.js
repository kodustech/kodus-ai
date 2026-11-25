#!/usr/bin/env node
// heavy-recall: the finder-recall eval on a heavy review (`@kody review --heavy`):
// the generalist plus the M3 lenses, then every step after them, scored on the
// known bugs it ships. It runs evals/investigation/run-recall.js, which drives
// production's AgentReviewStage, with RECALL_HEAVY=1 and the floors of this
// folder; the review, the judge and the result are the finder eval's.
//
//   node evals/heavy-recall/run.js --model=<id> [--set=controlled|light] [--gate] [--output=<result.json>] [--no-judge] [--cases=<id,id>] [--concurrency=N]
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const TARGETS = path.join(__dirname, 'targets.json');

const passed = process.argv.slice(2);
const set = passed.some((a) => a.startsWith('--set=') || a.startsWith('--cases=')) ? [] : ['--set=controlled'];
const run = spawnSync(process.execPath, [path.join(ROOT, 'evals/investigation/run-recall.js'), ...set, ...passed, `--targets=${TARGETS}`], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, RECALL_HEAVY: '1' },
});
process.exit(run.status === null ? 2 : run.status);
