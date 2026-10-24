import { describe, it, expect } from 'vitest';
import { buildNcsTargets, NCS, factoryMatches, visitAreasByDate, ncsJudge, cityOf } from './ncsTarget.js';

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
});
