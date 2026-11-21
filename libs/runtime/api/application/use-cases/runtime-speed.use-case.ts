import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { type Clock, RUNTIME_CLOCK } from '../../domain/ports';
import { buildRuntimeSpeed, type RuntimeSpeed, SPEED_WINDOW_DAYS, type SpeedWindowDays } from '../../domain/runtime-speed';
import { RUNTIME_SPEED_READER, type RuntimeSpeedReader, SPEED_ROW_LIMIT } from '../../infrastructure/pg-runtime-speed.reader';
import { orgOf } from './environment-view';

const DAY = 86_400_000;

/** The window a query names: 7 (the default) or 30 days; anything else is refused. */
export function speedWindowOf(raw: string | undefined): SpeedWindowDays {
    if (raw === undefined || raw === '') return 7;
    const n = Number(raw);
    if (!(SPEED_WINDOW_DAYS as readonly number[]).includes(n)) throw new BadRequestException(`windowDays must be one of ${SPEED_WINDOW_DAYS.join(', ')}`);
    return n as SpeedWindowDays;
}

/**
 * GET /runtime/settings/health/speed?windowDays=7|30 — owner only, like the
 * Health screen it sits on (docs/runtime/observability.md, "Speed"): p50/p95 of
 * request to verdict, to both sides ready and of the queue wait, over the
 * window, by machine source, host and environment.
 */
@Injectable()
export class GetRuntimeSpeedUseCase {
    constructor(
        @Inject(RUNTIME_SPEED_READER) private readonly reader: RuntimeSpeedReader,
        @Inject(RUNTIME_CLOCK) private readonly clock: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; windowDays?: string }): Promise<RuntimeSpeed> {
        const organizationId = orgOf(input.user);
        const windowDays = speedWindowOf(input.windowDays);
        const now = this.clock();
        const rows = await this.reader.speedRuns(organizationId, new Date(now.getTime() - windowDays * DAY), SPEED_ROW_LIMIT);
        return buildRuntimeSpeed({ rows, windowDays, now, truncated: rows.length >= SPEED_ROW_LIMIT });
    }
}
