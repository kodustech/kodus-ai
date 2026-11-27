import { tool, type Tool } from 'ai';
import { z } from 'zod';

import type { StepView } from '@libs/agent-harness/domain/contracts/policy.contract';

import { auditWriteTools, performedWrites, type WriteToolEvent } from './conversation-tool-audit';
import { createWriteAuthorization, REFUSAL, requireDeclaredAction } from './write-authorization';
import { RUNTIME_NOTE_PREFIX, WriteTruthPolicy } from './write-truth.policy';

const NONE = `${RUNTIME_NOTE_PREFIX} ACTIONS PERFORMED THIS TURN: none. Nothing has changed yet, so do not say you saved, created, recorded or updated anything — you may report an action only once its tool call has returned.`;
const performed = (names: string) =>
    `${RUNTIME_NOTE_PREFIX} ACTIONS PERFORMED THIS TURN: ${names}. Report these and nothing else — do not describe any other action as done.`;

// The steps list every call the model made, refused ones included; the note
// must not read them.
const view = (names: string[]): StepView =>
    ({
        runId: 'r',
        agentId: 'conversation',
        stepNumber: 1,
        maxSteps: 12,
        steps: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: '',
                    toolCalls: names.map((name, i) => ({ id: `c${i}`, name, input: {} })),
                },
            },
        ],
        messages: [],
        activeTools: [],
    }) as StepView;

const note = (done: string[], called: string[] = done) =>
    new WriteTruthPolicy(() => done).prepareStep(view(called))?.injectNote?.content;

describe('WriteTruthPolicy', () => {
    it('tells the model it has done nothing when no write ran', () => {
        expect(note([])).toBe(NONE);
    });

    it('names the writes that did run, once each', () => {
        expect(note(['KODUS_CREATE_MEMORY', 'KODUS_CREATE_MEMORY'])).toBe(
            performed('KODUS_CREATE_MEMORY'),
        );
    });

    it('does not report a write the steps list but that never ran', () => {
        expect(note([], ['kodus_save_memory'])).toBe(NONE);
    });

    // Kimi K2.7 told the developer "Done! I've saved that as a memory" after
    // the gate refused the save. Wired as the conversation agent wires it.
    describe('through the write gate and the audit', () => {
        function wire(fail = false) {
            const saved: unknown[] = [];
            const writes: WriteToolEvent[] = [];
            const authorization = createWriteAuthorization();
            const tools: Record<string, Tool> = requireDeclaredAction(
                auditWriteTools(
                    {
                        kodus_save_memory: tool({
                            description: 'save',
                            inputSchema: z.object({ text: z.string() }),
                            execute: async (args) => {
                                if (fail) throw new Error('store down');
                                saved.push(args);
                                return 'saved';
                            },
                        }),
                    },
                    { kodus_save_memory: {} },
                    (event) => writes.push(event),
                ),
                (name) => name === 'kodus_save_memory',
                authorization,
            );
            const policy = new WriteTruthPolicy(() => performedWrites(writes));
            const save = () =>
                (tools.kodus_save_memory.execute as any)({ text: 'use pnpm' }, {});
            const noteNow = () =>
                policy.prepareStep(view(['kodus_save_memory']))?.injectNote?.content;
            return { authorization, save, noteNow, saved };
        }

        it('reports nothing after a refused write', async () => {
            const { save, noteNow, saved } = wire();

            const answer = await save();

            expect(answer).toBe(REFUSAL);
            expect(saved).toEqual([]);
            expect(noteNow()).toBe(NONE);
        });

        it('reports the write once it was authorized and returned', async () => {
            const { authorization, save, noteNow, saved } = wire();
            authorization.grant('kodus_save_memory');

            expect(await save()).toBe('saved');
            expect(saved).toEqual([{ text: 'use pnpm' }]);
            expect(noteNow()).toBe(performed('kodus_save_memory'));
        });

        it('reports nothing for a write that threw', async () => {
            const { authorization, save, noteNow } = wire(true);
            authorization.grant('kodus_save_memory');

            await expect(save()).rejects.toThrow('store down');
            expect(noteNow()).toBe(NONE);
        });
    });
});
