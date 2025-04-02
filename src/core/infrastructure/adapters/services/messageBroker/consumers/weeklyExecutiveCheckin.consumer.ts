import { Inject, Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';

import { EXECUTE_AUTOMATION_SERVICE_TOKEN, IExecuteAutomationService } from '@/shared/domain/contracts/execute.automation.service.contracts';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class WeeklyExecutiveCheckinConsumer {
    constructor(
        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,
    ) { }

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'cron.runWeeklyExecutiveCheckin',
        queue: 'cron.weeklyExecutiveCheckin.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'cron.runWeeklyExecutiveCheckin',
            durable: true,
        },
    })
    async handleWeeklyExecutiveCheckin(message: any) {
        const payload = message?.payload;

        if (payload) {
            await this.executeAutomation.executeStrategy(
                AutomationType.AUTOMATION_EXECUTIVE_CHECKIN,
                {
                    organizationId: payload.organizationId,
                    organizationAutomationId: payload.organizationAutomationId,
                    origin: 'System',
                },
            );
        }
    }
}
