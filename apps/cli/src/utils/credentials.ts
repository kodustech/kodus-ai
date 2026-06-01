import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { StoredCredentials } from '../types/auth.js';

const KODUS_DIR = path.join(os.homedir(), '.kodus');
const CREDENTIALS_FILE = path.join(KODUS_DIR, 'credentials.json');

function isJsonParseError(error: unknown): boolean {
    return error instanceof SyntaxError;
}

async function ensureKodusDir(): Promise<void> {
    try {
        await fs.mkdir(KODUS_DIR, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
    try {
        const content = await fs.readFile(CREDENTIALS_FILE, 'utf-8');
        return JSON.parse(content) as StoredCredentials;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return null;
        }

        // Self-heal malformed JSON by isolating the broken file and treating as no credentials.
        if (isJsonParseError(error)) {
            const brokenFile = `${CREDENTIALS_FILE}.corrupted.${Date.now()}`;
            await fs.rename(CREDENTIALS_FILE, brokenFile).catch(() => {});
            return null;
        }

        throw error;
    }
}

export async function saveCredentials(
    credentials: StoredCredentials,
): Promise<void> {
    await ensureKodusDir();
    const tmpFile = `${CREDENTIALS_FILE}.${process.pid}.${Date.now()}.tmp`;
    const content = JSON.stringify(credentials, null, 2);

    await fs.writeFile(tmpFile, content, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpFile, CREDENTIALS_FILE);
}

export async function clearCredentials(): Promise<void> {
    try {
        await fs.unlink(CREDENTIALS_FILE);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

export async function credentialsExist(): Promise<boolean> {
    try {
        await fs.access(CREDENTIALS_FILE);
        return true;
    } catch {
        return false;
    }
}
