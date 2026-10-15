import {
    CreateCheckRunParams,
    FindCheckRunParams,
    IChecksAdapter,
    UpdateCheckRunParams,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { Injectable } from '@nestjs/common';

@Injectable()
export class NullChecksAdapter implements IChecksAdapter {
    createCheckRun(
        params: CreateCheckRunParams,
    ): Promise<string | number | null> {
        return Promise.resolve(null);
    }
    updateCheckRun(params: UpdateCheckRunParams): Promise<boolean> {
        return Promise.resolve(true);
    }
    findCheckRun(params: FindCheckRunParams): Promise<string | number | null> {
        return Promise.resolve(null);
    }
}
