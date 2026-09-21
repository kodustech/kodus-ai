// Preloaded into each wiring-smoke step (NODE_OPTIONS=--require): records every
// repo file the process loads — through require (engine .ts via ts-node or the
// esbuild hook, JSON) or fs reads, sync or async (datasets, prompts, targets) — and writes
// the list to $TRACE_LOADED_DIR/<TRACE_LOADED_LABEL>.<pid>.<threadId>.txt on exit.
// The thread id keeps worker threads (NODE_OPTIONS preloads this into them too)
// from writing over the main thread's list: they share the pid. A real nightly-
// shaped run once left a one-file list; wiring-smoke refuses a trace that does
// not contain the eval's own runner, so a bad trace fails instead of skipping.
// See engine-files.js for what the list is used for.
const fs = require('fs');
const path = require('path');

const dir = process.env.TRACE_LOADED_DIR;
if (dir) {
    const root = `${process.cwd()}${path.sep}`;
    const label = process.env.TRACE_LOADED_LABEL || 'unlabelled';
    const { threadId } = require('worker_threads');
    const read = new Set();
    const repoRelative = (file) => {
        const abs = path.resolve(String(file));
        return abs.startsWith(root) && !abs.includes(`${path.sep}node_modules${path.sep}`) ? abs.slice(root.length) : null;
    };

    const record = (file) => {
        if (typeof file === 'string' || file instanceof URL) {
            const rel = repoRelative(file instanceof URL ? file.pathname : file);
            if (rel) read.add(rel);
        }
    };
    const trace = (owner, name) => {
        const original = owner[name];
        owner[name] = function traced(file, ...rest) {
            record(file);
            return original.call(this, file, ...rest);
        };
    };
    trace(fs, 'readFileSync');
    trace(fs, 'readFile');
    trace(fs, 'createReadStream');
    trace(fs.promises, 'readFile');

    process.on('exit', () => {
        try {
            const loaded = Object.keys(require.cache).map(repoRelative).filter(Boolean);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${label}.${process.pid}.${threadId}.txt`), [...new Set([...loaded, ...read])].join('\n'));
        } catch {
            // Tracing must never change the outcome of the step it observes.
        }
    });
}
