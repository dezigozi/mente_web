import { describe, it, expect } from 'vitest';
import {
  buildNcsTargets, NCS, factoryMatches, visitAreasByDate, ncsJudge, cityOf,
  inNcsArea, buildAreaStats, goalBaseQty, goalTotal, allocateGoals,
} from './ncsTarget.js';

const fac = (key, other, ncs = 0) => ({
  key, phones: [], pref: '東京都', address: "",
  byFy: new Map([[2025, new Map([[NCS, ncs], ['オリックス', other]])]]),
});
const factories = new Map([fac('A', 346), fac('B', 120), fac('C', 99), fac('D', 500, 3)].map(f => [f.key, f]));
const base = { judgeFY: 2025, compareLeases: new Set(), phone: '', pref: '', keyword: '', onlyTargets: true };

describe('buildNcsTargets minOther', () => {
  it('未指定なら絞らない', () => {
    expect(buildNcsTargets(factories, base).map(x => x.f.key)).toEqual(['A', 'B', 'C']);
  });
  it('他社 ◯台以上だけ残す（境界は含む）', () => {
    expect(buildNcsTargets(factories, { ...base, minOther: 120 }).map(x => x.f.key)).toEqual(['A', 'B']);
  });
  it('NCSありも出すときも同じく絞る', () => {
    expect(buildNcsTargets(factories, { ...base, onlyTargets: false, minOther: 300 }).map(x => x.f.key)).toEqual(['D', 'A']);
  });
});

describe('factoryMatches', () => {
  const f = { key: 'ウチダカーワールド', address: '神奈川県横浜市都筑区1-2', pref: '神奈川県', tel: '045-932-5508' };
  it('phones が無ければ tel で市外局番を前方一致', () => {
    expect(factoryMatches(f, { phone: '045' })).toBe(true);
    expect(factoryMatches(f, { phone: '011' })).toBe(false);
  });
  it('都道府県・キーワード（住所と工場名、空白無視）', () => {
    expect(factoryMatches(f, { pref: '神奈川' })).toBe(true);
    expect(factoryMatches(f, { pref: '北海道' })).toBe(false);
    expect(factoryMatches(f, { keyword: '都筑 区' })).toBe(true);
    expect(factoryMatches(f, { keyword: 'カーワールド' })).toBe(true);
    expect(factoryMatches(f, { keyword: '札幌' })).toBe(false);
  });
  it('phones と tel の両方で照合（phones が空・別番号でも tel で拾う）', () => {
    expect(factoryMatches({ ...f, phones: new Set(['0118112165']) }, { phone: '011' })).toBe(true);
    expect(factoryMatches({ ...f, phones: new Set() }, { phone: '045' })).toBe(true);
    expect(factoryMatches({ ...f, phones: new Set(['0118112165']) }, { phone: '022' })).toBe(false);
  });
});

describe('visitAreasByDate', () => {
  it('日付ごとにエリアで束ね、工場の多い順', () => {
    const area = { A: '横浜市鶴見区', B: '横浜市都筑区', C: '横浜市都筑区' };
    const m = visitAreasByDate([
      { date: '2026-10-14', factoryKey: 'A' }, { date: '2026-10-14', factoryKey: 'B' },
      { date: '2026-10-14', factoryKey: 'C' }, { date: '2026-10-14', factoryKey: 'C' },
      { date: '2026-10-21', factoryKey: 'X' }, { date: '', factoryKey: 'A' },
    ], k => area[k]);
    expect([...m.keys()]).toEqual([20261014, 20261021]);
    expect(m.get(20261014).map(a => [a.area, a.keys.size])).toEqual([['横浜市都筑区', 2], ['横浜市鶴見区', 1]]);
    expect(m.get(20261021)[0].area).toBe('(エリア不明)');
  });
});

describe('ncsJudge', () => {
  it('訪問なし→none、受注→won を最優先', () => {
    expect(ncsJudge(null)).toBe('none');
    expect(ncsJudge({ ncsWon: true, waiting: true, revisit: true })).toBe('won');
    expect(ncsJudge({ ncsWon: false, waiting: true, revisit: true })).toBe('waiting');
    expect(ncsJudge({ ncsWon: false, waiting: false, revisit: true })).toBe('revisit');
    expect(ncsJudge({ ncsWon: false, waiting: false, revisit: false })).toBe('open');
  });
});

describe('cityOf', () => {
  it('政令市の区は市まで、23区・郡町村・市名に市を含むものはそのまま', () => {
    expect(cityOf('神奈川県横浜市鶴見区1-2')).toBe('横浜市');
    expect(cityOf('宮城県仙台市若林区3')).toBe('仙台市');
    expect(cityOf('三重県四日市市本町1')).toBe('四日市市');
    expect(cityOf('千葉県市川市八幡1')).toBe('市川市');
    expect(cityOf('東京都練馬区北町3-5-1')).toBe('練馬区');
    expect(cityOf('北海道虻田郡倶知安町1')).toBe('虻田郡倶知安町');
  });

  it('県名のあとの空白は詰める', () => {
    expect(cityOf('北海道 石狩市新港1')).toBe('石狩市');
  });
});

describe('inNcsArea', () => {
  it('空なら全国、県まるごと、市の指定', () => {
    expect(inNcsArea({}, '北海道', '稚内市')).toBe(true);
    const sel = { '東京都': true, '北海道': ['札幌市', '小樽市'] };
    expect(inNcsArea(sel, '東京都', '八王子市')).toBe(true);
    expect(inNcsArea(sel, '北海道', '札幌市')).toBe(true);
    expect(inNcsArea(sel, '北海道', '稚内市')).toBe(false);
    expect(inNcsArea(sel, '宮城県', '仙台市')).toBe(false);
  });
});

describe('buildAreaStats', () => {
  it('県と市ごとに工場数・他社・OR を足す', () => {
    const m = buildAreaStats([
      { pref: '宮城県', city: '仙台市', other: 10, or: 6 },
      { pref: '宮城県', city: '仙台市', other: 4, or: 0 },
      { pref: '宮城県', city: '石巻市', other: 3, or: 3 },
      { pref: '北海道', city: '札幌市', other: 7, or: 5 },
    ]);
    expect(m.get('宮城県')).toMatchObject({ n: 3, other: 17, or: 9 });
    expect(m.get('宮城県').cities.get('仙台市')).toEqual({ n: 2, other: 14, or: 6 });
    expect(m.get('北海道').cities.size).toBe(1);
  });
});

describe('目標（OR の30%）', () => {
  it('判定年度の OR 台数', () => {
    const f = { byFy: new Map([[2025, new Map([['OR', 147], ['MAL', 2]])]]) };
    expect(goalBaseQty(f, 2025)).toBe(147);
    expect(goalBaseQty(f, 2024)).toBe(0);
    expect(goalBaseQty(undefined, 2025)).toBe(0);
  });
  it('合計は OR 合計 × 30% の四捨五入', () => {
    expect(goalTotal(7419)).toBe(2226); // 2225.7
    expect(goalTotal(5)).toBe(2); // 1.5 → 2
    expect(goalTotal(0)).toBe(0);
  });
  it('工場に配っても合計は1台もずれない（端数は余りの大きい順）', () => {
    const items = [{ key: 'A', base: 147 }, { key: 'B', base: 121 }, { key: 'C', base: 1 }, { key: 'D', base: 2 }, { key: 'E', base: 0 }];
    const g = allocateGoals(items);
    expect(g.base).toBe(271);
    expect(g.total).toBe(81); // 81.3
    expect([...g.byKey.values()].reduce((t, x) => t + x, 0)).toBe(81);
    // 44.1 / 36.3 / 0.3 / 0.6 / 0 → 床 80、残り1は余りが一番大きい D
    expect(Object.fromEntries(g.byKey)).toEqual({ A: 44, B: 36, C: 0, D: 1, E: 0 });
  });
});
