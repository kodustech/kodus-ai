import { describe, expect, it, vi } from 'vitest';
import { RealMemoryApi } from '../memory.api.js';

describe('RealMemoryApi', () => {
    it('uses X-Team-Key when submitting memory capture with team key auth', async () => {
        const request = vi.fn().mockResolvedValue({
            id: 'capture-1',
            createdAt: new Date().toISOString(),
        });

        const api = new RealMemoryApi(request);
        await api.submitCapture(
            {
                source: 'test',
                memory: 'important note',
            },
            'kodus_team_key',
        );

        expect(request).toHaveBeenCalledWith('/cli/memory/captures', {
            method: 'POST',
            headers: {
                'X-Team-Key': 'kodus_team_key',
            },
            body: JSON.stringify({
                source: 'test',
                memory: 'important note',
            }),
        });
    });

    it('uses bearer auth when submitting memory capture with user token', async () => {
        const request = vi.fn().mockResolvedValue({
            id: 'capture-1',
            createdAt: new Date().toISOString(),
        });

        const api = new RealMemoryApi(request);
        await api.submitCapture(
            {
                source: 'test',
                memory: 'important note',
            },
            'eyJ.test.token',
        );

        expect(request).toHaveBeenCalledWith('/cli/memory/captures', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer eyJ.test.token',
            },
            body: JSON.stringify({
                source: 'test',
                memory: 'important note',
            }),
        });
    });
});
