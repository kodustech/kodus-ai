import { dumpCentralizedYaml } from './yaml-dump';

describe('dumpCentralizedYaml with custom agent CLI secrets', () => {
    it('never writes a CLI secret ciphertext into the YAML', () => {
        const yamlText = dumpCentralizedYaml({
            customAgents: [
                {
                    id: 'agent-1',
                    tools: {
                        cli: [
                            {
                                name: 'lintkit',
                                secrets: [
                                    {
                                        env: 'LINTKIT_TOKEN',
                                        ciphertext: 'aabbcc:ddeeff00',
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
        });
        expect(yamlText).toContain('LINTKIT_TOKEN');
        expect(yamlText).not.toContain('aabbcc:ddeeff00');
    });
});
