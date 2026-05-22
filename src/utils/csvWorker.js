/**
 * CSV ロード・パース Worker
 *
 * 73MB / 数十万行のCSVをタブレット等の非力なデバイスで処理するため、
 * fetch とパースの両方を Worker スレッドで完結させ、メインスレッド（UI）を
 * 一切ブロックしないようにする。
 *
 * メインスレッドとの通信:
 *  - 受信: { url, etag } — etag があれば条件付きGETで送り、304なら通信短絡
 *  - 送信(進捗): { type: 'progress', message }
 *  - 送信(完了): { ok: true, notModified, result, etag }
 *  - 送信(失敗): { ok: false, error }
 */
import { parseCsv } from './csvParse.js';

self.onmessage = async (e) => {
  const { url, etag } = e.data || {};
  try {
    self.postMessage({ type: 'progress', message: 'サーバーに接続中...' });

    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetch(url, { headers });

    if (response.status === 304) {
      self.postMessage({ ok: true, notModified: true });
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const newEtag = response.headers.get('ETag');

    self.postMessage({ type: 'progress', message: 'データをダウンロード中...' });
    const csv = await response.text();

    self.postMessage({ type: 'progress', message: 'データを解析中（数十万行）...' });
    const result = parseCsv(csv);

    self.postMessage({ ok: true, result, etag: newEtag });
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || String(err) });
  }
};
