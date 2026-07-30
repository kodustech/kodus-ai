<p align="center">
  <img alt="kodusロゴ" src="https://kodus.io/wp-content/uploads/2026/06/kodus-thumb-git-scaled.png">
</p>

<p align="center">
   <a href="http://makeapullrequest.com">
      <img alt="PRを歓迎します" src="https://img.shields.io/badge/PRs-welcome-darkgreen.svg?style=shields" />
   </a>
   <a href="https://github.com/kodustech/kodus-ai" target="_blank">
      <img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Githubのスター" />
   </a>
   <a href="./license.md">
      <img src="https://img.shields.io/badge/license-AGPLv3-red" alt="ライセンス" />
   </a>
</p>

---

<p align="center">
   <a href="https://kodus.io">ウェブサイト</a> ·
   <a href="https://discord.gg/6WbWrRbsH7">コミュニティ</a> ·
   <a href="https://docs.kodus.io">ドキュメント</a> ·
   <a href="https://docs.kodus.io/how_to_use/en/cli/overview">CLIドキュメント</a> ·
   <strong><a href="https://app.kodus.io">Kodus Cloudを試す </a></strong> ·
   <strong><a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">セルフホストガイド</a></strong>
</p>

<p align="center">
   🌐
   <a href="./README.md">English</a> ·
   <a href="./README.pt-BR.md">Português (BR)</a> ·
   <a href="./README.es.md">Español</a> ·
   <a href="./README.ja.md">日本語</a> ·
   <a href="./README.zh-CN.md">简体中文</a> ·
   <a href="./README.fr.md">Français</a>
</p>

## チームがKodusを選ぶ理由

- **モデル非依存**: Claude、GPT-5、Gemini、Llama、GLM、Kimi、または任意のOpenAI互換エンドポイントを利用可能。
- **LLMコストの上乗せなし**: モデルプロバイダーに直接支払い。隠れた倍率はありません。
- **コンテキストから学習**: Kodyはあなたのアーキテクチャ、標準、ワークフローに適応します。
- **ルールはあなたが決める**: 自然言語でカスタムレビュールールを定義。
- **プライバシーとセキュリティ**: ソースコードはモデルのトレーニングに使用されず、データは転送時および保存時に暗号化され、セルフホストランナーもサポート。セルフホストインスタンスは1日に1回の匿名ハートビートを送信します（集計カウンターのみ — コード、名前、識別子は含まれません）。`KODUS_TELEMETRY_DISABLED=true`でオプトアウト可能。[匿名テレメトリー](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/telemetry)を参照。
- **ネイティブなGitワークフロー**: GitHub、GitLab、Bitbucket、Azure ReposでPR内に直接機能。
- **CLI + CI/CD対応**: ローカルおよびパイプラインでレビューを実行。
- **運用への影響**: レビュー品質を高く保ちながら、技術的負債とデリバリーメトリクスを追跡。

## 製品のハイライト

<details>
  <summary><strong>🔑 独自キーの持ち込み (BYOK)</strong></summary>
<br />
独自のプロバイダー認証情報を接続し、Kodusレビューの背後にあるモデルを選択: OpenAI、Anthropic、Google Gemini、Vertex AI、Novita、または任意のOpenAI互換エンドポイント。隠れたLLM上乗せなしで、課金と使用量は独自のプロバイダーアカウントで管理。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/byok-scaled.png" alt="Kodus BYOKモデルプロバイダー設定" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>📈 トークン使用量</strong></summary>
<br />
AIコードレビュー全体のトークン消費を追跡し、コスト要因を把握し、導入が拡大してもモデル支出を予測可能に保ちます。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/token-usage-scaled.png" alt="Kodusトークン使用量ダッシュボード" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>⚙️ Kody Rules</strong></summary>
<br />
Kody Rulesにより、チームは自然言語でレビュー指示を定義し、組織、リポジトリ、パス、または特定のレビュースコープ全体に適用できます。Kodyはプルリクエストをレビューする際、これらのルールをコンテキストとして使用し、レビュー担当者が同じフィードバックを手動で繰り返すことなく、アーキテクチャの決定、セキュリティ要件、テストプラクティス、リポジトリ固有の規約を強制するのに役立ちます。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/rules-scaled.png" alt="Kodyルール" width="900">
</p>
</details>
<br />
<details>
  <summary><strong>📊 Cockpit</strong></summary>
<br />
Cockpitは、エンジニアリングワークフロー全体でKodusのレビュー効果、Kody Ruleの健全性、リポジトリの健全性、デリバリーメトリクスを測定するのに役立ちます。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/cockpit-kodus-scaled.png" alt="AIコードレビューパイプラインの健全性を示すKodus Cockpit" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>🧩 Kody Issues</strong></summary>
<br />
クローズされたプルリクエストの未実装サジェスションを自動的に追跡し、ステータス、重要度、カテゴリ、リポジトリごとに管理。将来のPRで修正が現れた際にKodyがそれらを解決。
<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/issues-scaled.png" alt="Kodus Issuesダッシュボード" width="900">
</p>

</details>

<br />
<details>
  <summary><strong>🔎 実際のプルリクエストをレビューするKodyを見る</strong></summary>
<br />
Kodyは差分を要約するだけではありません。コンテキストを伴ってコードをレビューし、重要度ごとにリスクをフラグし、プルリクエストに直接具体的な修正案を提案します。

<br />
<br />

<p align="center">
  <img
    src="https://kodus.io/wp-content/uploads/2025/12/review-kody-.png"
    alt="プルリクエストレビューで重大なIDORセキュリティ問題を検出するKody"
    width="700"
  />
</p>

この例では、Kodyは`organizationId`クエリパラメータが配列として渡されるとテナント保護をバイパスする可能性がある重大なIDORリスクを検出し、コードがマージされる前に明示的なランタイムバリデーションを提案します。

</details>

## はじめに

Kodusをどのように利用したいかに合わせたワークフローを選択してください。

<table>
  <tr>
    <td width="50%">
      <strong>Kodus Cloudを試す</strong>
      <br />
      インフラを管理せずにプルリクエストのレビューを開始。
      <br />
      <br />
      <a href="https://app.kodus.io/signup">無料アカウントを作成</a>
      ·
      <a href="https://kodus.io/pricing">料金を見る</a>
    </td>
    <td width="50%">
      <strong>Kodusをセルフホスト</strong>
      <br />
      データ、モデル、ランタイム設定を制御しながら、独自のインフラにKodusを
      デプロイ。
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">インストールガイド</a>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>CLIを使用</strong>
      <br />
      ターミナルから、ワーキングツリー、ステージ済み差分、
      ブランチ、コミットに対してAIコードレビューを実行。
      <br />
      <br />
      <code>kodus review</code>
      <br />
      <code>kodus review --staged</code>
      <br />
      <code>kodus review --prompt-only</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_use/en/cli/introduction">CLIの概要</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/commands">コマンドリファレンス</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/ci_cd">CI/CD</a>
    </td>
    <td width="50%">
      <strong>ローカルで貢献</strong>
      <br />
      API、worker、webhooksサービス、Webアプリ、ローカルインフラ全体にわたる
      開発のためにKodusモノレポをローカルで実行。
      <br />
      <br />
      <code>git clone https://github.com/kodustech/kodus-ai.git</code>
      <br />
      <code>cd kodus-ai</code>
      <br />
      <code>yarn setup</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator">ローカルクイックスタート</a>
    </td>
  </tr>
</table>

## モノレポ構造

Kodusは複数のアプリケーション、共有ドメインライブラリ、公開パッケージを含むモノレポです。

```txt
kodus-ai/
├── apps/
│   ├── api/          # NestJS API
│   ├── web/          # Next.jsダッシュボード
│   ├── worker/       # レビュー実行とキューのコンシューマー
│   └── webhooks/     # Gitプロバイダーのwebhook取り込み
├── libs/             # 共有NestJSドメインモジュール
├── packages/
│   ├── kodus-flow/   # AIエージェントオーケストレーションSDK
│   └── kodus-common/ # LLM抽象化パッケージ
└── scripts/          # 開発、デプロイ、ベンチマーク、自動化スクリプト
```

| パス | 目的 |
| --- | --- |
| `apps/api` | 認証、組織、チーム、Kody Rules、インテグレーション、権限、コードレビューオーケストレーションを担うメインのNestJS API。 |
| `apps/web` | KodusダッシュボードのNext.js Webアプリケーション。 |
| `apps/worker` | コードレビュー実行、キュー処理、サジェスションチェック、自動化ジョブ、監視タスクを行うバックグラウンドサービス。 |
| `apps/webhooks` | GitHub、GitLab、Azure Repos、Bitbucket、Forgejoイベントのwebhook取り込みサービス。 |
| `libs` | Kodusアプリケーション全体で使用される共有NestJSドメインモジュール。 |
| `packages/kodus-flow` | AIエージェントオーケストレーション用SDK。 |
| `packages/kodus-common` | モデルプロバイダー向けの共有LLM抽象化パッケージ。 |

完全なセットアップ手順については、[ローカルクイックスタート](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator)に従ってください。

## オープンソース vs. Teams vs. Enterprise

| 機能 | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-community2-scaled.webp" alt="Kody Community" width="110" /><br>Community | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-team-scaled.webp" alt="Kody Teams" width="110" /><br>Teams | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-enterprise-scaled.webp" alt="Kody Enterprise" width="110" /><br>Enterprise |
| :--- | :---: | :---: | :---: |
| 価格 | 無料 | $10/開発者 月額 または $8/開発者 年額 (+ tokens/開発者) | カスタム |
| ホスティング | セルフホスト **または** Kodusがホスト | Kodusがホスト | セルフホスト **または** Kodusがホスト |
| 独自キーの持ち込み (BYOK) | ✅ | ✅ | ✅ |
| PR使用量 | 独自のAPIキーで無制限のPR | 独自のAPIキーで無制限のPR | Kodus AI Tokens APIキーで無制限のPR |
| ユーザー | 無制限 | 無制限 | 無制限 |
| Kody Rules | 最大10 | 無制限 | 無制限 |
| アクティブなプラグイン | 最大3 | 無制限 | 無制限 |
| Kody Learningsとメモリ | ✅ | ✅ | ✅ |
| Quality Radarのイシュー | 無制限 | 無制限 | 無制限 |
| Kody Agentsの優先キュー | ❌ | ✅ | ✅ |
| エンジニアリングメトリクス / Cockpit | ❌ | ✅ | ✅ |
| SSO | ❌ | ❌ | ✅ |
| RBAC + 監査ログ + 分析 | ❌ | ❌ | ✅ |
| コンプライアンス | ❌ | ❌ | SOC 2 |
| サポート | Discordコミュニティサポート | Discordコミュニティ + メールサポート | プライベートDiscord + メール + 最大5時間/月の専用オンボーディング/サポート |

[すべてのプランを比較 →](https://kodus.io/pricing)

## リソース

| リソース | 説明 |
| --- | --- |
| [ウェブサイト](https://kodus.io) | Kodus、製品機能、価格について詳しく。 |
| [ドキュメント](https://docs.kodus.io) | セットアップガイド、製品ドキュメント、CLIの使用法、セルフホスト手順。 |
| [Kodus Cloud](https://app.kodus.io) | インフラを管理せずにKodusを使い始める。 |
| [セルフホストガイド](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm) | 独自の環境にKodusをデプロイ。 |
| [CLIドキュメント](https://docs.kodus.io/how_to_use/en/cli/overview) | ローカル、CI/CD、コーディングエージェント内でAIコードレビューを実行。 |
| [Discordコミュニティ](https://discord.gg/6WbWrRbsH7) | 質問、セットアップのサポート、Kodusチームとの対話。 |
| [料金](https://kodus.io/pricing) | Community、Teams、Enterpriseエディションを比較。 |
| [通話をスケジュール](https://cal.com/gabrielmalinosqui/30min) | セットアップ、セルフホスト、エンタープライズのニーズについてKodusチームと相談。 |



## コントリビュート

<p align="left">
  <img src="https://kodus.io/wp-content/uploads/2026/06/kody-contributing-scaled.png" alt="Kodyのコントリビュート" width="230" />
</p>

あらゆる規模のコントリビューションを歓迎します 🧡

誤字の修正、ドキュメントの改善、バグの報告、機能の提案、またはあるべきだと思うもののプルリクエストをオープンしてください。

どこから始めればよいか迷ったら、イシューをオープンするかコミュニティに参加してください。喜んでお手伝いします。
