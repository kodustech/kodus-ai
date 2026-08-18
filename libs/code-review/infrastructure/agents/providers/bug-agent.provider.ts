import { Injectable, Optional } from '@nestjs/common';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { BaseCodeReviewAgentProvider } from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
import { ReviewAgentIdentity } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { buildCategoryReviewPrompt } from '@libs/code-review/infrastructure/agents/prompts/review-prompt-blocks';

@Injectable()
export class BugAgentProvider extends BaseCodeReviewAgentProvider {
    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        @Optional()
        documentationSearchService?: DocumentationSearchExaService,
        @Optional()
        byokErrorCounter?: ByokErrorCounter,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
            documentationSearchService,
            byokErrorCounter,
        );
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'kodus-bug-review-agent',
            description:
                'Senior software engineer specialized in finding bugs, logic errors, ' +
                'edge cases, error handling issues, data flow problems, and race conditions ' +
                'in code changes. Investigates the codebase before making any suggestion.',
            goal:
                'Find real, impactful bugs in the code changes by investigating the codebase. ' +
                // EXPERIMENTO (RECALL_REPORT_ALL=1): a instrucao original era
                // 'Only report issues backed by concrete evidence from the code.'
                // Medimos que ela faz modelos que seguem instrucao ao pe da letra
                // (familia GPT) investigarem igual mas reportarem metade — terra
                // fez 53 tool calls e reportou 1,7 findings/caso, contra 3,2 do
                // deepseek com 54 chamadas. Isso vira recall menor sem que o
                // modelo tenha achado menos. Aqui trocamos filtro-na-origem por
                // reporte-tudo + confianca, deixando o filtro para o verify.
                // RECALL_NO_EVIDENCE_BAR=1 REMOVE a barra sem por nada no lugar —
                // o teste limpo da hipotese. RECALL_REPORT_ALL=1 troca por
                // permissao qualitativa, que e a forma que a Greptile documenta
                // como ineficaz ("internal debates about whether to follow the
                // developer or the user instructions").
                (process.env.RECALL_NO_EVIDENCE_BAR === '1'
                    ? ''
                    : process.env.RECALL_REPORT_ALL === '1'
                      ? 'Report every issue you find, including ones you are uncertain about or ' +
                        'consider low-severity. Do not filter for importance or confidence at this ' +
                        'stage — a separate verification step does that. For each finding, include ' +
                        'your confidence level and an estimated severity.'
                      : 'Only report issues backed by concrete evidence from the code.'),
            expertise: [
                'Bug detection and logic analysis',
                'Edge case identification',
                'Error handling verification',
                'Data flow and state management analysis',
                'Race condition detection',
                'Null/undefined safety',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'bug';
    }

    protected getCategoryPrompt(): string {
        return buildCategoryReviewPrompt('bug');
    }
}
