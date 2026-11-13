// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NcsTargetTab } from './App.jsx';

afterEach(() => { cleanup(); localStorage.clear(); });

const fac = (key, pref, address, fy2025) => ({
  key, pref, address, tel: '', phones: new Set(), orderersByFy: new Map(),
  byFy: new Map([[2025, new Map(Object.entries(fy2025))]]),
});
const factories = new Map([
  fac('札幌A', '北海道', '北海道札幌市中央区1', { OR: 100 }),
  fac('稚内B', '北海道', '北海道稚内市1', { OR: 10 }),
  fac('仙台C', '宮城県', '宮城県仙台市青葉区1', { OR: 50, MAL: 5 }),
  fac('練馬D', '東京都', '東京都練馬区1', { NCS: 3, OR: 40 }),
].map(f => [f.key, f]));
const index = { factories, fiscalYears: [2024, 2025], lastDate: 20261031 };
const pool = ['札幌A', '稚内B', '仙台C'].map(key => ({ key, tel: '', address: factories.get(key).address, pref: factories.get(key).pref }));

const setup = (props = {}) => render(
  <NcsTargetTab index={index} leaseCompanies={['NCS', 'OR', 'MAL']} judgeFY={2025} setJudgeFY={vi.fn()}
    pool={pool} poolKeys={new Set(pool.map(x => x.key))} visitLists={[]}
    statusOf={key => (key === '仙台C' ? { vs: [{ date: '2026-10-01' }], last: { date: '2026-10-01' } } : null)}
    onAddTargets={vi.fn()} onRemoveTargets={vi.fn(async () => {})} {...props} />
);
const names = () => ['札幌A', '稚内B', '仙台C'].filter(n => screen.queryByText(n));

describe('NcsTargetTab 行けるエリア・目標', () => {
  it('全国では対象3工場、目標は OR 160台の30%', () => {
    setup();
    expect(names()).toEqual(['札幌A', '稚内B', '仙台C']);
    expect(screen.getByText(/目標 NCS 48 台/)).toBeTruthy();
  });

  it('県を押すと県まるごと、▾ で市を外せる（ブラウザに保存）', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '北海道 2' }));
    expect(names()).toEqual(['札幌A', '稚内B']);
    expect(screen.getByText(/目標 NCS 33 台/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '北海道の市を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '稚内市 1' }));
    expect(names()).toEqual(['札幌A']);
    expect(screen.getByRole('button', { name: '北海道 1/2' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('ncs_area_v1'))).toEqual({ '北海道': ['札幌市'] });
    cleanup();
    setup();
    expect(names()).toEqual(['札幌A']);
  });

  it('エリア外のターゲットをまとめて外す（訪問した工場は残す）', async () => {
    const onRemoveTargets = vi.fn(async () => {});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    localStorage.setItem('ncs_area_v1', JSON.stringify({ '北海道': ['札幌市'] }));
    setup({ onRemoveTargets });
    expect(screen.getByText(/エリア外が 2件/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'エリア外の1件をターゲットから外す' }));
    await vi.waitFor(() => expect(onRemoveTargets).toHaveBeenCalledWith(['稚内B']));
    confirm.mockRestore();
  });
});
