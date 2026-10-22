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
    expect(within(table).getAllByText('オリックス自動車(株)大阪フロント課').length).toBe(1);
    expect(within(table).getAllByText('スターター').length).toBeGreaterThan(0);
    // 2025年度 7本 vs 2024年度 2本 → +250%
    expect(within(table).getAllByText('↗250%').length).toBeGreaterThan(0);
  });
});
