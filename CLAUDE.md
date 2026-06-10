# 架装品売上レポート Web版 — Claude Code 開発ガイド

Claude Code が自動で読むプロジェクト設定。配下Webアプリの実装・改修方針。
<!-- 3兄弟（メンテ実績/架装品500/本作）の共通DNAは skill「社内データ可視化アプリ共通規約」に集約候補 -->

---

## プロジェクト概要

架装品売上データの可視化・分析 Webアプリ。GAS API または `public/data/master_data.csv`
からデータ取得し、ピボット集計・ドリルダウン・伝票別利益分析を行う。

**ビュー:** 分析ダッシュボード / 一括網羅レポート / 品番検索レポート / 粗利収支分析（InvoiceReportView）
**ダッシュ検索:** 顧客検索（複数選択→合算実績）/ 品番検索（複数選択→クロスカット）

---

## 技術スタック

React 18 + Vite 6 + TailwindCSS 3 + lucide-react / データ: GAS API or master_data.csv /
キャッシュ: IndexedDB / **デプロイ: Cloudflare Workers (wrangler)** / **カラー: blue**（500版=red）

---

## 粗利収支分析ビュー（InvoiceReportView）※コードは App.jsx 参照

### 2段階設計（パフォーマンスの核心）
App側で `allInvoices`（rawData変更時のみ集計。60万行→数千件）を作り、ビューには集計済みを渡す。
- **YOU MUST NOT** `filteredRows`（60万行）をビューに渡さない。毎フィルタで再集計しフリーズする。
- 設計意図: 1伝票=複数品目行を `documentNumber` でグループ化し sales/profit 合算 → 案件単位の採算。

### フィルタ連鎖（この順序で useMemo）
年月 → リース会社 → 支店 → 担当者・顧客名・粗利率 → ソート → ページネーション(100件/頁)
- **YOU MUST** フィルタ変更時は必ず `setPage(0)` / `resetPage()`。
- **連動リセット**: リース変更で支店・担当者を `'ALL'` に / 支店変更で担当者を `'ALL'` に。
- **粗利率フィルタ**: `10`→10%以下 / `0`→赤字のみ / `-1`→大幅赤字のみ。
- **年月**: 年の選択肢は `allInvoices` の date から動的生成（固定値にしない）。デフォルトは会計年度（開始月4／終了月3、終了年=最新年）。

### CSV出力
`sortedInvoices`（フィルタ・ソート済み全件）を出力。**ページネーションに関係なく全件**。

### UI
サマリー4カード（伝票件数=青 / 売上 / 粗利 / 平均粗利率。モバイル `grid-cols-2`）。
テーブル=ヘッダー固定(slate)・全カラムソート・赤字ピンク背景・粗利率<10%オレンジバッジ。
**YOU MUST** `viewMode === 'invoice_report'` 時はメインのフィルタパネル（リース/期間/金額単位/粗利表示/顧客検索）を全非表示。

---

## ダッシュボード複数選択UI

### 二相選択（顧客・品番共通）
`pending`（チェック中）→「表示」ボタン→ `confirmed`（確定・反映）の2段階。
confirmed が変わって初めて `currentTableData` 再計算。表示ボタンで pending と検索ワードをクリア。

### 複数顧客モード（センチネル `__MULTI_CUSTOMER__`）
- 判定: `activeView.branchName === '__MULTI_CUSTOMER__'`。`isLeafLevel` を強制 `true` にしてドリル無効化。
- **YOU MUST** センチネルは `__` で囲み、実在の部店名と衝突させない。

### 品番クロスカット
- `selectedProductCodes`（`string[]`、空=フィルタなし）。`hierarchyOrder` は変えない（表示モード維持のまま品番絞り）。
- 集計は `baseRows`（選択品番でフィルタ済み）経由。`filteredRows` を直接使わない。

---

## GOTCHA（消すとミスする罠）

- **型安全（Number変換）** `csvLoader.js` は数値文字列を `Number` 化するため `productCode`/`productName`
  が数値になりうる。**文字列操作（`.replace`/`for...of` 等）の前に必ず `String()` キャスト**。新規の文字列関数も同様。
- **levelInfo destructure** `const { branchName, secondName, thirdName } = activeView;` の**3つ全部**を取る。
  `thirdName` を省くと `if(!thirdName)` で ReferenceError → **画面真っ白**。
- **CSVパース（Excel保存対策・必須2点）**
  - BOM除去: 先頭文字が `0xFEFF` なら `slice(1)`（放置で先頭列名 undefined）
  - ヘッダーtrim: 列名も `.map(h => h.trim())`（放置で `branch\r` → 全行 `(未分類)`）
- **伝票番号の列名ゆらぎ** CSVヘッダーは `Documentnumber`（大文字N）。集計時は `r.Documentnumber || r.documentNumber` で両参照。

---

## よくある作業（要点のみ）

- **フィルタ追加**: state追加 → 選択肢を useMemo 生成（連動なら上層フィルタ後データから）→ `filteredInvoices` に条件 → UI追加 → 変更時 `resetPage()`。
- **デフォルト年月変更**: `InvoiceReportView` の `defaultStartYear`/`defaultEndYear`/`startMonth`/`endMonth`。

---

## コマンドリファレンス

```bash
npm run dev      # 開発サーバー（localhost:5173）
npm run build    # ビルド
npm run preview  # ビルド確認
npm run deploy   # Cloudflare Workers へデプロイ（wrangler）
```

<!-- 要検討: ALL判定が 'ALL' 文字列。メンテ実績は Set.size===0。方針統一するか決める / React版(18) も500版(19)と要すり合わせ -->