// Preloaded into each wiring-smoke step (NODE_OPTIONS=--require): records every
// repo file the process loads — through require (engine .ts via ts-node or the
// esbuild hook, JSON) or readFileSync (datasets, prompts, targets) — and writes
// the list to $TRACE_LOADED_DIR/<TRACE_LOADED_LABEL>.<pid>.txt on exit.
// See engine-files.js for what the list is used for.
const fs = require('fs');
const path = require('path');

const dir = process.env.TRACE_LOADED_DIR;
if (dir) {
    const root = `${process.cwd()}${path.sep}`;
    const label = process.env.TRACE_LOADED_LABEL || 'unlabelled';
    const read = new Set();
    const repoRelative = (file) => {
        const abs = path.resolve(String(file));
        return abs.startsWith(root) && !abs.includes(`${path.sep}node_modules${path.sep}`) ? abs.slice(root.length) : null;
    };

    const readFileSync = fs.readFileSync;
    fs.readFileSync = function tracedReadFileSync(file, ...rest) {
        if (typeof file === 'string' || file instanceof URL) {
            const rel = repoRelative(file instanceof URL ? file.pathname : file);
            if (rel) read.add(rel);
        }
        return readFileSync.call(this, file, ...rest);
    };

    process.on('exit', () => {
        const loaded = Object.keys(require.cache).map(repoRelative).filter(Boolean);
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${label}.${process.pid}.txt`), [...new Set([...loaded, ...read])].join('\n'));
        } catch {
            // Tracing must never change the outcome of the step it observes.
        }
    });
}
