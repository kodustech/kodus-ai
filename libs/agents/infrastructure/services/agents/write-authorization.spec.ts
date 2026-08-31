import { tool } from 'ai';
import { z } from 'zod';

import {
    createWriteAuthorization,
    requireDeclaredAction,
} from './write-authorization';

const stub = () =>
    tool({
        description: 'stub',
        inputSchema: z.object({}),
        execute: async () => 'written',
    });

const isWrite = (name: string) => name === 'KODUS_CREATE_MEMORY';

describe('requireDeclaredAction', () => {
    it('refuses a write nobody declared, and says how to proceed', async () => {
        const auth = createWriteAuthorization();
        const tools = requireDeclaredAction(
            { KODUS_CREATE_MEMORY: stub() },
            isWrite,
            auth,
        );

        const result = await tools.KODUS_CREATE_MEMORY.execute!(
            {},
            {} as never,
        );

        expect(String(result)).toMatch(/kodusDecideAction/);
        expect(String(result)).toMatch(/not been performed/i);
    });

    it('lets the write through once an action is authorized', async () => {
        const auth = createWriteAuthorization();
        auth.grant('KODUS_CREATE_MEMORY');
        const tools = requireDeclaredAction(
            { KODUS_CREATE_MEMORY: stub() },
            isWrite,
            auth,
        );

        await expect(
            tools.KODUS_CREATE_MEMORY.execute!({}, {} as never),
        ).resolves.toBe('written');
    });

    it('authorizes the declared tool only', async () => {
        const auth = createWriteAuthorization();
        auth.grant('KODUS_CREATE_KODY_ISSUE');
        const tools = requireDeclaredAction(
            { KODUS_CREATE_MEMORY: stub() },
            isWrite,
            auth,
        );

        expect(
            String(await tools.KODUS_CREATE_MEMORY.execute!({}, {} as never)),
        ).toMatch(/kodusDecideAction/);
    });

    it('grants every write when the declaration named no tool', async () => {
        const auth = createWriteAuthorization();
        auth.grant(undefined);
        const tools = requireDeclaredAction(
            { KODUS_CREATE_MEMORY: stub() },
            isWrite,
            auth,
        );

        await expect(
            tools.KODUS_CREATE_MEMORY.execute!({}, {} as never),
        ).resolves.toBe('written');
    });

    it('leaves read tools alone', async () => {
        const auth = createWriteAuthorization();
        const read = stub();
        const tools = requireDeclaredAction(
            { KODUS_FIND_MEMORIES: read },
            isWrite,
            auth,
        );

        expect(tools.KODUS_FIND_MEMORIES).toBe(read);
    });
});
