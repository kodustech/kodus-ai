import type {
    MemoryCaptureApiRequest,
    MemoryCaptureApiResponse,
} from '../../types/memory.js';
import type { IMemoryApi } from './api.interface.js';
import { request } from './api-core.js';

type RequestFn = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

export class RealMemoryApi implements IMemoryApi {
    constructor(private readonly requester: RequestFn = request) {}

    async submitCapture(
        payload: MemoryCaptureApiRequest,
        accessToken: string,
    ): Promise<MemoryCaptureApiResponse> {
        const isTeamKey = accessToken.startsWith('kodus_');
        const headers: Record<string, string> = isTeamKey
            ? { 'X-Team-Key': accessToken }
            : { Authorization: `Bearer ${accessToken}` };

        return this.requester<MemoryCaptureApiResponse>('/cli/memory/captures', {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
    }
}
