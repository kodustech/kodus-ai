import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, concat, from, fromEvent, merge } from 'rxjs';
import { map, takeWhile, mergeMap } from 'rxjs/operators';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    DRY_RUN_SERVICE_TOKEN,
    IDryRunService,
} from '@libs/dryRun/domain/contracts/dryRun.service.contract';
import {
    IDryRunEvent,
    DryRunEventType,
    DryRunStatus,
} from '@libs/dryRun/domain/interfaces/dryRun.interface';

@Injectable()
export class SseDryRunUseCase {
    private readonly logger = createLogger(SseDryRunUseCase.name);
    constructor(
        @Inject(DRY_RUN_SERVICE_TOKEN)
        private readonly dryRunService: IDryRunService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    async execute(params: {
        correlationId: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<Observable<IDryRunEvent>> {
        const { correlationId, organizationAndTeamData } = params;

        const observables: Observable<IDryRunEvent>[] = [];

        for (const eventType of Object.values(DryRunEventType)) {
            observables.push(
                fromEvent(
                    this.eventEmitter,
                    `dryRun.${correlationId}.${eventType}`,
                ).pipe(map((event: IDryRunEvent) => event)),
            );
        }

        const futureEvents$ = merge(...observables);

        const pastEvents$ = from(
            this.getPastEventsObservable(
                correlationId,
                organizationAndTeamData,
            ),
        ).pipe(mergeMap((pastEvents) => from(pastEvents)));

        return concat(pastEvents$, futureEvents$).pipe(
            takeWhile((event) => {
                if (event.type === DryRunEventType.REMOVED) {
                    return false;
                }
                if (
                    event.type === DryRunEventType.STATUS_UPDATED &&
                    (event.payload.status === DryRunStatus.COMPLETED ||
                        event.payload.status === DryRunStatus.FAILED)
                ) {
                    return false;
                }
                return true;
            }, true),
        );
    }

    private async getPastEventsObservable(
        correlationId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IDryRunEvent[]> {
        const pastEvents: IDryRunEvent[] = [];

        try {
            const details = await this.dryRunService.findDryRunById({
                organizationAndTeamData,
                id: correlationId,
            });

            if (!details) {
                return pastEvents;
            }

            if (details.events?.length > 0) {
                const sortedEvents = details.events.sort((a, b) =>
                    a.timestamp > b.timestamp ? 1 : -1,
                );
                pastEvents.push(...sortedEvents);
            }

            return pastEvents;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching past dry run events',
                error,
                metadata: { correlationId, organizationAndTeamData },
                context: SseDryRunUseCase.name,
            });

            return pastEvents;
        }
    }
}
