export const AUTOMATION_FACTORY_TOKEN = Symbol('AutomationFactory');

export interface IAutomationFactory {
    automationType: string;
    setup(payload?: any): Promise<any>;
    run?(payload?: any): Promise<any>;
    stop(payload?: any): Promise<any>;
}
