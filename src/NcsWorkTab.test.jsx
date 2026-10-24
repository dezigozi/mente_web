// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { NcsWorkTab } from './App.jsx';

afterEach(cleanup);

const pool = [
  { key: '浅井自動車工業', tel: '045-572-0050', address: '神奈川県横浜市鶴見区1', pref: '神奈川県', contact: '山田' },
  { key: '滝川自工', tel: '011-811-2165', address: '北海道札幌市白石区2', pref: '北海道', contact: '' },
  { key: '平和車輌工場', tel: '011-861-9719', address: '北海道札幌市白石区3', pref: '北海道', contact: '' },
];
const visits = [{ id: 'v1', listId: 'old', factoryKey: '浅井自動車工業', tel: '045-572-0050', date: '2026-10-14', result: '好感触', memo: '窓口は佐藤さん' }];
const visitsByFactory = new Map([['浅井自動車工業', visits]]);
const statusOf = key => {
  const vs = visitsByFactory.get(key);
  if (!vs) return null;
  return { vs, first: vs[0], last: vs[vs.length - 1], stats: null, ncsWon: false, waiting: false, revisit: false, elapsed: 10 };
};
const index = {
  factories: new Map([['滝川自工', {
    key: '滝川自工', address: '北海道札幌市白石区2', byFy: new Map([[2025, new Map([['NCS', 3], ['OR', 120], ['MAL', 26]])], [2024, new Map([['OR', 999]])]]),
  }]]),
  fiscalYears: [2023, 2024, 2025],
};
const setup = (props = {}) => render(
  <NcsWorkTab index={index} judgeFY={2025} pool={pool} visitsByFactory={visitsByFactory} statusOf={statusOf}
    onSaveVisit={vi.fn(async () => {})} onDeleteVisit={vi.fn()} onRemoveTargets={vi.fn()} {...props} />
);
const factoryNames = () => screen.getAllByRole('row').slice(1).map(r => r.querySelector('td:nth-child(4) div')?.textContent);

describe('NcsWorkTab', () => {
  it('ダイジェストと全工場を1枚に出す', () => {
    setup();
    expect(screen.getByText('ターゲット').nextSibling.textContent).toBe('3');
    expect(screen.getByText('訪問した工場').nextSibling.textContent).toBe('1');
    expect(factoryNames()).toHaveLength(3);
    expect(screen.getByText('窓口は佐藤さん')).toBeTruthy();
  });

  it('工場名の右に判定年度の NCS・他社', () => {
    setup();
    expect(screen.getAllByTitle('2025/10〜2026/9').map(th => th.textContent)).toEqual(['NCS2025年度', '他社2025年度']);
    const cells = screen.getByText('滝川自工').closest('tr').querySelectorAll('td');
    expect([cells[4].textContent, cells[5].textContent]).toEqual(['3', '146']);
  });

  it('訪問済み／未訪問で絞る（未訪問→全部チェックでまとめて外せる）', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '訪問済み' }));
    expect(factoryNames()).toEqual(['浅井自動車工業']);
    fireEvent.click(screen.getByRole('button', { name: '未訪問' }));
    expect(factoryNames().sort()).toEqual(['平和車輌工場', '滝川自工'].sort());
    fireEvent.click(screen.getByRole('button', { name: '表示中を全部チェック' }));
    expect(screen.getByRole('button', { name: /^チェックした\d+件を外す$/ }).textContent).toContain('2件');
    fireEvent.click(screen.getByRole('button', { name: 'すべて' }));
    expect(factoryNames()).toHaveLength(3);
  });

  it('再訪問候補の日数を変えられる（経過日数の赤も追従）', () => {
    const onChangeRevisitDays = vi.fn();
    const { rerender } = setup({ onChangeRevisitDays });
    const input = screen.getByLabelText('再訪問候補の日数');
    expect(input.value).toBe('90');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChangeRevisitDays).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '7' } });
    expect(onChangeRevisitDays).toHaveBeenCalledWith(7);
    expect(screen.getByText('10日').className).not.toContain('text-rose-600');
    rerender(<NcsWorkTab index={index} judgeFY={2025} pool={pool} visitsByFactory={visitsByFactory} statusOf={statusOf}
      revisitDays={7} onChangeRevisitDays={onChangeRevisitDays} onSaveVisit={vi.fn()} onDeleteVisit={vi.fn()} onRemoveTargets={vi.fn()} />);
    expect(screen.getByText('10日').className).toContain('text-rose-600');
  });

  it('チェックした工場をまとめてターゲットから外す', async () => {
    const onRemoveTargets = vi.fn(async () => {});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ onRemoveTargets });
    const btn = () => screen.getByRole('button', { name: /^チェックした\d+件を外す$/ });
    expect(btn().disabled).toBe(true);
    for (const name of ['滝川自工', '平和車輌工場']) {
      fireEvent.click(screen.getByText(name).closest('tr').querySelector('td'));
    }
    expect(btn().textContent).toContain('チェックした2件を外す');
    fireEvent.click(btn());
    expect(confirm).toHaveBeenCalled();
    await vi.waitFor(() => expect(onRemoveTargets).toHaveBeenCalledTimes(1));
    expect(onRemoveTargets.mock.calls[0][0].sort()).toEqual(['平和車輌工場', '滝川自工'].sort());
    await vi.waitFor(() => expect(btn().textContent).toContain('チェックした0件を外す'));
    confirm.mockRestore();
  });

  it('実績Excel：期間（初期値は今期10/1〜今日）を選んで出す', async () => {
    const onExportReport = vi.fn(async () => {});
    setup({ onExportReport });
    fireEvent.click(screen.getByRole('button', { name: /実績Excel/ }));
    expect(screen.getByLabelText('レポート開始日').value).toMatch(/^\d{4}-10-01$/);
    fireEvent.change(screen.getByLabelText('レポート開始日'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('レポート終了日'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Excelを出す' }));
    await vi.waitFor(() => expect(onExportReport).toHaveBeenCalledWith('2026-10-01', '2026-12-31'));
  });

  it('電話・都道府県で絞り込める', () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText('022'), { target: { value: '011' } });
    expect(factoryNames().sort()).toEqual(['平和車輌工場', '滝川自工'].sort());
    fireEvent.change(screen.getByPlaceholderText('022'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('宮城県'), { target: { value: '神奈川' } });
    expect(factoryNames()).toEqual(['浅井自動車工業']);
  });

  it('カレンダーのエリアを押すと、その日の工場が先頭に来る', () => {
    setup();
    // 未訪問が先（判定順）なので、浅井は最後
    expect(factoryNames()[0]).not.toBe('浅井自動車工業');
    fireEvent.click(screen.getByRole('button', { name: /（カレンダー）$/ }));
    fireEvent.click(screen.getByRole('button', { name: '前の月' }));
    while (!screen.queryByText('2026年10月')) fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    fireEvent.click(screen.getByRole('button', { name: '横浜市 1' }));
    expect(factoryNames()[0]).toBe('浅井自動車工業');
    expect(screen.getByText(/横浜市 の1工場を上に表示中/)).toBeTruthy();
  });

  it('ダブルクリックで小窓。訪問日はカレンダーで選んだ日、保存で listId 空の記録', async () => {
    const onSaveVisit = vi.fn(async () => {});
    setup({ onSaveVisit });
    fireEvent.click(screen.getByRole('button', { name: /（カレンダー）$/ }));
    while (!screen.queryByText('2026年10月')) fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    fireEvent.click(screen.getByRole('button', { name: '2026/10/20を訪問日にする' }));
    const row = screen.getByText('滝川自工').closest('tr');
    fireEvent.doubleClick(row);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('訪問日').value).toBe('2026-10-20');
    fireEvent.change(within(dialog).getByLabelText('感触'), { target: { value: '様子見' } });
    fireEvent.change(within(dialog).getByLabelText('メモ'), { target: { value: ' 社長不在 ' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await vi.waitFor(() => expect(onSaveVisit).toHaveBeenCalledTimes(1));
    expect(onSaveVisit.mock.calls[0][0]).toMatchObject({
      factoryKey: '滝川自工', listId: '', tel: '011-811-2165', date: '2026-10-20', result: '様子見', memo: '社長不在',
    });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('小窓で過去の記録を直すと、元の id のまま保存', async () => {
    const onSaveVisit = vi.fn(async () => {});
    setup({ onSaveVisit });
    fireEvent.doubleClick(screen.getByText('浅井自動車工業').closest('tr'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByTitle('直す'));
    expect(within(dialog).getByLabelText('メモ').value).toBe('窓口は佐藤さん');
    fireEvent.change(within(dialog).getByLabelText('メモ'), { target: { value: '窓口は佐藤課長' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await vi.waitFor(() => expect(onSaveVisit).toHaveBeenCalledTimes(1));
    expect(onSaveVisit.mock.calls[0][0]).toMatchObject({ id: 'v1', listId: 'old', memo: '窓口は佐藤課長', date: '2026-10-14' });
  });
});
