export const AUTOMATION_STRATEGY_TOKEN = Symbol('AutomationStrategy');

export interface IAutomationStrategy {
    route(
        message: string,
        userId: string,
        channel: string,
        sessionId?: string,
        userName?: string,
    ): Promise<any>;
}
