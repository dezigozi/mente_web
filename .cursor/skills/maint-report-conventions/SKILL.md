# メンテ実績レポート — 実装規約（Agent Skill）

Cursor / Claude がこの **WEB サブディレクトリ**を編集するときに従う。詳細は同梱の `CLAUDE.md` を正とする。

## 必読

- リポジトリルート相当: `WEB/`（`git` はここにいる）
- 規約の全文: `WEB/CLAUDE.md`（技術スタック・データフロー・禁止事項）

## 要約（よく触る箇所）

- **分割禁止**: コンポーネントは `src/App.jsx` に集約。`utils/` は純粋関数、`aggregator.js` に React を import しない。
- **分析名**: `ALLOWED_ITEMS` はファイル先頭1箇所。比較は `norm()`。ダッシュ用は `ALLOWED_ITEM_NORM_SET` パターン可。
- **大規模 rows**: `rawData.rows` を**同条件で二重全件走査**しない。月は `filterRowsInMonthRange` 1本 → `rowsInMonth`、以降は `Set` でリース/得意先。パターンB専用導出は `viewMode==='B'` のときだけ。粗利 `allProductMonthly` は `reportMode==='margin'` のときだけ。
- **UI 負荷**: 候補DOMは件数上限（`B_FACTORY_CHECKBOX_CAP`）。重い再描画は `startTransition` / `memo`（入力 onChange には使わない）。
- **キャッシュ**: `App.jsx` の `CACHE_KEY` を変更したら CLAUDE.md のキャッシュ節も更新。

## コミット

- ブランチ: `master`
- Conventional Commits: `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` 等
- コミット本文は「何を・なぜ」が分かる日本語または英語でよい
