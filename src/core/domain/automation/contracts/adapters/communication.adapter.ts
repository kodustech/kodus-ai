export const COMMUNICATION_PLATFORM_ADAPTER_TOKEN = Symbol(
    'CommunicationPlatformAdapter',
);

export interface CommunicationPlatformAdapter {
    sendMessage(channel: string, message: string): Promise<void>;
    receiveMessage(): Promise<string>;
}
