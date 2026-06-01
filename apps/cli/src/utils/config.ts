import fs from 'fs/promises';
import path from 'path';
import os from 'os';

function getConfigDir(): string {
    return path.join(os.homedir(), '.kodus');
}

function getConfigFile(): string {
    return path.join(getConfigDir(), 'config.json');
}

export interface CliConfig {
    teamKey: string;
    teamName: string;
    organizationName: string;
    apiUrl?: string;
    cfAccessClientId?: string;
    cfAccessClientSecret?: string;
}

function isJsonParseError(error: unknown): boolean {
    return error instanceof SyntaxError;
}

async function ensureConfigDir(): Promise<void> {
    try {
        await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
}

export async function saveConfig(config: CliConfig): Promise<void> {
    await ensureConfigDir();
    const configFile = getConfigFile();
    const tmpFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
    const content = JSON.stringify(config, null, 2);

    await fs.writeFile(tmpFile, content, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpFile, configFile);
}

export async function loadConfig(): Promise<CliConfig | null> {
    try {
        const configFile = getConfigFile();
        const content = await fs.readFile(configFile, 'utf-8');
        return JSON.parse(content) as CliConfig;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return null;
        }

        // Self-heal malformed JSON by isolating the broken file and treating as no config.
        if (isJsonParseError(error)) {
            const configFile = getConfigFile();
            const brokenFile = `${configFile}.corrupted.${Date.now()}`;
            await fs.rename(configFile, brokenFile).catch(() => {});
            return null;
        }

        throw error;
    }
}

export async function clearConfig(): Promise<void> {
    try {
        await fs.unlink(getConfigFile());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

export async function configExists(): Promise<boolean> {
    try {
        await fs.access(getConfigFile());
        return true;
    } catch {
        return false;
    }
}
