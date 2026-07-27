# agent-workflow

GitHub 上で動作する、プラットフォーム非依存のエージェント型開発ループです。
アイデアは Issue として入り、テスト済みでリリースされた機能として出ていきます。
その間、人間が関与するのは意図的に設けた承認ゲートだけです。スクリプトで判断
できることはすべてスクリプトが判断し、エージェントは判断が必要なところにだけ
トークンを使います。

> この文書は英語版 `README.md`（`6bbc019` 時点）の内容に基づいています。

📐 **アーキテクチャ:** [`agent-loop-architecture.html`](agent-loop-architecture.html)
（対話的な配線グラフを備えた、正典としての設計文書。日本語版:
[`agent-loop-architecture.ja.html`](agent-loop-architecture.ja.html)）。🚧 **ビルド
状況:** [`STATUS.md`](STATUS.md)。リポジトリ: `yuchida-tamu/agent-workflow`。

## 基本原則（Ground rules）

1. **決定論を第一に。** スクリプトで判断できることはスクリプトにし、トークンは
   使いません。エージェントが動くのは、決定論的なチェックを通したあと、判断が
   必要な場面に限られます。
2. **モデルルーティング。** 閉じた集合の分類には Haiku、ルーブリックに沿った
   作業には Sonnet、答えの定まらない判断には Opus を割り当てます。機械的な作業
   に、より上位のティアを使うことはありません。
3. **記録は GitHub であって、会話ではない。** 人間へのヒアリングはセッション内で
   行い、成果物は Issue や PR に残します。ゲート承認は、人間自身の `gh` アカウント
   から投稿します。
4. **エージェントは次のことをしない。** 状態ラベルの遷移、ゲート承認の発行、
   Issue の直接起票。
5. **ゲートの間は自律的に。** 人間の判断が入るのはゲート（G1 ブリーフ、G2 プラン、
   G3 マージ、G4 リリース）と、リトライ回数を使い切ったときだけです。その間に
   あるものは、確認を挟まずに進みます。
6. **レビューは独立かつ Opus ティア。** `code-reviewer` と `ux-reviewer` は、
   実装したコンテキストの内側ではなく、そのつど新しく立ち上げた「まっさらな」
   サブエージェントとして動きます。

## あなたの入口はどれか

| あなたは… | やること |
|---|---|
| まったく新しいプロジェクトを始める | `project-genesis` エージェント（Opus）を実行します。ヒアリングを行い、リポジトリの土台を作り、マイルストーン 1 のバックログに初期アイテムを登録します |
| 既存のリポジトリにループを持ち込む | このリポジトリのクローンから `node init/cli.js adopt --target <あなたのリポジトリのパス> --repo owner/name` を実行します（下のクイックスタート参照） |
| すでに導入済みで、バックログを回し続けたい | `node scripts/next/cli.js --repo owner/name` を実行すると、次に誰が動くべきかを教えてくれます |

「既存リポジトリ」の道のりを最初から最後までたどる手順:
**[docs/getting-started.ja.md](docs/getting-started.ja.md)**。

## adopt クイックスタート

`@main` ではなく、リリース済みのバージョンをピン留めしてください。`adopt` が
あなたのリポジトリに設置するワークフローのスタブは、この同じタグを参照します。
そのため、ループの挙動が変わるのは、あなたがアップグレードを選んだときだけです。

```sh
git clone --branch v0.2.0 https://github.com/yuchida-tamu/agent-workflow
cd agent-workflow && npm install
node init/cli.js adopt --target /path/to/your-repo --repo <owner>/<name>
# 18 個のラベル一式（状態・優先度・リスク・ドリフト）を作成し、
# config・domains.yml・ビジネスポリシーパックの雛形を生成し、
# 自動では適用できないリポジトリ設定を出力します。設置されるワークフローの
# スタブは @v0.2.0 をピン留めします
node init/cli.js adopt --verify --target /path/to/your-repo --repo <owner>/<name>
# 実際に何が反映されたかを再読込します。G3 モード（native-review | solo-comment）
# も含めて確認できます
```

そのあとで、出力された `gh api` の設定コマンド（Actions のアクセス権、ブランチ
保護、G4 リリース用の Environment）を貼り付けて実行します。これらは、意図して
あなた自身が実行するものです。詳細は
[docs/getting-started.ja.md](docs/getting-started.ja.md)。

**アップグレード:** 設置済みの `.github/workflows/agentflow-*.yml` スタブにある
`@vX.Y.Z` の参照を新しいタグへ上げ、何が変わったかは
[CHANGELOG.ja.md](CHANGELOG.ja.md) で確認してください。

## コマンドリファレンス

`agentflow-*` の各 CLI です。いずれも `--help` を付けて実行するか、その `cli.js`
冒頭の usage コメントを読むと、全フラグを確認できます。

| command | 目的 |
|---|---|
| `agentflow-init` | リポジトリのブートストラップ: `labels` · `project` · `adopt`（`--verify` · `--coverage`） |
| `agentflow-next` | クロールフェーズのディスパッチャ。次に誰が、なぜ動くべきかを示す |
| `agentflow-state` | 作業アイテムのステートマシン: `status` · `plan` · `apply`（ラベル ↔ `state:*`） |
| `agentflow-gate` | `/approve` コメントを、ゲートとその承認者リストに照らして検証する |
| `agentflow-policy` | リスクポリシーエンジン: ポリシーパックに対する `evaluate` · `test` · `validate` |
| `agentflow-facts` | ポリシーエンジン向けに、git 範囲から diff・ドメイン・ドリフトの事実を抽出する |
| `agentflow-verdict` | 記録済みのリスク判定を読み、それがゲートを無人で通せるかどうかを問う |
| `agentflow-identity` | agentflow の GitHub App として振る舞う: `token` · `exec` · `whoami` · `doctor` |
| `agentflow-log` | 実行台帳: `start` · `end` · `audit`（モデルティアの遵守状況） |
| `agentflow-release` | G4: タグ付け + GitHub リリース、`verified → released`（`--verify` は不変条件を確認） |
| `agentflow-e2e` | コンパイル済みトレースから Gherkin シナリオを再生する: `run` · `smoke` |

## さらに深く

- **[docs/getting-started.ja.md](docs/getting-started.ja.md)** — 既存リポジトリ
  向けの道のり。導入から、最初のマージ・検証済み Issue まで。
- **[docs/github-app-runbook.md](docs/github-app-runbook.md)** — agentflow に
  独自の GitHub アイデンティティを与え、G3 を `/approve` コメント
  （`solo-comment`）ではなく、本物のレビュー（`native-review`）にします。
  （このランブックは現時点で英語のみです）
- **[docs/headless-runbook.md](docs/headless-runbook.md)** — 自分のセッション
  ではなく、GitHub がホストするランナー上でエージェントを動かします。課金は
  Claude のサブスクリプションに対して行われます。（英語のみ）
- **[STATUS.md](STATUS.md)** — 実際に何が作られているかを、フェーズごとに。

```sh
npm install
npm test   # エンジン + ステートマシンのテスト
```
