import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import updateNotifier from 'update-notifier';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

async function canUseUpdateNotifier(): Promise<boolean> {
    const configRoot =
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

    try {
        await fs.mkdir(configRoot, { recursive: true });
        await fs.access(configRoot, fsConstants.W_OK);
        return true;
    } catch {
        return false;
    }
}

export async function checkForUpdates(): Promise<void> {
    if (process.env.KODUS_DISABLE_UPDATE_CHECK === '1') {
        return;
    }

    if (!(await canUseUpdateNotifier())) {
        return;
    }

    // Update check is non-blocking (runs in background process)
    updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 12 }).notify();
}
