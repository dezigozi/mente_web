# メンテ実績レポート（mente_web）

架装品メンテナンスの実績データを可視化・分析する社内向け Web アプリ。  
React + Vite + Tailwind CSS で構築し、CSV をデータソースとしてブラウザ上で完結する。  
Vercel にデプロイ済み：[menteweb-eta.vercel.app](https://menteweb-eta.vercel.app)

---

## 主な機能

### 分析ダッシュボード
| 機能 | 説明 |
|---|---|
| ドリルダウン | リース会社 → 分類 → 品番 の 3 段階ドリルダウン |
| 表示パターン切替 | リース→分類→品番 / リース→工場→分類→品番 |
| リース会社絞り込み | ボタン選択で特定会社のみ表示 |
| 期間フィルター | 月単位で開始〜終了を指定 |
| 金額単位切替 | 円 / 千円 |
| 粗利表示 ON/OFF | 粗利列の表示・非表示 |
| 年次比較 | 受注数・粗利を年度別に並べて前年比（YoY）表示 |
| チェック選択合計 | 行をチェックして集計対象を任意に絞れる |
| CSV / PDF 出力 | 現在の表示内容をエクスポート |
| 対象分析名 | オルタネーター・スターター・コンプレッサー・エアコン関連の 4 分類のみ |

### 粗利収支分析
| 機能 | 説明 |
|---|---|
| 期間フィルター（年月） | カレンダー年月（例：2025年12月〜2026年3月）で範囲指定 |
| リース会社 複数選択 | 複数社を同時選択可能 |
| 分析名 複数選択 | 4 分類を任意に複数選択可能 |
| 品番検索 | 品番または分析名でテキスト絞り込み |
| 粗利率フィルター | 「粗利率○%以下」で損失・低利品番を抽出 |
| 売上単価 / 粗利単価 | 1個あたりの売上・粗利を自動計算して表示 |
| ソート | 全列クリックでソート（昇降切替） |
| CSV 出力 | フィルター・ソート済み状態をそのまま出力 |
| 商品名表示 | 品番に紐づく商品名を列表示 |

### 共通
- **IndexedDB キャッシュ**：前回取得データをキャッシュしてオフラインでも表示
- **パスワード認証**：`VITE_PASSWORD` 環境変数で保護（任意）
- **半角・全角の区別なし**：分析名フィルターは NFKC 正規化で表記ゆれを吸収

---

## 動作環境

| 項目 | バージョン |
|---|---|
| Node.js | 18 以上 |
| React | 18.x |
| Vite | 6.x |
| Tailwind CSS | 3.x |
| ブラウザ | Chrome / Edge / Safari（IndexedDB 対応必須） |

---

## セットアップ

```bash
# 1. リポジトリをクローン
git clone https://github.com/dezigozi/mente_web.git
cd mente_web

# 2. 依存パッケージをインストール
npm install

# 3. データファイルを配置
#    public/data/master_data.csv に元データを置く
#    （列フォーマットは下記「CSVフォーマット」参照）

# 4. 環境変数を設定（任意）
echo "VITE_PASSWORD=yourpassword" > .env

# 5. 開発サーバー起動
npm run dev
# → http://localhost:5173
```

---

## 使い方

### 開発
```bash
npm run dev       # 開発サーバー起動（ホットリロード）
npm run build     # 本番ビルド（dist/ に出力）
npm run preview   # ビルド成果物をプレビュー
```

### AI / 実装ルール（Cursor・Claude）
- エージェント向けの規約はリポジトリ直下の [`CLAUDE.md`](./CLAUDE.md) を参照（データフロー・不要な全件走査の禁止・デザイン等）
- Cursor Skill 要約: [`.cursor/skills/maint-report-conventions/SKILL.md`](./.cursor/skills/maint-report-conventions/SKILL.md)

### マスターデータ更新（Windows）
`マスタデータ更新.bat` を実行すると `public/data/master_data.csv` を上書きコピーする。  
Mac の場合は手動で CSV を差し替えてから「最新データに更新」ボタンを押す。

### Vercel デプロイ
```bash
# Vercel CLI でデプロイ
npx vercel --prod

# または GitHub 連携で master ブランチへの push で自動デプロイ
```
`VITE_PASSWORD` は Vercel の Environment Variables に設定する。

---

## CSV フォーマット

`public/data/master_data.csv` は以下の列を持つ日本語ヘッダーの CSV。  
不足列は自動的にスキップされる（列名マッピング方式）。

| 列名 | 内容 | フィールド名 |
|---|---|---|
| 納品日 | YYYY-MM-DD 形式 or Excel シリアル値 | `date` / `fiscalYear` / `month` |
| 宅配先電話番号 | 部店正規化キー | `branch`（正規化用） |
| 送り先名 | 部店名 | `branch` |
| 品番 | 商品コード | `productCode` |
| 商品名 | 商品名称 | `productName` |
| 分析名(大) | オルタネーター 等 | `item` |
| 単価 | 単価（円） | 売上計算用 |
| 数量 | 受注数 | `quantity` |
| 粗利 | 粗利（円） | `profit` |
| メンテ | リース会社名 | `leaseCompany` |

---

## ディレクトリ構成

```
mente_web/
├── public/
│   └── data/
│       └── master_data.csv   # データソース（.gitignore 対象外）
├── src/
│   ├── App.jsx               # メインコンポーネント（全画面・ロジック）
│   ├── index.css             # Tailwind ベーススタイル
│   ├── main.jsx              # エントリポイント
│   └── utils/
│       ├── aggregator.js     # 集計・ピボット関数
│       ├── csvLoader.js      # CSV 読み込み・パース
│       ├── jpPrefecture.js  # 住所1から都道府県推定
│       └── db.js             # IndexedDB キャッシュ
├── CLAUDE.md                 # AI 向け実装ルール
├── .cursor/skills/           # Cursor Agent Skill（上記要約）
├── index.html
├── package.json
├── tailwind.config.js
├── vite.config.js
└── マスタデータ更新.bat      # Windows 用データ更新スクリプト
```

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 画面にデータが出ない | `public/data/master_data.csv` の存在・列名を確認 |
| 古いデータが表示される | 「最新データに更新」ボタンでキャッシュをクリア |
| 分析名が表示されない | CSV の `分析名(大)` 列の表記を確認（半角・全角どちらも可） |
| ビルドエラー | `npm install` を再実行後に `npm run build` |

---

## ライセンス

社内限定アプリケーション。外部公開・再配布不可。
