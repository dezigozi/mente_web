import { describe, it, expect } from 'vitest';
import {
  buildLeaseReportIndex, listClients, defaultClientSelection, summarizeFactories, summarizeClients,
  prevBase, fiscalYearApr, shortClientName,
} from './leaseReport.js';
import { parseCsv } from './csvParse.js';

const row = (o) => ({
  leaseCompany: 'OR', orderClient: 'ｵﾘｯｸｽ自動車 大阪フロント課'.normalize('NFKC'),
  branchCompany: 'A工場', prefecture: '大阪府', item: 'ｵﾙﾀﾈｰﾀｰ', itemMid: 'MAX', quantity: 1,
  ...o,
});

describe('fiscalYearApr', () => {
  it('3月は前年度・4月は当年度', () => {
    expect(fiscalYearApr(2025, 3)).toBe(2024);
    expect(fiscalYearApr(2025, 4)).toBe(2025);
  });
});

describe('shortClientName', () => {
  it('会社名を外して課名だけ', () => {
    expect(shortClientName('オリックス自動車(株)名古屋フロント課')).toBe('名古屋フロント課');
    expect(shortClientName('ｵﾘｯｸｽ自動車(株) ｻｰﾋﾞｽｶﾝﾊﾟﾆｰ福岡支店')).toBe('サービスカンパニー福岡支店');
    expect(shortClientName('日本カーソリューションズ㈱ 東日本サービス部東京チーム')).toBe('東日本サービス部東京チーム');
    expect(shortClientName('MAL本社')).toBe('MAL本社');
  });
});

describe('buildLeaseReportIndex / summarize', () => {
  const rows = [
    row({ year: 2024, month: 4, quantity: 2 }),
    row({ year: 2025, month: 3, quantity: 3 }), // 2024年度
    row({ year: 2025, month: 4, quantity: 4 }), // 2025年度（前年同期間に入る）
    row({ year: 2025, month: 9, quantity: 10 }), // 2025年度（同期間外）
    row({ year: 2026, month: 4, quantity: 5 }), // 2026年度・データ最終月 = 4月
    row({ year: 2025, month: 5, item: 'ｺﾝﾌﾟﾚｯｻｰ', itemMid: '他社ﾘﾋﾞﾙﾄ', quantity: 7 }),
    row({ year: 2025, month: 5, item: 'エアコン関連', quantity: 99 }), // 対象外
    row({ year: 2025, month: 5, orderClient: 'オリックス自動車 東京フロント課', branchCompany: 'B工場', quantity: 6 }),
    row({ year: 2025, month: 5, leaseCompany: 'MAL', orderClient: 'MAL本社', branchCompany: 'C工場', quantity: 8 }),
  ];
  const index = buildLeaseReportIndex(rows);

  it('最新年度と月を持つ', () => {
    expect(index.lastFy).toBe(2026);
    expect(index.lastFm).toBe(0); // 4月
  });

  it('オリックスは西日本の得意先が初期選択、他は空（＝全部）', () => {
    expect([...defaultClientSelection(index, 'OR')]).toEqual(['オリックス自動車 大阪フロント課']);
    expect(defaultClientSelection(index, 'MAL').size).toBe(0);
    expect(listClients(index, 'OR').map(c => c.name)).toContain('オリックス自動車 東京フロント課');
  });

  it('工場別：選んだ得意先だけ数え、年度は4月区切り、半角カナの品目も拾う', () => {
    const s = summarizeFactories(index, 'OR', defaultClientSelection(index, 'OR'));
    expect(s.rows.map(r => r.key)).toEqual(['A工場']);
    const a = s.rows[0];
    expect(a.total.byFy.get(2024)).toBe(5);
    expect(a.total.byFy.get(2025)).toBe(21);
    expect(a.items.get('コンプレッサー').byFy.get(2025)).toBe(7);
    expect(a.mids.find(m => m.item === 'コンプレッサー').mid).toBe('他社リビルト');
    expect(s.info.years).toEqual([2024, 2025, 2026]);
    expect(s.info.partial).toBe(true);
    expect(s.info.lastMonth).toBe(4);
  });

  it('途中の最新年度は前年同期間（4月まで）と比べる。それ以外は前年度全体', () => {
    const s = summarizeFactories(index, 'OR', null);
    const a = s.rows.find(r => r.key === 'A工場');
    expect(prevBase(a.total, 2026, s.info)).toBe(4);
    expect(prevBase(a.total, 2025, s.info)).toBe(5);
  });

  it('得意先別：品目ごとの本数と合計', () => {
    const s = summarizeClients(index, 'OR', new Set());
    expect(s.rows.length).toBe(2);
    expect(s.total.byFy.get(2025)).toBe(27);
    expect(s.totalItems.get('オルタネーター').byFy.get(2025)).toBe(20);
    const mal = summarizeClients(index, 'MAL', new Set());
    expect(mal.total.byFy.get(2025)).toBe(8);
  });
});

describe('parseCsv', () => {
  const header = '売上伝票ＮＯ,納品日,伝票区分,得意先コード,得意先名,受注部名,受注者名,部名(1),担当者名(1),注文者名,宅配先電話番号,送り先名,住所１,住所２,車種名,車輌型式１,顧客名_漢字,メーカーコード,品番,商品名,分析名(大),分析名(中),原価,単価,数量,粗利,メンテ';
  const line = d => `1,${d},10,1,ｵﾘｯｸｽ自動車 大阪ﾌﾛﾝﾄ課,特販部,x,特販部,y,,06-1234-5678,テスト工場 様,大阪府大阪市1,,ｲｽｽﾞ,X,Z,20,P1,ｵﾙﾀ,ｵﾙﾀﾈｰﾀｰ,MAX,100,200,1,100,OR`;

  it('分析名(中) を itemMid に持ち、「2026年3月」形式の納品日も読む', () => {
    const { rows } = parseCsv(['﻿' + header, line('2026/4/1'), line('2026年3月')].join('\r\n'), { keepRaw: false });
    expect(rows.length).toBe(2);
    expect(rows[0].itemMid).toBe('MAX');
    expect(rows[1]).toMatchObject({ year: 2026, month: 3, fiscalYear: 2025 });
  });
});
