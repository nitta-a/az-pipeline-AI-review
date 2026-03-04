# LLM PR Reviewer

Azure DevOps パイプラインから LLM（大規模言語モデル）を呼び出し、Pull Request のコードレビューを自動化する Azure DevOps 拡張機能タスクです。

## 概要

PR がトリガーとなるパイプラインに本タスクを追加すると、以下の処理を自動で行います。

1. PR の最新イテレーションで変更されたファイルの内容を取得
2. 設定された LLM プロバイダーへ差分テキストを送信
3. レビュー結果を PR のスレッドコメントとして投稿
4. 再実行時は前回投稿した AI レビューコメントを自動削除してから新しいレビューを投稿

> LLM が特に指摘を出さなかった場合でも、PR コメントには「コメントはありません。」と明示的に表示されます。

LLM はバグ・ロジックの誤り、セキュリティリスク、パフォーマンス問題、設計・可読性、テストの抜け漏れの観点でレビューを行います。

## 対応 LLM プロバイダー

| プロバイダー | 説明 |
|---|---|
| **Azure OpenAI** | Azure 上にデプロイされた OpenAI モデル |
| **OpenAI** | OpenAI API（GPT-4o など） |
| **Anthropic** | Claude 系モデル |
| **AWS Bedrock** | AWS Bedrock 経由で利用する Claude 系モデルなど |
| **Azure AI Foundry** | Azure AI Foundry のサーバーレス API エンドポイント |

## 前提条件

- Node.js 16 以上
- Azure DevOps 組織（Azure Repos + Azure Pipelines）
- 利用する LLM プロバイダーの API キー / 認証情報

## インストール方法

### 1. ビルド

```bash
npm install
npm run build
```

### 2. パッケージ作成（tfx-cli が必要）

```bash
npm install -g tfx-cli
tfx extension create --manifest-globs vss-extension.json
```

生成された `.vsix` ファイルを Azure DevOps 組織の **Organization Settings > Extensions** からアップロードしてインストールします。

## パイプラインへの追加方法

### 1. OAuth トークンの有効化

パイプラインが Azure Repos API へアクセスするために、パイプラインの設定で **Allow scripts to access the OAuth token** を有効にします。

- Azure DevOps のパイプライン編集画面 → **Agent job** → **Allow scripts to access the OAuth token** にチェック

または YAML で明示的に指定します：

```yaml
variables:
  system.debug: false

jobs:
  - job: Review
    pool:
      vmImage: ubuntu-latest
    steps:
      - task: LLMReviewerTask@0
        env:
          SYSTEM_ACCESSTOKEN: $(System.AccessToken)
        inputs:
          llmConnectionString: '<接続文字列>'
```

### 2. 接続文字列の形式

`llmConnectionString` 入力はセミコロン区切りの `key=value` 形式で指定します。

#### Azure OpenAI

```
provider=azure;endpoint=https://<resource>.openai.azure.com;key=<api-key>;model=gpt-4o;api_version=2024-02-01
```

#### OpenAI

```
provider=openai;key=sk-<api-key>;model=gpt-4o
```

#### Anthropic Claude

```
provider=anthropic;key=sk-ant-<api-key>;model=claude-3-5-sonnet-20241022
```

#### AWS Bedrock

```
provider=bedrock;region=us-east-1;access_key=<access-key>;secret_key=<secret-key>;model=anthropic.claude-3-5-sonnet-20241022-v2:0
```

#### Azure AI Foundry

Azure AI Foundry のエンドポイントページに表示される **ターゲット URI**（エンドポイント）と **キー** を使用します。

```
provider=foundry;endpoint=https://<project>.services.ai.azure.com;key=<api-key>;model=<model-name>
```

`endpoint` の代わりに `target` または `target_uri` キーも使用できます：

```
provider=foundry;target_uri=https://<project>.services.ai.azure.com;key=<api-key>;model=<model-name>
```

> **Note:** モデル名はエンドポイントのデプロイ名またはモデル識別子を指定してください（例: `gpt-4o`、`Phi-4` など）。

> **セキュリティ上の注意：** API キーは直接 YAML に記載せず、Azure DevOps の **Pipeline variables（Secret 設定）** または **Variable Groups** に保存して参照することを推奨します。
>
> ```yaml
> inputs:
>   llmConnectionString: 'provider=azure;endpoint=$(AOAI_ENDPOINT);key=$(AOAI_KEY);model=gpt-4o'
> ```

### 3. PR トリガーの設定例（YAML 全体）

```yaml
trigger: none

pr:
  branches:
    include:
      - main
      - develop

jobs:
  - job: AIReview
    displayName: AI Code Review
    pool:
      vmImage: ubuntu-latest
    steps:
      - task: LLMReviewerTask@0
        displayName: LLM PR Review
        inputs:
          llmConnectionString: 'provider=azure;endpoint=$(AOAI_ENDPOINT);key=$(AOAI_KEY);model=gpt-4o'
```

## パイプライン実行時に必要な権限

本タスクは `System.AccessToken`（パイプラインの Build Service アカウントトークン）を使用して Azure Repos API を呼び出します。以下の権限設定が必要です。

### 1. Allow scripts to access the OAuth token（必須）

パイプラインが `System.AccessToken` を利用できるように、パイプラインまたは Agent job のオプションで有効化してください。

- GUI: パイプライン編集 → Agent job → **Allow scripts to access the OAuth token** を ON
- YAML: `env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)` をタスクに追加

### 2. Build Service アカウントへの Git 権限（必須）

| 権限 | 理由 |
|---|---|
| **Contribute to pull requests** | PR へのコメント投稿・削除に必要 |
| **Read** （リポジトリ） | PR の差分・ファイル内容の取得に必要 |

#### 設定手順

1. Azure DevOps の **Project Settings** → **Repositories** → 対象リポジトリを選択
2. **Security** タブを開く
3. `<ProjectName> Build Service (<OrgName>)` ユーザーを選択
4. 以下の権限を **Allow** に設定：
   - `Contribute to pull requests`
   - `Read`

または **Project Settings** → **Pipelines** → **Settings** で **Disable requesting for access to repos not already granted** が無効になっていることを確認してください。

## ライセンス

MIT
