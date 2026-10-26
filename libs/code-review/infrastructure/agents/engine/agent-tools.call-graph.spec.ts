import { buildAgentTools } from './agent-tools.factory';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

function makeRemoteCommands(): RemoteCommands {
    return {
        read: async () => '',
        listDir: async () => '',
        grep: async () => '',
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
}

const XML_CALL_GRAPH = `<CallGraph>
  <ChangedFunction name="updateProfile" file="src/profile/service.ts" lines="12-28" tested="false" status="modified">
    <Callers count="1">
      <Caller name="handleUpdate" file="src/profile/controller.ts" line="47" confidence="0.95" tier="receiver" />
    </Callers>
    <Callees count="1">
      <Callee name="saveProfile" file="src/profile/repository.ts" signature="saveProfile(profile: Profile): Promise&lt;void&gt;" confidence="0.85" tier="same" />
    </Callees>
  </ChangedFunction>
</CallGraph>`;

describe('buildAgentTools call graph lookup', () => {
    it('exposes callers and callees from the XML graph emitted in production', async () => {
        const tools = buildAgentTools(
            makeRemoteCommands(),
            undefined,
            undefined,
            undefined,
            undefined,
            XML_CALL_GRAPH,
        );

        expect(tools.getCallers).toBeDefined();

        const result = await tools.getCallers.execute({
            functionName: 'updateProfile',
        });

        expect(result).toContain('updateProfile (src/profile/service.ts)');
        expect(result).toContain(
            '← handleUpdate (src/profile/controller.ts:47, confidence 0.95)',
        );
        expect(result).toContain(
            '→ saveProfile (src/profile/repository.ts, confidence 0.85)',
        );
    });

    it('keeps the legacy text graph available during the XML migration', async () => {
        const tools = buildAgentTools(
            makeRemoteCommands(),
            undefined,
            undefined,
            undefined,
            undefined,
            [
                'Changed functions:',
                'updateProfile (src/profile/service.ts)',
                '  ← handleUpdate (src/profile/controller.ts:47)',
                '  → saveProfile (src/profile/repository.ts)',
            ].join('\n'),
        );

        const result = await tools.getCallers.execute({
            functionName: 'updateProfile',
        });

        expect(result).toContain(
            '← handleUpdate (src/profile/controller.ts:47)',
        );
        expect(result).toContain('→ saveProfile (src/profile/repository.ts)');
    });
});
