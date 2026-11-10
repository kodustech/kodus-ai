import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A final image inheriting Playwright keeps every browser layer even if a
// subsequent RUN deletes the files. The selected files must cross a stage.
function stages(dockerfile) {
    return dockerfile.split('\n').filter((line) => /^FROM /i.test(line)).map((line) => {
        const parts = line.trim().split(/\s+/);
        return { base: parts[1], alias: parts[2]?.toLowerCase() === 'as' ? parts[3] : undefined };
    });
}
test('final runtime ancestry never includes the full Playwright image', async () => {
    const file = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
    const all = stages(file), named = new Map(all.filter((s) => s.alias).map((s) => [s.alias, s.base]));
    let base = all.at(-1).base; const seen = new Set();
    while (named.has(base)) { assert.ok(!seen.has(base), 'stage ancestry cycle'); seen.add(base); base = named.get(base); }
    assert.match(base, /^ubuntu:24\.04@sha256:[a-f0-9]{64}$/);
    for (const stage of all) if (!named.has(stage.base)) assert.match(stage.base, /@sha256:[a-f0-9]{64}$/);
});
test('browser payload is explicitly limited and package installation stays in a builder', async () => {
    const file = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
    const final = file.slice(file.toUpperCase().lastIndexOf('\nFROM '));
    const copies = final.split('\n').filter((line) => /^COPY .*\/ms-playwright\//.test(line));
    assert.equal(copies.length, 2, 'only headless-shell and bundled ffmpeg may cross into final');
    assert.ok(copies.some((line) => /\/chromium_headless_shell-1248\//.test(line)));
    assert.ok(copies.some((line) => /\/ffmpeg-1013\//.test(line)));
    assert.doesNotMatch(final, /npm\s+(?:ci|install)|yarn\s+(?:install|add)|playwright(?:-core)?\s+install/);
    assert.match(file, /npm ci .*--ignore-scripts/);
    assert.match(final, /USER 10001:10001/);
});
