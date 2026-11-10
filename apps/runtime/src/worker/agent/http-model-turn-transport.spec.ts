import { readRuntimeRpc } from './http-model-turn';
import { LlmUnavailableError } from './llm-gateway';

it('rejects invalid UTF8 instead of replacing bytes inside a signed or opaque response frame', async () => {
    const bytes = Buffer.concat([
        Buffer.from('{"text":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
    ]);
    await expect(
        readRuntimeRpc(new Response(bytes), 100),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
});
it('refuses duplicate keys and oversized streamed responses with fixed public errors', async () => {
    await expect(
        readRuntimeRpc(new Response('{"x":1,"x":2}'), 100),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(
        readRuntimeRpc(new Response('x'.repeat(200)), 100),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
});
