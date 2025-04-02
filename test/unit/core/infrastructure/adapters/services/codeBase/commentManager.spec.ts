import {
    BehaviourForExistingDescription,
    CodeReviewConfig,
    FileChange,
    LimitationType,
} from '@/config/types/general/codeReview.type';
import { CommentManagerService } from '@/core/infrastructure/adapters/services/codeBase/commentManager.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { Test, TestingModule } from '@nestjs/testing';

describe('commentManager', () => {
    let commentManagerService: CommentManagerService;
    const mockCodeManagementService = {};
    const mockLoggerService = {};

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CommentManagerService,
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: PinoLoggerService,
                    useValue: mockLoggerService,
                },
            ],
        }).compile();

        commentManagerService = module.get<CommentManagerService>(
            CommentManagerService,
        );
    });

    it('should be defined', () => {
        expect(commentManagerService).toBeDefined();
    });

    const MOCK_FILE_CHANGE: FileChange[] = [
        {
            additions: 1,
            deletions: 2,
            filename: 'test.ts',
            blob_url: 'url',
            raw_url: 'url',
            changes: 3,
            content: 'content',
            contents_url: 'url',
            patch: 'patch',
            sha: 'sha',
            status: 'added',
        },
        {
            additions: 4,
            deletions: 5,
            filename: 'test2.ts',
            blob_url: 'url',
            raw_url: 'url',
            changes: 6,
            content: 'content',
            contents_url: 'url',
            patch: 'patch',
            sha: 'sha',
            status: 'added',
        },
        {
            additions: 7,
            deletions: 8,
            filename: 'test3.ts',
            blob_url: 'url',
            raw_url: 'url',
            changes: 9,
            content: 'content',
            contents_url: 'url',
            patch: 'patch',
            sha: 'sha',
            status: 'added',
        },
    ];

    it('should format initial message properly in multiple languages with varying encodings and writing styles', async () => {
        const testCases = [
            {
                language: LanguageValue.SPANISH,
                expected: `
# Resumen de PR (Comentario creado por [Kody](https://kodus.io) 🤖)

## ¡Revisión de código iniciada! 🚀

✋ ¡Hola, equipo! Ya estoy revisando los archivos modificados y comenzando la revisión para asegurarme de que todo esté en orden. Si necesitan más detalles, ¡estoy aquí! [Kody](https://kodus.io)

<details>
<summary>📂 Archivos modificados</summary>

| Archivo | Estado | ➕ Adiciones | ➖ Eliminaciones | 🔄 Cambios |
|------|--------|-------------|-------------|------------|
| [test.ts](url) | added | 1 | 2 | 3 |
| [test2.ts](url) | added | 4 | 5 | 6 |
| [test3.ts](url) | added | 7 | 8 | 9 |
</details>

<details>
<summary>📊 Resumen de cambios</summary>

- **Total de archivos**: 3
- **Total de líneas añadidas**: 12
- **Total de líneas eliminadas**: 15
- **Total de cambios**: 18
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
            },
            {
                language: LanguageValue.JAPANESE,
                expected: `
# PRサマリー([Kody](https://kodus.io)によって作成されたコメント 🤖)

## コードレビュー開始！ 🚀

✋ こんにちは、チーム！ 変更されたファイルを既に確認しており、すべてが順調であることを確認するためにレビューを開始しています。 詳細が必要な場合は、ここにいます！ [Kody](https://kodus.io)

<details>
<summary>📂 変更されたファイル</summary>

| ファイル | ステータス | ➕ 追加 | ➖ 削除 | 🔄 変更 |
|------|--------|-------------|-------------|------------|
| [test.ts](url) | added | 1 | 2 | 3 |
| [test2.ts](url) | added | 4 | 5 | 6 |
| [test3.ts](url) | added | 7 | 8 | 9 |
</details>

<details>
<summary>📊 変更の概要</summary>

- **合計ファイル**: 3
- **追加された行の合計**: 12
- **削除された行の合計**: 15
- **変更の合計**: 18
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
            },
            {
                language: LanguageValue.ARABIC,
                expected: `
# ملخص PR (تم إنشاء التعليق بواسطة [كودي](https://kodus.io) 🤖)

## بدأت مراجعة الكود! 🚀

✋ مرحبًا، فريق! أنا أراجع الملفات المتغيرة وأبدأ المراجعة للتأكد من أن كل شيء على ما يرام. إذا كنتم بحاجة إلى مزيد من التفاصيل، أنا هنا! [كودي](https://kodus.io)

<details>
<summary>📂 الملفات المتغيرة</summary>

| ملف | الحالة | ➕ الإضافات | ➖ الحذف | 🔄 التغييرات |
|------|--------|-------------|-------------|------------|
| [test.ts](url) | added | 1 | 2 | 3 |
| [test2.ts](url) | added | 4 | 5 | 6 |
| [test3.ts](url) | added | 7 | 8 | 9 |
</details>

<details>
<summary>📊 ملخص التغييرات</summary>

- **إجمالي الملفات**: 3
- **إجمالي الأسطر المضافة**: 12
- **إجمالي الأسطر المحذوفة**: 15
- **إجمالي التغييرات**: 18
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
            },
        ];

        for (const testCase of testCases) {
            const formattedMessage =
                // @ts-ignore
                await commentManagerService.generatePullRequestSummaryMarkdown(
                    MOCK_FILE_CHANGE,
                    testCase.language,
                );
            expect(formattedMessage).toEqual(testCase.expected);
        }
    });

    const MOCK_CODE_REVIEW_CONFIG: CodeReviewConfig = {
        automatedReviewActive: true,
        baseBranches: ['master'],
        ignoredTitleKeywords: ['WIP'],
        ignorePaths: ['we/ignore/this/path/*', 'we/ignore/this/other/path/*'],
        languageResultPrompt: LanguageValue.ENGLISH,
        maxSuggestions: 5,
        reviewOptions: {
            code_style: true,
            documentation_and_comments: true,
            error_handling: true,
            kody_rules: true,
            maintainability: true,
            performance_and_optimization: true,
            potential_issues: true,
            refactoring: true,
            security: true,
        },
        summary: {
            behaviourForExistingDescription:
                BehaviourForExistingDescription.REPLACE,
            customInstructions: 'custom instructions',
            generatePRSummary: true,
        },
        kodyRules: [],
        limitationType: LimitationType.FILE,
        severityLevelFilter: SeverityLevel.CRITICAL,
    };

    it('should format the finish message properly in multiple languages with varying encodings and writing styles', async () => {
        const testCases = [
            {
                codeReviewConfig: {
                    ...MOCK_CODE_REVIEW_CONFIG,
                    languageResultPrompt: LanguageValue.SPANISH,
                },
                expectedWithComments: `
## ¡Revisión de código completada! 🔥

La revisión de código se completó con éxito según sus configuraciones actuales.



<details>
<summary>Guía de Kody: Uso y configuración</summary>

<details>
<summary>Interactuando con Kody</summary>

- **Solicitar una revisión:** Pida a Kody que revise su PR manualmente añadiendo un comentario con el comando \`@kody start-review\` en la raíz de su PR.

- **Proporcionar comentarios:** Ayude a Kody a aprender y mejorar reaccionando a sus comentarios con un 👍 para sugerencias útiles o un 👎 si se necesitan mejoras.

</details>

<details>
<summary>Configuración actual de Kody</summary>

<details>
<summary>Opciones de revisión</summary>

Las siguientes opciones de revisión están habilitadas o deshabilitadas:

| Opciones                        | Habilitado |
|-------------------------------|---------|
| **Code Style** | ✅ |
| **Documentation And Comments** | ✅ |
| **Error Handling** | ✅ |
| **Kody Rules** | ✅ |
| **Maintainability** | ✅ |
| **Performance And Optimization** | ✅ |
| **Potential Issues** | ✅ |
| **Refactoring** | ✅ |
| **Security** | ✅ |

</details>

**[Acceda a sus configuraciones aquí.](https://app.kodus.io/automations/AutomationCodeReview/global/general)**

</details>
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
                expectedWithoutComments: `
# Revisión de Kody completada
**¡Grandes noticias!** 🎉
No se encontraron problemas que coincidan con sus configuraciones de revisión actuales.

¡Sigue con el excelente trabajo! 🚀

<details>
<summary>Guía de Kody: Uso y configuración</summary>

<details>
<summary>Interactuando con Kody</summary>

- **Solicitar una revisión:** Pida a Kody que revise su PR manualmente añadiendo un comentario con el comando \`@kody start-review\` en la raíz de su PR.

- **Proporcionar comentarios:** Ayude a Kody a aprender y mejorar reaccionando a sus comentarios con un 👍 para sugerencias útiles o un 👎 si se necesitan mejoras.

</details>

<details>
<summary>Configuración actual de Kody</summary>

<details>
<summary>Opciones de revisión</summary>

Las siguientes opciones de revisión están habilitadas o deshabilitadas:

| Opciones                        | Habilitado |
|-------------------------------|---------|
| **Code Style** | ✅ |
| **Documentation And Comments** | ✅ |
| **Error Handling** | ✅ |
| **Kody Rules** | ✅ |
| **Maintainability** | ✅ |
| **Performance And Optimization** | ✅ |
| **Potential Issues** | ✅ |
| **Refactoring** | ✅ |
| **Security** | ✅ |

</details>

**[Acceda a sus configuraciones aquí.](https://app.kodus.io/automations/AutomationCodeReview/global/general)**

</details>
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
            },
            {
                codeReviewConfig: {
                    ...MOCK_CODE_REVIEW_CONFIG,
                    languageResultPrompt: LanguageValue.JAPANESE,
                },
                expectedWithComments: `
## コードレビュー完了！ 🔥

現在の設定に基づいてコードレビューが正常に完了しました。



<details>
<summary>Kodyガイド:使用法と設定</summary>

<details>
<summary>Kodyとの対話</summary>

- **レビューをリクエスト:** PRのルートに\`@kody start-review\`コマンドを含むコメントを追加して、Kodyに手動でPRをレビューするよう依頼します。

- **フィードバックを提供:** 役立つ提案には👍、改善が必要な場合には👎で反応することで、Kodyが学習し改善するのを助けてください。

</details>

<details>
<summary>現在のKody設定</summary>

<details>
<summary>レビューオプション</summary>

以下のレビューオプションが有効または無効になっています：

| オプション                        | 有効 |
|-------------------------------|---------|
| **Code Style** | ✅ |
| **Documentation And Comments** | ✅ |
| **Error Handling** | ✅ |
| **Kody Rules** | ✅ |
| **Maintainability** | ✅ |
| **Performance And Optimization** | ✅ |
| **Potential Issues** | ✅ |
| **Refactoring** | ✅ |
| **Security** | ✅ |

</details>

**[ここで設定にアクセスします。](https://app.kodus.io/automations/AutomationCodeReview/global/general)**

</details>
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
                expectedWithoutComments: `
# Kodyレビュー完了
**素晴らしいニュースです！** 🎉
現在のレビュー設定に一致する問題は見つかりませんでした。

この調子で頑張ってください! 🚀

<details>
<summary>Kodyガイド:使用法と設定</summary>

<details>
<summary>Kodyとの対話</summary>

- **レビューをリクエスト:** PRのルートに\`@kody start-review\`コマンドを含むコメントを追加して、Kodyに手動でPRをレビューするよう依頼します。

- **フィードバックを提供:** 役立つ提案には👍、改善が必要な場合には👎で反応することで、Kodyが学習し改善するのを助けてください。

</details>

<details>
<summary>現在のKody設定</summary>

<details>
<summary>レビューオプション</summary>

以下のレビューオプションが有効または無効になっています：

| オプション                        | 有効 |
|-------------------------------|---------|
| **Code Style** | ✅ |
| **Documentation And Comments** | ✅ |
| **Error Handling** | ✅ |
| **Kody Rules** | ✅ |
| **Maintainability** | ✅ |
| **Performance And Optimization** | ✅ |
| **Potential Issues** | ✅ |
| **Refactoring** | ✅ |
| **Security** | ✅ |

</details>

**[ここで設定にアクセスします。](https://app.kodus.io/automations/AutomationCodeReview/global/general)**

</details>
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
            },
            {
                codeReviewConfig: {
                    ...MOCK_CODE_REVIEW_CONFIG,
                    languageResultPrompt: LanguageValue.ARABIC,
                },
                expectedWithComments: `
## تم إكمال مراجعة الكود! 🔥

تم إكمال مراجعة الكود بنجاح بناءً على تكويناتك الحالية.



<details>
<summary>دليل كودي: الاستخدام والتكوين</summary>

<details>
<summary>التفاعل مع كودي</summary>

- **طلب مراجعة:** اطلب من كودي مراجعة PR الخاص بك يدويًا عن طريق إضافة تعليق بالأمر \`@kody start-review\` في جذر PR الخاص بك.

- **تقديم ملاحظات:** ساعد كودي على التعلم والتحسن من خلال التفاعل مع تعليقاته بإعطاء 👍 للاقتراحات المفيدة أو 👎 إذا كانت هناك حاجة للتحسين.

</details>

<details>
<summary>تكوين كودي الحالي</summary>

<details>
<summary>خيارات المراجعة</summary>

خيارات المراجعة التالية مفعلة أو معطلة:

| خيارات                        | مفعل |
|-------------------------------|---------|
| **Code Style** | ✅ |
| **Documentation And Comments** | ✅ |
| **Error Handling** | ✅ |
| **Kody Rules** | ✅ |
| **Maintainability** | ✅ |
| **Performance And Optimization** | ✅ |
| **Potential Issues** | ✅ |
| **Refactoring** | ✅ |
| **Security** | ✅ |

</details>

**[الوصول إلى إعدادات التكوين الخاصة بك هنا.](https://app.kodus.io/automations/AutomationCodeReview/global/general)**

</details>
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
                expectedWithoutComments: `
# تم إكمال مراجعة كودي
**أخبار رائعة!** 🎉
لم يتم العثور على أي مشاكل تتطابق مع تكوينات المراجعة الحالية الخاصة بك.

واصل العمل الممتاز! 🚀

<details>
<summary>دليل كودي: الاستخدام والتكوين</summary>

<details>
<summary>التفاعل مع كودي</summary>

- **طلب مراجعة:** اطلب من كودي مراجعة PR الخاص بك يدويًا عن طريق إضافة تعليق بالأمر \`@kody start-review\` في جذر PR الخاص بك.

- **تقديم ملاحظات:** ساعد كودي على التعلم والتحسن من خلال التفاعل مع تعليقاته بإعطاء 👍 للاقتراحات المفيدة أو 👎 إذا كانت هناك حاجة للتحسين.

</details>

<details>
<summary>تكوين كودي الحالي</summary>

<details>
<summary>خيارات المراجعة</summary>

خيارات المراجعة التالية مفعلة أو معطلة:

| خيارات                        | مفعل |
|-------------------------------|---------|
| **Code Style** | ✅ |
| **Documentation And Comments** | ✅ |
| **Error Handling** | ✅ |
| **Kody Rules** | ✅ |
| **Maintainability** | ✅ |
| **Performance And Optimization** | ✅ |
| **Potential Issues** | ✅ |
| **Refactoring** | ✅ |
| **Security** | ✅ |

</details>

**[الوصول إلى إعدادات التكوين الخاصة بك هنا.](https://app.kodus.io/automations/AutomationCodeReview/global/general)**

</details>
</details>

<!-- kody-codereview -->
&#8203;`.trim(),
            },
        ];

        for (const testCase of testCases) {
            const formattedMessageWithComments =
                // @ts-ignore
                await commentManagerService.generatePullRequestFinishSummaryMarkdown(
                    [1, 2, 3] as any,
                    testCase.codeReviewConfig,
                );
            expect(formattedMessageWithComments).toEqual(
                testCase.expectedWithComments,
            );

            const formattedMessageWithoutComments =
                // @ts-ignore
                await commentManagerService.generatePullRequestFinishSummaryMarkdown(
                    [],
                    testCase.codeReviewConfig,
                );
            expect(formattedMessageWithoutComments).toEqual(
                testCase.expectedWithoutComments,
            );
        }
    });
});
