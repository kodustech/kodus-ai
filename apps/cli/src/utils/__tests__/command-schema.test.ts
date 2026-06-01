import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildCommandSchema } from '../command-schema.js';

describe('command schema', () => {
    it('marks required options using commander requiredOption', () => {
        const command = new Command('demo')
            .requiredOption('--token <value>', 'API token')
            .option('--config <path>', 'Optional config path');

        const schema = buildCommandSchema(command);
        const tokenOption = schema.options.find(
            (option) => option.long === '--token',
        );
        const configOption = schema.options.find(
            (option) => option.long === '--config',
        );

        expect(tokenOption?.required).toBe(true);
        expect(configOption?.required).toBe(false);
    });
});
