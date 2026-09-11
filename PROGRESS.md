# PROGRESS

## ① いま何を
タブ価格レポートに「登録用Excel」＋「⋯ → 掛率設定」を追加（`src/App.jsx` の `TabPriceView`、`src/utils/tabRegisterXlsx.js`）。
- 未設定品番ごとに OR/NCS/西出/MAL の4行を tab_data 形式（メンテ,品番,メーカーコード,TAB価格,適用日,備考＋分析名,原価）で出力
- TAB価格 = 最新売上行の単位原価 ÷ 掛率（会社×カテゴリ）→ 100円切り上げ。登録済みの会社は既存価格＋備考「登録済み」
- 掛率は localStorage（`tab_price_rates_v1`）に保存、既定値は `TAB_RATE_DEFAULTS`
- CSV→Excel（exceljs 動的import、品番ごと色分け・太罫線・Meiryo UI・登録済みはグレー斜体）。3c3e326 で push 済み
- 粗利単価・粗利率列を追加。コンプレッサーは `tabBaseCode`（最後の "R-" まで）で同系品番を判定し、登録済み同系をグループ末尾にグレーで並べる。同リース会社で価格差があれば備考「要確認」赤字。build 通過・Excel COM 確認済み、未コミット

## ② 次にやること
- ブラウザで実クリック確認 → commit → push → deploy

## ③ ハマり・未解決
- 掛率はブラウザ単位。共有したいなら public/data にJSONで持つ方式へ変更要
- 適用日は出力日固定。登録部署が日付を変える運用なら要相談
