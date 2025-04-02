export type MessagePayload<T = any> = {
    event_version: number;
    occurred_on: Date;
    payload: T;
    event_name: string;
    messageId: string;
};

export type BrokerConfig = {
    exchange: string;
    routingKey: string;
};

export const MESSAGE_BROKER_SERVICE_TOKEN = Symbol('MessageBrokerService');

export interface IMessageBrokerService {
    publishMessage(
        config: BrokerConfig,
        message: MessagePayload,
    ): Promise<void>;

    transformMessageToMessageBroker<T = any>(
        eventName: string,
        message: T,
    ): MessagePayload<T>;
}
