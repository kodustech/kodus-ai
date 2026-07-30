#!/usr/bin/env node

const { spawn } = require('child_process');

const startTime = Date.now();

console.log('[pre-push] Running test suite before push...');

const child = spawn('pnpm', ['run', 'test'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
});

child.on('error', (error) => {
    console.error('[pre-push] Failed to start tests:', error.message);
    process.exit(1);
});

child.on('close', (code) => {
    const durationMs = Date.now() - startTime;
    const durationSeconds = (durationMs / 1000).toFixed(1);

    if (code === 0) {
        console.log(
            `[pre-push] Tests finished successfully in ${durationSeconds}s. Proceeding with push.`,
        );
        process.exit(0);
    }

    console.error(
        `[pre-push] Tests failed in ${durationSeconds}s. Push was blocked.`,
    );
    process.exit(code || 1);
});
