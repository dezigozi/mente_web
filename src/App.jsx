import React, { useState, useMemo, useCallback, useEffect, useTransition, memo } from 'react';
import {
  ChevronRight, ChevronDown, ChevronUp, Building2, Tag, Layers,
  ArrowUpRight, ArrowDownRight, LayoutDashboard, Database,
  Calendar, RefreshCcw, CheckCircle2, FileText, FileSpreadsheet,
  AlertCircle, Loader2, XCircle, Eye, EyeOff,
  CheckSquare, Square, Menu, X, Package, Search, ArrowUpDown,
} from 'lucide-react';
import { getCache, setCache, clearCache } from './utils/db';
import { loadCsvData, generateFullDataCsvContent, loadTabData } from './utils/csvLoader';
/**
 * メンテ実績ダッシュ（単一ファイル構成）
 *
 * パフォーマンス方針（大規模 rows[] 前提）:
 * - 会計月の絞り込みは全行1回: filterRowsInMonthRange。リース/得意先は同配列に対し Set。filterRows 二重走査にしない。
 * - 分析名(大)の許容集合は事前 Set（ALLOWED_ITEM_NORM_SET）。行は norm を1回だけ。
 * - 工場階層専用の導出（工場名一覧・サジェスト）は viewMode==='B' のときだけ useMemo する。
 * - 粗利タブ用 allProductMonthly は reportMode==='margin' 時だけ構築する。
 * - 操作に伴う大きい再描画を startTransition で遅延優先に。DashboardView は React.memo。
 */
import {
  filterRows,
  filterRowsInMonthRange,
  aggregateByLease,
  aggregateByItemForLease,
  aggregateByBranchB,
  aggregateByOrdererForFactory,
  aggregateByMenteUnderFactory,
  aggregateByItemUnderFactoryMente,
  aggregateByProductCode,
  generateDetailCsvContent, calcYoY, formatCurrencyFull,
} from './utils/aggregator';

const CACHE_KEY = 'maint_report_data_v10';

const ALLOWED_ITEMS = ['オルタネーター', 'スターター', 'コンプレッサー', 'エアコン関連'];
// NFKC正規化：半角カナ→全角カナ、全角英数→半角英数 に統一して比較
const norm = s => (s || '').normalize('NFKC').trim();

/** 分析名フィルタ用（行ごとの norm 呼び出しを減らす） */
const ALLOWED_ITEM_NORM_SET = (() => {
  const s = new Set();
  for (const x of ALLOWED_ITEMS) s.add(norm(x));
  return s;
})();

/** 工場名ドロップダウン1画面あたりの行数（数千DOMで描画が固まるのを防ぐ） */
const B_FACTORY_CHECKBOX_CAP = 500;

/**
 * 工場名ドロップダウン: 1画面に出す行（残りは検索で拾う誘導）
 */
const BFactoryMultiSelect = ({
  bFactoryListAll, bFactoryListDisplay, bFactoryListOverflow,
  bFactoryQuery, onQueryChange,
  bFactorySelected, onToggle, onSelectAllInView, onClear,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative w-full min-w-0">
      <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-0.5 mb-1">
        工場名
      </div>
      <input
        type="text"
        value={bFactoryQuery}
        onChange={e => { onQueryChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { setTimeout(() => setOpen(false), 200); }}
        autoComplete="off"
        placeholder="名前一覧を絞り、複数にチェック"
        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
      />
      {bFactorySelected.length > 0 && (
        <div className="text-[10px] font-bold text-emerald-600 mt-0.5">{bFactorySelected.length}件選択中</div>
      )}
      {open && bFactoryListDisplay.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg p-1">
          {bFactoryListDisplay.map(s => {
            const checked = bFactorySelected.includes(s);
            return (
              <li key={s} className="hover:bg-emerald-50/60 rounded-lg">
                <label className="flex items-start gap-2 cursor-pointer px-2 py-1.5 text-xs font-bold text-slate-800">
                  <input
                    type="checkbox"
                    className="mt-0.5 flex-shrink-0"
                    checked={checked}
                    onChange={() => onToggle(s)}
                    onClick={e => e.stopPropagation()}
                  />
                  <span className="text-left break-all font-bold text-slate-800">{s}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 mt-1 no-print">
        <button
          type="button"
          onClick={() => onSelectAllInView(bFactoryListDisplay)}
          className="text-[10px] font-black text-slate-500 hover:text-emerald-600"
        >
          表示中を全て選択
        </button>
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] font-black text-slate-500 hover:text-rose-600"
        >
          選択をクリア
        </button>
        <span className="text-[9px] text-slate-400">候補 {bFactoryListAll.length} 件{bFactoryListOverflow > 0 ? `（先頭${B_FACTORY_CHECKBOX_CAP}件表示）` : ''}</span>
      </div>
    </div>
  );
};

/**
 * パターンB: 工場名(複数)・電話・都道府県
 */
function applyBFactorySearchFilters(rows, { factoryNames, phone, pref }) {
  if (!rows?.length) return rows;
  let out = rows;
  if (factoryNames && factoryNames.length) {
    const s = new Set(factoryNames);
    out = out.filter(r => s.has(r.branchCompany || r.branch));
  }
  const dP = (phone || '').replace(/\D/g, '');
  if (dP) {
    out = out.filter(r => (r.phoneSearchStr || '').includes(dP));
  }
  const nPr = (pref || '').trim();
  if (nPr) {
    const n3 = norm(nPr);
    out = out.filter(r => norm(r.prefecture || '').includes(n3));
  }
  return out;
}

/**
 * 候補付きテキスト（絞り込み用）
 */
const SuggestTextInput = ({ label, value, onChange, suggestions, placeholder, id, compact }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative w-full min-w-0"
      onBlur={() => { setTimeout(() => setOpen(false), 150); }}
    >
      <label htmlFor={id} className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-0.5 block mb-1">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="text"
          value={value}
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
          placeholder={placeholder}
          className={compact
            ? 'w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400'
            : 'w-full bg-slate-100 border-0 rounded-2xl px-4 py-2.5 text-sm font-bold text-slate-700 focus:ring-2 focus:ring-emerald-500/20 focus:bg-white'}
        />
        {open && suggestions && suggestions.length > 0 && (
          <ul className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg text-left text-xs font-bold text-slate-700">
            {suggestions.map((s, i) => {
              const main = typeof s === 'string' ? s : s.label;
              const sub = typeof s === 'string' ? null : s.sublabel;
              const fac = typeof s === 'string' ? null : s.factory;
              return (
                <li key={i}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-emerald-50 flex items-start justify-between gap-2"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { onChange(typeof s === 'string' ? s : s.value); setOpen(false); }}
                  >
                    <div className="min-w-0 flex-1">
                      <div>{main}</div>
                      {sub && <span className="block text-[10px] font-bold text-slate-400 tracking-tight mt-0.5">{sub}</span>}
                    </div>
                    {fac ? (
                      <div className="text-[10px] font-bold text-emerald-700 line-clamp-2 max-w-[45%] flex-shrink-0 text-right leading-tight">
                        {fac}
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

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

  /** メンテ(リース)複数。空＝全件 */
  const [selectedLeases, setSelectedLeases] = useState([]);
  /** 分類（分析名(大)）ALLOWED_ITEMS からの複数。空＝4分類すべて（パターンAのUIのみ。パイプラインはA/B共通で適用） */
  const [selectedItemCategories, setSelectedItemCategories] = useState([]);
  /** 得意先名(列E)複数。空＝全件 */
  const [selectedOrderClients, setSelectedOrderClients] = useState([]);
  const [orderClientQuery, setOrderClientQuery] = useState('');
  /** 得意先名: クリックで開くパネル（常時表示にしない） */
  const [orderClientPanelOpen, setOrderClientPanelOpen] = useState(false);
  const [monthRange, setMonthRange] = useState({ start: '4', end: '3' });
  const [amountUnit, setAmountUnit] = useState('yen');
  const [showProfit, setShowProfit] = useState(true);
  const [checkedItems, setCheckedItems] = useState(new Set());
  // activeView: 現在のドリルダウン位置
  const [activeView, setActiveView] = useState({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
  // viewMode: 'A' = リース→分類→品番 / 'B' = 工場階層（受注数のみ）
  const [viewMode, setViewMode] = useState('A');
  /**
   * パターンBの2系統: orderer = 工場→注文者（終了）/ menteItem = 工場→メンテ(AQ)→分析名(大)
   */
  const [viewBVariant, setViewBVariant] = useState('orderer');
  /** パターンB: 工場名(複数)・電話・都道府県 */
  const [bFactoryQuery, setBFactoryQuery] = useState('');
  const [bFactorySelected, setBFactorySelected] = useState([]);
  const [bSearchPhone, setBSearchPhone] = useState('');
  const [bSearchPref, setBSearchPref] = useState('');
  const [reportMode, setReportMode] = useState('dashboard'); // 'dashboard' | 'margin' | 'tab'
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [, startTransition] = useTransition();

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
      const { rows, ...rest } = csvData;
      await setCache(CACHE_KEY, {
        data: { ...rest, rows: rows.map(({ rawRow, ...r }) => r) },
        timestamp: Date.now(),
      });
      setRawData({ ...csvData, fromCache: false, cacheAgeMsg: '最新' });
      setConnectionStatus('online');
    } catch (err) {
      console.error('データ読み込みエラー:', err);
      // オフライン・配信欠け時: IndexedDB にキャッシュがあれば前回データを表示（赤エラーは出さない）
      let recovered = false;
      try {
        const fromStore = await getCache(CACHE_KEY);
        if (fromStore?.data?.rows?.length) {
          const ageMin = Math.floor((Date.now() - fromStore.timestamp) / 60000);
          setRawData({
            ...fromStore.data,
            fromCache: true,
            cacheAgeMsg: `${ageMin}分前（最新CSV取得失敗。キャッシュ表示。master_data 配置を確認）`,
          });
          setLoadError(null);
          setConnectionStatus('online');
          recovered = true;
        }
      } catch (_) { /* noop */ }
      if (!recovered) {
        const reason = err instanceof Error ? err.message : String(err);
        setLoadError(
          `CSVの読み込みに失敗しました。本番では public/data/master_data.csv をデプロイに含め、ローカルは「npm run dev」で起動（file:// 不可）してください。詳細: ${reason}`
        );
        setConnectionStatus('offline');
      }
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

  // 会計月範囲は全行1周のみ。以降の絞り込みは同配列＋Set（二重の filterRows 全件走査を避ける）
  const rowsInMonth = useMemo(
    () => (rawData?.rows?.length ? filterRowsInMonthRange(rawData.rows, monthRange.start, monthRange.end) : []),
    [rawData, monthRange.start, monthRange.end]
  );

  const filteredRows = useMemo(() => {
    const leaseSet = selectedLeases.length ? new Set(selectedLeases) : null;
    const orderSet = selectedOrderClients.length ? new Set(selectedOrderClients) : null;
    if (!leaseSet && !orderSet) return rowsInMonth;
    return rowsInMonth.filter((row) => {
      if (leaseSet && !leaseSet.has(row.leaseCompany ?? '')) return false;
      if (orderSet) {
        const o = row.orderClient ?? '(未分類)';
        if (!orderSet.has(o)) return false;
      }
      return true;
    });
  }, [rowsInMonth, selectedLeases, selectedOrderClients]);

  // ダッシュ用：分析名(大)白／ALLOWED_ITEMS 相当のみ。分類の複数選択は空＝4分類すべて
  const dashboardRows = useMemo(
    () => {
      const itemNormSet = selectedItemCategories.length
        ? new Set(selectedItemCategories.map((x) => norm(x)))
        : null;
      return filteredRows.filter((r) => {
        const it = r.item;
        if (!it || !ALLOWED_ITEM_NORM_SET.has(norm(it))) return false;
        if (itemNormSet && !itemNormSet.has(norm(it))) return false;
        return true;
      });
    },
    [filteredRows, selectedItemCategories]
  );

  /** 工場名 → 住所１（工場トップ階層の一覧セル専用） */
  const factoryAddressByBranch = useMemo(() => {
    const m = new Map();
    for (const r of dashboardRows) {
      const k = r.branchCompany || r.branch;
      if (!k || k === '(未分類)') continue;
      const a = (r.address1 || '').trim();
      if (!a) continue;
      if (!m.has(k)) m.set(k, a);
    }
    return m;
  }, [dashboardRows]);

  /** 工場名 → 宅配先電話（トップ階層の一覧表示・コピー用。先出1件） */
  const factoryPhoneByBranch = useMemo(() => {
    const m = new Map();
    for (const r of dashboardRows) {
      const k = r.branchCompany || r.branch;
      if (!k || k === '(未分類)') continue;
      const p = (r.deliveryPhone || '').trim();
      if (!p) continue;
      if (!m.has(k)) m.set(k, p);
    }
    return m;
  }, [dashboardRows]);

  useEffect(() => {
    if (viewMode !== 'B') {
      setBFactoryQuery('');
      setBFactorySelected([]);
      setBSearchPhone('');
      setBSearchPref('');
    }
  }, [viewMode]);

  const dashboardRowsB = useMemo(
    () => (viewMode === 'B' ? applyBFactorySearchFilters(dashboardRows, {
      factoryNames: bFactorySelected, phone: bSearchPhone, pref: bSearchPref,
    }) : dashboardRows),
    [viewMode, dashboardRows, bFactorySelected, bSearchPhone, bSearchPref]
  );

  const bSourceRows = viewMode === 'B' ? dashboardRowsB : dashboardRows;

  const bFactoryListAll = useMemo(() => {
    if (viewMode !== 'B' || !dashboardRows.length) return [];
    const set = new Set();
    for (const r of dashboardRows) {
      const c = r.branchCompany || r.branch;
      if (c && c !== '(未分類)') set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ja'));
  }, [viewMode, dashboardRows]);

  const bFactoryListFiltered = useMemo(() => {
    const q = norm(bFactoryQuery);
    if (!q) return bFactoryListAll;
    return bFactoryListAll.filter(s => norm(s).includes(q));
  }, [bFactoryListAll, bFactoryQuery]);

  const bFactoryListDisplay = useMemo(
    () => bFactoryListFiltered.slice(0, B_FACTORY_CHECKBOX_CAP),
    [bFactoryListFiltered]
  );
  const bFactoryListOverflow = Math.max(0, bFactoryListFiltered.length - bFactoryListDisplay.length);

  const bSuggestPhone = useMemo(() => {
    if (viewMode !== 'B') return [];
    const byKey = new Map();
    for (const r of dashboardRows) {
      const k = r.phoneSearchStr;
      if (!k || byKey.has(k)) continue;
      const raw = (r.deliveryPhone || '').trim() || k;
      const factory = (r.branchCompany || r.branch || '').trim() || '—';
      byKey.set(k, {
        value: r.deliveryPhone || k,
        label: raw,
        sublabel: k.length >= 2 ? k : '',
        factory,
      });
    }
    const list = Array.from(byKey.values());
    const d = bSearchPhone.replace(/\D/g, '');
    if (!d) return list.slice(0, 50);
    return list
      .filter(
        s => s.label.replace(/\D/g, '').includes(d)
          || (s.sublabel && s.sublabel.includes(d))
      )
      .slice(0, 50);
  }, [viewMode, dashboardRows, bSearchPhone]);

  const bSuggestPref = useMemo(() => {
    if (viewMode !== 'B') return [];
    const set = new Set();
    for (const r of dashboardRows) {
      if (r.prefecture) set.add(r.prefecture);
    }
    const all = Array.from(set).sort((a, b) => a.localeCompare(b, 'ja'));
    const q = norm(bSearchPref);
    if (!q) return all.slice(0, 50);
    return all.filter(s => norm(s).includes(q)).slice(0, 50);
  }, [viewMode, dashboardRows, bSearchPref]);

  const years = useMemo(() => rawData?.years || [], [rawData]);

  const leaseCompanies = useMemo(() =>
    rawData?.leaseCompanies?.filter(lc => lc && lc.trim()) || [],
    [rawData]
  );

  const orderClientOptions = useMemo(() => {
    if (!rowsInMonth.length) return [];
    const leaseSet = selectedLeases.length ? new Set(selectedLeases) : null;
    const src = leaseSet
      ? rowsInMonth.filter(r => leaseSet.has(r.leaseCompany ?? ''))
      : rowsInMonth;
    const s = new Set();
    for (const r of src) {
      if (r.orderClient && r.orderClient !== '(未分類)') s.add(r.orderClient);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'ja'));
  }, [rowsInMonth, selectedLeases]);

  const orderClientOptionsForSelect = useMemo(() => {
    if (!orderClientOptions.length) return [];
    const q = norm(orderClientQuery);
    if (!q) return orderClientOptions;
    const matched = orderClientOptions.filter(o => norm(o).includes(q));
    const mset = new Set(matched);
    const mustShow = selectedOrderClients.filter(n => !mset.has(n));
    return [...mustShow, ...matched].filter((n, i, a) => a.indexOf(n) === i);
  }, [orderClientOptions, orderClientQuery, selectedOrderClients]);

  // 粗利タブ表示時だけ全行畳み込み（ダッシュ切替のたびに走らせない）
  const allProductMonthly = useMemo(() => {
    if (reportMode !== 'margin' || !rawData?.rows) return [];
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
  }, [rawData, reportMode]);

  const currentTableData = useMemo(() => {
    if (!bSourceRows.length || !years.length) return [];
    const { leaseCo, branch, item } = activeView;

    if (viewMode === 'A') {
      if (item !== null) {
        return aggregateByProductCode(bSourceRows, years, { leaseCo, branch, item });
      }
      if (leaseCo !== null) return aggregateByItemForLease(bSourceRows, years, leaseCo);
      return aggregateByLease(bSourceRows, years);
    }

    if (viewBVariant === 'orderer') {
      if (branch !== null) {
        return aggregateByOrdererForFactory(bSourceRows, years, branch);
      }
      return aggregateByBranchB(bSourceRows, years);
    }
    if (branch !== null && leaseCo !== null) {
      return aggregateByItemUnderFactoryMente(bSourceRows, years, branch, leaseCo);
    }
    if (branch !== null) {
      return aggregateByMenteUnderFactory(bSourceRows, years, branch);
    }
    return aggregateByBranchB(bSourceRows, years);
  }, [bSourceRows, years, activeView, viewMode, viewBVariant]);

  // viewが変わるたびにチェック状態をリセット
  const viewKey = `${viewMode}|${viewBVariant}|${bFactoryQuery}|${[...bFactorySelected].sort().join('¦')}|${bSearchPhone}|${bSearchPref}|${[...selectedLeases].sort().join('¦')}|${[...selectedItemCategories].sort().join('¦')}|${[...selectedOrderClients].sort().join('¦')}|${activeView.leaseCo}|${activeView.branch}|${activeView.item}|${activeView.orderer ?? ''}`;
  useEffect(() => {
    if (!currentTableData.length) return;
    setCheckedItems(new Set(currentTableData.map(d => d.name)));
  }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLeafLevel = viewMode === 'A'
    ? activeView.item !== null
    : (viewBVariant === 'orderer'
      ? activeView.branch != null
      : (activeView.branch != null && activeView.leaseCo != null));

  const totalRow = useMemo(() => {
    if (!currentTableData.length || !years.length) return null;
    const filtered = currentTableData.filter(d => checkedItems.has(d.name));
    if (!filtered.length) return null;
    const profit = {}, quantity = {}, sales = {};
    years.forEach(y => { profit[y] = 0; quantity[y] = 0; sales[y] = 0; });
    filtered.forEach(d => years.forEach(y => {
      profit[y]   += d.profit[y]   || 0;
      quantity[y] += d.quantity[y] || 0;
      sales[y]     += d.sales?.[y]  || 0;
    }));
    const { leaseCo, branch, item } = activeView;
    let label = '全体 合計';
    if (viewMode === 'A') {
      if (item !== null) label = `${item} 合計`;
      else if (leaseCo !== null) label = `${leaseCo} 合計`;
    } else {
      if (viewBVariant === 'orderer') {
        if (branch !== null) label = `${branch} 合計`;
      } else {
        if (leaseCo !== null && branch !== null) label = `${leaseCo} 合計`;
        else if (branch !== null) label = `${branch} 合計`;
      }
    }
    return { name: label, profit, quantity, sales };
  }, [currentTableData, years, activeView, checkedItems, viewMode, viewBVariant]);

  const handleDrillDown = useCallback((row) => {
    if (isLeafLevel) return;
    const { leaseCo, branch } = activeView;
    if (viewMode === 'A') {
      if (leaseCo === null) {
        setActiveView({ leaseCo: row.name, branch: null, item: null, orderClient: null, orderer: null });
      } else {
        setActiveView(prev => ({ ...prev, item: row.name }));
      }
    } else {
      if (viewBVariant === 'orderer') {
        if (branch === null) {
          setActiveView({ leaseCo: null, branch: row.name, item: null, orderClient: null, orderer: null });
        }
        return;
      }
      if (branch === null) {
        setActiveView({ leaseCo: null, branch: row.name, item: null, orderClient: null, orderer: null });
      } else if (leaseCo === null) {
        setActiveView(prev => ({ ...prev, leaseCo: row.name, item: null, orderer: null }));
      }
    }
  }, [isLeafLevel, activeView, viewMode, viewBVariant]);

  const handleNavigateTo = useCallback((view) => setActiveView(view), []);
  const handleRefresh = () => loadData(true);

  const handleSaveCsv = async () => {
    const { leaseCo, branch, item } = activeView;

    let dataSource = rawData;
    if (!rawData?.rows?.[0] || !Array.isArray(rawData.rows[0].rawRow)) {
      setLoadingProgress({ fetchMsg: 'エクスポート用に全列を読み込み中...', isSyncing: true });
      try {
        dataSource = await loadCsvData();
      } catch (e) {
        console.error('全列CSV再取得失敗', e);
        return;
      } finally {
        setLoadingProgress({ fetchMsg: '', isSyncing: false });
      }
    }

    let rows = dataSource?.rows;
    if (!rows?.length) return;

    rows = filterRows(rows, {
      leaseCompanies: selectedLeases.length > 0 ? selectedLeases : undefined,
      orderClients: selectedOrderClients.length > 0 ? selectedOrderClients : undefined,
      startMonth: monthRange.start,
      endMonth: monthRange.end,
    });
    const allowedNorm = ALLOWED_ITEMS.map(norm);
    rows = rows.filter(r => allowedNorm.includes(norm(r.item)));
    if (selectedItemCategories.length > 0) {
      const s = new Set(selectedItemCategories.map((x) => norm(x)));
      rows = rows.filter((r) => s.has(norm(r.item || '')));
    }
    if (viewMode === 'B') {
      rows = applyBFactorySearchFilters(rows, {
        factoryNames: bFactorySelected, phone: bSearchPhone, pref: bSearchPref,
      });
    }

    if (viewMode === 'A') {
      if (leaseCo) rows = rows.filter(r => (r.leaseCompany || '(未分類)') === leaseCo);
      if (branch)  rows = rows.filter(r => (r.branch       || '(未分類)') === branch);
      if (item)    rows = rows.filter(r => (r.item         || '(未分類)') === item);
    } else {
      if (branch) {
        rows = rows.filter(
          r => (r.branchCompany || r.branch || '(未分類)') === branch
        );
      }
      if (viewBVariant === 'menteItem' && leaseCo) {
        rows = rows.filter(r => (r.leaseCompany  || '(未分類)') === leaseCo);
      }
    }

    if (!rows.length) return;

    const headers = dataSource?.csvHeaders || rawData?.csvHeaders;
    const canFullExport = headers?.length
      && rows.length > 0
      && rows.every(r => Array.isArray(r.rawRow) && r.rawRow.length > 0);
    const csv = canFullExport
      ? generateFullDataCsvContent(headers, rows)
      : generateDetailCsvContent(rows);

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = (viewMode === 'A'
      ? [leaseCo, branch, item]
      : (viewBVariant === 'orderer' ? [branch] : [branch, leaseCo])
    ).filter(Boolean).join('_') || 'ALL';
    a.download = `メンテ実績_全列_${suffix}_${new Date().toISOString().slice(0, 10)}.csv`;
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
            onClick={() => {
              startTransition(() => { setReportMode('dashboard'); setIsSidebarOpen(false); });
            }}
            className={`flex items-center gap-3 w-full p-4 rounded-2xl transition-all duration-300 ${
              reportMode === 'dashboard'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105'
                : 'text-green-400 hover:bg-green-800'
            }`}>
            <LayoutDashboard size={20} />
            <span className="font-black text-sm tracking-tight">分析ダッシュボード</span>
          </button>
          <button
            onClick={() => {
              startTransition(() => { setReportMode('margin'); setIsSidebarOpen(false); });
            }}
            className={`flex items-center gap-3 w-full p-4 rounded-2xl transition-all duration-300 ${
              reportMode === 'margin'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105'
                : 'text-green-400 hover:bg-green-800'
            }`}>
            <Package size={20} />
            <span className="font-black text-sm tracking-tight">粗利収支分析</span>
          </button>
          <button
            onClick={() => {
              startTransition(() => { setReportMode('tab'); setIsSidebarOpen(false); });
            }}
            className={`flex items-center gap-3 w-full p-4 rounded-2xl transition-all duration-300 ${
              reportMode === 'tab'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105'
                : 'text-green-400 hover:bg-green-800'
            }`}>
            <Tag size={20} />
            <span className="font-black text-sm tracking-tight">タブ価格レポート</span>
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
              <div className="flex flex-col gap-3 w-full max-w-3xl">
                <div className="flex bg-slate-100 p-1 rounded-2xl w-fit">
                  <button
                    onClick={() => {
                      startTransition(() => {
                        setViewMode('A');
                        setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                      });
                    }}
                    className={`px-5 py-2.5 rounded-xl text-xs font-black transition-all duration-300 whitespace-nowrap ${viewMode === 'A' ? 'bg-white text-slate-800 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>
                    リース → 分類 → 品番
                  </button>
                  <button
                    onClick={() => {
                      startTransition(() => {
                        setViewMode('B');
                        setViewBVariant('orderer');
                        setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                      });
                    }}
                    className={`px-5 py-2.5 rounded-xl text-xs font-black transition-all duration-300 whitespace-nowrap ${viewMode === 'B' ? 'bg-white text-slate-800 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>
                    工場
                  </button>
                </div>
                {viewMode === 'B' && (
                  <div className="flex flex-wrap bg-emerald-50/90 p-1 rounded-2xl w-fit gap-1 border border-emerald-100/80">
                    <button
                      type="button"
                      onClick={() => {
                        startTransition(() => {
                          setViewBVariant('orderer');
                          setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                        });
                      }}
                      className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${viewBVariant === 'orderer' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      工場 → 注文者
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        startTransition(() => {
                          setViewBVariant('menteItem');
                          setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                        });
                      }}
                      className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${viewBVariant === 'menteItem' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      工場 → メンテ → 分析名(大)
                    </button>
                  </div>
                )}
                {viewMode === 'B' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full max-w-5xl pt-1">
                    <BFactoryMultiSelect
                      bFactoryListAll={bFactoryListAll}
                      bFactoryListDisplay={bFactoryListDisplay}
                      bFactoryListOverflow={bFactoryListOverflow}
                      bFactoryQuery={bFactoryQuery}
                      onQueryChange={setBFactoryQuery}
                      bFactorySelected={bFactorySelected}
                      onToggle={(name) => {
                        startTransition(() => {
                          setBFactorySelected(prev => (
                            prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]
                          ));
                        });
                      }}
                      onSelectAllInView={(vis) => {
                        startTransition(() => {
                          setBFactorySelected(prev => Array.from(new Set([...prev, ...vis])));
                        });
                      }}
                      onClear={() => { startTransition(() => { setBFactorySelected([]); }); }}
                    />
                    <SuggestTextInput
                      id="b-search-phone"
                      label="電話番号"
                      value={bSearchPhone}
                      onChange={setBSearchPhone}
                      placeholder="数字（0なし表記も可）"
                      suggestions={bSuggestPhone}
                      compact
                    />
                    <SuggestTextInput
                      id="b-search-pref"
                      label="都道府県"
                      value={bSearchPref}
                      onChange={setBSearchPref}
                      placeholder="都道府県"
                      suggestions={bSuggestPref}
                      compact
                    />
                  </div>
                )}
              </div>
            </div>

            {/* リース会社＋得意先(列E) */}
            <div className="space-y-3 w-full">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">
                メンテ（リース会社）絞り込み
              </label>
              <div className="flex gap-2 flex-wrap items-center">
                <button
                  type="button"
                  onClick={() => {
                    startTransition(() => {
                      setSelectedLeases([]);
                      setSelectedOrderClients([]);
                      setOrderClientQuery('');
                      setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                    });
                  }}
                  className={`px-4 py-2 rounded-2xl text-xs font-black transition-all duration-300 ${
                    selectedLeases.length === 0
                      ? 'bg-emerald-600 text-white shadow-xl shadow-emerald-200'
                      : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                  }`}>
                  すべて
                </button>
                {leaseCompanies.map(l => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => {
                      startTransition(() => {
                        setSelectedLeases(prev => {
                          const s = new Set(prev);
                          if (s.has(l)) s.delete(l);
                          else s.add(l);
                          return Array.from(s);
                        });
                        setSelectedOrderClients([]);
                        setOrderClientQuery('');
                        setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                      });
                    }}
                    className={`px-4 py-2 rounded-2xl text-xs font-black transition-all duration-300 ${
                      selectedLeases.includes(l)
                        ? 'bg-emerald-600 text-white shadow-xl shadow-emerald-200'
                        : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                    }`}>
                    {l}
                  </button>
                ))}
                {selectedLeases.length > 0 && (
                  <span className="text-[10px] font-bold text-slate-500">{selectedLeases.length}社選択中</span>
                )}
              </div>
              {viewMode === 'A' && (
                <div className="mt-2 pt-2 border-t border-slate-100 w-full max-w-5xl">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-0.5 mb-1.5 block">
                    分類（分析名(大)）絞り込み
                  </label>
                  <div className="flex gap-2 flex-wrap items-center">
                    <button
                      type="button"
                      onClick={() => {
                        startTransition(() => {
                          setSelectedItemCategories([]);
                          setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                        });
                      }}
                      className={`px-4 py-2 rounded-2xl text-xs font-black transition-all duration-300 ${
                        selectedItemCategories.length === 0
                          ? 'bg-emerald-600 text-white shadow-xl shadow-emerald-200'
                          : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                      }`}
                    >
                      すべて
                    </button>
                    {ALLOWED_ITEMS.map((cat) => {
                      const on = selectedItemCategories.includes(cat);
                      return (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => {
                            startTransition(() => {
                              setSelectedItemCategories((prev) => {
                                if (prev.includes(cat)) return prev.filter((c) => c !== cat);
                                return [...prev, cat];
                              });
                              setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                            });
                          }}
                          className={`px-4 py-2 rounded-2xl text-xs font-black transition-all duration-300 ${
                            on
                              ? 'bg-emerald-600 text-white shadow-xl shadow-emerald-200'
                              : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                          }`}
                        >
                          {cat}
                        </button>
                      );
                    })}
                    {selectedItemCategories.length > 0 && (
                      <span className="text-[10px] font-bold text-slate-500">
                        {selectedItemCategories.length}分類選択中
                      </span>
                    )}
                  </div>
                </div>
              )}
              {orderClientOptions.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-100 w-full max-w-4xl">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] ml-0.5 mb-1.5">
                    得意先名（E列 {selectedLeases.length ? '・選択リース内の候補' : '（期間内全件）'}）
                  </div>
                  <button
                    type="button"
                    onClick={() => setOrderClientPanelOpen(o => !o)}
                    className={`w-full max-w-2xl flex items-center justify-between gap-2 rounded-xl border ${orderClientPanelOpen ? 'border-emerald-400 ring-2 ring-emerald-500/20' : 'border-slate-200'} bg-white px-3 py-2.5 text-left text-xs font-bold text-slate-800 hover:border-slate-300 transition-colors shadow-sm`}
                  >
                    <span className="min-w-0 truncate">
                      得意先名を絞り込み・選択
                      {selectedOrderClients.length > 0 && (
                        <span className="ml-2 text-emerald-600">{selectedOrderClients.length}件選択中</span>
                      )}
                    </span>
                    {orderClientPanelOpen
                      ? <ChevronUp size={18} className="text-slate-500 flex-shrink-0" />
                      : <ChevronDown size={18} className="text-slate-500 flex-shrink-0" />}
                  </button>
                  {orderClientPanelOpen && (
                    <div
                      className="mt-2 w-full max-w-2xl rounded-2xl border border-slate-200 bg-slate-50/50 p-3 shadow-inner animate-fade-in"
                    >
                      <div className="flex flex-wrap items-center justify-end gap-2 mb-1.5">
                        {selectedOrderClients.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              startTransition(() => { setSelectedOrderClients([]); setOrderClientQuery(''); });
                            }}
                            className="text-[10px] font-bold text-rose-500 hover:underline"
                          >
                            選択をクリア
                          </button>
                        )}
                      </div>
                      <input
                        type="search"
                        value={orderClientQuery}
                        onChange={e => setOrderClientQuery(e.target.value)}
                        placeholder="候補を絞り込み"
                        className="w-full mb-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-bold text-slate-700"
                      />
                      <select
                        multiple
                        size={Math.min(10, Math.max(4, orderClientOptionsForSelect.length || 1))}
                        className="w-full min-h-[8rem] rounded-xl border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-800 leading-snug"
                        value={selectedOrderClients}
                        onChange={(e) => {
                          const v = Array.from(e.target.selectedOptions, o => o.value);
                          startTransition(() => {
                            setSelectedOrderClients(v);
                            setActiveView({ leaseCo: null, branch: null, item: null, orderClient: null, orderer: null });
                          });
                        }}
                      >
                        {orderClientOptionsForSelect.map(name => (
                          <option key={name} value={name} title={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <p className="text-[9px] text-slate-500 mt-1.5">Ctrl(Windows) / ⌘(Mac)＋クリックで複数選択。パネル外のバーを再度クリックで閉じます。</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 期間 */}
            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">期間指定</label>
              <div className="flex items-center gap-4 bg-slate-100 p-2 rounded-2xl">
                <select value={monthRange.start} onChange={e => setMonthRange(prev => ({ ...prev, start: e.target.value }))}
                  className="bg-transparent border-none text-sm font-black px-4 py-1.5 focus:ring-0 text-slate-700 cursor-pointer">
                  {[...Array(12)].map((_, i) => <option key={i+1} value={String(i+1)}>{i+1}月</option>)}
                </select>
                <div className="w-4 h-0.5 bg-slate-300 rounded-full" />
                <select value={monthRange.end} onChange={e => setMonthRange(prev => ({ ...prev, end: e.target.value }))}
                  className="bg-transparent border-none text-sm font-black px-4 py-1.5 focus:ring-0 text-slate-700 cursor-pointer">
                  {[...Array(12)].map((_, i) => <option key={i+1} value={String(i+1)}>{i+1}月</option>)}
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
              <button type="button" onClick={() => setShowProfit(p => !p)} disabled={viewMode === 'B'}
                title={viewMode === 'B' ? 'パターン2は受注数のみのため未使用' : undefined}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-black transition-all duration-300 ${viewMode === 'B' ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : (showProfit ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-200' : 'bg-slate-100 text-slate-400 hover:bg-slate-200')}`}>
                {showProfit && viewMode === 'A' ? <Eye size={14} /> : <EyeOff size={14} />}
                {viewMode === 'B' ? '—' : (showProfit ? 'ON' : 'OFF')}
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
            viewBVariant={viewBVariant}
            isLeafLevel={isLeafLevel}
            checkedItems={checkedItems}
            onCheckedChange={setCheckedItems}
            onDrillDown={handleDrillDown}
            onNavigateTo={handleNavigateTo}
            onSavePdf={handleSavePdf}
            onSaveCsv={handleSaveCsv}
            fmtAmt={fmtAmt}
            amountUnit={amountUnit}
            showProfit={showProfit && viewMode === 'A'}
            totalRow={totalRow}
            factoryAddressByBranch={factoryAddressByBranch}
            factoryPhoneByBranch={factoryPhoneByBranch}
          />
        )}
        {rawData && !isLoading && reportMode === 'margin' && (
          <ProductMarginView items={allProductMonthly} leaseCompanies={leaseCompanies} />
        )}
        {rawData && !isLoading && reportMode === 'tab' && (
          <TabPriceView rows={rawData.rows} leaseCompanies={leaseCompanies} />
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
const DashboardView = memo(({
  data, years, activeView, viewMode, viewBVariant, isLeafLevel, checkedItems, onCheckedChange,
  onDrillDown, onNavigateTo, onSavePdf, onSaveCsv, fmtAmt, amountUnit, showProfit, totalRow,
  factoryAddressByBranch = new Map(),
  factoryPhoneByBranch = new Map(),
}) => {
  const toggleCheck = useCallback((name) => {
    onCheckedChange(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }, [onCheckedChange]);

  const { leaseCo, branch, item } = activeView;
  const emptyView = { leaseCo: null, branch: null, item: null, orderClient: null, orderer: null };

  const formatMarginRate = (p, s) => {
    if (s == null || s === 0) return '—';
    return `${((p / s) * 100).toFixed(1)}%`;
  };

  // 現在のレベルに応じたラベルを決定
  let levelLabel, levelTitle;
  if (viewMode === 'A') {
    if (item !== null) {
      levelLabel = '品番';
      levelTitle = `${item} 品番別実績`;
    } else if (leaseCo !== null) {
      levelLabel = '分類（分析名）';
      levelTitle = `${leaseCo} 分類別実績`;
    } else {
      levelLabel = 'リース会社';
      levelTitle = 'リース会社別 年次実績比較';
    }
  } else if (viewBVariant === 'orderer') {
    if (branch !== null) {
      levelLabel = '注文者';
      levelTitle = `${branch} 注文者別実績（受注数）`;
    } else {
      levelLabel = '工場';
      levelTitle = '工場（送り先）別 年次実績比較（受注数）';
    }
  } else {
    if (leaseCo !== null && branch !== null) {
      levelLabel = '分析名（大）';
      levelTitle = `${leaseCo} 分析名(大)別実績（受注数）`;
    } else if (branch !== null) {
      levelLabel = 'メンテ';
      levelTitle = `${branch} メンテ別実績（受注数）`;
    } else {
      levelLabel = '工場';
      levelTitle = '工場（送り先）別 年次実績比較（受注数）';
    }
  }

  // パンくずリスト
  const crumbs = viewMode === 'A' ? [
    {
      label: '全体',
      icon: <Database size={14} />,
      onClick: () => onNavigateTo({ ...emptyView }),
      isCurrent: leaseCo === null,
    },
  ] : [
    {
      label: '全体',
      icon: <Database size={14} />,
      onClick: () => onNavigateTo({ ...emptyView }),
      isCurrent: branch === null,
    },
  ];

  if (viewMode === 'A') {
    if (leaseCo !== null) {
      crumbs.push({
        label: leaseCo,
        icon: <Building2 size={14} />,
        onClick: () => onNavigateTo({ leaseCo, branch: null, item: null, orderClient: null, orderer: null }),
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
  } else {
    if (viewBVariant === 'orderer') {
      if (branch !== null) {
        crumbs.push({
          label: branch,
          icon: <Layers size={14} />,
          onClick: () => onNavigateTo({ ...emptyView }),
          isCurrent: true,
        });
      }
    } else {
      if (branch !== null) {
        crumbs.push({
          label: branch,
          icon: <Layers size={14} />,
          onClick: () => onNavigateTo({ ...emptyView }),
          isCurrent: leaseCo === null,
        });
      }
      if (leaseCo !== null && branch !== null) {
        crumbs.push({
          label: leaseCo,
          icon: <Tag size={14} />,
          onClick: () => onNavigateTo({ ...emptyView, branch, item: null, orderClient: null, orderer: null, leaseCo: null }),
          isCurrent: true,
        });
      }
    }
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
                type="button"
                onClick={crumb.onClick}
                className="flex items-center gap-1 text-slate-400 hover:text-slate-600 transition-colors"
              >
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
          <h3 className="font-black text-slate-800 text-base md:text-xl flex items-center gap-2 min-w-0 max-w-4xl flex-wrap">
            <Tag className="text-emerald-500 flex-shrink-0" />
            <span className="leading-snug break-words">{levelTitle}</span>
            {amountUnit === 'thousand' && (showProfit || viewMode === 'A') && (
              <span className="text-emerald-500 text-sm">（千円）</span>
            )}
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
                    const s = totalRow.sales?.[year]  || 0;
                    const yoy = years[yIdx-1] ? calcYoY(p, totalRow.profit[years[yIdx-1]])   : null;
                    const qoy = years[yIdx-1] ? calcYoY(q, totalRow.quantity[years[yIdx-1]]) : null;
                    const soy = years[yIdx-1] ? calcYoY(s, totalRow.sales?.[years[yIdx-1]] ?? 0) : null;
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
                          {viewMode === 'A' && (
                            <div className="flex justify-between items-baseline">
                              <span className="text-[10px] font-black text-sky-600">売上</span>
                              <div className="text-right">
                                <div className="font-mono font-black text-slate-800 text-xs md:text-base">{fmtAmt(s)}</div>
                                {soy !== null && (
                                  <div className={`text-[10px] font-black flex items-center justify-end gap-0.5 ${parseFloat(soy) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {parseFloat(soy) >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{soy}%
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
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
                          {viewMode === 'A' && (
                            <div className="flex justify-between items-baseline">
                              <span className="text-[10px] font-black text-amber-700">粗利率</span>
                              <div className="text-right">
                                <div className="font-mono font-black text-amber-800 text-xs md:text-base tabular-nums">
                                  {formatMarginRate(p, s)}
                                </div>
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
                      {viewMode === 'B' && branch === null
                        && ((factoryAddressByBranch.get(row.name) || '').trim() || (factoryPhoneByBranch.get(row.name) || '').trim()) ? (
                        <div
                          className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 max-w-3xl text-xs font-bold text-slate-500"
                          onMouseDown={e => e.stopPropagation()}
                        >
                          {(factoryAddressByBranch.get(row.name) || '').trim() ? (
                            <span className="break-words">{(factoryAddressByBranch.get(row.name) || '').trim()}</span>
                          ) : null}
                          {(factoryPhoneByBranch.get(row.name) || '').trim() ? (
                            <span className="text-slate-600 select-text">
                              TEL: {(factoryPhoneByBranch.get(row.name) || '').trim()}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {!isLeafLevel && (
                        <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-tighter no-print">
                          クリックでドリルダウン
                        </div>
                      )}
                    </td>
                    {years.map((year, yIdx) => {
                      const p = row.profit[year]   || 0;
                      const q = row.quantity[year] || 0;
                      const s = row.sales?.[year]  || 0;
                      const yoy = years[yIdx-1] ? calcYoY(p, row.profit[years[yIdx-1]])   : null;
                      const qoy = years[yIdx-1] ? calcYoY(q, row.quantity[years[yIdx-1]]) : null;
                      const soy = years[yIdx-1] ? calcYoY(s, row.sales?.[years[yIdx-1]] ?? 0) : null;
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
                            {viewMode === 'A' && (
                              <div className="flex justify-between items-baseline">
                                <span className="text-[10px] font-black text-sky-700">売上</span>
                                <div className="text-right">
                                  <div className="font-mono font-black text-slate-800 text-xs md:text-base">{fmtAmt(s)}</div>
                                  {soy !== null && (
                                    <div className={`text-[10px] font-black flex items-center justify-end gap-0.5 ${parseFloat(soy) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                      {parseFloat(soy) >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{soy}%
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
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
                            {viewMode === 'A' && (
                              <div className="flex justify-between items-baseline">
                                <span className="text-[10px] font-black text-amber-700">粗利率</span>
                                <div className="text-right">
                                  <div className="font-mono font-black text-amber-800 text-xs md:text-base tabular-nums">
                                    {formatMarginRate(p, s)}
                                  </div>
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
});

// ===== タブ価格レポートビュー =====

const toCalendarYear = (fy, m) => (m <= 3 ? fy + 1 : fy);

/** 対象カテゴリ（NFKC正規化済み） — エアコン関連は除外 */
const TAB_ALLOWED_ITEM_NORMS = new Set(['オルタネーター', 'スターター', 'コンプレッサー']);
const normTabItem = s => (s || '').normalize('NFKC').trim();

/** タブ価格レポート対象リース会社（固定） */
const TAB_TARGET_LEASES = new Set(['OR', 'NCS', '西出', 'MAL']);

const TabPriceView = ({ rows, leaseCompanies }) => {
  const [tabData, setTabData]       = useState(null); // { tabMap, applicableDates }
  const [tabLoading, setTabLoading] = useState(true);
  const [tabError, setTabError]     = useState(null);
  const [section, setSection]       = useState('missing'); // 'missing' | 'mismatch'
  const [selectedLeases, setSelectedLeases] = useState(new Set());
  const [search, setSearch]         = useState('');
  const [sortKey, setSortKey]       = useState(null);
  const [sortAsc, setSortAsc]       = useState(true);
  const [drillLease, setDrillLease] = useState(null); // null=リース会社一覧, string=ドリルダウン中

  // 年月オプション（単価不一致用期間フィルター）
  const ymOptions = useMemo(() => {
    const set = new Set();
    rows.forEach(r => {
      if (r.fiscalYear && r.month)
        set.add(toCalendarYear(r.fiscalYear, r.month) * 100 + r.month);
    });
    return [...set].sort((a, b) => a - b).map(v => ({ year: Math.floor(v / 100), month: v % 100 }));
  }, [rows]);

  const availYears = useMemo(
    () => [...new Set(ymOptions.map(o => o.year))].sort((a, b) => a - b),
    [ymOptions]
  );

  const [fromYear, setFromYear]   = useState(null);
  const [fromMonth, setFromMonth] = useState(null);
  const [toYear, setToYear]       = useState(null);
  const [toMonth, setToMonth]     = useState(null);

  useEffect(() => {
    if (!ymOptions.length) return;
    const first = ymOptions[0], last = ymOptions[ymOptions.length - 1];
    setFromYear(first.year); setFromMonth(first.month);
    setToYear(last.year);   setToMonth(last.month);
  }, [ymOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadTabData()
      .then(d => setTabData(d))
      .catch(e => setTabError(e.message))
      .finally(() => setTabLoading(false));
  }, []);

  const toggleLease = useCallback(l => {
    setSelectedLeases(prev => {
      const next = new Set(prev);
      next.has(l) ? next.delete(l) : next.add(l);
      return next;
    });
  }, []);

  // 対象4社 ＋ 共通除外（単価0円・伝票区分20）＋ ユーザー選択によるリース会社フィルター
  const leaseFilteredRows = useMemo(() => {
    return rows.filter(r => {
      if (!TAB_TARGET_LEASES.has(r.leaseCompany)) return false;
      if (r.unitPrice === 0) return false;
      if (r.slipType === '20') return false;
      if (/^R[HB]/i.test(r.productCode)) return false;
      if (selectedLeases.size > 0 && !selectedLeases.has(r.leaseCompany)) return false;
      return true;
    });
  }, [rows, selectedLeases]);

  // 適用日フィルター（両セクション共通 — リース会社ごとの適用日以降のみ）
  const applicableDateFilteredRows = useMemo(() => {
    if (!tabData?.applicableDates) return leaseFilteredRows;
    const { applicableDates } = tabData;
    return leaseFilteredRows.filter(r => {
      const appDate = applicableDates.get(r.leaseCompany);
      if (!appDate) return true;
      const calYear = toCalendarYear(r.fiscalYear, r.month);
      return calYear * 100 + r.month >= appDate.year * 100 + appDate.month;
    });
  }, [leaseFilteredRows, tabData]);

  // 適用日 ＋ 期間フィルター（単価不一致の絞り込み用）
  const periodFilteredRows = useMemo(() => {
    const fromVal = fromYear ? fromYear * 100 + (fromMonth || 1) : 0;
    const toVal   = toYear   ? toYear   * 100 + (toMonth   || 12) : 999999;
    return applicableDateFilteredRows.filter(r => {
      if (!r.fiscalYear || !r.month) return false;
      const v = toCalendarYear(r.fiscalYear, r.month) * 100 + r.month;
      return v >= fromVal && v <= toVal;
    });
  }, [applicableDateFilteredRows, fromYear, fromMonth, toYear, toMonth]);

  // タブ価格未設定品番
  // 条件: 分析名(大) ∈ {オルタネーター,スターター,コンプレッサー}
  //       売上日 >= 適用日（applicableDateFilteredRows で保証済み）
  //       (リース会社, 品番) が tab_data に存在しない
  const missingItems = useMemo(() => {
    if (!tabData) return [];
    const { tabMap } = tabData;
    const map = new Map();
    for (const r of applicableDateFilteredRows) {
      if (!TAB_ALLOWED_ITEM_NORMS.has(normTabItem(r.item))) continue;
      const codes = tabMap.get(r.leaseCompany);
      if (codes && codes.has(r.productCode)) continue;
      const key = `${r.leaseCompany}||${r.productCode}`;
      if (!map.has(key)) {
        map.set(key, {
          leaseCompany:  r.leaseCompany,
          productCode:   r.productCode,
          productName:   r.productName,
          item:          r.item,
          count:         0,
          totalSales:    0,
          latestDateVal: 0,
          latestYear:    null,
          latestMonth:   null,
        });
      }
      const e = map.get(key);
      e.count      += r.quantity || 1;
      e.totalSales += r.sales;
      const calY = toCalendarYear(r.fiscalYear, r.month);
      const dv   = calY * 100 + r.month;
      if (dv > e.latestDateVal) { e.latestDateVal = dv; e.latestYear = calY; e.latestMonth = r.month; }
    }
    return [...map.values()];
  }, [applicableDateFilteredRows, tabData]);

  // 単価不一致
  // 条件: 分析名(大) ∈ {オルタネーター,スターター,コンプレッサー}
  //       (リース会社, 品番) が tab_data に存在する
  //       実売単価 ≠ TAB価格
  const mismatchItems = useMemo(() => {
    if (!tabData) return [];
    const { tabMap } = tabData;
    const map = new Map();
    for (const r of periodFilteredRows) {
      if (!TAB_ALLOWED_ITEM_NORMS.has(normTabItem(r.item))) continue;
      const codes = tabMap.get(r.leaseCompany);
      if (!codes) continue;
      const tabEntry = codes.get(r.productCode);
      if (tabEntry === undefined) continue;
      const tabPrice = tabEntry.price;
      if (r.unitPrice == null || r.unitPrice === tabPrice) continue;
      const key = `${r.leaseCompany}||${r.productCode}||${r.unitPrice}`;
      if (!map.has(key)) {
        map.set(key, {
          leaseCompany: r.leaseCompany,
          productCode:  r.productCode,
          productName:  r.productName,
          item:         r.item,
          tabPrice,
          actualPrice:  r.unitPrice,
          diff:         r.unitPrice - tabPrice,
          count:        0,
          totalSales:   0,
        });
      }
      const e = map.get(key);
      e.count      += r.quantity || 1;
      e.totalSales += r.sales;
    }
    return [...map.values()];
  }, [periodFilteredRows, tabData]);

  const fmtYen = v => `¥${Math.round(v || 0).toLocaleString()}`;

  const currentItems = section === 'missing' ? missingItems : mismatchItems;

  // リース会社ごとの集計（第1階層）
  const leaseSummary = useMemo(() => {
    const map = new Map();
    for (const item of currentItems) {
      const l = item.leaseCompany;
      if (!map.has(l)) map.set(l, { leaseCompany: l, codeCount: 0, totalCount: 0, totalSales: 0 });
      const e = map.get(l);
      e.codeCount++;
      e.totalCount += item.count;
      e.totalSales += item.totalSales;
    }
    return [...map.values()].sort((a, b) => a.leaseCompany.localeCompare(b.leaseCompany));
  }, [currentItems]);

  // ドリルダウン中のリース会社の品番一覧（第2階層）
  const drillItems = useMemo(() =>
    drillLease ? currentItems.filter(r => r.leaseCompany === drillLease) : [],
    [currentItems, drillLease]
  );

  // 検索・ソートのベース
  const searchBase = drillLease ? drillItems : leaseSummary;

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return searchBase;
    if (drillLease) {
      return searchBase.filter(r =>
        r.productCode?.toLowerCase().includes(q) ||
        r.productName?.toLowerCase().includes(q)
      );
    }
    return searchBase.filter(r => r.leaseCompany?.toLowerCase().includes(q));
  }, [searchBase, search, drillLease]);

  const sorted = useMemo(() => {
    if (!sortKey) return searched;
    return [...searched].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === 'number' ? av - bv : String(av || '').localeCompare(String(bv || ''));
      return sortAsc ? cmp : -cmp;
    });
  }, [searched, sortKey, sortAsc]);

  const handleSort = key => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const SortIcon = ({ k }) => (
    <ArrowUpDown size={12} className={`inline ml-1 ${sortKey === k ? 'text-emerald-400' : 'text-slate-400'}`} />
  );

  const handleDrillIn = lease => { setDrillLease(lease); setSortKey(null); setSearch(''); };
  const handleDrillOut = () => { setDrillLease(null); setSortKey(null); setSearch(''); };

  // 適用日表示（未設定セクション用）
  const applicableDateDisplay = useMemo(() => {
    if (!tabData?.applicableDates) return [];
    const dates = tabData.applicableDates;
    const leases = selectedLeases.size > 0 ? [...selectedLeases] : [...dates.keys()];
    return leases
      .filter(l => TAB_TARGET_LEASES.has(l) && dates.has(l))
      .map(l => { const d = dates.get(l); return { lease: l, label: `${d.year}年${d.month}月${d.day}日` }; })
      .sort((a, b) => a.lease.localeCompare(b.lease));
  }, [tabData, selectedLeases]);

  const selMonths = yr => ymOptions.filter(o => o.year === yr).map(o => o.month);

  const handleExportCsv = () => {
    if (!tabData) return;
    const { tabMap, applicableDates } = tabData;
    const isMissing = section === 'missing';
    const esc = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

    const headersMissing = [
      '売上伝票ＮＯ', '納品日', 'リース会社', 'メーカーコード',
      '分析名(大)', '品番', '商品名', '受注者名',
      '単価', '数量', '原価', '粗利率', '粗利額',
    ];
    const headersMismatch = [
      '売上伝票ＮＯ', '納品日', 'リース会社', 'メーカーコード',
      '品番', '商品名', '分析名(大)', '受注者名',
      '単価', '数量', '原価', 'TAB価格', '差額', '適用日',
    ];
    const lines = [(isMissing ? headersMissing : headersMismatch).map(esc).join(',')];

    const sourceRows = isMissing ? leaseFilteredRows : periodFilteredRows;
    for (const r of sourceRows) {
      if (!TAB_ALLOWED_ITEM_NORMS.has(normTabItem(r.item))) continue;
      const codes    = tabMap.get(r.leaseCompany);
      const tabEntry = codes?.get(r.productCode);

      if (isMissing) {
        // 適用日以降 かつ tab_data に存在しない行のみ
        const appDate = applicableDates.get(r.leaseCompany);
        if (appDate) {
          const calYear = toCalendarYear(r.fiscalYear, r.month);
          if (calYear * 100 + r.month < appDate.year * 100 + appDate.month) continue;
        }
        if (tabEntry !== undefined) continue;
        const genka      = Math.round(r.sales - r.profit);
        const grossRate  = r.sales > 0 ? (r.profit / r.sales).toFixed(3) : '0.000';
        const grossProfit = Math.round(r.profit);
        lines.push([
          r.slipNo, r.date, r.leaseCompany, r.makerCode,
          r.item, r.productCode, r.productName, r.receiverName,
          r.unitPrice, r.quantity, genka, grossRate, grossProfit,
        ].map(esc).join(','));
      } else {
        // tab_data に存在し、単価が異なる行のみ
        if (tabEntry === undefined) continue;
        const tabPrice = tabEntry.price;
        if (r.unitPrice == null || r.unitPrice === tabPrice) continue;
        lines.push([
          r.slipNo, r.date, r.leaseCompany, tabEntry.makerCode,
          r.productCode, r.productName, r.item, r.receiverName,
          r.unitPrice, r.quantity, Math.round(r.sales - r.profit), tabPrice, r.unitPrice - tabPrice, tabEntry.dateStr,
        ].map(esc).join(','));
      }
    }

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `タブ価格レポート_${isMissing ? '未設定品番' : '単価不一致'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="space-y-6">
      {/* タイトル */}
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 rounded-3xl p-6 text-white">
        <div className="flex items-center gap-3 mb-1">
          <Tag size={24} className="text-emerald-400" />
          <h2 className="text-2xl font-black tracking-tight">タブ価格レポート</h2>
        </div>
        <p className="text-slate-400 text-sm font-bold">
          売上実績とタブ価格マスタの突合 — 未設定品番の検知 ＆ 単価不一致の検知
        </p>
        <p className="text-slate-500 text-xs mt-1">対象カテゴリ: オルタネーター・スターター・コンプレッサー</p>
      </div>

      {/* tab_data 読み込みエラー */}
      {tabError && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center gap-3 text-rose-700">
          <AlertCircle size={18} />
          <span className="font-bold text-sm">tab_data.csv の読み込みに失敗しました: {tabError}</span>
        </div>
      )}

      {/* リース会社フィルター（対象4社のみ） */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 no-print">
        <div className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3">リース会社フィルター <span className="normal-case font-bold text-slate-300">（対象: OR / NCS / 西出 / MAL）</span></div>
        <div className="flex flex-wrap gap-2">
          {leaseCompanies.filter(l => TAB_TARGET_LEASES.has(l)).map(l => {
            const checked = selectedLeases.has(l);
            return (
              <button key={l} onClick={() => toggleLease(l)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black border transition-all ${
                  checked
                    ? 'bg-emerald-500 text-white border-emerald-500 shadow'
                    : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-emerald-300'
                }`}>
                {checked ? <CheckSquare size={12} /> : <Square size={12} />}
                {l}
              </button>
            );
          })}
          {selectedLeases.size > 0 && (
            <button onClick={() => setSelectedLeases(new Set())}
              className="px-3 py-1.5 rounded-xl text-xs font-black text-rose-500 border border-rose-200 hover:bg-rose-50">
              クリア
            </button>
          )}
        </div>
      </div>

      {/* 適用日表示（両セクション共通） */}
      {!tabLoading && applicableDateDisplay.length > 0 && (
        <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4">
          <div className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2">
            タブ価格マスタ 適用日（この日以降の売上を突合しています）
          </div>
          <div className="flex flex-wrap gap-2">
            {applicableDateDisplay.map(({ lease, label }) => (
              <div key={lease}
                className="flex items-center gap-2 bg-white rounded-xl px-3 py-1.5 border border-emerald-100 text-xs font-bold shadow-sm">
                <span className="text-emerald-600 font-black">{lease}</span>
                <span className="text-slate-500">{label}以降</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 期間フィルター（単価不一致セクションのみ） */}
      {section === 'mismatch' && (
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 no-print">
          <div className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3">期間フィルター</div>
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">開始年月</div>
              <div className="flex gap-1">
                <select value={fromYear ?? ''} onChange={e => setFromYear(Number(e.target.value) || null)}
                  className="bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold text-slate-700">
                  {availYears.map(y => <option key={y} value={y}>{y}年</option>)}
                </select>
                <select value={fromMonth ?? ''} onChange={e => setFromMonth(Number(e.target.value) || null)}
                  className="bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold text-slate-700">
                  {(fromYear ? selMonths(fromYear) : []).map(m => <option key={m} value={m}>{m}月</option>)}
                </select>
              </div>
            </div>
            <div className="text-slate-400 font-black pb-2">〜</div>
            <div>
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">終了年月</div>
              <div className="flex gap-1">
                <select value={toYear ?? ''} onChange={e => setToYear(Number(e.target.value) || null)}
                  className="bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold text-slate-700">
                  {availYears.map(y => <option key={y} value={y}>{y}年</option>)}
                </select>
                <select value={toMonth ?? ''} onChange={e => setToMonth(Number(e.target.value) || null)}
                  className="bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold text-slate-700">
                  {(toYear ? selMonths(toYear) : []).map(m => <option key={m} value={m}>{m}月</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* サマリーバッジ */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-rose-50 border border-rose-100 rounded-2xl p-4">
          <div className="text-[10px] font-black text-rose-400 uppercase tracking-widest mb-2">タブ価格未設定品番</div>
          <div className="flex items-end gap-5">
            <div>
              <span className="text-3xl font-black text-rose-600">{missingItems.length.toLocaleString()}</span>
              <span className="text-xs font-black text-rose-400 ml-1">品番</span>
            </div>
            <div className="pb-0.5">
              <span className="text-xl font-black text-rose-400">{missingItems.reduce((s, r) => s + r.count, 0).toLocaleString()}</span>
              <span className="text-xs font-black text-rose-300 ml-1">件</span>
            </div>
          </div>
        </div>
        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4">
          <div className="text-[10px] font-black text-amber-500 uppercase tracking-widest mb-2">単価不一致</div>
          <div className="flex items-end gap-5">
            <div>
              <span className="text-3xl font-black text-amber-600">{mismatchItems.length.toLocaleString()}</span>
              <span className="text-xs font-black text-amber-400 ml-1">品番</span>
            </div>
            <div className="pb-0.5">
              <span className="text-xl font-black text-amber-400">{mismatchItems.reduce((s, r) => s + r.count, 0).toLocaleString()}</span>
              <span className="text-xs font-black text-amber-300 ml-1">件</span>
            </div>
          </div>
        </div>
      </div>

      {/* セクション切り替え + 検索 + CSV */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex rounded-2xl overflow-hidden border border-slate-200 shadow-sm">
          <button onClick={() => { setSection('missing'); setSortKey(null); setDrillLease(null); setSearch(''); }}
            className={`px-5 py-2.5 text-sm font-black transition-all ${
              section === 'missing' ? 'bg-rose-500 text-white' : 'bg-white text-slate-600 hover:bg-rose-50'
            }`}>
            タブ価格未設定品番
          </button>
          <button onClick={() => { setSection('mismatch'); setSortKey(null); setDrillLease(null); setSearch(''); }}
            className={`px-5 py-2.5 text-sm font-black transition-all ${
              section === 'mismatch' ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 hover:bg-amber-50'
            }`}>
            単価不一致
          </button>
        </div>

        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-2xl px-3 py-2 flex-1 min-w-[200px] max-w-xs shadow-sm">
          <Search size={14} className="text-slate-400 flex-shrink-0" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="品番・商品名・リース会社を検索"
            className="flex-1 text-xs font-bold text-slate-700 bg-transparent outline-none placeholder:text-slate-300"
          />
        </div>

        <button onClick={handleExportCsv}
          className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-slate-700 text-white text-xs font-black hover:bg-emerald-600 transition-colors shadow-sm">
          <FileSpreadsheet size={14} />
          CSV出力
        </button>
      </div>

      {/* テーブル */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
        {tabLoading ? (
          <div className="flex items-center justify-center gap-3 py-16 text-slate-400 font-bold">
            <Loader2 size={20} className="animate-spin" />
            タブ価格データを読み込み中...
          </div>
        ) : !drillLease ? (
          /* ===== 第1階層: リース会社サマリー ===== */
          currentItems.length === 0 ? (
            <div className="py-16 text-center text-slate-400 font-bold text-sm">
              <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-400" />
              {section === 'missing' ? '未設定品番はありません' : '単価不一致はありません'}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      {[
                        ['leaseCompany', 'リース会社'],
                        ['codeCount',   '品番数'],
                        ['totalCount',  '件数'],
                      ].map(([k, label]) => (
                        <th key={k} onClick={() => handleSort(k)}
                          className="px-4 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-600 whitespace-nowrap">
                          {label}<SortIcon k={k} />
                        </th>
                      ))}
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r, i) => (
                      <tr key={i}
                        onClick={() => handleDrillIn(r.leaseCompany)}
                        className={`border-b border-slate-50 cursor-pointer transition-colors ${
                          section === 'missing' ? 'hover:bg-rose-50/60' : 'hover:bg-amber-50/60'
                        }`}>
                        <td className="px-4 py-4 font-black text-slate-800 text-sm">{r.leaseCompany}</td>
                        <td className="px-4 py-4 font-mono font-black text-right">
                          <span className={`text-lg ${section === 'missing' ? 'text-rose-600' : 'text-amber-600'}`}>
                            {r.codeCount.toLocaleString()}
                          </span>
                          <span className="text-[10px] text-slate-400 ml-1">品番</span>
                        </td>
                        <td className="px-4 py-4 font-mono font-bold text-slate-600 text-right text-sm">
                          {r.totalCount.toLocaleString()}
                          <span className="text-[10px] text-slate-400 ml-1">件</span>
                        </td>
                        <td className="px-4 py-4 text-slate-300 text-right">
                          <ChevronRight size={16} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-4 border-t border-slate-100 text-xs text-slate-400 font-bold text-right">
                {leaseSummary.length} 社 / 全 {currentItems.length.toLocaleString()} 品番
              </div>
            </>
          )
        ) : (
          /* ===== 第2階層: 品番ドリルダウン ===== */
          <>
            {/* パンくず */}
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center gap-3">
              <button onClick={handleDrillOut}
                className="flex items-center gap-1 text-xs font-black text-slate-500 hover:text-emerald-600 transition-colors">
                <ChevronRight size={14} className="rotate-180" /> 一覧に戻る
              </button>
              <span className="text-slate-300">|</span>
              <span className={`font-black text-sm ${section === 'missing' ? 'text-rose-600' : 'text-amber-600'}`}>
                {drillLease}
              </span>
              <span className="text-xs text-slate-400 font-bold">
                {drillItems.length} 品番 / {drillItems.reduce((s, r) => s + r.count, 0).toLocaleString()} 件
              </span>
            </div>
            {sorted.length === 0 ? (
              <div className="py-12 text-center text-slate-400 font-bold text-sm">該当なし</div>
            ) : section === 'missing' ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        {[
                          ['productCode',   '品番'],
                          ['productName',   '商品名'],
                          ['item',          '分析名(大)'],
                          ['count',         '件数'],
                          ['latestDateVal', '最終売上年月'],
                        ].map(([k, label]) => (
                          <th key={k} onClick={() => handleSort(k)}
                            className="px-4 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-600 whitespace-nowrap">
                            {label}<SortIcon k={k} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((r, i) => (
                        <tr key={i} className="border-b border-slate-50 hover:bg-rose-50/40 transition-colors">
                          <td className="px-4 py-3 font-mono font-bold text-slate-800 text-xs whitespace-nowrap">{r.productCode}</td>
                          <td className="px-4 py-3 text-slate-600 text-xs max-w-[200px] truncate">{r.productName}</td>
                          <td className="px-4 py-3 text-xs">
                            <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 font-bold text-[10px] whitespace-nowrap">{r.item}</span>
                          </td>
                          <td className="px-4 py-3 font-mono font-bold text-slate-600 text-right text-xs">{r.count.toLocaleString()}</td>
                          <td className="px-4 py-3 font-mono text-slate-500 text-right text-xs whitespace-nowrap">
                            {r.latestYear && r.latestMonth ? `${r.latestYear}年${r.latestMonth}月` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        {[
                          ['productCode',  '品番'],
                          ['productName',  '商品名'],
                          ['item',         '分析名(大)'],
                          ['tabPrice',     'TAB価格'],
                          ['actualPrice',  '実売単価'],
                          ['diff',         '差額'],
                          ['count',        '件数'],
                        ].map(([k, label]) => (
                          <th key={k} onClick={() => handleSort(k)}
                            className="px-4 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-600 whitespace-nowrap">
                            {label}<SortIcon k={k} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((r, i) => {
                        const diffNeg = r.diff < 0;
                        return (
                          <tr key={i} className="border-b border-slate-50 hover:bg-amber-50/40 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-slate-800 text-xs whitespace-nowrap">{r.productCode}</td>
                            <td className="px-4 py-3 text-slate-600 text-xs max-w-[200px] truncate">{r.productName}</td>
                            <td className="px-4 py-3 text-xs">
                              <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 font-bold text-[10px] whitespace-nowrap">{r.item}</span>
                            </td>
                            <td className="px-4 py-3 font-mono font-bold text-emerald-700 text-right text-xs whitespace-nowrap">{fmtYen(r.tabPrice)}</td>
                            <td className="px-4 py-3 font-mono font-bold text-slate-700 text-right text-xs whitespace-nowrap">{fmtYen(r.actualPrice)}</td>
                            <td className={`px-4 py-3 font-mono font-bold text-right text-xs whitespace-nowrap ${diffNeg ? 'text-rose-600' : 'text-amber-600'}`}>
                              {r.diff > 0 ? '+' : ''}{fmtYen(r.diff)}
                            </td>
                            <td className="px-4 py-3 font-mono font-bold text-slate-600 text-right text-xs">{r.count.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="p-4 border-t border-slate-100 text-xs text-slate-400 font-bold text-right">
              {sorted.length.toLocaleString()} 品番表示
              {search && `（"${search}" で絞り込み中）`}
            </div>
          </>
        )}
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
