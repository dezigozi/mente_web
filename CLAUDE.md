# メンテ実績レポート（mente_web）

メンテ受注データの可視化 Web アプリ。React 18 + Vite 6 + TailwindCSS 3 + lucide-react、テストは vitest。
共通の実装規約は skill「shanai-dataviz-conventions」。

## データ
- `public/data/master_data.csv` … takanoyou_data_bunseki の master_data「メンテ」→「WEBに反映」で更新・push される（手で編集しない）
- 読み込みは Web Worker（`csvWorker.js` / `csvParse.js`）＋ IndexedDB キャッシュ（ETag 条件付き GET）
- `npm run build` の前に `scripts/bundle-master-csv.mjs`（prebuild）が走る

## 画面と主なファイル
- 本体はほぼ `src/App.jsx`。集計 `utils/aggregator.js`、リース会社レポート `utils/leaseReport.js`
- 期間指定の初期値は「開いた日の月〜11か月後」（データ最終月ではない）。年度の列は開始月で付け替え
- NCS訪問管理: `utils/ncsTarget.js`（抽出・成果判定の純関数）、`utils/visitStore.js` ＋ `gas/ncs_visit.gs`（共有保存）
  - **GAS は単独プロジェクト「NCS訪問管理」。Sales Pro の Code.gs には絶対に足さない**（doGet/doPost が衝突して止まる）
  - URL は `src/config/ncsShare.js`。GAS を直したら「デプロイを管理」→新バージョン（URL維持）

## コマンド
```bash
npm run dev      # 開発サーバー
npm run build    # ビルド（prebuild で CSV 同梱）
npm test         # vitest
```
デプロイは Vercel（menteweb-eta.vercel.app）。
