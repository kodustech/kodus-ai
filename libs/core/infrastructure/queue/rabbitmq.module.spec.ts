import { rabbitMQHandlerDiscovery } from './rabbitmq.module';

describe('rabbitMQHandlerDiscovery', () => {
    it('registers no handler only in a deep-scan slice child', () => {
        expect(
            rabbitMQHandlerDiscovery({
                enableConsumers: false,
                securityScanOnly: true,
            }),
        ).toMatchObject({
            enableControllerDiscovery: false,
            registerHandlers: false,
        });
        // API and webhooks: their feedback and notification consumers are
        // providers, so only controller discovery is off.
        expect(rabbitMQHandlerDiscovery({ enableConsumers: false })).toEqual({
            enableControllerDiscovery: false,
        });
    });

    it('registers only the deep-scan handler on the scan worker', () => {
        expect(
            rabbitMQHandlerDiscovery({
                enableConsumers: true,
                securityScanOnly: true,
            }),
        ).toEqual({
            enableControllerDiscovery: true,
            registerHandlers: true,
            defaultHandler: 'disabled',
            handlers: { 'security-scan': {} },
        });
    });
});
