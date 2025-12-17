import { IIssue } from '@/core/domain/issues/interfaces/issues.interface';
import { LabelType } from '@/shared/utils/codeManagement/labels';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { IssueStatus } from '@/config/types/general/issues.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

export const getMockIssues = (organizationId: string): IIssue[] => {
    const now = new Date().toISOString();

    return [
        {
            uuid: 'mock-issue-kody-1',
            title: '[Kody Rule] Padronizar DTOs de criação de usuário',
            description:
                'O DTO CreateUserDto.ts não está validando campos obrigatórios conforme o padrão definido pela regra KR-DTO-001.',
            filePath: 'src/modules/users/dto/create-user.dto.ts',
            language: 'typescript',
            label: LabelType.KODY_RULES,
            severity: SeverityLevel.HIGH,
            contributingSuggestions: [
                {
                    id: 'mock-suggestion-1',
                    prNumber: 9812,
                    prAuthor: {
                        id: 'u-101',
                        name: 'João Silva',
                    },
                    suggestionContent:
                        'Criar decorator @IsEmail e @IsNotEmpty para os campos obrigatórios.',
                    oneSentenceSummary:
                        'DTO não segue padrão de validação definido pela equipe.',
                    relevantFile: 'src/modules/users/dto/create-user.dto.ts',
                    language: 'typescript',
                    brokenKodyRulesIds: ['KR-DTO-001'],
                },
            ],
            repository: {
                id: 'repo-1',
                name: 'kodus-platform',
                full_name: 'kodus/kodus-platform',
                platform: PlatformType.GITHUB,
            },
            organizationId,
            status: IssueStatus.OPEN,
            createdAt: now,
            updatedAt: now,
            owner: {
                gitId: '2001',
                username: 'maria.dev',
            },
            reporter: {
                gitId: 'kodus',
                username: 'Kodus',
            },
            kodyRule: {
                number: '23fff538-9cb7-4561-9faa-9aa12e751f9d',
                title: 'DTOs devem validar campos obrigatórios',
            },
        },
        {
            uuid: 'mock-issue-kody-2',
            title: '[Kody Rule] Serviços não podem acessar o banco diretamente',
            description:
                'O serviço BillingService está acessando o repositório diretamente sem passar pela camada de repositórios.',
            filePath: 'src/modules/billing/billing.service.ts',
            language: 'typescript',
            label: LabelType.KODY_RULES,
            severity: SeverityLevel.MEDIUM,
            contributingSuggestions: [
                {
                    id: 'mock-suggestion-2',
                    prNumber: 10442,
                    prAuthor: {
                        id: 'u-204',
                        name: 'Ana Costa',
                    },
                    suggestionContent:
                        'Injetar BillingRepository e mover chamadas diretas ao mongoose para lá.',
                    oneSentenceSummary:
                        'Camada de serviço violando abstração definida pela KR-SERVICE-BOUNDARY.',
                    relevantFile: 'src/modules/billing/billing.service.ts',
                    language: 'typescript',
                    brokenKodyRulesIds: ['KR-SERVICE-BOUNDARY'],
                },
            ],
            repository: {
                id: 'repo-2',
                name: 'payments-api',
                full_name: 'kodus/payments-api',
                platform: PlatformType.GITHUB,
            },
            organizationId,
            status: IssueStatus.OPEN,
            createdAt: now,
            updatedAt: now,
            owner: {
                gitId: '1999',
                username: 'bruno.dev',
            },
            reporter: {
                gitId: 'kodus',
                username: 'Kodus',
            },
            kodyRule: {
                number: 'bfcae8a7-d8a5-461a-9ac3-cf447d9284a7',
                title: 'Services devem depender apenas da camada de repositórios',
            },
        },
    ];
};
