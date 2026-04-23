import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ChevronRight, Building2, Tag, Layers,
  ArrowUpRight, ArrowDownRight, LayoutDashboard, Database,
  Calendar, RefreshCcw, CheckCircle2, FileText, FileSpreadsheet,
  AlertCircle, Loader2, XCircle, Eye, EyeOff,
  CheckSquare, Square, Menu, X, Package, Search, ArrowUpDown,
} from 'lucide-react';
import { getCache, setCache, clearCache } from './utils/db';
import { loadCsvData } from './utils/csvLoader';
import {
  filterRows,
  aggregateByLease,
  aggregateByItemForLease,
  aggregateByBranchForLease,
  aggregateByItemForBranch,
  aggregateByProductCode,
  generateDetailCsvContent, calcYoY, formatCurrencyFull,
} from './utils/aggregator';

const CACHE_KEY = 'maint_report_data_v1';

const ALLOWED_ITEMS = ['オルタネーター', 'スターター', 'コンプレッサー', 'エアコン関連'];
// NFKC正規化：半角カナ→全角カナ、全角英数→半角英数 に統一して比較
const norm = s => (s || '').normalize('NFKC').trim();

const App = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(() =>
    localStorage.getItem('maint_report_auth') === 'true'
  );
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState('');

  const [rawData, setRawData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ fetchMsg: '', isSyncing: false });
  const [loadError, setLoadError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('idle');

  const [selectedLeaseCo, setSelectedLeaseCo] = useState('ALL');
  const [monthRange, setMonthRange] = useState({ start: '4', end: '3' });
  const [amountUnit, setAmountUnit] = useState('yen');
  const [showProfit, setShowProfit] = useState(true);
  const [checkedItems, setCheckedItems] = useState(new Set());
  // activeView: 現在のドリルダウン位置
  const [activeView, setActiveView] = useState({ leaseCo: null, branch: null, item: null });
  // viewMode: 'A' = リース→分類→品番 / 'B' = リース→工場→分類→品番
  const [viewMode, setViewMode] = useState('A');
  const [reportMode, setReportMode] = useState('dashboard'); // 'dashboard' | 'margin'
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const fmtAmt = useCallback((val) => {
    if (amountUnit === 'thousand') {
      const v = Math.round((val || 0) / 1000);
      return `¥${v.toLocaleString()}`;
    }
    return formatCurrencyFull(val);
  }, [amountUnit]);

  const loadData = useCallback(async (forceRefresh = false) => {
    setIsLoading(true);
    setLoadError(null);
    setConnectionStatus('loading');
    setLoadingProgress({ fetchMsg: 'CSVデータを読み込み中...', isSyncing: true });

    try {
      if (!forceRefresh) {
        const cached = await getCache(CACHE_KEY);
        if (cached?.data) {
          const ageMin = Math.floor((Date.now() - cached.timestamp) / 60000);
          setRawData({ ...cached.data, fromCache: true, cacheAgeMsg: `${ageMin}分前のデータ` });
          setConnectionStatus('online');
        }
      } else {
        await clearCache();
      }

      const csvData = await loadCsvData();
      await setCache(CACHE_KEY, { data: csvData, timestamp: Date.now() });
      setRawData({ ...csvData, fromCache: false, cacheAgeMsg: '最新' });
      setConnectionStatus('online');
    } catch (err) {
      console.error('データ読み込みエラー:', err);
      setLoadError('CSVファイルの読み込みに失敗しました。public/data/master_data.csv を確認してください。');
      setConnectionStatus('offline');
    } finally {
      setIsLoading(false);
      setLoadingProgress({ fetchMsg: '', isSyncing: false });
    }
  }, []);

  useEffect(() => { loadData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rawData?.rows.length) return;
    const maxFY = Math.max(...rawData.years);
    const latestMonths = rawData.rows.filter(r => r.fiscalYear === maxFY).map(r => r.month);
    if (latestMonths.length > 0) {
      const toFiscalPos = m => (m - 4 + 12) % 12;
      const latest = latestMonths.reduce((best, m) => toFiscalPos(m) > toFiscalPos(best) ? m : best);
      setMonthRange({ start: '4', end: String(latest) });
    }
  }, [rawData]);

  const filteredRows = useMemo(() => {
    if (!rawData) return [];
    return filterRows(rawData.rows, {
      leaseCompany: selectedLeaseCo,
      startMonth: monthRange.start,
      endMonth: monthRange.end,
    });
  }, [rawData, selectedLeaseCo, monthRange]);

  // ダッシュボード用：ALLOWED_ITEMSの分析名のみに絞り込み（半角全角を区別しない）
  const dashboardRows = useMemo(() => {
    const allowedNorm = ALLOWED_ITEMS.map(norm);
    return filteredRows.filter(r => allowedNorm.includes(norm(r.item)));
  }, [filteredRows]);

  const years = useMemo(() => rawData?.years || [], [rawData]);

  const leaseCompanies = useMemo(() =>
    rawData?.leaseCompanies?.filter(lc => lc && lc.trim()) || [],
    [rawData]
  );

  // 粗利収支分析用：rawData変更時のみ月×リース会社×品番で事前集計
  const allProductMonthly = useMemo(() => {
    if (!rawData?.rows) return [];
    const map = {};
    rawData.rows.forEach(r => {
      if (!r.productCode || !r.leaseCompany) return;
      const key = `${r.fiscalYear}|${r.month}|${r.leaseCompany}|${r.productCode}`;
      if (!map[key]) {
        map[key] = {
          fiscalYear: r.fiscalYear,
          month: r.month,
          leaseCompany: r.leaseCompany,
          productCode: r.productCode,
          productName: r.productName || '',
          item: r.item || '',
          quantity: 0,
          sales: 0,
          profit: 0,
        };
      }
      map[key].quantity += Number(r.quantity) || 0;
      map[key].sales    += Number(r.sales)    || 0;
      map[key].profit   += Number(r.profit)   || 0;
    });
    return Object.values(map);
  }, [rawData]);

  const currentTableData = useMemo(() => {
    if (!dashboardRows.length || !years.length) return [];
    const { leaseCo, branch, item } = activeView;

    // 最下層: 品番
    if (item !== null) {
      return aggregateByProductCode(dashboardRows, years, { leaseCo, branch, item });
    }

    if (viewMode === 'A') {
      if (leaseCo !== null) return aggregateByItemForLease(dashboardRows, years, leaseCo);
      return aggregateByLease(dashboardRows, years);
    } else {
      if (leaseCo !== null && branch !== null) return aggregateByItemForBranch(dashboardRows, years, leaseCo, branch);
      if (leaseCo !== null) return aggregateByBranchForLease(dashboardRows, years, leaseCo);
      return aggregateByLease(dashboardRows, years);
    }
  }, [dashboardRows, years, activeView, viewMode]);

  // viewが変わるたびにチェック状態をリセット
  const viewKey = `${activeView.leaseCo}|${activeView.branch}|${activeView.item}`;
  useEffect(() => {
    if (!currentTableData.length) return;
    setCheckedItems(new Set(currentTableData.map(d => d.name)));
  }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLeafLevel = activeView.item !== null;

  const totalRow = useMemo(() => {
    if (!currentTableData.length || !years.length) return null;
    const filtered = currentTableData.filter(d => checkedItems.has(d.name));
    if (!filtered.length) return null;
    const profit = {}, quantity = {};
    years.forEach(y => { profit[y] = 0; quantity[y] = 0; });
    filtered.forEach(d => years.forEach(y => {
      profit[y]   += d.profit[y]   || 0;
      quantity[y] += d.quantity[y] || 0;
    }));
    const { leaseCo, branch, item } = activeView;
    let label = '全体 合計';
    if (item !== null)   label = `${item} 合計`;
    else if (branch !== null) label = `${branch} 合計`;
    else if (leaseCo !== null) label = `${leaseCo} 合計`;
    return { name: label, profit, quantity };
  }, [currentTableData, years, activeView, checkedItems]);

  const handleDrillDown = (row) => {
    if (isLeafLevel) return;
    const { leaseCo, branch } = activeView;
    if (viewMode === 'A') {
      if (leaseCo === null) {
        setActiveView({ leaseCo: row.name, branch: null, item: null });
      } else {
        setActiveView(prev => ({ ...prev, item: row.name }));
      }
    } else {
      if (leaseCo === null) {
        setActiveView({ leaseCo: row.name, branch: null, item: null });
      } else if (branch === null) {
        setActiveView(prev => ({ ...prev, branch: row.name }));
      } else {
        setActiveView(prev => ({ ...prev, item: row.name }));
      }
    }
  };

  const handleNavigateTo = useCallback((view) => setActiveView(view), []);
  const handleRefresh = () => loadData(true);

  const handleSaveCsv = () => {
    const { leaseCo, branch, item } = activeView;
    let rows = dashboardRows;
    if (leaseCo) rows = rows.filter(r => (r.leaseCompany || '(未分類)') === leaseCo);
    if (branch)  rows = rows.filter(r => (r.branch       || '(未分類)') === branch);
    if (item)    rows = rows.filter(r => (r.item         || '(未分類)') === item);
    if (!rows.length) return;
    const csv = generateDetailCsvContent(rows);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = [leaseCo, branch, item].filter(Boolean).join('_') || 'ALL';
    a.download = `メンテ実績_${suffix}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSavePdf = () => window.print();

  const handleLogin = (e) => {
    e.preventDefault();
    if (passwordInput === (import.meta.env.VITE_PASSWORD || '')) {
      localStorage.setItem('maint_report_auth', 'true');
      setIsAuthenticated(true);
    } else {
      setAuthError('パスワードが違います');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('maint_report_auth');
    setIsAuthenticated(false);
  };

  if (!isAuthenticated && import.meta.env.VITE_PASSWORD) {
    return (
      <div className="min-h-screen bg-green-950 flex items-center justify-center p-4">
        <div className="bg-white rounded-[3rem] w-full max-w-sm shadow-2xl overflow-hidden">
          <div className="p-10 border-b border-slate-50 bg-green-50/50">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-emerald-600 p-2 rounded-xl text-white"><Database size={22} /></div>
              <h1 className="text-xl font-black tracking-tighter text-slate-800">Maint Report</h1>
            </div>
            <p className="text-[11px] text-slate-400 font-bold uppercase tracking-widest">メンテ実績レポート</p>
          </div>
          <form onSubmit={handleLogin} className="p-10 space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">パスワード</label>
              <input type="password" value={passwordInput} onChange={e => setPasswordInput(e.target.value)}
                className="w-full bg-slate-100 border-none rounded-2xl p-4 text-sm font-bold text-slate-700 focus:ring-4 focus:ring-emerald-500/10"
                placeholder="••••••••" autoFocus />
              {authError && <p className="text-xs text-rose-500 font-bold px-2">{authError}</p>}
            </div>
            <button type="submit"
              className="w-full bg-green-900 text-white py-4 rounded-2xl font-black shadow-xl hover:bg-emerald-600 transition-all active:scale-95">
              ログイン
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 select-none">

      {/* Top Bar */}
      <div className="fixed top-0 left-0 right-0 z-40 bg-green-900 text-white flex items-center justify-between px-4 py-3 no-print">
        <button onClick={() => setIsSidebarOpen(v => !v)} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="bg-emerald-600 p-1.5 rounded-lg"><Database size={18} /></div>
          <span className="font-black text-sm tracking-tight">メンテ実績レポート</span>
        </button>
        <button onClick={() => setIsSidebarOpen(v => !v)} className="p-2 rounded-xl hover:bg-green-800 transition-colors">
          {isSidebarOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-30" onClick={() => setIsSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 w-64 bg-green-900 text-white flex flex-col p-6 h-screen shadow-2xl z-40 no-print transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between mb-10 px-2">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-600 p-2 rounded-xl text-white shadow-lg shadow-emerald-500/20">
              <Database size={24} />
            </div>
            <h1 className="text-lg font-black leading-none tracking-tighter uppercase">
              Maint<br/>Report
            </h1>
          </div>
          <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 rounded-xl hover:bg-green-800 text-green-400 transition-colors">
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 space-y-2">
          <button
            onClick={() => { setReportMode('dashboard'); setIsSidebarOpen(false); }}
            className={`flex items-center gap-3 w-full p-4 rounded-2xl transition-all duration-300 ${
              reportMode === 'dashboard'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105'
                : 'text-green-400 hover:bg-green-800'
            }`}>
            <LayoutDashboard size={20} />
            <span className="font-black text-sm tracking-tight">分析ダッシュボード</span>
          </button>
          <button
            onClick={() => { setReportMode('margin'); setIsSidebarOpen(false); }}
            className={`flex items-center gap-3 w-full p-4 rounded-2xl transition-all duration-300 ${
              reportMode === 'margin'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105'
                : 'text-green-400 hover:bg-green-800'
            }`}>
            <Package size={20} />
            <span className="font-black text-sm tracking-tight">粗利収支分析</span>
          </button>

          <div className="pt-8 pb-2 px-4 text-[10px] font-black text-green-500 uppercase tracking-widest">
            Reports Export
          </div>
          <button onClick={handleSavePdf} className="flex items-center gap-3 w-full p-4 rounded-2xl text-green-400 hover:bg-green-800 transition-all border border-transparent hover:border-green-700">
            <div className="flex items-center gap-3 italic font-bold text-sm text-green-200"><FileText size={18} /> PDF Export</div>
          </button>
          <button onClick={handleSaveCsv} className="flex items-center gap-3 w-full p-4 rounded-2xl text-green-400 hover:bg-green-800 transition-all border border-transparent hover:border-green-700">
            <div className="flex items-center gap-3 italic font-bold text-sm text-green-200"><FileSpreadsheet size={18} /> CSV Export</div>
          </button>
        </nav>

        {rawData && (
          <div className="mb-4 p-3 bg-green-800 rounded-2xl text-xs space-y-1">
            <div className="flex justify-between text-green-400">
              <span>レコード数</span>
              <span className="font-mono font-bold text-green-200">{rawData.rows.length.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-green-400">
              <span>データ</span>
              <span className={`font-mono font-bold ${rawData.fromCache ? 'text-emerald-400' : 'text-green-300'}`}>
                {rawData.cacheAgeMsg || (rawData.fromCache ? 'Cache' : '最新')}
              </span>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {import.meta.env.VITE_PASSWORD && (
            <button onClick={handleLogout} className="flex items-center gap-3 w-full p-3 rounded-2xl text-green-500 hover:bg-green-800 transition-all text-xs font-bold">
              <XCircle size={16} /> ログアウト
            </button>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="pt-20 min-h-screen px-4 pb-4 md:px-8 md:pb-8 overflow-y-auto custom-scrollbar">

        {/* Header */}
        <header className="mb-6 md:mb-10 space-y-4 md:space-y-8 no-print">
          <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-2xl md:text-4xl font-black text-slate-800 tracking-tighter">
                  メンテ実績レポート
                </h2>
                <ConnectionBadge status={connectionStatus} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              {loadingProgress.isSyncing && (
                <div className="flex items-center gap-2 text-xs font-bold text-slate-500 bg-slate-100 px-4 py-2 rounded-2xl animate-pulse">
                  <Loader2 size={14} className="animate-spin" />
                  {loadingProgress.fetchMsg}
                </div>
              )}
              <button onClick={handleRefresh} disabled={isLoading}
                className={`group flex items-center gap-2 px-5 md:px-8 py-3 md:py-4 rounded-3xl bg-green-900 text-white font-black text-sm shadow-2xl hover:bg-emerald-600 transition-all duration-300 active:scale-95 disabled:opacity-50 ${isLoading ? 'animate-pulse' : ''}`}>
                <RefreshCcw size={16} className={isLoading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'} />
                <span className="hidden sm:inline">{isLoading ? '同期中...' : '最新データに更新'}</span>
                <span className="sm:hidden">{isLoading ? '同期中' : '更新'}</span>
              </button>
            </div>
          </div>

          {/* Filters — ダッシュボードのみ表示 */}
          {reportMode === 'dashboard' && <div className="bg-white p-4 md:p-8 rounded-3xl md:rounded-[3rem] shadow-sm border border-slate-100 flex flex-wrap gap-6 md:gap-10 items-start">

            {/* 表示パターン切り替え */}
            <div className="space-y-3 w-full">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">
                表示パターン
              </label>
              <div className="flex bg-slate-100 p-1 rounded-2xl w-fit">
                <button
                  onClick={() => { setViewMode('A'); setActiveView({ leaseCo: null, branch: null, item: null }); }}
                  className={`px-5 py-2.5 rounded-xl text-xs font-black transition-all duration-300 whitespace-nowrap ${viewMode === 'A' ? 'bg-white text-slate-800 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>
                  リース → 分類 → 品番
                </button>
                <button
                  onClick={() => { setViewMode('B'); setActiveView({ leaseCo: null, branch: null, item: null }); }}
                  className={`px-5 py-2.5 rounded-xl text-xs font-black transition-all duration-300 whitespace-nowrap ${viewMode === 'B' ? 'bg-white text-slate-800 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>
                  リース → 工場 → 分類 → 品番
                </button>
              </div>
            </div>

            {/* リース会社フィルター */}
            <div className="space-y-3 w-full">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">
                メンテ（リース会社）絞り込み
              </label>
              <div className="flex gap-2 flex-wrap">
                {['ALL', ...leaseCompanies].map(l => (
                  <button key={l}
                    onClick={() => { setSelectedLeaseCo(l); setActiveView({ leaseCo: null, branch: null, item: null }); }}
                    className={`px-4 py-2 rounded-2xl text-xs font-black transition-all duration-300 ${
                      selectedLeaseCo === l
                        ? 'bg-emerald-600 text-white shadow-xl shadow-emerald-200'
                        : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                    }`}>
                    {l === 'ALL' ? 'すべて' : l}
                  </button>
                ))}
              </div>
            </div>

            {/* 期間 */}
            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">期間指定</label>
              <div className="flex items-center gap-4 bg-slate-100 p-2 rounded-2xl">
                <select value={monthRange.start} onChange={e => setMonthRange(prev => ({ ...prev, start: e.target.value }))}
                  className="bg-transparent border-none text-sm font-black px-4 py-1.5 focus:ring-0 text-slate-700 cursor-pointer">
                  {[...Array(12)].map((_, i) => <option key={i+1} value={i+1}>{i+1}月</option>)}
                </select>
                <div className="w-4 h-0.5 bg-slate-300 rounded-full" />
                <select value={monthRange.end} onChange={e => setMonthRange(prev => ({ ...prev, end: e.target.value }))}
                  className="bg-transparent border-none text-sm font-black px-4 py-1.5 focus:ring-0 text-slate-700 cursor-pointer">
                  {[...Array(12)].map((_, i) => <option key={i+1} value={i+1}>{i+1}月</option>)}
                </select>
              </div>
            </div>

            {/* 金額単位 */}
            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">金額単位</label>
              <div className="flex bg-slate-100 p-1 rounded-2xl">
                {['yen', 'thousand'].map(u => (
                  <button key={u} onClick={() => setAmountUnit(u)}
                    className={`px-5 py-2.5 rounded-xl text-xs font-black transition-all duration-300 ${amountUnit === u ? 'bg-white text-slate-800 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>
                    {u === 'yen' ? '円' : '千円'}
                  </button>
                ))}
              </div>
            </div>

            {/* 粗利表示 */}
            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">粗利表示</label>
              <button onClick={() => setShowProfit(p => !p)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-black transition-all duration-300 ${showProfit ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-200' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}>
                {showProfit ? <Eye size={14} /> : <EyeOff size={14} />}
                {showProfit ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>}
        </header>

        {isLoading && !rawData && <LoadingScreen />}

        {loadError && (
          <div className="bg-rose-50 border border-rose-200 rounded-3xl p-8 mb-8 flex items-center gap-4 animate-fade-in">
            <AlertCircle className="text-rose-500 flex-shrink-0" size={24} />
            <div>
              <h3 className="font-black text-rose-800 mb-1">データ読み込みエラー</h3>
              <p className="text-sm text-rose-600">{loadError}</p>
            </div>
          </div>
        )}

        {rawData && !isLoading && reportMode === 'dashboard' && (
          <DashboardView
            data={currentTableData}
            years={years}
            activeView={activeView}
            viewMode={viewMode}
            isLeafLevel={isLeafLevel}
            checkedItems={checkedItems}
            onCheckedChange={setCheckedItems}
            onDrillDown={handleDrillDown}
            onNavigateTo={handleNavigateTo}
            onSavePdf={handleSavePdf}
            onSaveCsv={handleSaveCsv}
            fmtAmt={fmtAmt}
            amountUnit={amountUnit}
            showProfit={showProfit}
            totalRow={totalRow}
          />
        )}
        {rawData && !isLoading && reportMode === 'margin' && (
          <ProductMarginView items={allProductMonthly} leaseCompanies={leaseCompanies} />
        )}
      </main>
    </div>
  );
};

// ===== 接続ステータスバッジ =====
const ConnectionBadge = ({ status }) => {
  const map = {
    idle:    { cls: 'bg-slate-100 text-slate-500 border-slate-200',                label: 'Standby',    Icon: CheckCircle2 },
    loading: { cls: 'bg-amber-50 text-amber-600 border-amber-100 animate-pulse',   label: 'Loading...', Icon: Loader2 },
    online:  { cls: 'bg-emerald-50 text-emerald-600 border-emerald-100',           label: 'Live',       Icon: CheckCircle2 },
    offline: { cls: 'bg-rose-50 text-rose-600 border-rose-100',                    label: 'Offline',    Icon: AlertCircle },
  };
  const { cls, label, Icon } = map[status] || map.idle;
  return (
    <div className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[10px] font-black uppercase border shadow-sm ${cls}`}>
      <Icon size={12} className={status === 'loading' ? 'animate-spin' : ''} /> {label}
    </div>
  );
};

// ===== ローディング画面 =====
const LoadingScreen = () => (
  <div className="flex flex-col items-center justify-center h-96 animate-fade-in">
    <div className="relative mb-8">
      <div className="w-20 h-20 border-4 border-slate-200 rounded-full" />
      <div className="absolute top-0 left-0 w-20 h-20 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      <Database className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-emerald-500" size={28} />
    </div>
    <h3 className="text-xl font-black text-slate-700 mb-2">データを読み込んでいます</h3>
    <p className="text-sm text-slate-400 font-bold">CSVファイルを解析中...</p>
    <div className="flex gap-1 mt-6">
      {[0, 1, 2].map(i => (
        <div key={i} className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </div>
  </div>
);

// ===== ダッシュボードビュー =====
const DashboardView = ({
  data, years, activeView, viewMode, isLeafLevel, checkedItems, onCheckedChange,
  onDrillDown, onNavigateTo, onSavePdf, onSaveCsv, fmtAmt, amountUnit, showProfit, totalRow,
}) => {
  const toggleCheck = useCallback((name) => {
    onCheckedChange(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }, [onCheckedChange]);

  const { leaseCo, branch, item } = activeView;

  // 現在のレベルに応じたラベルを決定
  let levelLabel, levelTitle;
  if (item !== null) {
    levelLabel = '品番';
    levelTitle = `${item} 品番別実績`;
  } else if (viewMode === 'A') {
    if (leaseCo !== null) {
      levelLabel = '分類（分析名）';
      levelTitle = `${leaseCo} 分類別実績`;
    } else {
      levelLabel = 'リース会社';
      levelTitle = 'リース会社別 年次実績比較';
    }
  } else {
    if (leaseCo !== null && branch !== null) {
      levelLabel = '分類（分析名）';
      levelTitle = `${branch} 分類別実績`;
    } else if (leaseCo !== null) {
      levelLabel = '工場（部店）';
      levelTitle = `${leaseCo} 工場別実績`;
    } else {
      levelLabel = 'リース会社';
      levelTitle = 'リース会社別 年次実績比較';
    }
  }

  // パンくずリスト
  const crumbs = [
    {
      label: '全体',
      icon: <Database size={14} />,
      onClick: () => onNavigateTo({ leaseCo: null, branch: null, item: null }),
      isCurrent: leaseCo === null,
    },
  ];
  if (leaseCo !== null) {
    crumbs.push({
      label: leaseCo,
      icon: <Building2 size={14} />,
      onClick: () => onNavigateTo({ leaseCo, branch: null, item: null }),
      isCurrent: branch === null && item === null,
    });
  }
  if (branch !== null) {
    crumbs.push({
      label: branch,
      icon: <Layers size={14} />,
      onClick: () => onNavigateTo({ leaseCo, branch, item: null }),
      isCurrent: item === null,
    });
  }
  if (item !== null) {
    crumbs.push({
      label: item,
      icon: <Tag size={14} />,
      onClick: null,
      isCurrent: true,
    });
  }

  return (
    <div className="space-y-4 md:space-y-8 animate-fade-in-up">

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 md:gap-2 text-xs md:text-sm font-bold no-print flex-wrap">
        {crumbs.map((crumb, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && <ChevronRight size={14} className="text-slate-300 flex-shrink-0" />}
            {crumb.isCurrent ? (
              <span className="flex items-center gap-1 text-emerald-600">
                {crumb.icon} {crumb.label}
              </span>
            ) : (
              <button
                onClick={crumb.onClick}
                className="flex items-center gap-1 text-slate-400 hover:text-slate-600 transition-colors">
                {crumb.icon} {crumb.label}
              </button>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Check controls */}
      <div className="flex items-center gap-2 no-print">
        <button onClick={() => onCheckedChange(new Set(data.map(d => d.name)))}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 text-xs font-black transition-colors">
          <CheckSquare size={14} /> 全チェック
        </button>
        <button onClick={() => onCheckedChange(new Set())}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 text-xs font-black transition-colors">
          <Square size={14} /> 全解除
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-3xl md:rounded-[3rem] shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 md:p-8 border-b border-slate-50 flex flex-col md:flex-row md:justify-between md:items-center gap-3 bg-green-50/30">
          <h3 className="font-black text-slate-800 text-base md:text-xl flex items-center gap-2">
            <Tag className="text-emerald-500 flex-shrink-0" />
            {levelTitle}
            {amountUnit === 'thousand' && <span className="ml-1 text-emerald-500 text-sm">（千円）</span>}
          </h3>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-xs font-bold text-slate-400 flex items-center gap-1.5">
              <Calendar size={14} />
              {new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })}
            </div>
            <div className="flex gap-2 no-print">
              <button onClick={onSavePdf}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-xl border border-slate-200 text-slate-600 hover:text-emerald-500 hover:border-emerald-200 transition-all shadow-sm text-xs font-bold">
                <FileText size={14} /> PDF
              </button>
              <button onClick={onSaveCsv}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-xl border border-slate-200 text-slate-600 hover:text-emerald-500 hover:border-emerald-200 transition-all shadow-sm text-xs font-bold">
                <FileSpreadsheet size={14} /> CSV
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-green-900 text-sm md:text-xl font-black text-white tracking-wide text-center">
                <th className="px-1 md:px-2 py-3 md:py-4 w-10 md:w-12 text-center">選択</th>
                <th className="px-3 md:px-8 py-3 md:py-4 min-w-[140px] md:min-w-[200px] text-center">
                  {levelLabel}
                </th>
                {years.map(year => (
                  <th key={year} className="px-2 md:px-6 py-3 md:py-4 text-center border-l border-green-800 min-w-[120px]">
                    {year}年度
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">

              {/* 合計行 */}
              {totalRow && (
                <tr className="bg-emerald-50/50 border-b-2 border-emerald-200">
                  <td className="px-1 md:px-2 py-4 w-10 md:w-12 text-center">—</td>
                  <td className="px-3 md:px-8 py-4">
                    <div className="font-black text-emerald-700 text-sm md:text-lg">{totalRow.name}</div>
                  </td>
                  {years.map((year, yIdx) => {
                    const p = totalRow.profit[year]   || 0;
                    const q = totalRow.quantity[year] || 0;
                    const yoy = years[yIdx-1] ? calcYoY(p, totalRow.profit[years[yIdx-1]])   : null;
                    const qoy = years[yIdx-1] ? calcYoY(q, totalRow.quantity[years[yIdx-1]]) : null;
                    return (
                      <td key={year} className="px-2 md:px-6 py-4 border-l border-emerald-200">
                        <div className="space-y-2">
                          <div className="flex justify-between items-baseline">
                            <span className="text-[10px] font-black text-emerald-500">受注数</span>
                            <div className="text-right">
                              <div className="font-mono font-black text-emerald-800 text-xs md:text-base">{q.toLocaleString()}</div>
                              {qoy !== null && (
                                <div className={`text-[10px] font-black flex items-center justify-end gap-0.5 ${parseFloat(qoy) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                  {parseFloat(qoy) >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{qoy}%
                                </div>
                              )}
                            </div>
                          </div>
                          {showProfit && (
                            <div className="flex justify-between items-baseline">
                              <span className="text-[10px] font-black text-emerald-500">粗利</span>
                              <div className="text-right">
                                <div className="font-mono font-black text-emerald-600 text-xs md:text-base">{fmtAmt(p)}</div>
                                {yoy !== null && (
                                  <div className={`text-[10px] font-black flex items-center justify-end gap-0.5 ${parseFloat(yoy) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {parseFloat(yoy) >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{yoy}%
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              )}

              {data.length === 0 ? (
                <tr>
                  <td colSpan={years.length + 2} className="px-4 py-12 text-center text-slate-300 italic">
                    該当するデータがありません
                  </td>
                </tr>
              ) : (
                data.map((row, idx) => (
                  <tr key={idx}
                    className={`group hover:bg-emerald-50/30 transition-all ${!isLeafLevel ? 'cursor-pointer' : ''}`}
                    onClick={() => !isLeafLevel && onDrillDown(row)}>
                    <td className="px-1 md:px-2 py-4 w-10 md:w-12 align-middle text-center" onClick={e => e.stopPropagation()}>
                      <button type="button" onClick={() => toggleCheck(row.name)}
                        className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-emerald-600 transition-colors">
                        {checkedItems.has(row.name)
                          ? <CheckSquare size={16} className="text-emerald-600" />
                          : <Square size={16} className="text-slate-300" />}
                      </button>
                    </td>
                    <td className="px-3 md:px-8 py-4">
                      <div className="font-black text-slate-800 text-sm md:text-lg group-hover:text-emerald-600 transition-colors flex items-center gap-2">
                        {row.name}
                        {!isLeafLevel && (
                          <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-all -translate-x-2 group-hover:translate-x-0" />
                        )}
                      </div>
                      {!isLeafLevel && (
                        <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-tighter no-print">
                          クリックでドリルダウン
                        </div>
                      )}
                    </td>
                    {years.map((year, yIdx) => {
                      const p = row.profit[year]   || 0;
                      const q = row.quantity[year] || 0;
                      const yoy = years[yIdx-1] ? calcYoY(p, row.profit[years[yIdx-1]])   : null;
                      const qoy = years[yIdx-1] ? calcYoY(q, row.quantity[years[yIdx-1]]) : null;
                      return (
                        <td key={year} className="px-2 md:px-6 py-4 border-l border-slate-300 group-hover:bg-white/50">
                          <div className="space-y-2">
                            <div className="flex justify-between items-baseline">
                              <span className="text-[10px] font-black text-slate-600">受注数</span>
                              <div className="text-right">
                                <div className="font-mono font-black text-slate-700 text-xs md:text-base">{q.toLocaleString()}</div>
                                {qoy !== null && (
                                  <div className={`text-[10px] font-black flex items-center justify-end gap-0.5 ${parseFloat(qoy) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {parseFloat(qoy) >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{qoy}%
                                  </div>
                                )}
                              </div>
                            </div>
                            {showProfit && (
                              <div className="flex justify-between items-baseline">
                                <span className="text-[10px] font-black text-slate-600">粗利</span>
                                <div className="text-right">
                                  <div className="font-mono font-black text-emerald-600 text-xs md:text-base">{fmtAmt(p)}</div>
                                  {yoy !== null && (
                                    <div className={`text-[10px] font-black flex items-center justify-end gap-0.5 ${parseFloat(yoy) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                      {parseFloat(yoy) >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{yoy}%
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ===== 粗利収支分析ビュー =====

// 会計年度・月 → カレンダー年に変換（4月始まり想定：1〜3月は翌年）
const toCalYear = (fy, m) => m <= 3 ? fy + 1 : fy;

const ProductMarginView = ({ items, leaseCompanies }) => {
  // 空Set = すべて表示、値あり = 選択中のものだけ表示
  const [selectedLeases, setSelectedLeases] = useState(new Set());
  const [selectedItems,  setSelectedItems]  = useState(new Set());
  const [search, setSearch] = useState('');
  const [maxMargin, setMaxMargin] = useState('');
  const [sortKey, setSortKey] = useState('sales');
  const [sortAsc, setSortAsc] = useState(false);

  // 利用可能な年月（カレンダー年ベース）を昇順で列挙
  const ymOptions = useMemo(() => {
    const set = new Set();
    items.forEach(r => {
      if (r.fiscalYear && r.month) {
        set.add(toCalYear(r.fiscalYear, r.month) * 100 + r.month);
      }
    });
    return [...set].sort((a, b) => a - b).map(v => ({ year: Math.floor(v / 100), month: v % 100 }));
  }, [items]);

  const availYears = useMemo(() =>
    [...new Set(ymOptions.map(o => o.year))].sort((a, b) => a - b),
    [ymOptions]
  );

  const [fromYear,  setFromYear]  = useState(null);
  const [fromMonth, setFromMonth] = useState(null);
  const [toYear,    setToYear]    = useState(null);
  const [toMonth,   setToMonth]   = useState(null);

  // データ読み込み後、初期値を最初〜最後の年月にセット
  useEffect(() => {
    if (ymOptions.length === 0) return;
    const first = ymOptions[0];
    const last  = ymOptions[ymOptions.length - 1];
    setFromYear(first.year);
    setFromMonth(first.month);
    setToYear(last.year);
    setToMonth(last.month);
  }, [ymOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // 期間フィルター（カレンダー年月ベース）
  const byDateRange = useMemo(() => {
    if (!fromYear || !toYear) return items;
    const fromVal = fromYear * 100 + (fromMonth || 1);
    const toVal   = toYear   * 100 + (toMonth   || 12);
    return items.filter(r => {
      if (!r.fiscalYear || !r.month) return false;
      const val = toCalYear(r.fiscalYear, r.month) * 100 + r.month;
      return val >= fromVal && val <= toVal;
    });
  }, [items, fromYear, fromMonth, toYear, toMonth]);

  // リース会社フィルター（複数選択、空=すべて）
  const byLease = useMemo(() => {
    if (selectedLeases.size === 0) return byDateRange;
    return byDateRange.filter(r => selectedLeases.has(r.leaseCompany));
  }, [byDateRange, selectedLeases]);

  // リース会社×品番で集計（ALLOWED_ITEMSのみ対象、半角全角を区別しない）
  const aggregated = useMemo(() => {
    const allowedNorm = ALLOWED_ITEMS.map(norm);
    const map = {};
    byLease.forEach(r => {
      if (!allowedNorm.includes(norm(r.item))) return;
      const key = `${r.leaseCompany}||${r.productCode}`;
      if (!map[key]) {
        map[key] = {
          leaseCompany: r.leaseCompany,
          productCode: r.productCode,
          productName: r.productName || '',
          item: r.item || '',
          quantity: 0,
          sales: 0,
          profit: 0,
        };
      }
      map[key].quantity += r.quantity;
      map[key].sales    += r.sales;
      map[key].profit   += r.profit;
    });
    return Object.values(map).map(r => ({
      ...r,
      margin: r.sales > 0 ? (r.profit / r.sales * 100) : 0,
    }));
  }, [byLease]);

  // 分析名フィルター（複数選択・半角全角を区別しない、空=すべて）
  const byItem = useMemo(() => {
    if (selectedItems.size === 0) return aggregated;
    const normedSelected = [...selectedItems].map(norm);
    return aggregated.filter(r => normedSelected.includes(norm(r.item)));
  }, [aggregated, selectedItems]);

  // 品番・分類テキスト検索
  const searched = useMemo(() => {
    if (!search.trim()) return byItem;
    const q = search.toLowerCase();
    return byItem.filter(r =>
      r.productCode.toLowerCase().includes(q) ||
      r.item.toLowerCase().includes(q)
    );
  }, [byItem, search]);

  // 粗利率上限フィルター
  const filteredByMargin = useMemo(() => {
    const limit = parseFloat(maxMargin);
    if (maxMargin === '' || isNaN(limit)) return searched;
    return searched.filter(r => r.margin <= limit);
  }, [searched, maxMargin]);

  // ソート
  const sorted = useMemo(() => {
    return [...filteredByMargin].sort((a, b) => {
      const unitSalesA  = a.quantity > 0 ? a.sales  / a.quantity : 0;
      const unitSalesB  = b.quantity > 0 ? b.sales  / b.quantity : 0;
      const unitProfitA = a.quantity > 0 ? a.profit / a.quantity : 0;
      const unitProfitB = b.quantity > 0 ? b.profit / b.quantity : 0;
      let v;
      switch (sortKey) {
        case 'leaseCompany': v = a.leaseCompany.localeCompare(b.leaseCompany, 'ja'); break;
        case 'productCode':  v = a.productCode.localeCompare(b.productCode, 'ja'); break;
        case 'item':         v = a.item.localeCompare(b.item, 'ja'); break;
        case 'productName':  v = a.productName.localeCompare(b.productName, 'ja'); break;
        case 'quantity':     v = a.quantity - b.quantity; break;
        case 'profit':       v = a.profit - b.profit; break;
        case 'margin':       v = a.margin - b.margin; break;
        case 'unitSales':    v = unitSalesA - unitSalesB; break;
        case 'unitProfit':   v = unitProfitA - unitProfitB; break;
        default:             v = a.sales - b.sales;
      }
      return sortAsc ? v : -v;
    });
  }, [filteredByMargin, sortKey, sortAsc]);

  const totalQty    = filteredByMargin.reduce((s, r) => s + r.quantity, 0);
  const totalSales  = filteredByMargin.reduce((s, r) => s + r.sales, 0);
  const totalProfit = filteredByMargin.reduce((s, r) => s + r.profit, 0);
  const avgMargin   = totalSales > 0 ? (totalProfit / totalSales * 100) : 0;

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(false); }
  };

  const handleExportCsv = () => {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = ['リース会社', '品番', '分類（分析名）', '商品名', '個数', '売上', '売上単価', '粗利', '粗利単価', '粗利率(%)'];
    const lines = [headers.map(q).join(',')];
    sorted.forEach(r => {
      const unitSales  = r.quantity > 0 ? Math.round(r.sales  / r.quantity) : 0;
      const unitProfit = r.quantity > 0 ? Math.round(r.profit / r.quantity) : 0;
      lines.push([
        q(r.leaseCompany), q(r.productCode), q(r.item), q(r.productName),
        r.quantity, Math.round(r.sales), unitSales, Math.round(r.profit), unitProfit,
        r.margin.toFixed(1),
      ].join(','));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `メンテ粗利収支分析_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fmtYen = n => `¥${Math.round(n || 0).toLocaleString()}`;

  const SortTh = ({ label, skey, align = 'center' }) => (
    <th
      className={`px-3 py-3 cursor-pointer select-none hover:bg-green-700 transition-colors whitespace-nowrap`}
      onClick={() => handleSort(skey)}>
      <div className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : align === 'left' ? 'justify-start' : 'justify-center'}`}>
        {label}
        <ArrowUpDown size={11} className={sortKey === skey ? 'text-emerald-300' : 'text-green-700'} />
      </div>
    </th>
  );

  return (
    <div className="space-y-6 animate-fade-in-up">

      {/* ヘッダー */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="bg-emerald-600 p-2.5 rounded-xl text-white shadow-lg shadow-emerald-600/20">
          <Package size={22} />
        </div>
        <div>
          <h2 className="text-2xl font-black text-slate-800 tracking-tight">粗利収支分析</h2>
          <p className="text-xs text-slate-400 font-bold mt-0.5">リース会社 × 品番ごとの個数・売上・粗利・粗利率</p>
        </div>
        <button onClick={handleExportCsv} disabled={sorted.length === 0}
          className="ml-auto flex items-center gap-2 px-5 py-3 bg-green-900 text-white rounded-2xl text-xs font-black hover:bg-emerald-600 transition-all disabled:opacity-40 shadow-lg">
          <FileSpreadsheet size={15} /> CSV出力 ({sorted.length.toLocaleString()}件)
        </button>
      </div>

      {/* フィルターパネル */}
      <div className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100 space-y-4">

        {/* 期間（年月指定） */}
        <div className="space-y-2">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">期間</label>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 bg-slate-100 rounded-xl px-3 py-2">
              <select
                value={fromYear || ''}
                onChange={e => setFromYear(Number(e.target.value))}
                className="bg-transparent border-none text-sm font-black text-slate-700 focus:ring-0 cursor-pointer pr-1">
                {availYears.map(y => <option key={y} value={y}>{y}年</option>)}
              </select>
              <select
                value={fromMonth || ''}
                onChange={e => setFromMonth(Number(e.target.value))}
                className="bg-transparent border-none text-sm font-black text-slate-700 focus:ring-0 cursor-pointer pr-1">
                {[...Array(12)].map((_, i) => <option key={i+1} value={i+1}>{i+1}月</option>)}
              </select>
            </div>
            <span className="text-slate-400 font-black text-sm">〜</span>
            <div className="flex items-center gap-1 bg-slate-100 rounded-xl px-3 py-2">
              <select
                value={toYear || ''}
                onChange={e => setToYear(Number(e.target.value))}
                className="bg-transparent border-none text-sm font-black text-slate-700 focus:ring-0 cursor-pointer pr-1">
                {availYears.map(y => <option key={y} value={y}>{y}年</option>)}
              </select>
              <select
                value={toMonth || ''}
                onChange={e => setToMonth(Number(e.target.value))}
                className="bg-transparent border-none text-sm font-black text-slate-700 focus:ring-0 cursor-pointer pr-1">
                {[...Array(12)].map((_, i) => <option key={i+1} value={i+1}>{i+1}月</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* リース会社（複数選択） */}
        <div className="space-y-2">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
            リース会社
            {selectedLeases.size > 0 && (
              <span className="ml-2 text-emerald-500">{selectedLeases.size}件選択中</span>
            )}
          </label>
          <div className="flex gap-2 flex-wrap">
            {/* すべてボタン：選択リセット */}
            <button
              onClick={() => setSelectedLeases(new Set())}
              className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all duration-200 ${
                selectedLeases.size === 0
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}>
              すべて
            </button>
            {leaseCompanies.map(l => {
              const active = selectedLeases.has(l);
              return (
                <button key={l}
                  onClick={() => setSelectedLeases(prev => {
                    const next = new Set(prev);
                    active ? next.delete(l) : next.add(l);
                    return next;
                  })}
                  className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all duration-200 ${
                    active
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}>
                  {l}
                </button>
              );
            })}
          </div>
        </div>

        {/* 分析名フィルター（複数選択） */}
        <div className="space-y-2">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
            分析名
            {selectedItems.size > 0 && (
              <span className="ml-2 text-emerald-500">{selectedItems.size}件選択中</span>
            )}
          </label>
          <div className="flex gap-2 flex-wrap">
            {/* すべてボタン：選択リセット */}
            <button
              onClick={() => setSelectedItems(new Set())}
              className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all duration-200 ${
                selectedItems.size === 0
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}>
              すべて
            </button>
            {ALLOWED_ITEMS.map(it => {
              const active = selectedItems.has(it);
              return (
                <button key={it}
                  onClick={() => setSelectedItems(prev => {
                    const next = new Set(prev);
                    active ? next.delete(it) : next.add(it);
                    return next;
                  })}
                  className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all duration-200 ${
                    active
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}>
                  {it}
                </button>
              );
            })}
          </div>
        </div>

        {/* 品番・分類検索 ＋ 粗利率上限フィルター */}
        <div className="space-y-2">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">品番・分類 検索</label>
          <div className="flex items-center gap-3 flex-wrap">
            {/* 品番検索 */}
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="品番または分析名で絞り込み..."
                className="w-64 bg-slate-100 rounded-xl pl-8 pr-8 py-2.5 text-sm font-bold text-slate-700 border-none outline-none focus:ring-2 focus:ring-emerald-400"
              />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X size={14} />
                </button>
              )}
            </div>
            {/* 粗利率上限フィルター */}
            <div className="flex items-center gap-2 bg-slate-100 rounded-xl px-3 py-2 h-[42px]">
              <span className="text-[11px] font-black text-slate-400 whitespace-nowrap">粗利率</span>
              <input
                type="number"
                min="-100"
                max="100"
                step="1"
                value={maxMargin}
                onChange={e => setMaxMargin(e.target.value)}
                placeholder="—"
                className="w-14 bg-transparent border-none outline-none text-sm font-black text-slate-700 text-center focus:ring-0 p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="text-[11px] font-black text-slate-400 whitespace-nowrap">%以下</span>
              {maxMargin !== '' && (
                <button onClick={() => setMaxMargin('')}
                  className="text-slate-400 hover:text-slate-600 ml-1">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* サマリーカード */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: '品番数',    value: filteredByMargin.length.toLocaleString(),   color: 'text-emerald-700', bg: 'bg-emerald-50' },
          { label: '合計個数',  value: totalQty.toLocaleString(),          color: 'text-slate-700',   bg: 'bg-white' },
          { label: '合計売上',  value: fmtYen(totalSales),                 color: 'text-slate-700',   bg: 'bg-white' },
          { label: '合計粗利',  value: fmtYen(totalProfit),                color: totalProfit >= 0 ? 'text-emerald-600' : 'text-rose-600', bg: 'bg-white' },
          { label: '平均粗利率', value: `${avgMargin.toFixed(1)}%`,        color: avgMargin >= 20 ? 'text-emerald-600' : avgMargin >= 10 ? 'text-amber-600' : 'text-rose-600', bg: 'bg-white' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} className={`${bg} rounded-2xl p-4 shadow-sm border border-slate-100`}>
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">{label}</div>
            <div className={`text-base md:text-xl font-black ${color} font-mono`}>{value}</div>
          </div>
        ))}
      </div>

      {/* テーブル */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-green-900 text-white text-xs font-black uppercase tracking-wide">
                <SortTh label="リース会社"     skey="leaseCompany"  align="left" />
                <SortTh label="品番"           skey="productCode"   align="left" />
                <SortTh label="分類（分析名）" skey="item"          align="left" />
                <SortTh label="商品名"         skey="productName"   align="left" />
                <SortTh label="個数"       skey="quantity"    align="right" />
                <SortTh label="売上"       skey="sales"       align="right" />
                <SortTh label="売上単価"   skey="unitSales"   align="right" />
                <SortTh label="粗利"       skey="profit"      align="right" />
                <SortTh label="粗利単価"   skey="unitProfit"  align="right" />
                <SortTh label="粗利率"     skey="margin"      align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-slate-300 italic">
                    該当データがありません
                  </td>
                </tr>
              ) : sorted.map((r, i) => {
                const isNegative  = r.profit < 0;
                const isLowMargin = !isNegative && r.margin < 10;
                const unitSales  = r.quantity > 0 ? r.sales  / r.quantity : 0;
                const unitProfit = r.quantity > 0 ? r.profit / r.quantity : 0;
                return (
                  <tr key={i}
                    className={`hover:bg-emerald-50/30 transition-all ${isNegative ? 'bg-rose-50' : ''}`}>
                    <td className="px-3 py-3 font-bold text-slate-700 whitespace-nowrap">{r.leaseCompany}</td>
                    <td className="px-3 py-3 font-mono font-black text-slate-800 whitespace-nowrap text-xs">{r.productCode}</td>
                    <td className="px-3 py-3 text-slate-600 max-w-[180px] truncate" title={r.item}>{r.item}</td>
                    <td className="px-3 py-3 text-slate-600 max-w-[220px] truncate" title={r.productName}>{r.productName}</td>
                    <td className="px-3 py-3 font-mono font-bold text-slate-700 text-right">{r.quantity.toLocaleString()}</td>
                    <td className="px-3 py-3 font-mono font-bold text-slate-700 text-right">{fmtYen(r.sales)}</td>
                    <td className="px-3 py-3 font-mono font-bold text-slate-500 text-right text-xs">{fmtYen(unitSales)}</td>
                    <td className={`px-3 py-3 font-mono font-bold text-right ${isNegative ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {fmtYen(r.profit)}
                    </td>
                    <td className={`px-3 py-3 font-mono font-bold text-right text-xs ${isNegative ? 'text-rose-400' : 'text-emerald-500'}`}>
                      {fmtYen(unitProfit)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded-lg text-xs font-black ${
                        isNegative  ? 'bg-rose-100 text-rose-700' :
                        isLowMargin ? 'bg-amber-100 text-amber-700' :
                                      'bg-emerald-100 text-emerald-700'
                      }`}>
                        {r.margin.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {sorted.length > 0 && (
          <div className="p-4 border-t border-slate-100 text-xs text-slate-400 font-bold text-right">
            {sorted.length.toLocaleString()} 件表示（全{aggregated.length.toLocaleString()}件中）
            {maxMargin !== '' && !isNaN(parseFloat(maxMargin)) && (
              <span className="ml-2 text-amber-500">粗利率 {maxMargin}%以下でフィルター中</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
