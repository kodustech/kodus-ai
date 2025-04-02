import { IExecuteAutomationService } from '@/shared/domain/contracts/execute.automation.service.contracts';
import { Injectable } from '@nestjs/common';
import { AutomationRegistry } from './register.automation';
import { CommunicationService } from '../../../platformIntegration/communication.service';
import { PinoLoggerService } from '../../../logger/pino.service';

@Injectable()
export class ExecuteAutomationService implements IExecuteAutomationService {
    constructor(
        private readonly automationRegistry: AutomationRegistry,
        private readonly communicationService: CommunicationService,
        private readonly logger: PinoLoggerService,
    ) {}

    async executeStrategy(name: string, payload: any): Promise<any> {
        const strategy = this.automationRegistry.getStrategy(name);
        return await strategy.run(payload);
    }

    async setupStrategy(name: string, payload: any): Promise<any> {
        const strategy = this.automationRegistry.getStrategy(name);
        return await strategy.setup(payload);
    }

    async stopStrategy(name: string, payload: any): Promise<any> {
        const strategy = this.automationRegistry.getStrategy(name);
        return await strategy.stop(payload);
    }

    async getAutomationMethods(name: string): Promise<any> {
        return this.automationRegistry.getStrategy(name);
    }
}
