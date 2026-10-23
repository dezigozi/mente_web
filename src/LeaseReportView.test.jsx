// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { LeaseReportView } from './App.jsx';

afterEach(cleanup);

const row = (o) => ({
  leaseCompany: 'OR', orderClient: 'オリックス自動車(株)大阪フロント課', branchCompany: 'A工場',
  prefecture: '大阪府', item: 'オルタネーター', itemMid: 'MAX', quantity: 1, year: 2025, month: 5, ...o,
});
const rows = [
  row({ quantity: 3 }),
  row({ year: 2024, month: 5, quantity: 2 }),
  row({ item: 'コンプレッサー', itemMid: '他社リビルト', quantity: 4 }),
  row({ orderClient: 'オリックス自動車(株)東京フロント課', branchCompany: 'B工場', prefecture: '東京都', quantity: 9 }),
  row({ leaseCompany: 'MAL', orderClient: 'MAL本社', branchCompany: 'C工場', quantity: 5 }),
];

describe('LeaseReportView', () => {
  it('初期はオリックスの西日本だけ。東京の工場は出ない', () => {
    render(<LeaseReportView rows={rows} />);
    expect(screen.getByText('A工場')).toBeTruthy();
    expect(screen.queryByText('B工場')).toBeNull();
    expect(screen.getByText(/西日本（大阪・広島・高松・福岡・名古屋）/)).toBeTruthy();
    // 合計行・得意先の列・説明文は出さない
    expect(screen.queryByText('合計')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: '得意先' })).toBeNull();
    expect(screen.queryByText(/数量（本数）/)).toBeNull();
    expect(screen.getByRole('button', { name: '大阪フロント課' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '西日本' })).toBeNull();
  });

  it('「全部」で東京の工場も出る。行を開くと品目と分析名(中)の内訳', () => {
    render(<LeaseReportView rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(screen.getByText('B工場')).toBeTruthy();
    fireEvent.click(screen.getByText('A工場'));
    expect(screen.getByText('他社リビルト')).toBeTruthy();
  });

  it('リース会社を MAL に変えると MAL の工場だけ、得意先は全部', () => {
    render(<LeaseReportView rows={rows} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'MAL' } });
    expect(screen.getByText('C工場')).toBeTruthy();
    expect(screen.queryByText('A工場')).toBeNull();
    expect(screen.getByText(/全得意先/)).toBeTruthy();
  });

  it('支店別タブ：得意先ごとにオルタ・スタ・コンプの行と前年比', () => {
    render(<LeaseReportView rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /支店別/ }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('大阪フロント課').length).toBe(1);
    expect(within(table).queryByText(/オリックス自動車/)).toBeNull();
    expect(within(table).getAllByText('スターター').length).toBeGreaterThan(0);
    // 2025年度 7本 vs 2024年度 2本 → +250%
    expect(within(table).getAllByText('↗250%').length).toBeGreaterThan(0);
  });

  it('選んだ得意先の計が表のいちばん下に出る（支店別・工場別とも）', () => {
    render(<LeaseReportView rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    // 工場別：A工場 7 + B工場 9 = 16（2025年度）
    let bodies = screen.getByRole('table').querySelectorAll('tbody');
    let last = bodies[bodies.length - 1];
    expect(within(last).getByText('計')).toBeTruthy();
    expect(last.querySelector('tr').textContent).toContain('16');
    fireEvent.click(screen.getByRole('button', { name: /支店別/ }));
    bodies = screen.getByRole('table').querySelectorAll('tbody');
    last = bodies[bodies.length - 1];
    expect(last.querySelector('tr').textContent).toMatch(/^計/);
    expect(last.querySelector('tr').textContent).toContain('16');
    expect(within(last).getByText('コンプレッサー')).toBeTruthy();
  });

  it('タブ名は「支店別実績」。よく出る車種タブで品目ごとのランキングと年度切替', () => {
    const carRows = [
      row({ year: 2025, month: 5, carName: 'ｲｽｽﾞ', carType: 'NPR88-1', quantity: 3 }),
      row({ year: 2025, month: 5, carName: 'ｽｽﾞｷ', carType: 'DA17V-1', quantity: 5 }),
      row({ year: 2024, month: 5, carName: 'ﾄﾖﾀ', carType: 'TRH200-1', quantity: 2 }),
    ];
    render(<LeaseReportView rows={carRows} />);
    expect(screen.getByRole('button', { name: '支店別実績' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'よく出る車種' }));
    const tables = screen.getAllByRole('table');
    expect(tables.length).toBe(3);
    const names = within(tables[0]).getAllByRole('row').slice(1).map(r => r.textContent);
    expect(names[0]).toContain('スズキ DA17V');
    expect(names[1]).toContain('イスズ NPR88');
    fireEvent.click(screen.getByRole('button', { name: '2024年度' }));
    expect(within(screen.getAllByRole('table')[0]).getByText('トヨタ TRH200')).toBeTruthy();
  });

  it('よく出る車種：上位22車種の残りは「その他」にまとめ、最後に「計」', () => {
    const many = Array.from({ length: 25 }, (_, i) => row({ carName: 'ﾄﾖﾀ', carType: `T${String(i).padStart(2, '0')}-1`, quantity: 30 - i }));
    render(<LeaseReportView rows={many} />);
    fireEvent.click(screen.getByRole('button', { name: 'よく出る車種' }));
    const t = screen.getAllByRole('table')[0];
    const trs = within(t).getAllByRole('row').slice(1);
    expect(trs.length).toBe(22 + 2);
    // 残り3車種 = 8+7+6
    expect(trs[22].textContent).toMatch(/^その他（3車種）21/);
    expect(trs[23].textContent).toMatch(/^計/);
    expect(trs[23].textContent).toContain(String(many.reduce((a, r) => a + r.quantity, 0)));
    fireEvent.click(screen.getByRole('button', { name: '全部表示' }));
    expect(within(screen.getAllByRole('table')[0]).getAllByRole('row').length).toBe(1 + 25 + 1);
  });
});
