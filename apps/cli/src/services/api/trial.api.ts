import type { TrialStatus } from '../../types/trial.js';
import type { ITrialApi } from './api.interface.js';
import { requestWithRetry } from './api-core.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

export class RealTrialApi implements ITrialApi {
    constructor(private readonly requester: RequestWithRetry = requestWithRetry) {}

    async getStatus(fingerprint: string): Promise<TrialStatus> {
        return this.requester<TrialStatus>(
            `/cli/trial/status?fingerprint=${fingerprint}`,
        );
    }
}
