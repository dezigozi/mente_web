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
    └── db.js          # IndexedDB 操作専用
```

- コンポーネントは **App.jsx 1 ファイルにまとめる**（小規模のため分割不要）
- `utils/` は副作用なしの純粋関数のみ。React の import 禁止

---

## データフロー

```
CSV → csvLoader.js → rawData（rows[]）
        ↓
filterRows()        ← 期間・リース会社フィルター
        ↓
dashboardRows       ← ALLOWED_ITEMS で分析名を絞り込み（ダッシュボード用）
        ↓
aggregateBy*()      ← 集計関数（aggregator.js）
        ↓
currentTableData    ← テーブル表示用
```

```
rawData.rows → allProductMonthly（月×リース×品番で事前集計）
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

## 状態管理ルール

- グローバル状態管理ライブラリ（Redux 等）は使わない
- `useState` + `useMemo` + `useCallback` のみで管理
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

- キャッシュキー: `maint_report_data_v1`
- スキーマ変更（フィールド追加など）をした場合は **キャッシュキーのバージョン番号をインクリメント**
  - 例: `maint_report_data_v1` → `maint_report_data_v2`
- キャッシュのライフサイクル管理は `src/utils/db.js` のみで行う

---

## Git / デプロイルール

- ブランチ: `master`（main ではない）
- コミットメッセージ: Conventional Commits 形式
  - `feat:` 新機能
  - `fix:` バグ修正
  - `refactor:` 動作変更なしのリファクタリング
  - `docs:` ドキュメント更新のみ
- `public/data/master_data.csv` はコミット対象（データ更新のたびにコミット）
- `.env` はコミット禁止（`.gitignore` に含める）

---

## やってはいけないこと

- `src/` を `components/` `pages/` 等に分割しない（小規模のため不要）
- Tailwind 以外の CSS フレームワーク（Bootstrap 等）を追加しない
- サーバーサイドロジックを追加しない（完全クライアントサイド）
- `aggregator.js` に React の `import` を追加しない
- `ALLOWED_ITEMS` を複数箇所で定義しない（ファイル先頭の 1 箇所のみ）
- フィルターの "すべて" を `'ALL'` 文字列で判定しない（`Set.size === 0` パターンを使う）
