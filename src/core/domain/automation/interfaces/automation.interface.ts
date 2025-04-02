import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';
import { AutomationType } from '../enums/automation-type';

export interface IAutomation {
    uuid: string;
    name: string;
    description: string;
    tags: string[];
    antiPatterns: string[];
    status: boolean;
    automationType: AutomationType;
    level: AutomationLevel;
}
