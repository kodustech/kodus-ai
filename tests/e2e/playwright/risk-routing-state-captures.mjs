// Screenshots of the deployed Next.js app, including its real sidebar/layout.
// Settings use the seeded QA tenant's real API and are restored in finally.
// Only preview responses are fixtures; those images say so in the manifest.
import assert from 'node:assert/strict';
import { comparePolicyOverlayMotion } from './risk-overlay-motion.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect as baseExpect } from 'playwright/test';

const expect = baseExpect.configure({ timeout: 30_000 });
const fields = [
    'riskAssessmentActive',
    'riskCriteria',
    'reviewMode',
    'riskReviewRouting',
    'pullRequestApprovalActive',
    'approvalPolicies',
    'approvalSensitivePaths',
];

export async function captureRiskRoutingStates({
    page,
    context,
    web,
    out,
    settingsRequest,
    hydrated,
    initialCaptures = [],
}) {
    assert.ok(
        settingsRequest?.url &&
            settingsRequest.body?.organizationAndTeamData?.teamId,
        'Use the authenticated full-app smoke before capturing states.',
    );
    const dir = `${out}/app-states`;
    mkdirSync(dir, { recursive: true });
    const manifest = [...initialCaptures];
    const riskSwitch = page.getByRole('switch', {
        name: 'Risk assessment',
        exact: true,
    });
    await hydrated(riskSwitch);
    const snapshot = await riskSwitch.evaluate((node, fields) => {
        let fiber =
            node[
                Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
            ];
        while (fiber) {
            const props = fiber.memoizedProps;
            const control = props?.control ?? props?.value?.control;
            if (control?._formValues) {
                const values = control._formValues;
                return Object.fromEntries(
                    fields.map((key) => [
                        key,
                        key === 'riskReviewRouting'
                            ? {
                                  noRisk:
                                      values[key]?.noRisk?.value ?? 'balanced',
                                  riskFound:
                                      values[key]?.riskFound?.value ?? 'heavy',
                              }
                            : values[key]?.value,
                    ]),
                );
            }
            fiber = fiber.return;
        }
        return null;
    }, fields);
    assert.ok(snapshot, 'The real settings form must be loaded.');
    const restore = {
        ...snapshot,
        riskAssessmentActive: snapshot.riskAssessmentActive ?? false,
        riskCriteria: snapshot.riskCriteria ?? [],
        reviewMode: snapshot.reviewMode ?? 'balanced',
        pullRequestApprovalActive: snapshot.pullRequestApprovalActive ?? false,
        approvalPolicies: snapshot.approvalPolicies ?? [],
        approvalSensitivePaths: snapshot.approvalSensitivePaths ?? [],
    };
    const criteria = [
        {
            id: 'screenshot-access',
            name: 'Access control',
            enabled: true,
            instructions:
                'Permission changes may expose data across accounts. Distinguish them from equivalent refactors.',
            includedFiles: ['src/access/**'],
            excludedFiles: ['**/*.spec.ts'],
        },
        {
            id: 'screenshot-data',
            name: 'Customer data deletion',
            enabled: false,
            instructions:
                'Check recovery and tests when account deletion can remove customer data across services.',
        },
    ];
    const policies = [
        {
            id: 'screenshot-docs',
            name: 'Documentation',
            enabled: true,
            includedFiles: ['docs/**'],
        },
        {
            id: 'screenshot-deps',
            name: 'Dependency updates',
            enabled: true,
            labels: ['dependencies'],
            authors: ['dependabot[bot]'],
            maxChangedLines: 150,
            lineCountExcludedFiles: ['yarn.lock'],
            instruction:
                'Only dependency updates that keep the same major version.',
        },
        { id: 'screenshot-small', name: 'Small clean changes', enabled: false },
    ];
    const baseline = {
        riskAssessmentActive: true,
        riskCriteria: criteria,
        reviewMode: 'balanced',
        riskReviewRouting: { noRisk: 'balanced', riskFound: 'heavy' },
        pullRequestApprovalActive: true,
        approvalPolicies: policies,
        approvalSensitivePaths: ['src/auth/**', 'db/migrations/**'],
    };
    async function configure(configValue) {
        const response = await context.request.post(settingsRequest.url, {
            data: { ...settingsRequest.body, configValue },
        });
        if (!response.ok()) {
            const failure = await response.json().catch(() => ({}));
            const messages = Array.isArray(failure.message)
                ? failure.message
                : [failure.message].filter(Boolean);
            // The default preview has no git connection. Keep that account
            // usable without inventing an integration or bypassing its guard.
            if (
                response.status() === 400 &&
                messages.includes(
                    'Connect a code provider before adding label or team conditions.',
                ) &&
                configValue.approvalPolicies?.some(
                    (policy) => policy.labels?.length,
                )
            ) {
                for (const policy of policies) delete policy.labels;
                return configure({
                    ...configValue,
                    approvalPolicies: configValue.approvalPolicies.map(
                        ({ labels: _labels, ...policy }) => policy,
                    ),
                });
            }
            writeFileSync(
                `${dir}/settings-validation.json`,
                JSON.stringify(
                    {
                        status: response.status(),
                        messages,
                        fields: Object.keys(configValue),
                    },
                    null,
                    2,
                ),
            );
            throw new Error(
                `QA settings update returned HTTP ${response.status()}: ${messages.join('; ')}`,
            );
        }
        assert.ok(
            response.ok(),
            `QA settings update returned HTTP ${response.status()}.`,
        );
    }
    async function open(tab, patch = {}) {
        await configure({ ...baseline, ...patch });
        await page.goto(`${web}/settings/code-review/global/${tab}`, {
            waitUntil: 'domcontentloaded',
        });
        await page
            .getByRole('heading', {
                name:
                    tab === 'risk'
                        ? 'Risk assessment'
                        : tab === 'routing'
                          ? 'Routing'
                          : 'General settings',
                exact: true,
            })
            .waitFor();
        await hydrated(
            page.getByRole('button', { name: 'Save settings', exact: true }),
        );
    }
    async function shot(id, group, title, note = '', fixture = false) {
        if (id === '25-approval-human-files') {
            await page
                .getByRole('region', { name: 'Human approval', exact: true })
                .scrollIntoViewIfNeeded();
        } else if (group === 'General') {
            await page
                .locator(
                    id === '26-general-risk-off'
                        ? '[data-field-name="reviewMode"]'
                        : '[data-field-name="pullRequestApprovalActive"]',
                )
                .scrollIntoViewIfNeeded();
        }
        // Let Radix enter transitions settle before preserving the image.
        await page.waitForTimeout(500);
        if (page.viewportSize().width >= 768) {
            await expect(
                page.getByRole('link', {
                    name: /^Reviews(?:\s|$)/,
                    includeHidden: true,
                }),
            ).toBeVisible();
        }
        await page.screenshot({ path: `${dir}/${id}.png`, fullPage: true });
        manifest.push({
            id,
            group,
            title,
            note,
            fixture,
            source: fixture
                ? 'App completo no Runo · resposta de preview simulada'
                : 'App completo no Runo · configuração real do tenant de QA',
            file: `${id}.png`,
            url: page.url(),
        });
        writeFileSync(
            `${dir}/manifest.json`,
            JSON.stringify(manifest, null, 2),
        );
        console.log(`CAPTURE ${id}`);
    }
    async function editPolicy(name) {
        await page
            .getByRole('listitem')
            .filter({ has: page.getByRole('heading', { name, exact: true }) })
            .getByRole('button', { name: 'Edit', exact: true })
            .click();
    }
    const previewPath = '**/code-review/risk/preview';
    const repositoriesPath = '**/code-management/repositories/selected?*';
    let releasePreview;
    try {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await open('risk', { riskCriteria: [] });
        await shot('01-risk-auto', 'Risk', 'Ligado, sem critérios');
        await open('risk');
        await shot(
            '02-risk-criteria',
            'Risk',
            'Critérios ativos e desativados',
        );
        await page.getByText('File filters', { exact: true }).click();
        await shot('03-risk-filters', 'Risk', 'Filtros do critério expandidos');
        await open('risk', { riskAssessmentActive: false });
        await shot('04-risk-off', 'Risk', 'Avaliação desligada');
        await open('risk', { riskAssessmentActive: false, riskCriteria: [] });
        await shot('05-risk-off-empty', 'Risk', 'Desligado, sem critérios');

        await open('risk');
        await page
            .getByRole('button', { name: 'Add criterion', exact: true })
            .click();
        await shot('06-criterion-empty', 'Critérios', 'Novo critério vazio');
        await page.getByLabel('Name', { exact: true }).fill('Payment changes');
        await page
            .getByLabel('What should Kody consider?')
            .fill(
                'Check whether a payment change can charge a customer twice. Consider retries and idempotency.',
            );
        await shot(
            '07-criterion-filled',
            'Critérios',
            'Novo critério preenchido',
        );
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page
            .getByRole('button', { name: 'Edit Access control', exact: true })
            .click();
        await shot(
            '08-criterion-edit',
            'Critérios',
            'Included e excluded files',
        );
        await page
            .getByRole('button', { name: 'Edit included files', exact: true })
            .click();
        await page
            .getByLabel('Test a file', { exact: true })
            .fill('src/access/permissions.ts');
        await shot('09-glob-matched', 'Critérios', 'Path corresponde ao glob');
        await page
            .getByLabel('Test a file', { exact: true })
            .fill('src/billing/invoice.ts');
        await shot(
            '10-glob-unmatched',
            'Critérios',
            'Path não corresponde ao glob',
        );
        await page
            .getByPlaceholder(
                'Search a pattern, or type a new one and press Enter to add',
            )
            .fill('src/[');
        await shot('11-glob-invalid', 'Critérios', 'Sintaxe de glob inválida');
        await page
            .getByPlaceholder(
                'Search a pattern, or type a new one and press Enter to add',
            )
            .fill('src/payments/**');
        await shot('12-glob-valid', 'Critérios', 'Novo glob válido');
        await open('risk');
        await page
            .getByRole('button', { name: 'Edit Access control', exact: true })
            .click();
        await page
            .getByRole('button', { name: 'Edit excluded files', exact: true })
            .click();
        await page
            .getByLabel('Test a file', { exact: true })
            .fill('src/access/permissions.spec.ts');
        await shot(
            '13-glob-excluded',
            'Critérios',
            'Excluded files: teste de path',
        );

        await open('routing');
        await shot('14-routing-on', 'Routing', 'Por risco: Balanced / Heavy');
        await expect(
            page.getByRole('combobox', {
                name: 'Risk assessment unavailable',
                exact: true,
            }),
        ).toBeVisible();
        await page.getByText('Manual commands', { exact: true }).click();
        await shot(
            '15-routing-default',
            'Routing',
            'Ajuda de comandos manuais',
        );
        await page
            .getByRole('combobox', { name: 'Risk found', exact: true })
            .click();
        await shot('16-routing-options', 'Routing', 'Opções de profundidade');
        await open('routing', {
            riskReviewRouting: { noRisk: 'heavy', riskFound: 'balanced' },
        });
        await shot('17-routing-custom', 'Routing', 'Rotas personalizadas');
        await open('routing', {
            riskReviewRouting: { noRisk: 'balanced', riskFound: 'balanced' },
        });
        await shot('18-routing-balanced', 'Routing', 'Balanced nos dois casos');
        await open('routing', {
            riskReviewRouting: { noRisk: 'heavy', riskFound: 'heavy' },
        });
        await shot('19-routing-heavy', 'Routing', 'Heavy nos dois casos');
        await open('routing', { riskAssessmentActive: false });
        await shot(
            '20-routing-off-balanced',
            'Routing',
            'Risco desligado: Balanced para todos',
        );
        await open('routing', {
            riskAssessmentActive: false,
            reviewMode: 'heavy',
        });
        await shot(
            '21-routing-off-heavy',
            'Routing',
            'Risco desligado: Heavy para todos',
        );

        await open('general', { pullRequestApprovalActive: false });
        await shot(
            '22-approval-off',
            'General',
            'Aprovação automática desligada',
        );
        await open('general', { approvalPolicies: [] });
        await shot(
            '23-approval-empty',
            'General',
            'Aprovação ligada, sem políticas',
        );
        await open('general');
        await shot(
            '24-approval-policies',
            'General',
            'Políticas ativas e desativadas',
        );
        await page
            .getByRole('region', { name: 'Human approval', exact: true })
            .scrollIntoViewIfNeeded();
        await shot(
            '25-approval-human-files',
            'General',
            'Arquivos que exigem aprovação humana',
        );
        await open('general', {
            riskAssessmentActive: false,
            reviewMode: 'heavy',
        });
        await shot(
            '26-general-risk-off',
            'General',
            'Resumo com risco desligado',
        );
        await open('general');
        await page
            .getByRole('button', { name: 'Add policy', exact: true })
            .click();
        await page.getByLabel('Name', { exact: true }).fill('All clean PRs');
        await shot(
            '27-policy-all-clean',
            'Políticas',
            'Política sem condições',
        );
        await page
            .getByLabel('Name', { exact: true })
            .fill('Small clean changes');
        await shot('28-policy-duplicate', 'Políticas', 'Nome duplicado');
        await page.getByLabel('Name', { exact: true }).fill('All clean PRs');
        await page
            .getByRole('combobox', { name: 'Add condition', exact: true })
            .click();
        await shot(
            '29-policy-conditions',
            'Políticas',
            'Condições disponíveis',
        );
        await open('general');
        await comparePolicyOverlayMotion({
            page,
            out,
            open: () => editPolicy('Dependency updates'),
            close: () =>
                page
                    .getByRole('button', {
                        name: 'Close policy editor',
                        exact: true,
                    })
                    .click(),
        });
        await editPolicy('Dependency updates');
        await expect(
            page.getByRole('button', { name: 'Apply', exact: true }),
        ).toBeInViewport();
        await shot(
            '30-policy-dependencies',
            'Políticas',
            policies[1].labels?.length
                ? 'Label, autor, linhas e instrução'
                : 'Autor, linhas e instrução',
        );
        await page
            .getByRole('region', { name: 'Policy settings', exact: true })
            .evaluate((node) => {
                node.scrollTop = node.scrollHeight;
            });
        await expect(
            page.getByRole('button', { name: 'Apply', exact: true }),
        ).toBeInViewport();
        await shot(
            '31-policy-dependencies-bottom',
            'Políticas',
            'Final do editor de condições',
        );
        await open('general');
        await editPolicy('Documentation');
        await shot('32-policy-files', 'Políticas', 'Condições de arquivos');
        await page
            .getByRole('button', { name: 'Edit included files', exact: true })
            .click();
        const fileEditor = page.getByRole('region', {
            name: 'Included files',
            exact: true,
        });
        await fileEditor
            .getByLabel('Test a file', { exact: true })
            .fill('docs/api.md');
        await expect(
            fileEditor.getByText('Matched by', { exact: false }),
        ).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(1);
        await shot(
            '42-policy-file-validator',
            'Políticas',
            'Validador de glob no próprio painel',
        );
        await fileEditor
            .getByRole('button', {
                name: 'Close included files editor',
                exact: true,
            })
            .click();
        await expect(
            page.getByRole('dialog', { name: 'Edit policy', exact: true }),
        ).toBeVisible();

        await page.route(repositoriesPath, (route) =>
            route.fulfill({
                json: { data: [{ id: 'screenshot-repo', name: 'api' }] },
            }),
        );
        for (const [index, status, title] of [
            [33, 'empty', 'Painel inicial'],
            [34, 'loading', 'Avaliação em andamento'],
            [35, 'clean', 'Nenhum risco encontrado'],
            [36, 'risk', 'Risco identificado'],
            [37, 'unavailable', 'Avaliação indisponível'],
            [38, 'error', 'Erro ao carregar a avaliação'],
        ]) {
            let pending;
            await page.route(previewPath, async (route) => {
                if (status === 'loading')
                    await new Promise((resolve) => {
                        pending = resolve;
                        releasePreview = resolve;
                    });
                if (status === 'error')
                    return route.fulfill({
                        status: 500,
                        json: { message: 'Preview fixture unavailable' },
                    });
                return route.fulfill({
                    json: {
                        data: {
                            assessment:
                                status === 'unavailable'
                                    ? {
                                          status: 'unavailable',
                                          reason: 'The PR diff is incomplete. Kody could not assess risk.',
                                      }
                                    : {
                                          status: 'assessed',
                                          riskIdentified: status === 'risk',
                                          reason:
                                              status === 'risk'
                                                  ? 'The change removes account isolation from the data access path.'
                                                  : 'The change preserves behavior and permissions.',
                                      },
                            files: [
                                {
                                    path: 'src/access/permissions.ts',
                                    status: 'modified',
                                },
                            ],
                        },
                    },
                });
            });
            await open('risk');
            await page
                .getByRole('button', { name: 'Preview on a PR', exact: true })
                .click();
            if (status !== 'empty') {
                const dialog = page.getByRole('dialog');
                await dialog.getByRole('combobox').click();
                await page.getByRole('option').first().click();
                await dialog
                    .getByRole('spinbutton', { name: 'PR number' })
                    .fill('42');
                await dialog
                    .getByRole('button', { name: 'Preview risk', exact: true })
                    .click();
                if (status !== 'loading') {
                    if (status === 'error')
                        await dialog.getByRole('alert').waitFor();
                    else
                        await dialog
                            .getByRole('heading', {
                                name:
                                    status === 'risk'
                                        ? 'Risk found'
                                        : status === 'clean'
                                          ? 'No risk found'
                                          : 'Assessment unavailable',
                                exact: true,
                            })
                            .waitFor();
                }
            }
            await shot(
                `${index}-preview-${status}`,
                'Preview',
                title,
                'Somente a resposta do preview e a lista do seletor usam exemplos; a aplicação e o menu são reais.',
                true,
            );
            pending?.();
            await page.unroute(previewPath);
            releasePreview = undefined;
        }
        await page.unroute(repositoriesPath);
        await page.setViewportSize({ width: 390, height: 844 });
        await open('risk');
        await shot('39-risk-mobile', 'Mobile', 'Risk no mobile');
        await open('routing');
        await shot('40-routing-mobile', 'Mobile', 'Routing no mobile');
        await open('general');
        await shot('41-general-mobile', 'Mobile', 'General no mobile');
        await editPolicy('Dependency updates');
        const apply = page.getByRole('button', { name: 'Apply', exact: true });
        await expect(apply).toBeInViewport();
        const before = await apply.boundingBox();
        await shot(
            '43-policy-mobile',
            'Mobile',
            'Editor de política com ações fixas',
        );
        await page
            .getByRole('region', { name: 'Policy settings', exact: true })
            .evaluate((node) => {
                node.scrollTop = node.scrollHeight;
            });
        await expect(apply).toBeInViewport();
        const after = await apply.boundingBox();
        assert.ok(
            before && after && Math.abs(before.y - after.y) <= 2,
            'Policy actions must stay fixed while conditions scroll.',
        );
        await shot(
            '44-policy-mobile-scrolled',
            'Mobile',
            'Ações permanecem visíveis após rolagem',
        );
        await apply.click();
        await expect(
            page.getByRole('dialog', { name: 'Edit policy', exact: true }),
        ).toHaveCount(0);
    } finally {
        releasePreview?.();
        await page.unroute(previewPath);
        await page.unroute(repositoriesPath);
        await configure(restore);
        await page.setViewportSize({ width: 1440, height: 1000 });
        writeFileSync(
            `${dir}/manifest.json`,
            JSON.stringify(manifest, null, 2),
        );
    }
}
