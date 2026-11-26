/**
 * Review on #2709 (sartorijr92, round 2): a refused BYOK base URL tells the
 * org what fixes it where it runs. On cloud, a public endpoint; on a
 * self-hosted install, the operator's allowance (#2381), where a gateway on
 * the LAN is the usual setup and "use a public endpoint" is no fix.
 */
import { classifyLLMError } from './error-classifier';
import { GatewayAddressRefusedError } from './gateway-address-guard';

jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));
const { environment } = jest.requireMock('@libs/ee/configs/environment');

const refused = (host: string, address: string) =>
    new TypeError('fetch failed', {
        cause: new GatewayAddressRefusedError(host, address),
    });

describe('the message for a refused BYOK base URL', () => {
    it('cloud: points at a public endpoint, names no allowance', () => {
        environment.API_CLOUD_MODE = true;
        const msg = classifyLLMError(
            refused('llm.lan', '10.0.0.4'),
        ).friendlyMessage;
        expect(msg).toBe(
            'The base URL of this model resolves to a private or reserved address, so the call was not sent. Point it at a public provider endpoint.',
        );
    });

    it('self-hosted: names the operator allowance, and that http is fine there', () => {
        environment.API_CLOUD_MODE = false;
        const msg = classifyLLMError(
            refused('localhost', '127.0.0.1'),
            'openai_compatible',
        ).friendlyMessage;
        expect(msg).toBe(
            'The base URL of this model (openai_compatible) resolves to a private or reserved address, so the call was not sent. Point it at a public provider endpoint. On a self-hosted install, the operator can allow a gateway on its own network with API_ALLOWED_PRIVATE_HOSTS (host[:port], IP or range); a host named there may use http.',
        );
    });

    it('self-hosted: the metadata service is never offered the allowance', () => {
        environment.API_CLOUD_MODE = false;
        const msg = classifyLLMError(
            refused('169.254.169.254', '169.254.169.254'),
        ).friendlyMessage;
        // The cloud sentence, with no allowance after it.
        expect(msg).toBe(
            'The base URL of this model resolves to a private or reserved address, so the call was not sent. Point it at a public provider endpoint.',
        );
    });
});
