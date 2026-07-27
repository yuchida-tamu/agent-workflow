# はじめに: 既存リポジトリにループを持ち込む

この文書は、すでに存在するリポジトリを、アイデアから `state:verified` まで一気に
進む最初の Issue へと導きます。各ステップで出会うゲートの名前も示します。まったく
新しいプロジェクトを始める場合は、代わりに `project-genesis` エージェント
（Opus ティア）を実行してください。ヒアリングを行い、以下のすべてに相当する
処理を一度のパスで済ませます。

> この文書は英語版 `docs/getting-started.md`（`6bbc019` 時点）の内容に基づいて
> います。英語版: [`docs/getting-started.md`](getting-started.md)

## 1. インストール、ラベル、config、domains

`yuchida-tamu/agent-workflow` のクローンから、あなたのプロジェクトを対象に向けて:

```sh
git clone https://github.com/yuchida-tamu/agent-workflow
cd agent-workflow && npm install

node init/cli.js adopt --target /path/to/your-repo --repo <owner>/<name>
```

`adopt` は追加的かつ冪等です。すでにあるファイルを上書きすることはなく、ラベルを
強制することもありません。一度のパスで次を行います。

- リポジトリに欠けている分だけ、18 個のラベル一式（状態・優先度・リスク・
  ドリフト）を作成します（内部では `agentflow-init labels` を使用）。
- 対象リポジトリに `agentflow.config.json`、`domains.yml`、初期のビジネス
  ポリシーパック、`e2e/` ディレクトリを足場作りします。これも欠けているものだけ
  です。
- エージェント定義を `.claude/agents/` に設置します。
- ループが必要とする 3 つのリポジトリ設定（このツールキットへの Actions アクセス、
  G3 のブランチ保護、G4 リリース用の Environment）を読み取り、欠けているものに
  ついて、正確な `gh api` コマンドを**出力します**。実行することはありません。
  それはあなたのリポジトリに対するポリシー変更なので、意図的なキーストロークの
  ままにしてあります。出力されたコマンドは、あなた自身で貼り付けて実行して
  ください。

そのあと、あなたのリポジトリで `domains.yml` を開き、コード領域をビジネス上の
重要度に対応づけます。エントリが 2 つだけでも、出発点としては有効なマップです。
`adopt --coverage` は、追跡対象のソースのうち、まだ未対応づけの割合を教えて
くれます。

```sh
node init/cli.js adopt --coverage --target /path/to/your-repo
```

すべてが実際に反映されたことを確認します。

```sh
node init/cli.js adopt --verify --target /path/to/your-repo --repo <owner>/<name>
```

これは、あなたのリポジトリがどの **G3 モード**（`native-review` または
`solo-comment`）にあるか、そしてその理由も報告します（ステップ 6 参照）。

## 2. 最初の Issue を種まきする

あなたのリポジトリに、`state:idea` の Issue を 1 つ起票し、最初に作りたいものを
記述します。この時点で、その形がどうであるかは問いません。次のステージは、荒削り
なアイデアを、レビュー可能なブリーフへと変えるために存在します。

## 3. シェイプ → G1

`state:idea` のままの Issue に対して `product-shaper` エージェントを実行します。
セッション内でヒアリングを行い（標準の UX ルールに沿って多肢選択で）、ブリーフを
Issue コメントとして投稿します。問題、ユーザーストーリー、受け入れ基準、影響
ドメイン。そして G1 を求めます。ラベルを自分で編集することはありません。状態遷移
は、どのステージでもゲートワークフローの仕事であって、どのエージェントの仕事でも
ないからです。そのため Issue は、下記のゲートが発火するまで `state:idea` に
とどまります。

**ゲート G1 — ブリーフ承認。** ブリーフを読み、あなた自身の GitHub アカウントから
`/approve G1` を Issue コメントとして投稿します。`agentflow · gate` ワークフローが
コメントを検証し（正しいゲートか、承認権限のある承認者か、ボットの投稿でないか）、
Issue を `idea → spec` へ遷移させます。`state:spec` は「ブリーフ承認済み、プラン
待ち」を意味します。

```sh
node scripts/next/cli.js --repo <owner>/<name>   # 次に誰が動くかを確認する
```

## 4. プラン → G2（リスクベース）

いま `state:spec` にある Issue に対して `architect` エージェントを実行します。
地形を把握し、プランのコメント（アプローチ、宣言したファイル面、リスク）を書き、
作業を 1 PR サイズの子 Issue（`state:ready`）へと分解し、リスクエンジンをプランに
対して実行します（`agentflow-facts --stage plan` → `agentflow-policy evaluate`）。
プランが着地すると、Issue は `spec → planned` へ移ります。ここはゲートなしで、
承認は不要です。

**ゲート G2 — プラン承認 — は条件付きで**、`planned → ready` をゲートします。
リスク判定が人間のレビューを不要とするなら、遷移は**自動で通ります**。コメントは
不要で、ゲートワークフローが自動通過のメモを投稿して先へ進みます。判定がレビュー
を必要とするなら、G1 と同じように `/approve G2` を Issue コメントとして投稿します。
高リスクの判定を言いくるめて下げてはいけません。それをエスカレートさせることこそ
が狙いです。

## 5. 実装

`state:ready` の子 Issue に対して `implementer` エージェントを実行します。自身の
ワークツリーで作業し、ビルドし、セルフ検証し、PR を開きます。その過程で Issue を
`state:in-progress`、続いて `state:in-review` へと動かします。

## 6. PR / レビュー → G3

すべての PR は独立したレビューを受けます。`code-reviewer`（および UI 面には
`ux-reviewer`）が、そのつど新しく立ち上げた「冷えた」サブエージェントとして動き、
実装者自身のコンテキストの内側で動くことはありません。

**ゲート G3 — マージ — には 2 つのモードがあり**、どちらであるかは `adopt --verify`
（ステップ 1）がすでに教えてくれています。

- **`native-review`** — `agent_identity` を設定してある場合
  （[docs/github-app-runbook.md](github-app-runbook.md) 参照。英語のみ）。エージェント
  の PR は App が作成するので、「自分自身の」PR にはなりません。承認の行為は、PR に
  対する本物の **GitHub 承認レビュー**です。ブランチ保護でこれを必須にできます。
- **`solo-comment`** — `agent_identity` が未設定の場合。エージェントの PR は
  あなたが作成するので、GitHub は自分の PR の承認を禁じます。承認の行為は、
  **head SHA を明記した `/approve` コメントを PR に付け**、それをあなた自身が
  マージすることです。前へ進めるのはマージそのものです。マージ後の自動処理が
  Issue を `in-review → merged → verified` へと自律的に遷移させます。手動での
  フォールバック（`node scripts/state/cli.js apply --issue N --to <state>
  --approved-gate G3`）は、自動処理が動かなかった稀なケースのためだけのものです。

App を設定していないリポジトリは、既定で `solo-comment` モードです。これは正当な
定常状態であって、未完成のセットアップではありません。

**G3 は PR 上にあり、Issue 上にはありません。** `/approve G3` を *Issue* コメント
として投稿すると、設計上つねに拒否されます。G3 を支えるレビューガードは、PR の
レビュー成果物と head SHA を必要としますが、そのどちらも Issue コメントは
持ちません。そのため毎回、安全側に倒れて失敗します。承認は PR 自体に対して行い、
それからマージしてください。Issue は、Issue 側の承認ではなく、上記のマージ自動
処理を通じて進みます。

## 7. merged → verified

マージされると、マージ後のステップが、あなたのシナリオスイートに対して
`agentflow-e2e smoke` を実行し（空のスイートでは何も検証せずに通ります。これは
失敗ではなく、あなたのリポジトリのカバレッジについての事実です）、通れば
`merged → verified` へ遷移させます。ここにゲートはありません。G3 がすでに、人間の
判断を要する部分をカバーしているからです。

あなたのリポジトリがリリースを行う場合（`release_kind: tag`）、`verified → released`
は **ゲート G4** です。Issue に `/approve G4` を投稿します。行為は G1／G2 と同じ
です。`agentflow-release --repo <owner>/<name> --issue N` が、その記録済みの承認を
消費してタグ付けとリリース公開を行います。自前で承認を発行することはありません。

## レベルアップ

上記のうち 2 つは「スターター」構成であり、いずれも、卒業したくなったときのための
ランバックがあります。

- **[docs/github-app-runbook.md](github-app-runbook.md)** — agentflow に独自の
  GitHub アイデンティティを与え、G3 を `native-review` にします。エージェントの
  フィードバックが、あなたのものではなく、目に見えてエージェントのものになります。
  （現時点で英語のみ）
- **[docs/headless-runbook.md](headless-runbook.md)** — GitHub のイベントに、
  あなた自身の Claude Code セッションではなく、ランナー上でエージェントを起動させ
  ます。課金は、従量制の API クレジットではなく、あなたの Claude サブスクリプション
  に対して行われます。（現時点で英語のみ）
