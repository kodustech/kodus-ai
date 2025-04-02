import { AutomationEntity } from '../entities/automation.entity';
import { IAutomation } from '../interfaces/automation.interface';

export const AUTOMATION_REPOSITORY_TOKEN = Symbol('AutomationRepository');

export interface IAutomationRepository {
    create(automation: IAutomation): Promise<AutomationEntity>;
    update(
        filter: Partial<IAutomation>,
        data: Partial<IAutomation>,
    ): Promise<AutomationEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<AutomationEntity | null>;
    find(filter?: Partial<IAutomation>): Promise<AutomationEntity[]>;
    findOne(
        filter: Partial<IAutomation>,
    ): Promise<AutomationEntity | undefined>;
}
