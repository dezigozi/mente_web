/**
 * NCS訪問管理の共有保存先（gas/ncs_visit.gs をウェブアプリとしてデプロイした /exec の URL）
 * 空のときはブラウザ内（IndexedDB）だけに保存する。
 * URL が公開されても、読み書きには共有キー（各自が画面で1回入力）が要る。
 * GAS プロジェクト「NCS訪問管理」（arai.tokuhannbu）。コード修正時は「デプロイを管理」→ 新バージョンで URL を変えずに更新
 */
export const NCS_GAS_URL = import.meta.env.VITE_NCS_GAS_URL
  || 'https://script.google.com/macros/s/AKfycbxAelAWYuw-kCHp-6GXitzZbTdh80cwXwJqbxAU2oS2DrGUv2u8XZTBQ-B7RThd4L9HoA/exec';
