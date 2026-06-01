import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

interface DeviceData {
    deviceId: string;
    createdAt: string;
    deviceToken?: string;
    tokenUpdatedAt?: string;
}

function getKodusDir(): string {
    return path.join(os.homedir(), '.kodus');
}

function getDeviceFile(): string {
    return path.join(getKodusDir(), 'device.json');
}

const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let cachedDevice: DeviceData | null = null;
let initializationPromise: Promise<{
    deviceId: string;
    deviceToken?: string;
}> | null = null;

function isValidDeviceId(value: unknown): value is string {
    return typeof value === 'string' && UUID_REGEX.test(value);
}

function isValidDeviceToken(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

async function ensureKodusDir(): Promise<void> {
    try {
        await fs.mkdir(getKodusDir(), { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
}

async function writeDeviceData(data: DeviceData): Promise<void> {
    await ensureKodusDir();
    const tmpFile = `${getDeviceFile()}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
    });
    await fs.rename(tmpFile, getDeviceFile());
}

async function readStoredDeviceData(): Promise<DeviceData | null> {
    try {
        const content = await fs.readFile(getDeviceFile(), 'utf-8');
        const parsed = JSON.parse(content) as Partial<DeviceData>;
        if (!isValidDeviceId(parsed.deviceId)) {
            return null;
        }

        return {
            deviceId: parsed.deviceId,
            createdAt:
                typeof parsed.createdAt === 'string'
                    ? parsed.createdAt
                    : new Date().toISOString(),
            ...(isValidDeviceToken(parsed.deviceToken)
                ? { deviceToken: parsed.deviceToken }
                : {}),
            ...(typeof parsed.tokenUpdatedAt === 'string'
                ? { tokenUpdatedAt: parsed.tokenUpdatedAt }
                : {}),
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        return null;
    }
}

export async function getDeviceIdentity(): Promise<{
    deviceId: string;
    deviceToken?: string;
}> {
    if (cachedDevice) {
        return {
            deviceId: cachedDevice.deviceId,
            ...(cachedDevice.deviceToken
                ? { deviceToken: cachedDevice.deviceToken }
                : {}),
        };
    }

    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        const existing = await readStoredDeviceData();
        if (existing) {
            cachedDevice = existing;
            return {
                deviceId: existing.deviceId,
                ...(existing.deviceToken
                    ? { deviceToken: existing.deviceToken }
                    : {}),
            };
        }

        const created: DeviceData = {
            deviceId: randomUUID(),
            createdAt: new Date().toISOString(),
        };
        cachedDevice = created;

        try {
            await writeDeviceData(created);
        } catch {
            // If persistence fails, still return a process-stable identity.
        }

        return { deviceId: created.deviceId };
    })();

    return initializationPromise;
}

export async function getOrCreateDeviceId(): Promise<string> {
    const identity = await getDeviceIdentity();
    return identity.deviceId;
}

export async function updateDeviceToken(deviceToken: string): Promise<void> {
    if (!isValidDeviceToken(deviceToken)) {
        return;
    }

    const current = cachedDevice ??
        (await readStoredDeviceData()) ?? {
            deviceId: randomUUID(),
            createdAt: new Date().toISOString(),
        };

    if (current.deviceToken === deviceToken && cachedDevice) {
        return;
    }

    const next: DeviceData = {
        ...current,
        deviceToken,
        tokenUpdatedAt: new Date().toISOString(),
    };
    cachedDevice = next;

    try {
        await writeDeviceData(next);
    } catch {
        // Keep in-memory token even if disk persistence fails.
    }
}
