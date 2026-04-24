/**
 * 本番ビルド用: Git に master_data.csv を置かない場合、ビルド時に1回取得して public に書く。
 * Vercel の Environment Variables に MASTER_CSV_BUNDLE_URL を設定（サーバー側取得のため CORS 不要）
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, '../public/data/master_data.csv');
const url = process.env.MASTER_CSV_BUNDLE_URL?.trim();

async function main() {
  if (url) {
    process.stderr.write(`[bundle-master-csv] Fetching from MASTER_CSV_BUNDLE_URL…\n`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`GET failed ${res.status} ${res.statusText}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);
    process.stderr.write(`[bundle-master-csv] Wrote ${out} (${buf.byteLength} bytes)\n`);
    return;
  }

  if (existsSync(out) && statSync(out).size > 0) {
    process.stderr.write(`[bundle-master-csv] Using existing ${out}\n`);
    return;
  }

  process.stderr.write(
    `[bundle-master-csv] Skip: set MASTER_CSV_BUNDLE_URL on Vercel, or add public/data/master_data.csv locally.\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
