import {
    getCloudflareAccessHeaders,
    request,
    resetApiConfigCache,
    resolveApiBaseUrl,
} from './api-core.js';
import type { IKodusApi, ISessionsApi, ITrialApi } from './api.interface.js';
import { RealAuthApi } from './auth.api.js';
import { RealConfigApi } from './config.api.js';
import { RealMemoryApi } from './memory.api.js';
import { RealReviewApi } from './review.api.js';
import { RealRulesApi } from './rules.api.js';
import { RealSessionsApi } from './sessions.api.js';
import { RealTrialApi } from './trial.api.js';

export const _resetConfigCache = resetApiConfigCache;
export { getCloudflareAccessHeaders, request, resolveApiBaseUrl };

export class RealApi implements IKodusApi {
    auth = new RealAuthApi();
    config = new RealConfigApi();
    review = new RealReviewApi();
    trial: ITrialApi = new RealTrialApi();
    memory = new RealMemoryApi();
    sessions: ISessionsApi = new RealSessionsApi();
    rules = new RealRulesApi();
}
