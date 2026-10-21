/**
 * NCS訪問管理の共有保存先（gas/ncs_visit.gs をウェブアプリとしてデプロイした /exec の URL）
 * 空のときはブラウザ内（IndexedDB）だけに保存する。
 * URL が公開されても、読み書きには共有キー（各自が画面で1回入力）が要る。
 */
export const NCS_GAS_URL = import.meta.env.VITE_NCS_GAS_URL || '';
