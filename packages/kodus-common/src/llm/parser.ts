import { ContentBlock } from '@langchain/core/messages';
import {
    BaseOutputParser,
    JsonOutputParser,
    StringOutputParser,
    StructuredOutputParser,
} from '@langchain/core/output_parsers';
import { InteropZodType, interopSafeParse } from '@langchain/core/utils/types';
import { PromptRunnerService } from './promptRunner.service';
import { LLMModelProvider } from './helper';
import { ParserType } from './builder';
import { tryParseJSONObject } from '@/utils/json';

const getBlockType = (block: ContentBlock): string | undefined => {
    const typeValue = (block as { type?: unknown }).type;
    return typeof typeValue === 'string' ? typeValue : undefined;
};

const contentBlocksToText = (content: ContentBlock[]): string => {
    const noReasoningContent = content.filter((block) => {
        const type = getBlockType(block);
        return type !== 'reasoning' && type !== 'thinking';
    });

    const text = noReasoningContent.map((block) => {
        const maybeText = (block as { text?: unknown }).text;
        return typeof maybeText === 'string' ? maybeText : '';
    });

    return text.join('\n').trim();
};

export class CustomStringOutputParser extends StringOutputParser {
    static override lc_name(): string {
        return 'CustomStringOutputParser';
    }
    lc_namespace = ['kodus', 'output_parsers', 'string'];

    protected override _messageContentToString(content: ContentBlock): string {
        const type = getBlockType(content);
        if (type === 'reasoning' || type === 'thinking') {
            return '';
        }
        return super._messageContentToString(content);
    }
}

export class CustomJsonOutputParser extends JsonOutputParser {
    static override lc_name(): string {
        return 'CustomJsonOutputParser';
    }
    lc_namespace = ['kodus', 'output_parsers', 'json'];

    protected override _baseMessageContentToString(
        content: ContentBlock[],
    ): string {
        return contentBlocksToText(content);
    }
}

export class ZodOutputParser<
    Output,
    Schema extends InteropZodType<Output> = InteropZodType<Output>,
> extends BaseOutputParser<Output> {
    static override lc_name(): string {
        return 'ZodOutputParser';
    }
    lc_namespace = ['kodus', 'output_parsers', 'zod'];

    private readonly structuredParser: BaseOutputParser<Output>;

    constructor(
        private readonly config: {
            schema: Schema;
            promptRunnerService: PromptRunnerService;
            provider?: LLMModelProvider;
            fallbackProvider?: LLMModelProvider;
        },
    ) {
        super();
        this.structuredParser = StructuredOutputParser.fromZodSchema(
            this.config.schema,
        );
    }

    protected override _baseMessageContentToString(
        content: ContentBlock[],
    ): string {
        return contentBlocksToText(content);
    }

    public override getFormatInstructions(): string {
        return this.structuredParser.getFormatInstructions();
    }

    private parseWithSchema(value: unknown): Output {
        const parsed = interopSafeParse<Output>(this.config.schema, value);
        if (!parsed.success) {
            throw new Error('Failed to parse JSON with provided schema');
        }
        return parsed.data;
    }

    /**
     * Parses the raw string output from the LLM.
     * It attempts to extract and parse JSON, and if it fails,
     * it uses another LLM call to correct the format.
     */
    public override async parse(text: string): Promise<Output> {
        if (!text) {
            throw new Error('Input text is empty or undefined');
        }

        const parseJsonPreprocessorValue = (value: unknown): unknown => {
            if (typeof value !== 'string') {
                throw new Error('Input must be a string');
            }

            let cleanResponse = value;
            if (value.startsWith('```')) {
                cleanResponse = value
                    .replace(/^```json\n/, '')
                    .replace(/\n```(\n)?$/, '')
                    .trim();
            }

            const parsedResponse = tryParseJSONObject(cleanResponse);
            if (parsedResponse) {
                return parsedResponse;
            }

            throw new Error('Failed to parse JSON from the provided string');
        };

        try {
            const parsed = await this.structuredParser.parse(text);
            return this.parseWithSchema(parsed);
        } catch {
            try {
                const preprocessed = parseJsonPreprocessorValue(text);
                return this.parseWithSchema(preprocessed);
            } catch {
                // If parsing fails, use the LLM to fix the JSON
                return this._runCorrectionChain(text);
            }
        }
    }

    /**
     * Internal method to run a new prompt chain to fix malformed JSON.
     */
    private async _runCorrectionChain(
        malformedOutput: string,
    ): Promise<Output> {
        if (!this.config.schema) {
            throw new Error('Schema is required for JSON correction');
        }

        if (!malformedOutput) {
            throw new Error('Malformed output is empty or undefined');
        }

        const prompt = (input: string) =>
            `${input}\n\n${this.structuredParser.getFormatInstructions()}`;

        const result = await this.config.promptRunnerService
            .builder()
            .setProviders({
                main:
                    this.config.provider || LLMModelProvider.OPENAI_GPT_4O_MINI,
                fallback:
                    this.config.fallbackProvider ||
                    LLMModelProvider.OPENAI_GPT_4O,
            })
            .setParser(ParserType.CUSTOM, this.structuredParser)
            .setPayload(malformedOutput)
            .addPrompt({ prompt })
            .setTemperature(0)
            .setLLMJsonMode(true)
            .setRunName('fixAndExtractJson')
            .execute();

        if (!result) {
            throw new Error('Failed to correct JSON even after LLM fallback.');
        }

        try {
            return this.parseWithSchema(result);
        } catch {
            throw new Error('Failed to correct JSON even after LLM fallback.');
        }
    }
}
