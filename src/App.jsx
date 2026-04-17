import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ChevronRight, Building2, Tag,
  ArrowUpRight, ArrowDownRight, LayoutDashboard, Database,
  Calendar, RefreshCcw, CheckCircle2, FileText, FileSpreadsheet,
  AlertCircle, Loader2, XCircle, Eye, EyeOff,
  CheckSquare, Square, Menu, X,
} from 'lucide-react';
import { getCache, setCache, clearCache } from './utils/db';
import { loadCsvData } from './utils/csvLoader';
import {
  filterRows, aggregateByBranch, aggregateByItem,
  generateDetailCsvContent, calcYoY, formatCurrency, formatCurrencyFull,
} from './utils/aggregator';

const CACHE_KEY = 'maint_report_data_v1';

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
  const [activeView, setActiveView] = useState({ branchName: null });
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

  // データ読み込み後：最新月を終了月に設定
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

  const years = useMemo(() => rawData?.years || [], [rawData]);

  const leaseCompanies = useMemo(() =>
    rawData?.leaseCompanies?.filter(lc => lc && lc.trim()) || [],
    [rawData]
  );

  const currentTableData = useMemo(() => {
    if (!filteredRows.length || !years.length) return [];
    const { branchName } = activeView;
    if (!branchName) return aggregateByBranch(filteredRows, years);
    return aggregateByItem(filteredRows, years, branchName);
  }, [filteredRows, years, activeView]);

  useEffect(() => {
    if (!currentTableData.length) return;
    setCheckedItems(new Set(currentTableData.map(d => d.name)));
  }, [activeView.branchName]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLeafLevel = !!activeView.branchName;

  const totalRow = useMemo(() => {
    if (!currentTableData.length || !years.length) return null;
    const filtered = currentTableData.filter(item => checkedItems.has(item.name));
    if (!filtered.length) return null;
    const profit = {}, quantity = {};
    years.forEach(y => { profit[y] = 0; quantity[y] = 0; });
    filtered.forEach(item => years.forEach(y => {
      profit[y]   += item.profit[y]   || 0;
      quantity[y] += item.quantity[y] || 0;
    }));
    const label = !activeView.branchName ? '全部店 合計' : `${activeView.branchName} 合計`;
    return { name: label, profit, quantity };
  }, [currentTableData, years, activeView, checkedItems]);

  const handleDrillDown = (item) => {
    if (isLeafLevel) return;
    setActiveView({ branchName: item.name });
  };

  const handleBreadcrumb = () => setActiveView({ branchName: null });
  const handleRefresh = () => loadData(true);

  const handleSaveCsv = () => {
    const { branchName } = activeView;
    let rows = filteredRows;
    if (branchName) rows = rows.filter(r => r.branch === branchName);
    if (!rows.length) return;
    const csv = generateDetailCsvContent(rows);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `メンテ実績_${branchName || 'ALL'}_${new Date().toISOString().slice(0, 10)}.csv`;
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
          <div className="flex items-center gap-3 w-full p-4 rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105">
            <LayoutDashboard size={20} />
            <span className="font-black text-sm tracking-tight">分析ダッシュボード</span>
          </div>

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

          {/* Filters */}
          <div className="bg-white p-4 md:p-8 rounded-3xl md:rounded-[3rem] shadow-sm border border-slate-100 flex flex-wrap gap-6 md:gap-12 items-start md:items-center">

            <div className="space-y-3 w-full">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">
                メンテ（リース会社）選択
              </label>
              <div className="flex gap-2 flex-wrap">
                {['ALL', ...leaseCompanies].map(l => (
                  <button key={l}
                    onClick={() => { setSelectedLeaseCo(l); setActiveView({ branchName: null }); }}
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

            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">粗利表示</label>
              <button onClick={() => setShowProfit(p => !p)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-black transition-all duration-300 ${showProfit ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-200' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}>
                {showProfit ? <Eye size={14} /> : <EyeOff size={14} />}
                {showProfit ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
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

        {rawData && !isLoading && (
          <DashboardView
            data={currentTableData}
            years={years}
            activeView={activeView}
            isLeafLevel={isLeafLevel}
            checkedItems={checkedItems}
            onCheckedChange={setCheckedItems}
            onDrillDown={handleDrillDown}
            onBreadcrumb={handleBreadcrumb}
            onSavePdf={handleSavePdf}
            onSaveCsv={handleSaveCsv}
            fmtAmt={fmtAmt}
            amountUnit={amountUnit}
            showProfit={showProfit}
            totalRow={totalRow}
          />
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
  data, years, activeView, isLeafLevel, checkedItems, onCheckedChange,
  onDrillDown, onBreadcrumb, onSavePdf, onSaveCsv, fmtAmt, amountUnit, showProfit, totalRow,
}) => {
  const toggleCheck = useCallback((name) => {
    onCheckedChange(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }, [onCheckedChange]);

  const levelLabel = !activeView.branchName ? '部店名（工場様）' : 'アイテム（分析名）';
  const levelTitle = !activeView.branchName ? '部店別 年次実績比較' : `${activeView.branchName} アイテム別実績`;

  return (
    <div className="space-y-4 md:space-y-8 animate-fade-in-up">

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 md:gap-2 text-xs md:text-sm font-bold no-print flex-wrap">
        <button onClick={onBreadcrumb}
          className={`flex items-center gap-1 transition-colors ${!activeView.branchName ? 'text-emerald-600' : 'text-slate-400 hover:text-slate-600'}`}>
          <Building2 size={16} /> 部店一覧
        </button>
        {activeView.branchName && (
          <>
            <ChevronRight size={14} className="text-slate-300" />
            <span className="text-emerald-600 flex items-center gap-1">
              <Tag size={16} /> {activeView.branchName}
            </span>
          </>
        )}
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
                data.map((item, idx) => (
                  <tr key={idx}
                    className={`group hover:bg-emerald-50/30 transition-all ${!isLeafLevel ? 'cursor-pointer' : ''}`}
                    onClick={() => !isLeafLevel && onDrillDown(item)}>
                    <td className="px-1 md:px-2 py-4 w-10 md:w-12 align-middle text-center" onClick={e => e.stopPropagation()}>
                      <button type="button" onClick={() => toggleCheck(item.name)}
                        className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-emerald-600 transition-colors">
                        {checkedItems.has(item.name)
                          ? <CheckSquare size={16} className="text-emerald-600" />
                          : <Square size={16} className="text-slate-300" />}
                      </button>
                    </td>
                    <td className="px-3 md:px-8 py-4">
                      <div className="font-black text-slate-800 text-sm md:text-lg group-hover:text-emerald-600 transition-colors flex items-center gap-2">
                        {item.name}
                        {!isLeafLevel && (
                          <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-all -translate-x-2 group-hover:translate-x-0" />
                        )}
                      </div>
                      {!isLeafLevel && (
                        <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-tighter no-print">
                          クリックでアイテム別を表示
                        </div>
                      )}
                    </td>
                    {years.map((year, yIdx) => {
                      const p = item.profit[year]   || 0;
                      const q = item.quantity[year] || 0;
                      const yoy = years[yIdx-1] ? calcYoY(p, item.profit[years[yIdx-1]])   : null;
                      const qoy = years[yIdx-1] ? calcYoY(q, item.quantity[years[yIdx-1]]) : null;
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

export default App;
