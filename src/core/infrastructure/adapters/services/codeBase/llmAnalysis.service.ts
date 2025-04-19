import { Injectable } from '@nestjs/common';
import { IAIAnalysisService } from '../../../../domain/codeBase/contracts/AIAnalysisService.contract';
import {
    FileChangeContext,
    AnalysisContext,
    AIAnalysisResult,
    CodeSuggestion,
    ReviewModeResponse,
    FileChange,
    ISafeguardResponse,
    ReviewModeConfig,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '../logger/pino.service';
import {
    getChatGemini,
    getChatGPT,
    getChatVertexAI,
    getDeepseekByNovitaAI,
} from '@/shared/utils/langchainCommon/document';
import { RunnableSequence } from '@langchain/core/runnables';
import {
    StringOutputParser,
    StructuredOutputParser,
} from '@langchain/core/output_parsers';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
    prompt_codeReviewSafeguard_system,
    prompt_codeReviewSafeguard_user,
} from '@/shared/utils/langchainCommon/prompts/codeReviewSafeguard';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { LLMResponseProcessor } from './utils/transforms/llmResponseProcessor.transform';
import { prompt_validateImplementedSuggestions } from '@/shared/utils/langchainCommon/prompts/validateImplementedSuggestions';
import { prompt_selectorLightOrHeavyMode_system } from '@/shared/utils/langchainCommon/prompts/seletorLightOrHeavyMode';
import {
    CodeReviewPayload,
    prompt_codereview_system_gemini,
    prompt_codereview_user_deepseek,
} from '@/shared/utils/langchainCommon/prompts/configuration/codeReview';
import {
    prompt_severity_analysis_system,
    prompt_severity_analysis_user,
} from '@/shared/utils/langchainCommon/prompts/severityAnalysis';
import {
    NewCodeReviewPayload,
    prompt_specificCategoryCodeReview,
} from '@/shared/utils/langchainCommon/prompts/codeReview/specificCategoryCodeReview';
import { prompt_potentialIssues } from '@/shared/utils/langchainCommon/prompts/codeReview/categories/pontetialIssues';
import { prompt_languageContext } from '@/shared/utils/langchainCommon/prompts/codeReview/languageContext';

// Interface for token tracking
interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    model?: string;
    runId?: string;
    parentRunId?: string;
}

// Handler for token tracking
class TokenTrackingHandler extends BaseCallbackHandler {
    name = 'TokenTrackingHandler';
    tokenUsages: TokenUsage[] = [];

    private extractUsageMetadata(output: any): TokenUsage {
        try {
            // Attempts to extract information from different locations in the response
            const usage: TokenUsage = {};

            // Extracts token information
            if (output?.llmOutput?.tokenUsage) {
                Object.assign(usage, output.llmOutput.tokenUsage);
            } else if (output?.llmOutput?.usage) {
                Object.assign(usage, output.llmOutput.usage);
            } else if (output?.generations?.[0]?.[0]?.message?.usage_metadata) {
                const metadata =
                    output.generations[0][0].message.usage_metadata;
                usage.input_tokens = metadata.input_tokens;
                usage.output_tokens = metadata.output_tokens;
                usage.total_tokens = metadata.total_tokens;
            }

            // Extracts model
            usage.model =
                output?.llmOutput?.model ||
                output?.generations?.[0]?.[0]?.message?.response_metadata
                    ?.model ||
                'unknown';

            return usage;
        } catch (error) {
            console.error('Error extracting usage metadata:', error);
            return {};
        }
    }

    async handleLLMEnd(
        output: any,
        runId: string,
        parentRunId?: string,
        tags?: string[],
    ) {
        const usage = this.extractUsageMetadata(output);

        if (Object.keys(usage).length > 0) {
            this.tokenUsages.push({
                ...usage,
                runId,
                parentRunId,
            });
        }
    }

    getTokenUsages(): TokenUsage[] {
        return this.tokenUsages;
    }

    reset() {
        this.tokenUsages = [];
    }
}

export const LLM_ANALYSIS_SERVICE_TOKEN = Symbol('LLMAnalysisService');

@Injectable()
export class LLMAnalysisService implements IAIAnalysisService {
    private readonly tokenTracker: TokenTrackingHandler;
    private readonly llmResponseProcessor: LLMResponseProcessor;

    constructor(private readonly logger: PinoLoggerService) {
        this.tokenTracker = new TokenTrackingHandler();
        this.llmResponseProcessor = new LLMResponseProcessor(logger);
    }

    //#region Helper Functions
    // Creates the prefix for the prompt cache (every prompt that uses file or codeDiff must start with this)
    private preparePrefixChainForCache(
        context: {
            patchWithLinesStr: string;
            fileContent: string;
            language: string;
            filePath: string;
        },
        reviewMode: ReviewModeResponse,
    ) {
        if (!context?.patchWithLinesStr) {
            throw new Error('Required context parameters are missing');
        }

        if (reviewMode === ReviewModeResponse.LIGHT_MODE) {
            return {
                type: 'text',
                text: `
                <codeDiff>
                    ${context.patchWithLinesStr}
                </codeDiff>

                <filePath>
                    ${context.filePath}
                </filePath>
                `,
                cache_control: { type: 'ephemeral' },
            };
        }

        return {
            type: 'text',
            text: `
            <fileContent>
                ${context.fileContent}
            </fileContent>

            <codeDiff>
                ${context.patchWithLinesStr}
            </codeDiff>

            <filePath>
                ${context.filePath}
            </filePath>
            `,
            cache_control: { type: 'ephemeral' },
        };
    }

    private async logTokenUsage(metadata: any) {
        // Log token usage for analysis and monitoring
        this.logger.log({
            message: 'Token usage',
            context: LLMAnalysisService.name,
            metadata: {
                ...metadata,
            },
        });
    }
    //#endregion

    //#region Analyze Code with AI
    async analyzeCodeWithAI(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
    ): Promise<AIAnalysisResult> {
        const provider = this.getInitialProvider(context, reviewModeResponse);

        // Reset token tracking for new analysis
        this.tokenTracker.reset();

        // Prepare base context
        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );

        try {
            // Create chain with fallback
            const chain = await this.createAnalysisChainWithFallback(
                provider,
                baseContext,
                reviewModeResponse,
            );

            // Execute analysis
            const result = await chain.invoke(baseContext);

            // Process result and tokens
            const analysisResult = this.llmResponseProcessor.processResponse(
                organizationAndTeamData,
                prNumber,
                result,
            );

            if (!analysisResult) {
                return null;
            }

            analysisResult.codeReviewModelUsed = {
                generateSuggestions: provider,
            };

            return analysisResult;
        } catch (error) {
            this.logger.error({
                message: `Error during LLM code analysis for PR#${prNumber}`,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
                error,
            });
            throw error;
        }
    }

    private async prepareAnalysisContext(
        fileContext: FileChangeContext,
        context: AnalysisContext,
    ) {
        const baseContext = {
            pullRequest: context?.pullRequest,
            patchWithLinesStr: fileContext?.patchWithLinesStr,
            maxSuggestionsParams:
                context.codeReviewConfig?.suggestionControl?.maxSuggestions,
            language: context?.repository?.language,
            filePath: fileContext?.file?.filename,
            languageResultPrompt:
                context?.codeReviewConfig?.languageResultPrompt,
            reviewOptions: context?.codeReviewConfig?.reviewOptions,
            fileContent: fileContext?.file?.fileContent,
            limitationType:
                context?.codeReviewConfig?.suggestionControl?.limitationType,
            severityLevelFilter:
                context?.codeReviewConfig?.suggestionControl
                    ?.severityLevelFilter,
            groupingMode:
                context?.codeReviewConfig?.suggestionControl?.groupingMode,
            organizationAndTeamData: context?.organizationAndTeamData,
        };

        return baseContext;
    }

    private async createAnalysisChainWithFallback(
        provider: LLMModelProvider,
        context: any,
        reviewMode: ReviewModeResponse,
    ) {
        const fallbackProvider = this.getFallbackProvider(provider, reviewMode);

        try {
            const mainChain = await this.createAnalysisProviderChain(
                provider,
                reviewMode,
            );
            const fallbackChain = await this.createAnalysisProviderChain(
                fallbackProvider,
                reviewMode,
            );

            // Use withFallbacks to properly configure the fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'analyzeCodeWithAI',
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                        reviewMode: reviewMode,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                },
            });
            throw error;
        }
    }

    private async createAnalysisProviderChain(
        provider: LLMModelProvider,
        reviewModeResponse: ReviewModeResponse,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : provider === LLMModelProvider.GEMINI_2_5_PRO_PREVIEW
                      ? getChatGemini({
                            model: LLMModelProvider.GEMINI_2_5_PRO_PREVIEW,
                            temperature: 0,
                            callbacks: [this.tokenTracker],
                        })
                      : getChatGPT({
                            model: getLLMModelProviderWithFallback(
                                LLMModelProvider.CHATGPT_4_ALL,
                            ),
                            temperature: 0,
                            callbacks: [this.tokenTracker],
                        });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            if (provider === LLMModelProvider.DEEPSEEK_V3) {
                const lightModeChain = RunnableSequence.from([
                    async (input: any) => {
                        return [
                            {
                                role: 'user',
                                content: [
                                    {
                                        type: 'text',
                                        text: prompt_codereview_user_deepseek(
                                            input,
                                        ),
                                    },
                                ],
                            },
                        ];
                    },
                    llm,
                    new StringOutputParser(),
                ]);

                return lightModeChain;
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    return [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: prompt_codereview_system_gemini(
                                        input,
                                    ),
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis code chain',
                error,
                context: LLMAnalysisService.name,
                metadata: { provider },
            });
            throw error;
        }
    }
    //#endregion

    //#region Light Mode Functions
    private getInitialProvider(
        context: AnalysisContext,
        reviewModeResponse: ReviewModeResponse,
        newDeepseekVersion: boolean = false,
    ): LLMModelProvider {
        if (
            reviewModeResponse === ReviewModeResponse.LIGHT_MODE &&
            context?.codeReviewConfig?.reviewModeConfig ===
                ReviewModeConfig.LIGHT_MODE_FULL
        ) {
            return newDeepseekVersion
                ? LLMModelProvider.DEEPSEEK_V3_0324
                : LLMModelProvider.DEEPSEEK_V3;
        }
        return LLMModelProvider.GEMINI_2_5_PRO_PREVIEW;
    }

    private getFallbackProvider(
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
        newDeepseekVersion: boolean = false,
    ): LLMModelProvider {
        if (newDeepseekVersion) {
            return LLMModelProvider.DEEPSEEK_V3_0324;
        }
        return LLMModelProvider.DEEPSEEK_V3;
    }
    //#endregion

    //#region Generate Code Suggestions
    private async createSuggestionsChainWithFallback(
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.GEMINI_2_5_PRO_PREVIEW
                : LLMModelProvider.CHATGPT_4_ALL;
        try {
            // Main chain
            const mainChain = await this.createAnalysisChainWithFallback(
                provider,
                {},
                reviewMode,
            );

            const fallbackChain = await this.createAnalysisChainWithFallback(
                fallbackProvider,
                {},
                reviewMode,
            );

            // Combine with fallback
            return RunnableSequence.from([mainChain, fallbackChain]);
        } catch (error) {
            this.logger.error({
                message: 'Error creating suggestions chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                },
            });
            throw error;
        }
    }

    async generateCodeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        sessionId: string,
        question: string,
        parameters: any,
        reviewMode: ReviewModeResponse = ReviewModeResponse.LIGHT_MODE,
    ) {
        const provider =
            parameters.llmProvider || LLMModelProvider.GEMINI_2_5_PRO_PREVIEW;

        // Reset token tracking for new suggestions
        this.tokenTracker.reset();

        try {
            const chain = await this.createSuggestionsChainWithFallback(
                provider,
                reviewMode,
            );
            const result = await chain.invoke({ question });

            // Log token usage
            const tokenUsages = this.tokenTracker.getTokenUsages();
            await this.logTokenUsage({
                tokenUsages,
                organizationAndTeamData,
                sessionId,
                parameters,
            });
            return result;
        } catch (error) {
            this.logger.error({
                message: `Error generating code suggestions`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    sessionId,
                    parameters,
                },
            });
            throw error;
        }
    }
    //#endregion

    //#region Severity Analysis
    public async createSeverityAnalysisChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: any[],
        selectedCategories: object,
    ) {
        try {
            const model =
                provider === LLMModelProvider.CHATGPT_4_ALL
                    ? getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : getChatVertexAI({
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      });

            const chain = RunnableSequence.from([
                async () => {
                    const systemPrompt = prompt_severity_analysis_system();
                    const humanPrompt = prompt_severity_analysis_user(
                        codeSuggestions,
                        selectedCategories,
                    );

                    return [
                        new SystemMessage(systemPrompt),
                        new HumanMessage(humanPrompt),
                    ];
                },
                model,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating severity analysis chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            throw error;
        }
    }
    //#endregion

    //#region Generate Suggestions Based On Category
    public async specificCategoryCodeReview(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
    ): Promise<AIAnalysisResult> {
        try {
            const provider = this.getInitialProvider(
                context,
                reviewModeResponse,
                true,
            );

            // Reset token tracking for new analysis
            this.tokenTracker.reset();

            // Prepare base context
            const baseContext = await this.prepareAnalysisContext(
                fileContext,
                context,
            );

            // Create chain with fallback
            const chain =
                await this.createSpecificCategoryCodeReviewChainWithFallback(
                    provider,
                    baseContext,
                    reviewModeResponse,
                );

            // Execute analysis
            const result = await chain.invoke(baseContext);

            // Process result and tokens
            const analysisResult = this.llmResponseProcessor.processResponse(
                organizationAndTeamData,
                prNumber,
                result,
            );

            if (!analysisResult) {
                return null;
            }

            analysisResult.codeReviewModelUsed = {
                generateSuggestions: provider,
            };

            return analysisResult;
        } catch (error) {
            this.logger.error({
                message: `Error generating suggestions based on category for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
            });
            return null;
        }
    }

    private async createSpecificCategoryCodeReviewChainWithFallback(
        provider: LLMModelProvider,
        context: any,
        reviewMode: ReviewModeResponse,
    ) {
        const fallbackProvider = this.getFallbackProvider(provider, reviewMode);

        try {
            const mainChain =
                await this.createSpecificCategoryCodeReviewProviderChain(
                    provider,
                    reviewMode,
                    context,
                );
            const fallbackChain =
                await this.createSpecificCategoryCodeReviewProviderChain(
                    fallbackProvider,
                    reviewMode,
                    context,
                );

            // Use withFallbacks to properly configure the fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'generateSuggestionsBasedOnCategory',
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                        reviewMode: reviewMode,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                },
            });
            throw error;
        }
    }

    private async createSpecificCategoryCodeReviewProviderChain(
        provider: LLMModelProvider,
        reviewModeResponse: ReviewModeResponse,
        context: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3_0324
                    ? getDeepseekByNovitaAI({
                          model: LLMModelProvider.DEEPSEEK_V3_0324,
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : getChatGemini({
                          model: LLMModelProvider.GEMINI_2_5_PRO_PREVIEW,
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      });

            const payload: NewCodeReviewPayload = {
                languageResultPrompt: 'pt-BR',
                fileContent: context.fileContent,
                codeDiff: context.patchWithLinesStr,
                categorySpecificInstructions: prompt_potentialIssues(),
                isLanguageContextEnabled: true,
                languageContext: prompt_languageContext({
                    languageName: 'NestJS',
                    libraryContexts: [
                        {
                            name: 'NestJS',
                            description: `TITLE: Bootstrapping a NestJS Application with TypeScript
DESCRIPTION: Entry point for a NestJS application that creates and starts the application server. It imports the root module and uses NestFactory to create an application instance that listens on the specified port.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/first-steps.md#2025-04-07_snippet_1

LANGUAGE: typescript
CODE:
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

LANGUAGE: javascript
CODE:
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

----------------------------------------

TITLE: Installing NestJS CLI and Creating a New Project
DESCRIPTION: Commands to install the NestJS CLI globally and create a new NestJS project. The CLI sets up a project directory with all necessary files and dependencies.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/first-steps.md#2025-04-07_snippet_0

LANGUAGE: bash
CODE:
$ npm i -g @nestjs/cli
$ nest new project-name

----------------------------------------

TITLE: Creating Prisma Service in NestJS
DESCRIPTION: Implementation of PrismaService that extends PrismaClient and handles database connection initialization.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/recipes/prisma.md#2025-04-07_snippet_7

LANGUAGE: typescript
CODE:
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
  }
}

----------------------------------------

TITLE: Auto Type Conversion for Path Parameters
DESCRIPTION: Demonstrates automatic type conversion of path parameters from string to number using ValidationPipe.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/techniques/validation.md#2025-04-07_snippet_12

LANGUAGE: typescript
CODE:
@Get(':id')
findOne(@Param('id') id: number) {
  console.log(typeof id === 'number'); // true
  return 'This action returns a user';
}

----------------------------------------

TITLE: Implementing AuthService with Sign-in Logic in NestJS
DESCRIPTION: Implementation of AuthService with a signIn method that validates user credentials and prepares for JWT token generation. It uses UsersService to look up user information.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/security/authentication.md#2025-04-07_snippet_3

LANGUAGE: typescript
CODE:
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(private usersService: UsersService) {}

  async signIn(username: string, pass: string): Promise<any> {
    const user = await this.usersService.findOne(username);
    if (user?.password !== pass) {
      throw new UnauthorizedException();
    }
    const { password, ...result } = user;
    // TODO: Generate a JWT and return it here
    // instead of the user object
    return result;
  }
}

----------------------------------------

TITLE: Creating Authentication Controller with Protected Routes in NestJS
DESCRIPTION: Controller that handles authentication requests, including the login endpoint and a protected profile endpoint that uses the AuthGuard to require valid JWT tokens.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/security/authentication.md#2025-04-07_snippet_12

LANGUAGE: typescript
CODE:
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards
} from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @HttpCode(HttpStatus.OK)
  @Post('login')
  signIn(@Body() signInDto: Record<string, any>) {
    return this.authService.signIn(signInDto.username, signInDto.password);
  }

  @UseGuards(AuthGuard)
  @Get('profile')
  getProfile(@Request() req) {
    return req.user;
  }
}

----------------------------------------

TITLE: Implementing JWT Authentication Guard in NestJS
DESCRIPTION: Guard that validates the JWT bearer token from the request headers, extracts the payload, and assigns it to the request object for use in route handlers.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/security/authentication.md#2025-04-07_snippet_11

LANGUAGE: typescript
CODE:
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jwtConstants } from './constants';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      const payload = await this.jwtService.verifyAsync(
        token,
        {
          secret: jwtConstants.secret
        }
      );
      // 💡 We're assigning the payload to the request object here
      // so that we can access it in our route handlers
      request['user'] = payload;
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

----------------------------------------

TITLE: Defining a DTO with Validation Rules in TypeScript
DESCRIPTION: Example of a Data Transfer Object (DTO) class with validation decorators from class-validator. This DTO validates that email is a valid email format and password is not empty.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/techniques/validation.md#2025-04-07_snippet_4

LANGUAGE: typescript
CODE:
import { IsEmail, IsNotEmpty } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;
}

----------------------------------------

TITLE: Implementing AuthGuard with Public Route Check in NestJS
DESCRIPTION: This code shows the implementation of an AuthGuard that checks for public routes using Reflector. It also handles JWT verification and sets the user payload on the request object.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/security/authentication.md#2025-04-07_snippet_17

LANGUAGE: typescript
CODE:
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwtService: JwtService, private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // 💡 See this condition
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: jwtConstants.secret,
      });
      // 💡 We're assigning the payload to the request object here
      // so that we can access it in our route handlers
      request['user'] = payload;
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

----------------------------------------

TITLE: Registering Providers in NestJS Module
DESCRIPTION: This snippet demonstrates how to register providers and controllers in a NestJS module using the @Module decorator. It shows the basic structure of a module file.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/fundamentals/dependency-injection.md#2025-04-07_snippet_2

LANGUAGE: typescript
CODE:
import { Module } from '@nestjs/common';
import { CatsController } from './cats/cats.controller';
import { CatsService } from './cats/cats.service';

@Module({
  controllers: [CatsController],
  providers: [CatsService],
})
export class AppModule {}

----------------------------------------

TITLE: Configuring UsersModule in NestJS
DESCRIPTION: Configuration of UsersModule to export UsersService, making it available for use in other modules like AuthModule.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/security/authentication.md#2025-04-07_snippet_2

LANGUAGE: typescript
CODE:
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

----------------------------------------

TITLE: Creating Database Connection Provider with TypeORM
DESCRIPTION: Defines a custom provider for establishing a database connection using TypeORM's DataSource. It sets up MySQL connection parameters and entity configurations.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/recipes/sql-typeorm.md#2025-04-07_snippet_1

LANGUAGE: typescript
CODE:
import { DataSource } from 'typeorm';

export const databaseProviders = [
  {
    provide: 'DATA_SOURCE',
    useFactory: async () => {
      const dataSource = new DataSource({
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'root',
        database: 'test',
        entities: [
            __dirname + '/../**/*.entity{.ts,.js}',
        ],
        synchronize: true,
      });

      return dataSource.initialize();
    },
  },
];

----------------------------------------

TITLE: Creating Basic NestJS Controller with TypeScript
DESCRIPTION: Demonstrates how to create a basic controller with a GET endpoint using the @Controller and @Get decorators. The controller handles requests to the /cats endpoint and returns all cats.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/controllers.md#2025-04-07_snippet_0

LANGUAGE: typescript
CODE:
import { Controller, Get } from '@nestjs/common';

@Controller('cats')
export class CatsController {
  @Get()
  findAll(): string {
    return 'This action returns all cats';
  }
}

----------------------------------------

TITLE: Using Multiple Authentication Strategies in NestJS
DESCRIPTION: This snippet shows how to configure an AuthGuard to use multiple authentication strategies in a chain. The first strategy to succeed, redirect, or error will halt the chain.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/recipes/passport.md#2025-04-07_snippet_24

LANGUAGE: typescript
CODE:
export class JwtAuthGuard extends AuthGuard(['strategy_jwt_1', 'strategy_jwt_2', '...']) { ... }

----------------------------------------

TITLE: Complete CRUD Controller Implementation
DESCRIPTION: Full implementation of a REST controller with CRUD operations including create, read, update, and delete endpoints.
SOURCE: https://github.com/nestjs/docs.nestjs.com/blob/master/content/controllers.md#2025-04-07_snippet_13

LANGUAGE: typescript
CODE:
import { Controller, Get, Query, Post, Body, Put, Param, Delete } from '@nestjs/common';
import { CreateCatDto, UpdateCatDto, ListAllEntities } from './dto';

@Controller('cats')
export class CatsController {
  @Post()
  create(@Body() createCatDto: CreateCatDto) {
    return 'This action adds a new cat';
  }

  @Get()
  findAll(@Query() query: ListAllEntities) {
    return \`This action returns all cats (limit: \${query.limit} items)\`;
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return \`This action returns a #\${id} cat\`;
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateCatDto: UpdateCatDto) {
    return \`This action updates a #\${id} cat\`;
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return \`This action removes a #\${id} cat\`;
  }
}`,
                        },
                    ],
                    languageBestPractices: '',
                }),
            };

            const chain = RunnableSequence.from([
                async (input: any) => {
                    return [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: prompt_specificCategoryCodeReview(
                                        payload,
                                    ),
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis code chain',
                error,
                context: LLMAnalysisService.name,
                metadata: { provider },
            });
            throw error;
        }
    }

    //#endregion

    //#region Filter Suggestions Safe Guard
    async filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
    ): Promise<ISafeguardResponse> {
        try {
            suggestions?.forEach((suggestion) => {
                if (
                    suggestion &&
                    Object.prototype.hasOwnProperty.call(
                        suggestion,
                        'suggestionEmbedded',
                    )
                ) {
                    delete suggestion?.suggestionEmbedded;
                }
            });

            const provider = LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET;
            const baseContext = {
                organizationAndTeamData,
                file: {
                    ...file,
                    fileContent: file.fileContent,
                },
                codeDiff,
                suggestions,
                languageResultPrompt,
            };

            // Create chain with fallback
            const chain = await this.createSafeGuardChainWithFallback(
                organizationAndTeamData,
                prNumber,
                provider,
                reviewMode,
                baseContext,
            );

            // Execute analysis
            const response = await chain.invoke(baseContext);

            const tokenUsages = this.tokenTracker.getTokenUsages();

            const filteredSuggestions =
                await this.extractSuggestionsFromCodeReviewSafeguard(
                    organizationAndTeamData,
                    prNumber,
                    response,
                );

            // Filter and update suggestions
            const suggestionsToUpdate =
                filteredSuggestions?.codeSuggestions?.filter(
                    (s) => s.action === 'update',
                );
            const suggestionsToDiscard = new Set(
                filteredSuggestions?.codeSuggestions
                    ?.filter((s) => s.action === 'discard')
                    .map((s) => s.id),
            );

            this.logTokenUsage({
                tokenUsages,
                pullRequestId: prNumber,
                fileContext: file?.filename,
                provider,
                organizationAndTeamData,
            });

            const filteredAndMappedSuggestions = suggestions
                ?.filter(
                    (suggestion) => !suggestionsToDiscard.has(suggestion.id),
                )
                ?.map((suggestion) => {
                    const updatedSuggestion = suggestionsToUpdate?.find(
                        (s) => s.id === suggestion.id,
                    );

                    if (!updatedSuggestion) {
                        return suggestion;
                    }

                    return {
                        ...suggestion,
                        suggestionContent: updatedSuggestion?.suggestionContent,
                        existingCode: updatedSuggestion?.existingCode,
                        improvedCode: updatedSuggestion?.improvedCode,
                        oneSentenceSummary:
                            updatedSuggestion?.oneSentenceSummary,
                        relevantLinesStart:
                            updatedSuggestion?.relevantLinesStart,
                        relevantLinesEnd: updatedSuggestion?.relevantLinesEnd,
                    };
                });

            return {
                suggestions: filteredAndMappedSuggestions,
                codeReviewModelUsed: {
                    safeguard: provider,
                },
            };
        } catch (error) {
            this.logger.error({
                message: `Error during suggestions safe guard analysis for PR#${prNumber}`,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    file: file?.filename,
                },
                error,
            });
            return { suggestions };
        }
    }

    private async createSafeGuardChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
        context: any,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET
                : LLMModelProvider.CHATGPT_4_ALL;
        try {
            const mainChain = await this.createSafeGuardProviderChain(
                organizationAndTeamData,
                prNumber,
                provider,
                reviewMode,
                context,
            );
            const fallbackChain = await this.createSafeGuardProviderChain(
                organizationAndTeamData,
                prNumber,
                fallbackProvider,
                reviewMode,
                context,
            );

            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'filterSuggestionsSafeGuard',
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                        reviewMode: reviewMode,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating safe guard chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                    organizationAndTeamData,
                    prNumber,
                },
            });
            throw error;
        }
    }

    private async createSafeGuardProviderChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
        context?: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET
                    ? getChatVertexAI({
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      });

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const systemPrompt = prompt_codeReviewSafeguard_system();
                    const humanPrompt = prompt_codeReviewSafeguard_user(
                        input.languageResultPrompt,
                    );

                    return [
                        {
                            role: 'user',
                            content: [
                                // Required for pipeline steps that use file or codeDiff
                                this.preparePrefixChainForCache(
                                    {
                                        fileContent: input.file.fileContent,
                                        patchWithLinesStr: input.codeDiff,
                                        language: input.file.language,
                                        filePath: input.file.filename,
                                    },
                                    reviewMode,
                                ),
                                {
                                    type: 'text',
                                    text: `<suggestionsContext>${JSON.stringify(input?.suggestions, null, 2) || 'No suggestions provided'}</suggestionsContext>`,
                                },
                                {
                                    type: 'text',
                                    text: systemPrompt,
                                },
                                {
                                    type: 'text',
                                    text: humanPrompt,
                                },
                                {
                                    type: 'text',
                                    text: 'Start analysis',
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating safe guard provider chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: { organizationAndTeamData, prNumber, provider },
            });
            throw error;
        }
    }

    private async extractSuggestionsFromText(
        text: string,
    ): Promise<CodeSuggestion[]> {
        try {
            const regex = /\{[\s\S]*"codeSuggestions"[\s\S]*\}/;
            const match = text.match(regex);

            if (!match) {
                throw new Error('No JSON with codeSuggestions found');
            }

            return JSON.parse(match[0]);
        } catch (error) {
            throw new Error(`Failed to extract suggestions: ${error.message}`);
        }
    }

    async extractSuggestionsFromCodeReviewSafeguard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        safeGuardResponse: any,
    ) {
        try {
            try {
                return await this.extractSuggestionsFromText(safeGuardResponse);
            } catch (error) {
                this.logger.warn({
                    message: `Failed to extract suggestions using code for PR#${prNumber}, falling back to LLM`,
                    context: LLMAnalysisService.name,
                    error,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                // Fallback for LLM
                const provider = LLMModelProvider.CHATGPT_4_ALL_MINI;
                const baseContext = { safeGuardResponse };

                const chain =
                    await this.createExtractSuggestionsChainWithFallback(
                        organizationAndTeamData,
                        prNumber,
                        provider,
                        baseContext,
                    );

                return await chain.invoke(baseContext);
            }
        } catch (error) {
            this.logger.error({
                message: `Error extracting suggestions from safe guard response for PR#${prNumber}`,
                context: LLMAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                },
            });
            throw error;
        }
    }

    private async createExtractSuggestionsChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            const mainChain = await this.createExtractSuggestionsProviderChain(
                organizationAndTeamData,
                prNumber,
                provider,
                context,
            );
            const fallbackProvider =
                provider === LLMModelProvider.CHATGPT_4_ALL_MINI
                    ? LLMModelProvider.CHATGPT_4_ALL
                    : LLMModelProvider.CHATGPT_4_ALL_MINI;
            const fallbackChain =
                await this.createExtractSuggestionsProviderChain(
                    organizationAndTeamData,
                    prNumber,
                    fallbackProvider,
                    context,
                );

            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'extractSuggestionsFromCodeReviewSafeguard',
                    metadata: {
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: `Error creating chain with fallback for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            throw error;
        }
    }

    private async createExtractSuggestionsProviderChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            let llm = getChatGPT({
                model:
                    provider === LLMModelProvider.CHATGPT_4_ALL_MINI
                        ? getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL_MINI,
                          )
                        : getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                temperature: 0,
                callbacks: [this.tokenTracker],
            }).bind({
                response_format: { type: 'json_object' },
            });

            const parser = StructuredOutputParser.fromZodSchema(
                z.object({
                    codeSuggestions: z.array(
                        z
                            .object({
                                id: z.string(),
                                suggestionContent: z.string(),
                                existingCode: z.string(),
                                improvedCode: z.string(),
                                oneSentenceSummary: z.string(),
                                relevantLinesStart: z.string(),
                                relevantLinesEnd: z.string(),
                                label: z.string().optional(),
                                action: z.string(),
                                reason: z.string().optional(),
                            })
                            .refine(
                                (data) =>
                                    data.suggestionContent &&
                                    data.existingCode &&
                                    data.oneSentenceSummary &&
                                    data.relevantLinesStart &&
                                    data.relevantLinesEnd &&
                                    data.action,
                                {
                                    message: 'All fields are required',
                                },
                            ),
                    ),
                }),
            );

            const formatInstructions = parser.getFormatInstructions();

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const prompt = `${input.safeGuardResponse}\n\n${formatInstructions}`;
                    return [new HumanMessage({ content: prompt })];
                },
                llm,
                new StringOutputParser(),
                parser.parse.bind(parser),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating extract suggestions provider chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            throw error;
        }
    }
    //#endregion

    //#region Validate Implemented Suggestions
    async validateImplementedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codePatch: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const baseContext = {
            organizationAndTeamData,
            prNumber,
            codePatch,
            codeSuggestions,
        };

        const chain =
            await this.createValidateImplementedSuggestionsChainWithFallback(
                organizationAndTeamData,
                prNumber,
                provider,
                baseContext,
            );

        try {
            const result = await chain.invoke(baseContext);

            const suggestionsWithImplementedStatus =
                this.llmResponseProcessor.processResponse(
                    organizationAndTeamData,
                    prNumber,
                    result,
                );

            const implementedSuggestions =
                suggestionsWithImplementedStatus?.codeSuggestions || [];

            return implementedSuggestions;
        } catch (error) {
            this.logger.error({
                message:
                    'Error executing validate implemented suggestions chain:',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
        }

        return codeSuggestions;
    }

    private async createValidateImplementedSuggestionsChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.DEEPSEEK_V3
                : LLMModelProvider.CHATGPT_4_ALL;

        try {
            // Chain principal
            const mainChain =
                await this.createValidateImplementedSuggestionsChain(
                    organizationAndTeamData,
                    prNumber,
                    provider,
                    context,
                );

            // Chain de fallback
            const fallbackChain =
                await this.createValidateImplementedSuggestionsChain(
                    organizationAndTeamData,
                    prNumber,
                    fallbackProvider,
                    context,
                );

            // Configurar chain com fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'validateImplementedSuggestions',
                    metadata: {
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message:
                    'Error creating validate implemented suggestions chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: prNumber,
                },
            });
            throw error;
        }
    }

    private async createValidateImplementedSuggestionsChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                          maxTokens: 8000,
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                      });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const humanPrompt = prompt_validateImplementedSuggestions({
                        codePatch: input.codePatch,
                        codeSuggestions: input.codeSuggestions,
                    });

                    return [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: humanPrompt,
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating validate implemented suggestions chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: prNumber,
                    provider,
                },
            });
        }
    }

    //#endregion

    //#region Select Review Mode
    async selectReviewMode(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        file: FileChange,
        codeDiff: string,
    ): Promise<ReviewModeResponse> {
        const baseContext = {
            organizationAndTeamData,
            prNumber,
            file,
            codeDiff,
        };

        const chain = await this.createSelectReviewModeChainWithFallback(
            organizationAndTeamData,
            prNumber,
            provider,
            baseContext,
        );

        try {
            const result = await chain.invoke(baseContext);

            const reviewMode =
                this.llmResponseProcessor.processReviewModeResponse(
                    organizationAndTeamData,
                    prNumber,
                    result,
                );

            return reviewMode?.reviewMode || ReviewModeResponse.LIGHT_MODE;
        } catch (error) {
            this.logger.error({
                message: 'Error executing select review mode chain:',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            return ReviewModeResponse.LIGHT_MODE;
        }
    }

    private async createSelectReviewModeChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.DEEPSEEK_V3
                : LLMModelProvider.CHATGPT_4_ALL;

        try {
            // Main chain
            const mainChain = await this.createSelectReviewModeChain(
                organizationAndTeamData,
                prNumber,
                provider,
                context,
            );

            // Fallback chain
            const fallbackChain = await this.createSelectReviewModeChain(
                organizationAndTeamData,
                prNumber,
                fallbackProvider,
                context,
            );

            // Configure chain with fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'selectReviewMode',
                    metadata: {
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message:
                    'Error creating select review mode chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                    organizationAndTeamData,
                    prNumber,
                },
            });
            throw error;
        }
    }

    private async createSelectReviewModeChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                          maxTokens: 8000,
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                      });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const humanPrompt = prompt_selectorLightOrHeavyMode_system({
                        file: input.file,
                        codeDiff: input.codeDiff,
                    });

                    return [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: humanPrompt,
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating select review mode chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
        }
    }

    //#endregion
}
