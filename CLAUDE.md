# CLAUDE.md — メンテ実績レポート 実装ルール

このファイルは AI エージェント（Cursor / Claude）がこのリポジトリを編集する際に  
**必ず従う実装規約**を記述する。変更・追加は必ずこのファイルも更新すること。

---

## 技術スタック（変更禁止）

| 役割 | 採用技術 |
|---|---|
| UI フレームワーク | React 18（関数コンポーネント + Hooks） |
| ビルドツール | Vite 6 |
| スタイリング | Tailwind CSS 3（クラス直書き、外部 CSS 最小化） |
| アイコン | lucide-react |
| キャッシュ | IndexedDB（`src/utils/db.js`） |
| データソース | CSV（`public/data/master_data.csv`） |
| デプロイ | Vercel |

**ライブラリ追加前**に必ず確認。追加する場合は README の「動作環境」も更新する。

---

## ファイル構成ルール

```
src/
├── App.jsx          # 全コンポーネントをここに集約（分割しない）
└── utils/
    ├── aggregator.js  # 純粋関数のみ。副作用・状態を持たない
    ├── csvLoader.js   # CSV パース専用。UI ロジックを混入しない
    ├── jpPrefecture.js  # 住所1から都道府県推定（正規化・代表表記用）
    └── db.js          # IndexedDB 操作専用
```

- コンポーネントは **App.jsx 1 ファイルにまとめる**（小規模のため分割不要）
- `utils/` は副作用なしの純粋関数のみ。React の import 禁止

---

## データフロー

### 分析ダッシュボード（大規模データ前提）

`rawData.rows` を**同条件で二重に全件走査しない**こと。会計月は1回 `filterRowsInMonthRange`（`aggregator.js`）にかけ、得た `rowsInMonth` に対してリース・得意先は `Set` で OR 条件を当てる。`filterRows()` による「月＋リース＋得意先」の直列利用は、**同じ操作で二周目の全件走査を生む**ため、ダッシュ用導出では避ける（CSV エクスポート等の一発処理では従来どおり `filterRows` 可）。

```
CSV → csvLoader.js → rawData（rows[]）
        ↓
rowsInMonth         ← filterRowsInMonthRange（月範囲だけ・全行1周）
        ↓
filteredRows        ← リース・得意先（Set。rowsInMonth 上を追加周回のみ）
        ↓
dashboardRows       ← ALLOWED_ITEM_NORM_SET＋norm（分析名。ダッシュ用）
        ↓
パターンB 時だけ    ← 工場名候補・電話/都道府県サジェスト（viewMode==='B' ガード）
        ↓
aggregateBy*()      ← 集計関数（aggregator.js）
        ↓
currentTableData    ← テーブル表示用
```

### 粗利収支分析

`allProductMonthly` は **reportMode==='margin'（粗利タブ）のときだけ** `rawData.rows` を畳み込む。ダッシュ表示中に毎回作らない（切替の体感を悪化させないため）。

```
rawData.rows → allProductMonthly（月×リース×品番。粗利タブ表示時のみ構築）
        ↓
ProductMarginView 内で期間・リース・分析名・検索・粗利率で絞り込み
        ↓
sorted              ← テーブル表示・CSV 出力用
```

---

## 分析名フィルタリング（重要）

### 対象分析名（ALLOWED_ITEMS）
```js
const ALLOWED_ITEMS = ['オルタネーター', 'スターター', 'コンプレッサー', 'エアコン関連'];
```

- **ダッシュボード・粗利収支分析の両方**に適用する
- `ALLOWED_ITEMS` はファイル先頭（App コンポーネントの外）に定義する
- 変更する場合はこの定数 **1 箇所だけ** 変えれば両画面に反映される

### 半角・全角の正規化
```js
const norm = s => (s || '').normalize('NFKC').trim();
```

- NFKC 正規化で半角カナ→全角カナ、全角英数→半角英数 に統一
- `ALLOWED_ITEMS` との比較・フィルタリングには必ず `norm()` を使う

---

## カレンダー年変換（会計年度 → カレンダー年）

```js
const toCalYear = (fy, m) => m <= 3 ? fy + 1 : fy;
```

- 会計年度は **4月始まり** を前提
- 月 1〜3 は翌カレンダー年として扱う（例：FY2025の3月 = 2026年3月）
- 粗利収支分析の期間フィルターはカレンダー年月ベースで計算する

---

## CSV 列マッピング（csvLoader.js）

列名が変わった場合は `csvLoader.js` の `COL_*` 定数を修正する。  
**インデックスのハードコードより列名ルックアップを優先**（列順変更に強い）。

```js
const COL_DATE   = idx['納品日']        ?? 1;
const COL_PHONE  = idx['宅配先電話番号'] ?? 10;
const COL_BRANCH = idx['送り先名']      ?? 11;
const COL_CODE   = idx['品番']          ?? 30;
const COL_NAME   = idx['商品名']        ?? 31;
const COL_ITEM   = idx['分析名(大)']    ?? 32;
const COL_PRICE  = idx['単価']          ?? 38;
const COL_QTY    = idx['数量']          ?? 39;
const COL_PROFIT = idx['粗利']          ?? 40;
const COL_LEASE  = idx['メンテ']        ?? 41;
```

新しい列を追加した場合は：
1. `csvLoader.js` に `COL_*` 定数を追加
2. `rows.push({...})` にフィールドを追加
3. `allProductMonthly`（App.jsx）の map にも追加
4. `aggregated`（ProductMarginView）の map にも追加

---

## パフォーマンス（必須）

- **同じフィルタ条件**で `rawData.rows` を**二度**全件 `filter` / `filterRows` しない。月は `rowsInMonth` 1本に寄せ、得意先候補もその配列を流用する。
- パターンB専用（工場名チェック候補・サジェスト）は `viewMode === 'B'` の `useMemo` 内に閉じる。パターンAの操作的に無駄な導出を走らせない。
- 粗利タブ集計 `allProductMonthly` は `reportMode === 'margin'` のときだけ作る。ダッシュ操作中に全行畳み込まない。
- 工場名ドロップダウン等、候補が極端に多い **DOM 一覧は件数に上限**を付け、超過分は検索誘導。定数: `B_FACTORY_CHECKBOX_CAP`（500）。
- 絞り込み・表示切替に伴い重い子ツリーが再描画されやすい箇所は、必要に応じて `startTransition` または `React.memo` を使う（**入力中の onChange には使わない**＝打鍵遅延の原因）。

---

## 状態管理ルール

- グローバル状態管理ライブラリ（Redux 等）は使わない
- `useState` + `useMemo` + `useCallback` + `useTransition` + `React.memo` で足りる範囲に留める
- フィルター状態は各ビューコンポーネント内にローカルに持つ
- 複数選択フィルターは `Set` を使う（`new Set()` = 全選択）

```js
// 複数選択の実装パターン
const [selectedItems, setSelectedItems] = useState(new Set()); // 空=すべて

// トグル
setSelectedItems(prev => {
  const next = new Set(prev);
  active ? next.delete(item) : next.add(item);
  return next;
});

// フィルター適用
if (selectedItems.size === 0) return allData;  // 空なら全件
return allData.filter(r => selectedItems.has(r.field));
```

---

## デザインシステム

### カラー
- **プライマリ**: `green-900` / `emerald-600`
- **背景**: `slate-50` / `white`
- **テキスト**: `slate-800`（見出し）/ `slate-600`（本文）/ `slate-400`（補助）
- **粗利プラス**: `emerald-600`
- **粗利マイナス**: `rose-600`
- **低粗利率（10%未満）**: `amber-600`

### 共通クラスパターン
```
// フィルターボタン（アクティブ）
bg-emerald-600 text-white shadow-md shadow-emerald-200

// フィルターボタン（非アクティブ）
bg-slate-100 text-slate-500 hover:bg-slate-200

// カード
bg-white rounded-3xl shadow-sm border border-slate-100

// テーブルヘッダー
bg-green-900 text-white font-black

// プライマリボタン
bg-green-900 text-white hover:bg-emerald-600 rounded-3xl font-black
```

---

## キャッシュルール

- キャッシュキー: ソース上の定数 `CACHE_KEY`（例: `maint_report_data_v6`）。`App.jsx` と一致させる
- スキーマ変更（フィールド追加など）をした場合は **App.jsx の `CACHE_KEY` のバージョン番号をインクリメント**し、本節の記述も合わせて更新する
- キャッシュのライフサイクル管理は `src/utils/db.js` のみで行う

---

## Git / デプロイルール

- ブランチ: `master`（main ではない）
- コミットメッセージ: Conventional Commits 形式
  - `feat:` 新機能
  - `fix:` バグ修正
  - `refactor:` 動作変更なしのリファクタリング
  - `docs:` ドキュメント更新のみ
- `public/data/master_data.csv` は**データ置き場として**本リポジトリに含める前提だが、**GitHub の単一ファイル 100MB 制限**を超える場合は、Git LFS の利用・ファイル分割・社内配布からの手動配置のいずれかで運用し、**push が拒否されたらコミットに含めない**（`README` の手動配置手順に従う）
- `.env` はコミット禁止（`.gitignore` に含める）

---

## やってはいけないこと

- `src/` を `components/` `pages/` 等に分割しない（小規模のため不要）
- Tailwind 以外の CSS フレームワーク（Bootstrap 等）を追加しない
- サーバーサイドロジックを追加しない（完全クライアントサイド）
- `aggregator.js` に React の `import` を追加しない
- `ALLOWED_ITEMS` を複数箇所で定義しない（ファイル先頭の 1 箇所のみ）
- フィルターの "すべて" を `'ALL'` 文字列で判定しない（`Set.size === 0` パターンを使う）
