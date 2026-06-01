import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importDeviceModule(
    homeDir: string,
): Promise<typeof import('../device.js')> {
    vi.resetModules();
    vi.doMock('os', async () => {
        const actual = await vi.importActual<any>('os');
        return {
            ...actual,
            homedir: () => homeDir,
            default: {
                ...actual,
                homedir: () => homeDir,
            },
        };
    });

    return import('../device.js');
}

describe('device util', () => {
    const tempDirs: string[] = [];
    const VALID_DEVICE_ID = '11111111-1111-4111-8111-111111111111';

    afterEach(async () => {
        vi.doUnmock('os');
        vi.restoreAllMocks();
        vi.resetModules();

        while (tempDirs.length > 0) {
            const dir = tempDirs.pop()!;
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('creates and persists a new device id', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-device-test-'),
        );
        tempDirs.push(home);
        const { getDeviceIdentity } = await importDeviceModule(home);

        const identity = await getDeviceIdentity();
        const deviceId = identity.deviceId;
        expect(deviceId).toMatch(/^[0-9a-f-]{36}$/i);

        const stored = JSON.parse(
            await fs.readFile(
                path.join(home, '.kodus', 'device.json'),
                'utf-8',
            ),
        ) as { deviceId: string; createdAt: string; deviceToken?: string };

        expect(stored.deviceId).toBe(deviceId);
        expect(typeof stored.createdAt).toBe('string');
        expect(stored.deviceToken).toBeUndefined();
    });

    it('reuses existing stored device id', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-device-test-'),
        );
        tempDirs.push(home);
        const deviceFile = path.join(home, '.kodus', 'device.json');
        await fs.mkdir(path.dirname(deviceFile), { recursive: true });
        await fs.writeFile(
            deviceFile,
            JSON.stringify({
                deviceId: VALID_DEVICE_ID,
                createdAt: new Date().toISOString(),
            }),
            'utf-8',
        );

        const { getOrCreateDeviceId } = await importDeviceModule(home);
        const deviceId = await getOrCreateDeviceId();
        expect(deviceId).toBe(VALID_DEVICE_ID);
    });

    it('recovers from malformed device file by generating a new id', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-device-test-'),
        );
        tempDirs.push(home);
        const deviceFile = path.join(home, '.kodus', 'device.json');
        await fs.mkdir(path.dirname(deviceFile), { recursive: true });
        await fs.writeFile(deviceFile, '{ malformed-json ', 'utf-8');

        const { getOrCreateDeviceId } = await importDeviceModule(home);
        const deviceId = await getOrCreateDeviceId();
        expect(deviceId).toMatch(/^[0-9a-f-]{36}$/i);

        const stored = JSON.parse(await fs.readFile(deviceFile, 'utf-8')) as {
            deviceId: string;
        };
        expect(stored.deviceId).toBe(deviceId);
    });

    it('regenerates id when stored device id is not a valid UUID', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-device-test-'),
        );
        tempDirs.push(home);
        const deviceFile = path.join(home, '.kodus', 'device.json');
        await fs.mkdir(path.dirname(deviceFile), { recursive: true });
        await fs.writeFile(
            deviceFile,
            JSON.stringify({
                deviceId: 'invalid-device-id',
                createdAt: new Date().toISOString(),
            }),
            'utf-8',
        );

        const { getOrCreateDeviceId } = await importDeviceModule(home);
        const deviceId = await getOrCreateDeviceId();
        expect(deviceId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(deviceId).not.toBe('invalid-device-id');
    });

    it('persists and reuses device token', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-device-test-'),
        );
        tempDirs.push(home);
        const { getDeviceIdentity, updateDeviceToken } =
            await importDeviceModule(home);

        const before = await getDeviceIdentity();
        expect(before.deviceToken).toBeUndefined();

        await updateDeviceToken('device-token-abc');

        const after = await getDeviceIdentity();
        expect(after.deviceId).toBe(before.deviceId);
        expect(after.deviceToken).toBe('device-token-abc');

        const stored = JSON.parse(
            await fs.readFile(
                path.join(home, '.kodus', 'device.json'),
                'utf-8',
            ),
        ) as {
            deviceId: string;
            deviceToken?: string;
            tokenUpdatedAt?: string;
        };
        expect(stored.deviceId).toBe(before.deviceId);
        expect(stored.deviceToken).toBe('device-token-abc');
        expect(typeof stored.tokenUpdatedAt).toBe('string');
    });

    it('ignores empty device token updates', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-device-test-'),
        );
        tempDirs.push(home);
        const { getDeviceIdentity, updateDeviceToken } =
            await importDeviceModule(home);

        await getDeviceIdentity();
        await updateDeviceToken('  ');

        const stored = JSON.parse(
            await fs.readFile(
                path.join(home, '.kodus', 'device.json'),
                'utf-8',
            ),
        ) as { deviceToken?: string };
        expect(stored.deviceToken).toBeUndefined();
    });
});
