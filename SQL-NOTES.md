# Tally の SQLite モード（Windows・任意）

**普段の家計簿をSQLiteファイルで管理したいときは、展開したフォルダーの [Start-SQLite.cmd](<Start-SQLite.cmd>) を起動してください。** PC内のブラウザで操作し、取引・月間予算・貯蓄目標・追加カテゴリ・カテゴリ色・自動分類ルールをローカルDBに保存します。Python 3.8以上（同梱SQLite 3.25以上）が必要です。`pip install`、CDN、クラウドアカウントは不要です。

| 起動方法 | 保存先・用途 |
|---|---|
| [アプリ単体](<index.html>) を直接開く | 従来どおりブラウザ内に保存。インストール不要。ブラウザ単体版の分析はネイティブJavaScriptであり、ブラウザ内SQLiteではありません。 |
| [Start-SQLite.cmd](<Start-SQLite.cmd>) | Windows上のSQLite。既定URLは `http://127.0.0.1:8766/`、既定DBは `%LOCALAPPDATA%\Tally\ledger.sqlite3`。同じPCで同じDBを開けば、EdgeとChromeから同じ記録を参照できます。 |
| [分析用CLI](<vendor/tally_sql.py>) | JSONバックアップをローカルで分析。既定ではメモリ内SQLiteのみ。日常用DBにもブラウザ保存領域にも接続しません。 |

## はじめる・移行する・更新する

1. ZIPは **すべて展開** します。SQLiteモードでは [アプリ](<index.html>)・[サーバー](<tally_db.py>)・[ブラウザ接続部](<sqlite-client.js>)・[共通モジュール](<vendor/tally_sql.py>) の相対配置を変えないでください。
2. [Start-SQLite.cmd](<Start-SQLite.cmd>) を開きます。黒い画面に出たURLを使います。初回は「自分の家計簿」を表示します。架空のサンプルを試すときだけ「設定」→「表示データ」→「デモデータ」を選びます。PCで使うだけならファイアウォールにLAN用の受信例外を作る必要はありません。
3. 既存ブラウザ版から移す場合：**従来の同じブラウザ・同じ場所**で「自分の家計簿」→「データ管理」からJSONを保存します。SQLite版でも「自分の家計簿」に切り替え、データ管理からJSONを選んで復元します。復元はマージでなく全体置換です。移行先にデータがあれば先にバックアップしてください。ブラウザの記録は自動移動・消去しません。
4. 使用中は起動ウィンドウを開いたままにします。終了は `Ctrl+C`。複数タブで同じ記録を同時編集し、競合メッセージが出た場合は **再読み込み後に変更をやり直します**。競合を無視した上書きはしません。
5. 更新前にはSQLite版からJSONを保存してください。次に、サーバーを止めてから新しい配布物を別フォルダーへ展開し、新しいランチャーを起動します。**アプリの展開先とDB保存先は別**です。初期化のつもりでDBファイルを削除しないでください。既存TallyのDBスキーマv1・v2は、初回の起動時にv3へ自動移行します。取引・照合キー・予算・目標・既存の色やルール・リビジョンは書き換えず、不足する設定テーブル（v3で追加した `custom_categories` を含む）を1トランザクションで追加します。移行失敗時は途中の変更も元に戻します。未対応バージョン・別用途のSQLiteは初期化しません。移行後のDBを古いサーバーでは開かないでください。生DBをコピーする場合も、先にすべてのSQLiteモード・DBツールを閉じてください。

**プライバシーと制限：** サーバーは `127.0.0.1` だけで待ち受け、同じホスト・オリジンからのリクエストを確認します。CORS・LAN配信・ディレクトリ一覧・DBファイルのHTTP配布はありません。取引はログに出しません。他の端末への自動同期もなく、AndroidのWi-Fi表示とは別モードです。HTTPはループバック専用で、端末上のプログラムに対する認証機能や暗号化ではありません。DB・JSON・CSVは個人情報を含む平文です。Windowsのユーザー・ディスク保護を利用し、バックアップの共有先にご注意ください。

### ポート変更・試験用DB

```powershell
py -3 -B tally_db.py --port 8767
# 下記は明示的に独立した試験用DBを使用。0は空きポートを選択。通常のDBには触れない。
py -3 -B tally_db.py --db ".\test-data\trial.sqlite3" --port 0 --no-browser
```

既定ポートが使用中なら、起動済みのTallyウィンドウを確認するか `--port` を変更してください。`--db` を変えない限りポートを変えても実データの保存先は同じです。

## JSONバックアップをSQLで分析・書き出しする（任意のCLI）

[分析用CLI](<vendor/tally_sql.py>) はTallyのv1/v2/v3/v4 JSONバックアップ（UTF-8、16 MiB以下）を**読み取り専用**で開きます。Excel用CSV、PayPayのCSV、ブラウザ保存領域は入力ではありません。日時は取引の日付文字列をそのまま使い、時差変換はしません。期間指定は任意、開始日・終了日の **両端を含みます**。

```powershell
# 例：2月の食費の高額明細上位3件。カテゴリを省略すると各カテゴリで上位3件。
py -3 vendor/tally_sql.py "家計簿バックアップ.json" --period-start 2024-02-01 --period-end 2024-02-29 --category 食費 --top 3
# 月別収入・支出・振替・差額。全種別の収支には --type all を指定。
py -3 vendor/tally_sql.py "家計簿バックアップ.json" --report monthly --type all
# カテゴリ別に、取引名ごとに合算した利用額上位3件をCSV保存。
py -3 vendor/tally_sql.py "家計簿バックアップ.json" --report merchants --top 3 --format csv --output "利用額上位.csv"
# 分析用SQLiteのスナップショットと、別途カテゴリ合計レポートを書き出す。
py -3 vendor/tally_sql.py "家計簿バックアップ.json" --export-db "分析用.sqlite" --report categories --output "支出集計.json"
```

- `--report top`（既定）：種別・カテゴリ内で明細を金額降順→日付降順→ID昇順に並べて `ROW_NUMBER()` で上位N件を抽出します。**全体の上位N件**ではありません。
- `--report merchants`：同じ種別・カテゴリ・取引名の合計を算出し、合計降順→取引名昇順でランキング。取引名は店舗IDではありません。表記の違う店舗名・手入力名は別々に扱います。
- `--report categories`：選択した期間内の種別・カテゴリごとの合計と件数。`--report monthly`：月別の収入・支出・振替・収支・件数。**収支は収入−支出で、振替を計上しません**。データがない月は出力しません。
- `--type` は `expense`（既定）/ `income` / `transfer` / `all`。`--category` はカテゴリ名完全一致。`--top` は1〜1000、既定5（`top`・`merchants`のみ）。SQL文を入力する機能はなく、条件値はすべてバインドパラメーターです。
- `--format json`（既定）または `csv`（UTF-8 BOM付き）。`--output` がなければレポートを標準出力に表示します。CSVでは表計算ソフトで数式になり得る**文字列**の先頭をエスケープします。元のバックアップやDB内の文字列は変えません。
- **`--export-db` はフィルターに関係なく全期間の全取引と予算を書き出します。** 分析投影のみで、貯蓄目標、追加カテゴリの登録リスト、色、ルール、CSVの照合キー等は含めません。取引・予算が参照するカテゴリ名は残します。DB復元用バックアップの代わりにはなりません。出力に既存ファイルは指定できません。匿名化・暗号化はありません。

### SQLiteビュー・トランザクション

日常用DBには `transactions`、`budgets`、`goals`、`category_colors`、`category_rules`、`custom_categories`、`meta` を格納します。アプリの1回の保存は、`BEGIN IMMEDIATE` と現在のリビジョン比較を含む単一のSQLiteトランザクションです。失敗すれば行・予算・目標・追加カテゴリ・色・ルール・リビジョンをまとめてロールバックします。日付、種別＋日付、カテゴリ＋日付のインデックスを使用できます。日常用DBを外部ツールから直接書き換えるとリビジョン管理を無効化してしまうため、**分析は書き出した別DBで**行ってください。

[分析用CLI](<vendor/tally_sql.py>)は入力の検証後、メモリ内DBに一括インポートし、`query_only` を有効化します。こちらも実際のSQLiteで次のように参照できます。

```sql
SELECT month, income, expense, transfer, net FROM v_monthly_cashflow ORDER BY month;
SELECT month, type, category, total, count FROM v_monthly_categories ORDER BY month, type, total DESC;
SELECT date, category, title, amount, signed_amount FROM v_ledger ORDER BY date DESC, id;
```

## 開発・組み込み（通常の利用には不要）

- SQLライブラリのビルド、npm・pipは不要です。**ブラウザ単体HTMLへ [sqlite-client.js](<sqlite-client.js>) をバンドルしません**。親アプリの通常のビルドで [index.html](<index.html>) を生成した後、[SQLiteサーバー](<tally_db.py>) が配信時に `</head>` の直前に同一オリジンの専用スクリプトを追加します。DBモード用ファイルを単体HTMLの代わりに直接開かないでください。サーバーは起動時のHTML・クライアントを保持するので、再ビルド後は再起動・再読み込みしてください。
- [専用スクリプト](<sqlite-client.js>) はSQLite版でのみ `window.TallyDB` を定義します。いずれも**同期API**です。DBへのアクセスはローカルHTTP経由で、CDN/WASM/遠隔サーバーを使いません。

```js
const {state, revision} = TallyDB.read(); // state: {rows, budgets, goals, colors, rules, customCategories}
const next = TallyDB.save(nextState, revision); // 新しいrevision。競合は error.status === 409
const topRows = TallyDB.queryTop('2024-02-01', '2024-02-29', 3, '食費');
const periodRows = TallyDB.queryPeriod('2024-02-01', '2024-02-29', '');
```

`rows` は `id,date,type,amount,category,title,source` と任意の `key`、`budgets` はカテゴリ→正整数（円）、`goals` は `{id,title,target,saved}` 配列（`saved` は未指定なら0）。`read()`は保存順を保持します。`queryTop(start,end,limit=5,category='')` は支出のみをカテゴリ別にSQLで順位付けして、元の行オブジェクトをカテゴリ昇順→順位順で返します。`queryPeriod(start,end,category='')` は全種別を日付降順→ID昇順で返します。直前の `read()` / `save()` からDBのリビジョンが変わった場合は、分析も `409` で失敗します。**古いスナップショットで自動再試行せず、再読み込みしてください。** デモデータをこれらの書き込み・分析APIに渡さず、デモの分析にはデモ内データだけを使います。

`colors` は既存の収入・支出・振替カテゴリ名をキー、`#` と6桁の16進数字を値とする上書き指定です。`rules` は最大500件の順序付き配列です。各要素は `{prefix, type, category}` で、`type` は `income` または `expense`、`category` はその種別の既存カテゴリ名です。接頭辞の前後の空白は除去し、残りの文字の表記と順番は保持します。同じ種別で NFKC・小文字化・トリム後の接頭辞が重なる設定は拒否します。空文字は不可、接頭辞の上限は150 UTF-16コード単位です。分類ルールの適用により明細をまとめて変更する場合も、行と設定を `save(nextState, revision)` で一緒に渡し、1回のリビジョンで確定させます。

新規DBまたは移行直後の `colors` と `rules` は `{}` と `[]` です。旧クライアントとの互換性のため、保存時に `goals`・`colors`・`rules`・`customCategories` のキーを**省略すると、その項目は変更されません**。初期化したいとき（古いバックアップへの明示的な全置換を含む）は、該当キーに `[]` / `{}` を明示してください。追加カテゴリの初期値は `{expense:[], income:[]}` です。`null` は無効です。DBスキーマ（v3）とJSONバックアップ形式（v4）は別のバージョン番号です。

JSON v4の任意フィールド `viewSettings`（表示設定の形式はv1）は、HTML版・SQLite版の間でも引き継げます。表示月・ホームや分析の条件・面積図のサイズはブラウザ側で適用し、SQLiteの台帳スキーマや照合用キーを変更しません。分析用CLIは従来どおり取引・予算だけを抽出します。

### 追加カテゴリ（v4 JSON）

`customCategories` は `{expense: ["旅行", "ペット"], income: ["配当"]}` のような、支出と収入それぞれ最大100件の登録リストです。各種別内での表示順を保持します。振替には作成できません。カテゴリ名は NFKC 正規化・前後の空白除去後に 1〜32 UTF-16 コード単位で、収入・支出・振替を横断し、組み込み名を含めた重複（英字の大文字小文字・全角半角の違いも含む）を拒否します。制御・不可視書式文字、HTMLマークアップ用記号、JavaScriptオブジェクトの予約名等は使用できません。参照は正規化後の登録名と完全一致させてください。

- 通常の保存で追加カテゴリを省略すると、現在の登録を引き継ぎます。リストを明示的に減らすときは、新しい取引・予算、およびそのまま残る色・分類ルールが削除対象を参照していないことをサーバーで検証します。参照があれば、変更全体がロールバックされます。
- `rows` / `rules` は種別ごとの登録カテゴリ、`budgets` は支出カテゴリ、`colors` は登録名の範囲に制限されます。CLIはv4の登録リストを検証したうえで分析用の取引・予算だけを抽出します。v1〜v3の分析投影は従来どおり読み取り可能です。
- ブラウザ側の `TallyPrefs.customCategories(raw)` は検証済みの新しいリストを返します。引数を省略すると空、明示時は支出・収入の両配列を指定します。`categoryList(type, custom)` は組み込み＋追加カテゴリ、`defaultColor(name)` は組み込みの既定色または追加名から決まる安定した16進色です。`colors(raw, custom)`・`rules(raw, custom)`・`upsertRule(old, rule, custom)` は同じリストを参照します。組み込みの定義自体は変更されません。

配信は許可されたページ・専用スクリプト・3つのAPIに限定されます。レスポンスは `no-store`、インラインスクリプトのCSPハッシュは配信するHTMLから計算します。DBモード以外のCSP・保存方式は変更しません。

- **テスト：** `node tests/sql-cli.cjs`（Windowsでは `py -3`、ほかでは `python3` を使用。別環境は環境変数 `TALLY_PYTHON` にPythonの実行ファイルを指定）。[テスト](<tests/sql-cli.cjs>) は `tests/` 内の一時フォルダー・架空データ・ループバックの空きポートを使い、ユーザーの既定DBを開きません。DBスキーマv1・v2→v3移行・JSON v1/v2/v3/v4入力・期間境界・カテゴリ別順位・ビュー・インデックス・CSV出力・衝突時の保持・旧クライアントからの変更時の設定保持・DB再接続・移行/一括保存途中のロールバック・HTTPアクセス制御を検証します。
- **依存関係・ライセンス：** 利用するSQLエンジンはインストール済みPython標準の `sqlite3`（[Python公式](https://docs.python.org/3/library/sqlite3.html)、[SQLiteのライセンス](https://sqlite.org/copyright.html)）です。第三者のSQLiteバイナリやsql.jsは同梱していません。[npm公式レジストリでsql.js 1.14.1のメタデータ](https://registry.npmjs.org/sql.js/1.14.1)は確認しましたが、この作業環境では配布アーカイブを取得して照合できなかったため採用していません。[vendor内のモジュール](<vendor/tally_sql.py>)はこのアプリ用のPythonソースであり、未検証の外部エンジンや独自SQLパーサーではありません。
