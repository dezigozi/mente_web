import React, { useState, useMemo, useCallback, useEffect, useTransition, useRef, memo } from 'react';
import { flushSync } from 'react-dom';
import {
  ChevronRight, ChevronDown, ChevronUp, Building2, Tag, Layers,
  ArrowUpRight, ArrowDownRight, LayoutDashboard, Database,
  Calendar, RefreshCcw, CheckCircle2, FileText, FileSpreadsheet,
  AlertCircle, Loader2, XCircle, Eye, EyeOff,
  CheckSquare, Square, Menu, X, Package, Search, ArrowUpDown,
  MoreHorizontal, SlidersHorizontal, RotateCcw, MapPin, BookOpen,
  ClipboardList, Trash2, Upload, Download, Plus, History, Target, Pencil, Check, Car,
} from 'lucide-react';
import { clearCache } from './utils/db';
import { loadCsvData, loadCsvDataFull, generateFullDataCsvContent, loadTabData } from './utils/csvLoader';
import { writeTabRegisterXlsx } from './utils/tabRegisterXlsx';
import { writeRoutePlanXlsx } from './utils/routePlanXlsx';
import { writeNcsReportXlsx } from './utils/ncsReportXlsx';
import { writeDashboardXlsx } from './utils/dashboardXlsx';
import { writeLeaseReportXlsx } from './utils/leaseReportXlsx';
import {
  NCS, buildFactoryIndex, latestCompleteFiscalYear, buildNcsTargets, splitFy, topOrderers,
  buildPostVisitStats, dateNum, fmtDateNum, daysBetween, areaOf, cityOf, factoryMatches, visitAreasByDate, ncsJudge, fiscalYearOct, buildVisitReport,
} from './utils/ncsTarget';
import {
  loadAll, saveList, saveVisit, deleteVisit, exportAll, importAll, newId,
  storeMode, getShareKey, setShareKey, localLeftovers, migrateLocalToShared,
} from './utils/visitStore';
import {
  REBUILD_ITEMS, WEST_ORIX_CLIENT_KEYWORDS, ORIX_LEASE, buildLeaseReportIndex, listClients,
  defaultClientSelection, summarizeFactories, summarizeClients, summarizeCars, prevBase, monthOfFiscalIndex, shortClientName, sumSeries,
} from './utils/leaseReport';
import areaCodes from './data/areaCodes.json';
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
  aggregateMenteChildrenByFactory,
  topOrderersByFactory,
  aggregateByItemUnderFactoryMente,
  aggregateByProductCode,
  generateDetailCsvContent, calcYoY, formatCurrencyFull,
} from './utils/aggregator';


/** 期間指定の開始月に合わせて行の fiscalYear を付け替え（kasouhin_uriage_Web と同ロジック） */
function mapRowsWithFiscalYearStart(rows, startMonthStr) {
  if (!rows?.length) return rows;
  const sm = parseInt(String(startMonthStr), 10);
  if (Number.isNaN(sm) || sm < 1 || sm > 12) return rows;
  return rows.map((r) => {
    const m = Number(r.month);
    if (!m || m < 1 || m > 12) return r;
    const CY =
      r.year != null && r.year !== ''
        ? Number(r.year)
        : (m >= 4 ? Number(r.fiscalYear) : Number(r.fiscalYear) + 1);
    if (Number.isNaN(CY)) return r;
    const newFY = m >= sm ? CY : CY - 1;
    return { ...r, fiscalYear: newFY };
  });
}

/**
 * 行配列から会計年度の最大値を求める。
 * Math.max(...配列) は引数スプレッドのため数万行で RangeError（Maximum call stack size exceeded）になる。
 */
function maxFiscalYearFromRows(rows) {
  let maxFY = -Infinity;
  for (const r of rows) {
    const x = r?.fiscalYear;
    if (x == null || x === '') continue;
    const n = Number(x);
    if (Number.isFinite(n) && n > maxFY) maxFY = n;
  }
  return maxFY === -Infinity ? undefined : maxFY;
}

/** 対象の分析名(大)。エアコン関連は出さない（2026-10-24 たかたか指示） */
const ALLOWED_ITEMS = ['オルタネーター', 'スターター', 'コンプレッサー'];
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
  // 入力即時反映用ローカル state（親 state は debounce で更新）
  const [localQuery, setLocalQuery] = useState(bFactoryQuery);
  const debounceRef = useRef();
  // 外から bFactoryQuery が変わった時にローカルも同期
  useEffect(() => { setLocalQuery(bFactoryQuery); }, [bFactoryQuery]);
  const handleChange = (val) => {
    setLocalQuery(val);
    setOpen(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { onQueryChange(val); }, 180);
  };
  return (
    <div className="relative w-full min-w-0">
      <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-0.5 mb-1">
        工場名
      </div>
      <input
        type="text"
        value={localQuery}
        onChange={e => handleChange(e.target.value)}
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
        <ul
          className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg p-1"
          onMouseDown={e => e.preventDefault()}
        >
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
    // 0始まり＝市外局番として前方一致（045 が 03-3045-… に当たらないように）。0なしは従来どおり部分一致
    out = dP.startsWith('0')
      ? out.filter(r => (r.phoneSearchStr || '').startsWith(dP))
      : out.filter(r => (r.phoneSearchStr || '').includes(dP));
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
  // 入力即時反映用ローカル state（親 state は debounce で更新）
  const [localValue, setLocalValue] = useState(value);
  const debounceRef = useRef();
  // 外から value が変わった時にローカルも同期（候補クリック時など）
  useEffect(() => { setLocalValue(value); }, [value]);
  const handleChange = (val) => {
    setLocalValue(val);
    setOpen(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { onChange(val); }, 180);
  };
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
          value={localValue}
          onChange={e => handleChange(e.target.value)}
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
  /** 分類（分析名(大)）ALLOWED_ITEMS からの複数。空＝3分類すべて（パターンAのUIのみ。パイプラインはA/B共通で適用） */
  const [selectedItemCategories, setSelectedItemCategories] = useState([]);
  /** 得意先名(列E)複数。空＝全件 */
  const [selectedOrderClients, setSelectedOrderClients] = useState([]);
  const [orderClientQuery, setOrderClientQuery] = useState('');
  /** 得意先名: クリックで開くパネル（常時表示にしない） */
  const [orderClientPanelOpen, setOrderClientPanelOpen] = useState(false);
  // デフォルトは直近1年（当月起点で12ヶ月遡る。例: 5月起動 → 5月〜翌4月の12ヶ月）
  const [monthRange, setMonthRange] = useState(() => {
    const m = new Date().getMonth() + 1;
    return { start: String(m), end: String(m === 1 ? 12 : m - 1) };
  });
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
  const [reportMode, setReportMode] = useState('dashboard'); // 'dashboard' | 'margin' | 'tab' | 'ncs' | 'lease'
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
      // キャッシュ（IndexedDB）と ETag 判定は loadCsvData 側に一本化。ここで二重に読み書きしない
      if (forceRefresh) await clearCache();
      const csvData = await loadCsvData(msg => {
        setLoadingProgress({ fetchMsg: msg, isSyncing: true });
      });
      setRawData({ ...csvData, fromCache: false, cacheAgeMsg: '最新' });
      setConnectionStatus('online');
    } catch (err) {
      console.error('データ読み込みエラー:', err);
      const reason = err instanceof Error ? err.message : String(err);
      setLoadError(
        `CSVの読み込みに失敗しました。本番では public/data/master_data.csv をデプロイに含め、ローカルは「npm run dev」で起動（file:// 不可）してください。詳細: ${reason}`
      );
      setConnectionStatus('offline');
    } finally {
      setIsLoading(false);
      setLoadingProgress({ fetchMsg: '', isSyncing: false });
    }
  }, []);

  // パスワード保護が有効な場合は、認証完了するまで重いCSVダウンロード/パースを開始しない。
  // タブレット等の非力なデバイスでパスワード画面自体が固まる問題への対処。
  useEffect(() => {
    const isPasswordProtected = !!import.meta.env.VITE_PASSWORD;
    if (isPasswordProtected && !isAuthenticated) return;
    loadData();
  }, [isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // 月範囲は初期マウント時に「直近1年」で確定済み。
  // 旧仕様（データ最新月に end を合わせる）はここで上書きされ、当月起点の start に戻ってしまうため削除。

  // 会計月範囲は全行1周のみ。以降の絞り込みは同配列＋Set（二重の filterRows 全件走査を避ける）
  const rowsInMonth = useMemo(
    () => (rawData?.rows?.length ? filterRowsInMonthRange(rawData.rows, monthRange.start, monthRange.end) : []),
    [rawData, monthRange.start, monthRange.end]
  );

  /** 期間指定の「開始月」を会計年度のキーに反映（kasouhin_uriage_Web と同様） */
  const rowsWithFiscalByStartMonth = useMemo(
    () => mapRowsWithFiscalYearStart(rowsInMonth, monthRange.start),
    [rowsInMonth, monthRange.start]
  );

  const filteredRows = useMemo(() => {
    const leaseSet = selectedLeases.length ? new Set(selectedLeases) : null;
    const orderSet = selectedOrderClients.length ? new Set(selectedOrderClients) : null;
    if (!leaseSet && !orderSet) return rowsWithFiscalByStartMonth;
    return rowsWithFiscalByStartMonth.filter((row) => {
      if (leaseSet && !leaseSet.has(row.leaseCompany ?? '')) return false;
      if (orderSet) {
        const o = row.orderClient ?? '(未分類)';
        if (!orderSet.has(o)) return false;
      }
      return true;
    });
  }, [rowsWithFiscalByStartMonth, selectedLeases, selectedOrderClients]);

  // ダッシュ用：分析名(大)白／ALLOWED_ITEMS 相当のみ。分類の複数選択は空＝3分類すべて
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
    // 地名（横浜市 など）を打ったら市外局番の一覧から候補を出す
    const qArea = norm(bSearchPhone.replace(/[\d\s\-－ー()（）]/g, ''));
    if (qArea) {
      return areaCodes.list
        .filter(([, area]) => norm(area).includes(qArea))
        .slice(0, 50)
        .map(([tel, area]) => ({ value: tel, label: tel, sublabel: '', factory: area }));
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

  const years = useMemo(() => {
    const set = new Set();
    for (const r of dashboardRows) {
      if (r.fiscalYear != null && r.fiscalYear !== '') set.add(Number(r.fiscalYear));
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [dashboardRows]);

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

  // パターンB（工場→メンテ）の工場一覧: 行の子展開でメンテ（リース会社）別を出す
  const factoryChildren = useMemo(() => {
    if (viewMode !== 'B' || viewBVariant === 'orderer' || activeView.branch !== null) return null;
    if (!bSourceRows.length || !years.length) return null;
    return aggregateMenteChildrenByFactory(bSourceRows, years);
  }, [bSourceRows, years, viewMode, viewBVariant, activeView.branch]);

  // ルート計画書Excelの担当者欄用: 最新年度で受注数の多い注文者 上位3名
  const getTopOrderers = useCallback(
    (factories) => topOrderersByFactory(bSourceRows, years[years.length - 1], factories, 3),
    [bSourceRows, years]
  );

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
        dataSource = await loadCsvDataFull();
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
    rows = mapRowsWithFiscalYearStart(rows, monthRange.start);
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
          <button
            onClick={() => {
              startTransition(() => { setReportMode('ncs'); setIsSidebarOpen(false); });
            }}
            className={`flex items-center gap-3 w-full p-4 rounded-2xl transition-all duration-300 ${
              reportMode === 'ncs'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105'
                : 'text-green-400 hover:bg-green-800'
            }`}>
            <MapPin size={20} />
            <span className="font-black text-sm tracking-tight">NCS訪問管理</span>
          </button>
          <button
            onClick={() => {
              startTransition(() => { setReportMode('lease'); setIsSidebarOpen(false); });
            }}
            className={`flex items-center gap-3 w-full p-4 rounded-2xl transition-all duration-300 ${
              reportMode === 'lease'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 scale-105'
                : 'text-green-400 hover:bg-green-800'
            }`}>
            <Building2 size={20} />
            <span className="font-black text-sm tracking-tight">リース会社別レポート</span>
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
      <main className="pt-20 h-screen px-4 pb-4 md:px-8 md:pb-8 overflow-y-auto custom-scrollbar">

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
                      placeholder="数字 or 地名（横浜市→045）"
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
            monthRange={monthRange}
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
            factoryChildren={factoryChildren}
            factoryAddressByBranch={factoryAddressByBranch}
            factoryPhoneByBranch={factoryPhoneByBranch}
            getTopOrderers={getTopOrderers}
          />
        )}
        {rawData && !isLoading && reportMode === 'margin' && (
          <ProductMarginView items={allProductMonthly} leaseCompanies={leaseCompanies} />
        )}
        {rawData && !isLoading && reportMode === 'tab' && (
          <TabPriceView rows={rawData.rows} leaseCompanies={leaseCompanies} />
        )}
        {rawData && !isLoading && reportMode === 'ncs' && (
          <NcsVisitView rows={rawData.rows} leaseCompanies={leaseCompanies} />
        )}
        {rawData && !isLoading && reportMode === 'lease' && (
          <LeaseReportView rows={rawData.rows} />
        )}
      </main>
    </div>
  );
};

// ===== リース会社別レポート（工場別リビルト実績 / 支店別実績 / よく出る車種） =====

const LEASE_REPORT_ITEM_LABEL = { 'オルタネーター': 'オルタ', 'スターター': 'スターター', 'コンプレッサー': 'コンプレッサー' };
const LEASE_REPORT_LEASE_NAME = { OR: 'オリックス自動車' };
const LEASE_REPORT_RENDER_STEP = 200;
const LEASE_REPORT_FILE_NAME = { factory: '工場別レポート', client: '支店別レポート', car: '車種別レポート' };
/** よく出る車種の初期表示（A4横1枚に収まる数）。残りは「その他」にまとめる */
const LEASE_REPORT_CAR_TOP = 22;
const LEASE_REPORT_TAB_TITLE = {
  factory: '工場別リビルト実績',
  client: '支店別実績（オルタ・スターター・コンプレッサー）',
  car: 'よく出る車種（オルタ・スターター・コンプレッサー）',
};
/** 提出用の印刷（工場別・支店別）：ブラウザのヘッダー/フッターを消すため余白0、余白は各ページに中で付ける */
const LEASE_REPORT_PRINT_TITLE = { factory: '工場別ご実績', client: '支店別ご実績' };
const LEASE_REPORT_CAR_PRINT_CSS = `@media print {
  @page { size: A4 landscape; margin: 0; }
  .lease-print-sheet { padding: 8mm 10mm; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
}`;
const LEASE_REPORT_PRINT_CSS = `@media print {
  @page { size: A4; margin: 0; }
  .lease-print-sheet { padding: 10mm 12mm; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
}`;

/** 年度の見出し（途中の年度は「〜◯月 途中」） */
const LeaseYearTh = ({ fy, info }) => (
  <th className="px-3 py-2 font-black text-right whitespace-nowrap">
    {fy}年度
    <span className="block text-[9px] font-bold text-green-300">
      {info.partial && fy === info.lastFy ? `4月〜${info.lastMonth}月 途中` : `${fy}/4〜${fy + 1}/3`}
    </span>
  </th>
);

/** 本数＋前年比（途中の年度は前年同期間と比べる） */
const LeaseQtyTd = ({ series, fy, info, className = '' }) => {
  const q = series.byFy.get(fy) || 0;
  return (
    <td className={`px-3 py-1.5 text-right whitespace-nowrap ${className}`}>
      {q ? q.toLocaleString() : ''}<NcsYoY curr={q} prev={prevBase(series, fy, info)} />
    </td>
  );
};

const leaseYoYText = (series, fy, info) => {
  const y = calcYoY(series.byFy.get(fy) || 0, prevBase(series, fy, info));
  return y == null ? '' : y;
};

const LeaseReportView = memo(({ rows }) => {
  const index = useMemo(() => buildLeaseReportIndex(rows), [rows]);
  const leaseOptions = useMemo(() => {
    const qty = new Map();
    index.leases.forEach((cells, l) => { let t = 0; cells.forEach(c => { t += c.qty; }); qty.set(l, t); });
    const order = l => { const i = TAB_LEASE_ORDER.indexOf(l); return i < 0 ? 99 : i; };
    return [...qty.keys()].sort((a, b) => order(a) - order(b) || qty.get(b) - qty.get(a));
  }, [index]);

  const [lease, setLease] = useState(ORIX_LEASE);
  const [clients, setClients] = useState(() => defaultClientSelection(index, ORIX_LEASE));
  const [tab, setTab] = useState('factory'); // 'factory' | 'client' | 'car'
  const [carFy, setCarFy] = useState(index.lastFy);
  const [carShowAll, setCarShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [renderLimit, setRenderLimit] = useState(LEASE_REPORT_RENDER_STEP);

  // データ読み直しで OR が無い・選択が古いときは合わせ直す
  useEffect(() => {
    if (leaseOptions.length && !leaseOptions.includes(lease)) {
      setLease(leaseOptions[0]);
      setClients(defaultClientSelection(index, leaseOptions[0]));
    }
  }, [leaseOptions, lease, index]);

  const clientList = useMemo(() => listClients(index, lease), [index, lease]);
  const westDefault = useMemo(() => defaultClientSelection(index, lease), [index, lease]);

  const resetView = () => { setOpenKey(null); setRenderLimit(LEASE_REPORT_RENDER_STEP); setCarShowAll(false); };
  const changeLease = (l) => {
    setLease(l);
    setClients(defaultClientSelection(index, l));
    setQuery('');
    resetView();
  };
  const toggleClient = (name) => {
    setClients(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
    resetView();
  };

  const factorySum = useMemo(
    () => (tab === 'factory' ? summarizeFactories(index, lease, clients) : null),
    [tab, index, lease, clients],
  );
  const clientSum = useMemo(
    () => (tab === 'client' ? summarizeClients(index, lease, clients) : null),
    [tab, index, lease, clients],
  );
  const carSum = useMemo(
    () => (tab === 'car' ? summarizeCars(index, lease, clients, carFy) : null),
    [tab, index, lease, clients, carFy],
  );
  const sum = tab === 'factory' ? factorySum : clientSum;
  const info = sum?.info;
  const years = info?.years || [];
  const carPartial = carFy === index.lastFy && index.lastFm < 11;
  const carFyLabel = fy => (fy === index.lastFy && index.lastFm < 11
    ? `${fy}年度（4月〜${monthOfFiscalIndex(index.lastFm)}月 途中）`
    : `${fy}年度（${fy}/4〜${fy + 1}/3）`);

  const shownFactories = useMemo(() => {
    if (!factorySum) return [];
    const q = norm(query);
    if (!q) return factorySum.rows;
    return factorySum.rows.filter(f => norm(`${f.key} ${f.pref} ${f.address}`).includes(q));
  }, [factorySum, query]);

  /** 表の一番下の「計」（工場別は絞り込み後の工場、支店別は選んだ得意先） */
  const bottomTotal = useMemo(() => {
    if (tab === 'car') return null;
    if (tab === 'client') return clientSum.rows.length ? { total: clientSum.total, items: clientSum.totalItems } : null;
    if (!shownFactories.length) return null;
    return {
      total: sumSeries(shownFactories.map(f => f.total)),
      items: new Map(REBUILD_ITEMS.map(it => [it, sumSeries(shownFactories.map(f => f.items.get(it)))])),
    };
  }, [tab, clientSum, shownFactories]);

  const printTitle = LEASE_REPORT_PRINT_TITLE[tab]
    ? `${LEASE_REPORT_LEASE_NAME[lease] || lease}様　${LEASE_REPORT_PRINT_TITLE[tab]}`
    : null;
  const scopeText = clients.size === 0
    ? '全得意先'
    : (lease === ORIX_LEASE && clients.size === westDefault.size && [...westDefault].every(n => clients.has(n))
      ? `西日本（${WEST_ORIX_CLIENT_KEYWORDS.join('・')}）`
      : `${clients.size}得意先`);

  const handleCsv = () => {
    const yCols = years.flatMap(fy => [`${fy}年度`, `${fy}年度 前年比%`]);
    const line = (cells) => cells.map(ncsCsvQ).join(',');
    const yVals = s => years.flatMap(fy => [s.byFy.get(fy) || 0, leaseYoYText(s, fy, info)]);
    const out = [];
    if (tab === 'car') {
      out.push(line(['品目', '順位', '車種', `${carFy}年度`, carPartial ? '前年同期間' : `${carFy - 1}年度`, '前年比%']));
      REBUILD_ITEMS.forEach(it => carSum.items.get(it).rows.forEach((r, i) => {
        const y = calcYoY(r.qty, r.prev);
        out.push(line([it, i + 1, r.car, r.qty, r.prev, y == null ? '' : y]));
      }));
    } else if (tab === 'factory') {
      out.push(line(['工場', '都道府県', '品目', ...yCols]));
      for (const f of shownFactories) {
        out.push(line([f.key, f.pref, '計', ...yVals(f.total)]));
        REBUILD_ITEMS.forEach(it => out.push(line([f.key, f.pref, it, ...yVals(f.items.get(it))])));
      }
      if (bottomTotal) {
        out.push(line(['計', '', '計', ...yVals(bottomTotal.total)]));
        REBUILD_ITEMS.forEach(it => out.push(line(['計', '', it, ...yVals(bottomTotal.items.get(it))])));
      }
    } else {
      out.push(line(['得意先', '品目', ...yCols]));
      for (const c of clientSum.rows) {
        out.push(line([shortClientName(c.client), '計', ...yVals(c.total)]));
        REBUILD_ITEMS.forEach(it => out.push(line([shortClientName(c.client), it, ...yVals(c.items.get(it))])));
      }
      if (bottomTotal) {
        out.push(line(['計', '計', ...yVals(bottomTotal.total)]));
        REBUILD_ITEMS.forEach(it => out.push(line(['計', it, ...yVals(bottomTotal.items.get(it))])));
      }
    }
    const kind = { factory: '工場別リビルト実績', client: '支店別実績', car: `よく出る車種_${carFy}年度` }[tab];
    ncsDownload(new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${lease}_${kind}.csv`);
  };

  // 印刷と同じ中身を Excel に（工場別は開いている工場だけ内訳つき、車種は表示中の上位＋その他）
  const handleExcel = async () => {
    try {
      await writeLeaseReportXlsx({
        tab,
        fileName: LEASE_REPORT_FILE_NAME[tab],
        title: printTitle || `${lease}　${LEASE_REPORT_TAB_TITLE[tab]}`,
        items: REBUILD_ITEMS, itemLabel: LEASE_REPORT_ITEM_LABEL,
        footer: printTitle ? 'アライ電機産業株式会社' : null,
        years, info, bottomTotal,
        factories: shownFactories, openKey,
        clientRows: clientSum?.rows, clientName: shortClientName,
        carSum, carSubTitle: `${carFyLabel(carFy)}　${scopeText}`, carTop: LEASE_REPORT_CAR_TOP, carShowAll, carPartial,
      });
    } catch (e) {
      console.error(e);
      alert(e?.message || 'Excelの作成に失敗したよ');
    }
  };

  /** PDF の保存名は document.title になるので、印刷の間だけ「工場別レポート_20261023」にする */
  const handlePrint = () => {
    flushSync(() => setRenderLimit(Infinity));
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const prevTitle = document.title;
    document.title = `${LEASE_REPORT_FILE_NAME[tab]}_${ymd}`;
    const restore = () => { document.title = prevTitle; window.removeEventListener('afterprint', restore); };
    window.addEventListener('afterprint', restore);
    window.print();
  };

  const tabBtn = (key, label, Icon) => (
    <button key={key} onClick={() => { setTab(key); resetView(); }}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-black transition-all ${
        tab === key ? 'bg-white text-slate-800 shadow' : 'text-slate-500 hover:text-slate-700'}`}>
      <Icon size={16} /> {label}
    </button>
  );
  const totalBody = (labelSpan) => bottomTotal && (
    <tbody className="print-group border-t-2 border-green-900">
      <tr className="bg-emerald-50">
        <td className="px-3 py-2 font-black text-emerald-800" colSpan={labelSpan}>計</td>
        {years.map(fy => <LeaseQtyTd key={fy} series={bottomTotal.total} fy={fy} info={info} className="font-black text-slate-800" />)}
      </tr>
      {REBUILD_ITEMS.map(it => (
        <tr key={it} className="bg-emerald-50/40 border-b border-slate-100">
          <td className="px-3 py-1 pl-8 font-bold text-emerald-700" colSpan={labelSpan}>{LEASE_REPORT_ITEM_LABEL[it]}</td>
          {years.map(fy => <LeaseQtyTd key={fy} series={bottomTotal.items.get(it)} fy={fy} info={info} className="font-bold text-slate-700" />)}
        </tr>
      ))}
    </tbody>
  );
  const chipCls = on => `px-3 py-1.5 rounded-xl text-xs font-black border transition-colors ${
    on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-500 border-slate-200 hover:border-emerald-300'}`;

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex flex-wrap items-center gap-3 no-print">
        <div className="flex items-center gap-2 mr-2">
          <Building2 size={22} className="text-emerald-600" />
          <h2 className="text-2xl font-black text-slate-800 tracking-tight">リース会社別レポート</h2>
        </div>
        <div className="inline-flex flex-wrap gap-1 bg-slate-100 p-1.5 rounded-3xl">
          {tabBtn('factory', '工場別リビルト実績', Building2)}
          {tabBtn('client', '支店別実績', Layers)}
          {tabBtn('car', 'よく出る車種', Car)}
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={handleCsv} className="flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-black bg-white border border-slate-200 text-slate-600 hover:text-emerald-600 hover:border-emerald-300 shadow-sm">
            <Download size={14} /> CSV
          </button>
          <button onClick={handleExcel} title="印刷と同じ表をExcelで保存" className="flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-black bg-white border border-slate-200 text-slate-600 hover:text-emerald-600 hover:border-emerald-300 shadow-sm">
            <FileSpreadsheet size={14} /> Excel
          </button>
          <button onClick={handlePrint} className="flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-black bg-green-900 text-white hover:bg-emerald-600 shadow-sm">
            <FileText size={14} /> 印刷
          </button>
        </div>
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-5 space-y-4 no-print">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-black text-slate-500">リース会社</span>
          <select value={lease} onChange={e => changeLease(e.target.value)}
            className="px-4 py-2.5 rounded-2xl border border-slate-200 bg-white text-sm font-black text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-300">
            {leaseOptions.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          {tab === 'factory' && (
            <input value={query} onChange={e => { setQuery(e.target.value); setRenderLimit(LEASE_REPORT_RENDER_STEP); }}
              placeholder="工場名・県で絞り込み"
              className="ml-auto w-64 px-4 py-2.5 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-300" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-black text-slate-500 mr-1">得意先</span>
          <button onClick={() => { setClients(new Set()); resetView(); }} className={chipCls(clients.size === 0)}>全部</button>
          <span className="w-px h-5 bg-slate-200 mx-1" />
          {clientList.map(c => (
            <button key={c.name} onClick={() => toggleClient(c.name)} className={chipCls(clients.has(c.name))}>
              {shortClientName(c.name)}
            </button>
          ))}
        </div>
      </div>

      <div className={`bg-white rounded-3xl shadow-sm border border-slate-100 p-4 md:p-6 ${
        printTitle || tab === 'car' ? 'lease-print-sheet print:!mt-0 print:rounded-none print:border-0 print:shadow-none' : ''}`}>
        {printTitle && <style>{LEASE_REPORT_PRINT_CSS}</style>}
        {tab === 'car' && <style>{LEASE_REPORT_CAR_PRINT_CSS}</style>}
        {printTitle && <h1 className="hidden print:block mb-4 text-xl font-black text-slate-900">{printTitle}</h1>}
        <div className={`mb-3 font-black text-slate-800 ${printTitle ? 'print:hidden' : ''}`}>
          {lease}　{LEASE_REPORT_TAB_TITLE[tab]}
          {tab === 'car' && <span className="ml-2 text-sm font-black text-emerald-700">{carFyLabel(carFy)}</span>}
          <span className="ml-2 text-xs font-bold text-slate-500">{scopeText}</span>
        </div>
        <div className="overflow-x-auto">
          {tab === 'car' ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-1.5 no-print">
                <span className="text-xs font-black text-slate-500 mr-1">年度</span>
                {carSum.years.map(fy => (
                  <button key={fy} onClick={() => { setCarFy(fy); setCarShowAll(false); }} className={chipCls(carFy === fy)}>{fy}年度</button>
                ))}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 print:grid-cols-3 gap-4 print:gap-3">
                {REBUILD_ITEMS.map(it => {
                  const g = carSum.items.get(it);
                  const shown = carShowAll ? g.rows : g.rows.slice(0, LEASE_REPORT_CAR_TOP);
                  let topQty = 0, topPrev = 0;
                  shown.forEach(r => { topQty += r.qty; topPrev += r.prev; });
                  const other = shown.length < g.rows.length ? { qty: g.total - topQty, prev: g.prevTotal - topPrev } : null;
                  const sumRow = (label, qty, prev, cls) => (
                    <tr className={cls}>
                      <td />
                      <td className="px-2 py-1 font-black">{label}</td>
                      <td className="px-3 py-1 text-right whitespace-nowrap font-black">
                        {qty.toLocaleString()}<NcsYoY curr={qty} prev={prev} />
                      </td>
                    </tr>
                  );
                  return (
                    <div key={it} className="print-group border border-slate-100 rounded-2xl overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-green-900 text-white">
                          <tr>
                            <th className="px-2 py-2 text-right font-black w-8">#</th>
                            <th className="px-2 py-2 text-left font-black">{LEASE_REPORT_ITEM_LABEL[it]}</th>
                            <th className="px-3 py-2 text-right font-black whitespace-nowrap">本数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((r, i) => (
                            <tr key={r.car} className="border-b border-slate-50">
                              <td className="px-2 py-1 text-right font-bold text-slate-400">{i + 1}</td>
                              <td className="px-2 py-1 font-bold text-slate-700">{r.car}</td>
                              <td className="px-3 py-1 text-right whitespace-nowrap font-black text-slate-800">
                                {r.qty.toLocaleString()}<NcsYoY curr={r.qty} prev={r.prev} />
                              </td>
                            </tr>
                          ))}
                          {!g.rows.length && (
                            <tr><td colSpan={3} className="px-3 py-8 text-center text-slate-400 font-bold">データがないよ</td></tr>
                          )}
                          {other && sumRow(`その他（${(g.rows.length - shown.length).toLocaleString()}車種）`, other.qty, other.prev, 'border-b border-slate-100 bg-slate-50 text-slate-600')}
                          {g.rows.length > 0 && sumRow('計', g.total, g.prevTotal, 'border-t-2 border-green-900 bg-emerald-50 text-emerald-800')}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
              {REBUILD_ITEMS.some(it => carSum.items.get(it).rows.length > LEASE_REPORT_CAR_TOP) && (
                <div className="flex justify-center no-print">
                  <button onClick={() => setCarShowAll(v => !v)} className="px-4 py-2 rounded-xl text-xs font-black bg-slate-100 text-slate-600 hover:bg-emerald-50">
                    {carShowAll ? `上位${LEASE_REPORT_CAR_TOP}車種＋その他に戻す` : '全部表示'}
                  </button>
                </div>
              )}
              <div className="text-[11px] font-bold text-slate-400">
                車種＝車種名（メーカー）＋車輌型式のハイフンより前。前年比は{carPartial ? '前年同期間' : '前年度'}と比べてるよ
              </div>
            </div>
          ) : tab === 'factory' ? (
            <table className="w-full text-xs">
              <thead className="bg-green-900 text-white">
                <tr>
                  <th className="px-3 py-2 text-left font-black">工場</th>
                  <th className="px-3 py-2 text-left font-black whitespace-nowrap">県</th>
                  {years.map(fy => <LeaseYearTh key={fy} fy={fy} info={info} />)}
                </tr>
              </thead>
              {shownFactories.slice(0, renderLimit).map(f => {
                const open = openKey === f.key;
                return (
                  <tbody key={f.key} className="print-group">
                    <tr onClick={() => setOpenKey(open ? null : f.key)}
                      className="border-b border-slate-100 hover:bg-emerald-50/50 cursor-pointer">
                      <td className="px-3 py-1.5 font-black text-slate-800">
                        <span className="inline-flex items-center gap-1">
                          {open ? <ChevronDown size={12} className="text-emerald-600 no-print" /> : <ChevronRight size={12} className="text-slate-300 no-print" />}
                          {f.key}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-bold text-slate-500 whitespace-nowrap">{f.pref}</td>
                      {years.map(fy => <LeaseQtyTd key={fy} series={f.total} fy={fy} info={info} className="font-black text-slate-800" />)}
                    </tr>
                    {open && REBUILD_ITEMS.map(it => (
                      <React.Fragment key={it}>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <td className="px-3 py-1 pl-8 font-black text-emerald-700" colSpan={2}>{LEASE_REPORT_ITEM_LABEL[it]}</td>
                          {years.map(fy => <LeaseQtyTd key={fy} series={f.items.get(it)} fy={fy} info={info} className="font-bold text-slate-700" />)}
                        </tr>
                        {f.mids.filter(m => m.item === it).map(m => (
                          <tr key={m.mid} className="bg-slate-50/50 border-b border-slate-50">
                            <td className="px-3 py-1 pl-14 font-bold text-slate-500" colSpan={2}>{m.mid}</td>
                            {years.map(fy => <LeaseQtyTd key={fy} series={m.series} fy={fy} info={info} className="text-slate-500" />)}
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                );
              })}
              {!shownFactories.length && (
                <tbody><tr><td colSpan={2 + years.length} className="px-3 py-10 text-center text-slate-400 font-bold">条件に合う工場がないよ</td></tr></tbody>
              )}
              {totalBody(2)}
            </table>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-green-900 text-white">
                <tr>
                  <th className="px-3 py-2 text-left font-black">得意先 / 品目</th>
                  {years.map(fy => <LeaseYearTh key={fy} fy={fy} info={info} />)}
                </tr>
              </thead>
              {clientSum.rows.map(c => (
                <tbody key={c.client} className="print-group">
                  <tr className="border-b border-slate-100 bg-white">
                    <td className="px-3 py-1.5 font-black text-slate-800">{shortClientName(c.client)}</td>
                    {years.map(fy => <LeaseQtyTd key={fy} series={c.total} fy={fy} info={info} className="font-black text-slate-800" />)}
                  </tr>
                  {REBUILD_ITEMS.map(it => (
                    <tr key={it} className="border-b border-slate-50">
                      <td className="px-3 py-1 pl-8 font-bold text-slate-500">{LEASE_REPORT_ITEM_LABEL[it]}</td>
                      {years.map(fy => <LeaseQtyTd key={fy} series={c.items.get(it)} fy={fy} info={info} className="text-slate-700" />)}
                    </tr>
                  ))}
                </tbody>
              ))}
              {!clientSum.rows.length && (
                <tbody><tr><td colSpan={1 + years.length} className="px-3 py-10 text-center text-slate-400 font-bold">データがないよ</td></tr></tbody>
              )}
              {totalBody(1)}
            </table>
          )}
        </div>
        {tab === 'factory' && shownFactories.length > renderLimit && (
          <div className="mt-3 flex gap-2 justify-center no-print">
            <button onClick={() => setRenderLimit(n => n + LEASE_REPORT_RENDER_STEP)} className="px-4 py-2 rounded-xl text-xs font-black bg-slate-100 text-slate-600 hover:bg-emerald-50">
              もっと見る（残り {(shownFactories.length - renderLimit).toLocaleString()}工場）
            </button>
            <button onClick={() => setRenderLimit(Infinity)} className="px-4 py-2 rounded-xl text-xs font-black bg-slate-100 text-slate-600 hover:bg-emerald-50">全部表示</button>
          </div>
        )}
        {printTitle && <div className="hidden print:block mt-6 text-right text-sm font-black text-slate-900">アライ電機産業株式会社</div>}
      </div>
    </div>
  );
});

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

const RENDER_CHUNK = 150;

// ===== ダッシュ表の1行（＋展開した子行）。チェック/展開で該当行だけ再描画させるため memo =====
const NO_CHILDREN = [];
const formatMarginRate = (p, s) => {
  if (s == null || s === 0) return '—';
  return `${((p / s) * 100).toFixed(1)}%`;
};
const DashRowGroup = memo(({
  row, years, viewMode, isLeafLevel, canExpand, isChecked, isOpen, childRows, showFactoryInfo, address, phone,
  fmtAmt, showProfit, onToggleCheck, onToggleExpand, onDrillDown, onNavigateTo,
}) => (
    <tbody className={`print-group border-t border-slate-100 ${isChecked ? '' : 'no-print'}`}>
      <tr
        className={`group hover:bg-emerald-50/30 transition-colors ${!isLeafLevel ? 'cursor-pointer' : ''} ${isOpen ? 'bg-emerald-50/20' : ''}`}
        onClick={() => {
          if (canExpand) onToggleExpand(row.name);
          else if (!isLeafLevel) onDrillDown(row);
        }}>
        <td className="px-1 md:px-2 py-4 w-10 md:w-12 align-middle text-center" onClick={e => e.stopPropagation()}>
          <button type="button" onClick={() => onToggleCheck(row.name)}
            className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-emerald-600 transition-colors">
            {isChecked
              ? <CheckSquare size={16} className="text-emerald-600" />
              : <Square size={16} className="text-slate-300" />}
          </button>
        </td>
        <td className="px-3 md:px-8 py-4">
          <div className="font-black text-slate-800 text-sm md:text-lg group-hover:text-emerald-600 transition-colors flex items-center gap-2">
            {canExpand && (
              isOpen
                ? <ChevronDown size={16} className="text-emerald-600 flex-shrink-0 no-print" />
                : <ChevronRight size={16} className="text-slate-400 flex-shrink-0 no-print" />
            )}
            {row.name}
            {!isLeafLevel && !canExpand && (
              <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-all -translate-x-2 group-hover:translate-x-0" />
            )}
          </div>
          {showFactoryInfo && (address || phone) ? (
            <div
              className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 max-w-3xl text-xs font-bold text-slate-500"
              onMouseDown={e => e.stopPropagation()}
            >
              {address ? <span className="break-words">{address}</span> : null}
              {phone ? <span className="text-slate-600 select-text">TEL: {phone}</span> : null}
            </div>
          ) : null}
          {!isLeafLevel && (
            <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-tighter no-print">
              {canExpand ? 'クリックでメンテ別を展開' : 'クリックでドリルダウン'}
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
      {childRows.map(c => (
        <tr key={c.name}
          className="bg-slate-50/60 hover:bg-emerald-50/40 cursor-pointer transition-colors"
          title="クリックで分析名(大)別へ"
          onClick={() => onNavigateTo({ leaseCo: c.name, branch: row.name, item: null, orderClient: null, orderer: null })}>
          <td className="w-10 md:w-12" />
          <td className="pl-10 md:pl-16 pr-3 py-2 border-l-4 border-emerald-200" />
          {years.map((year, yIdx) => {
            const q = c.quantity[year] || 0;
            const qoy = years[yIdx-1] ? calcYoY(q, c.quantity[years[yIdx-1]]) : null;
            return (
              <td key={year} className="px-2 md:px-6 py-2 border-l border-slate-300">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-bold text-slate-700 text-xs md:text-sm">{c.name}</span>
                  <span className="text-right">
                    <span className="font-mono font-black text-slate-600 text-xs md:text-sm">{q ? q.toLocaleString() : ''}</span>
                    {qoy !== null && (
                      <span className={`ml-2 text-[10px] font-black ${parseFloat(qoy) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {parseFloat(qoy) >= 0 ? '↗' : '↘'}{qoy}%
                      </span>
                    )}
                  </span>
                </div>
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
));

// ===== ダッシュボードビュー =====
const DashboardView = memo(({
  data, years, monthRange, activeView, viewMode, viewBVariant, isLeafLevel, checkedItems, onCheckedChange,
  onDrillDown, onNavigateTo, onSavePdf, onSaveCsv, fmtAmt, amountUnit, showProfit, totalRow,
  factoryChildren = null,
  factoryAddressByBranch = new Map(),
  factoryPhoneByBranch = new Map(),
  getTopOrderers,
}) => {
  const toggleCheck = useCallback((name) => {
    onCheckedChange(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }, [onCheckedChange]);

  // 年度別ソート
  const [sortYear, setSortYear] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  // ソートキー: viewMode='A' は売上、'B' は受注数
  const sortKey = viewMode === 'A' ? 'sales' : 'quantity';
  const sortKeyLabel = viewMode === 'A' ? '売上' : '受注数';

  const displayData = useMemo(() => {
    if (!sortYear || !years.includes(sortYear)) return data;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => ((a[sortKey]?.[sortYear] || 0) - (b[sortKey]?.[sortYear] || 0)) * dir);
  }, [data, sortYear, sortDir, sortKey, years]);

  // 段階描画: 工場一覧は8千行超になるので、最初は一部だけ描いて下までスクロールしたら継ぎ足す
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK);
  const [printing, setPrinting] = useState(false);
  useEffect(() => { setRenderLimit(RENDER_CHUNK); }, [displayData]);
  const visibleData = useMemo(() => {
    if (printing) return displayData.filter(d => checkedItems.has(d.name));
    return renderLimit >= displayData.length ? displayData : displayData.slice(0, renderLimit);
  }, [displayData, renderLimit, printing, checkedItems]);
  const moreRef = useRef(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setRenderLimit(n => n + RENDER_CHUNK);
    }, { root: el.closest('main'), rootMargin: '1500px 0px' }); // スクロールするのは main
    io.observe(el);
    return () => io.disconnect();
  }, [visibleData]);
  // 印刷/PDFの直前はチェックした行を全部描く
  useEffect(() => {
    const onBefore = () => flushSync(() => setPrinting(true));
    const onAfter = () => setPrinting(false);
    window.addEventListener('beforeprint', onBefore);
    window.addEventListener('afterprint', onAfter);
    return () => {
      window.removeEventListener('beforeprint', onBefore);
      window.removeEventListener('afterprint', onAfter);
    };
  }, []);

  // 工場一覧の子展開（メンテ別）。工場名の Set
  const [expanded, setExpanded] = useState(() => new Set());
  const canExpand = !!factoryChildren;
  const toggleExpand = useCallback((name) => {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }, []);

  // チェックした工場を営業ルートプランナー用の計画書Excelに（工場一覧のときだけ）
  const canRouteExport = viewMode === 'B' && activeView.branch === null;
  const handleRouteExport = useCallback(async () => {
    const picked = displayData.filter(d => checkedItems.has(d.name) && d.name !== '(未分類)');
    const top = getTopOrderers ? getTopOrderers(picked.map(d => d.name)) : new Map();
    const list = picked.map(d => ({
      name: d.name,
      address: (factoryAddressByBranch.get(d.name) || '').trim(),
      tel: (factoryPhoneByBranch.get(d.name) || '').trim(),
      contact: (top.get(d.name) || []).join('、'),
    }));
    if (!list.length) { alert('ルートに入れる工場にチェックしてね'); return; }
    try {
      await writeRoutePlanXlsx(list);
    } catch (e) {
      console.error(e);
      alert(e?.message || 'ルート計画書の作成に失敗したよ');
    }
  }, [displayData, checkedItems, factoryAddressByBranch, factoryPhoneByBranch, getTopOrderers]);

  const handleSortYear = useCallback((year) => {
    if (sortYear !== year) {
      setSortYear(year);
      setSortDir('desc');
    } else if (sortDir === 'desc') {
      setSortDir('asc');
    } else {
      setSortYear(null);
      setSortDir('desc');
    }
  }, [sortYear, sortDir]);

  const { leaseCo, branch, item } = activeView;
  const showFactoryInfo = viewMode === 'B' && branch === null;
  const emptyView = { leaseCo: null, branch: null, item: null, orderClient: null, orderer: null };

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

  // PDF と同じ中身（チェックした行＋合計、展開中の子）を Excel に
  const handleExcelExport = async () => {
    const picked = displayData.filter(d => checkedItems.has(d.name));
    if (!picked.length) { alert('Excelに出す行にチェックしてね'); return; }
    const list = picked.map(d => ({
      ...d,
      address: showFactoryInfo ? (factoryAddressByBranch.get(d.name) || '').trim() : '',
      phone: showFactoryInfo ? (factoryPhoneByBranch.get(d.name) || '').trim() : '',
      children: canExpand && expanded.has(d.name) ? (factoryChildren.get(d.name) || NO_CHILDREN) : NO_CHILDREN,
    }));
    try {
      await writeDashboardXlsx({
        title: levelTitle, levelLabel, years, monthRange, rows: list,
        totalLabel: totalRow?.name ?? null,
        showSales: viewMode === 'A', showProfit, showFactoryInfo, amountUnit,
      });
    } catch (e) {
      console.error(e);
      alert(e?.message || 'Excelの作成に失敗したよ');
    }
  };

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
        {canExpand && (
          <>
            <button onClick={() => setExpanded(new Set(data.map(d => d.name)))}
              title="すべての工場を展開"
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 text-xs font-black transition-colors">
              <ChevronDown size={14} /> 全展開
            </button>
            <button onClick={() => setExpanded(new Set())}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 text-xs font-black transition-colors">
              <ChevronUp size={14} /> 全閉じ
            </button>
          </>
        )}
        {canRouteExport && (
          <button onClick={handleRouteExport}
            title="チェックした工場を営業ルートプランナーの訪問先に入れた計画書Excelを保存"
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 text-xs font-black transition-colors">
            <MapPin size={14} /> ルート計画書Excel
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-3xl md:rounded-[3rem] shadow-sm border border-slate-100 overflow-clip">
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
              <button onClick={handleExcelExport}
                title="PDFと同じ表（チェックした行＋合計）をExcelで保存"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-xl border border-slate-200 text-slate-600 hover:text-emerald-500 hover:border-emerald-200 transition-all shadow-sm text-xs font-bold">
                <FileSpreadsheet size={14} /> Excel
              </button>
              <button onClick={onSaveCsv}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-xl border border-slate-200 text-slate-600 hover:text-emerald-500 hover:border-emerald-200 transition-all shadow-sm text-xs font-bold">
                <FileSpreadsheet size={14} /> CSV
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-clip">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-green-900 text-sm md:text-xl font-black text-white tracking-wide text-center">
                <th className="px-1 md:px-2 py-3 md:py-4 w-10 md:w-12 text-center sticky top-0 z-10 bg-green-900">選択</th>
                <th className="px-3 md:px-8 py-3 md:py-4 min-w-[140px] md:min-w-[200px] text-center sticky top-0 z-10 bg-green-900">
                  {levelLabel}
                </th>
                {years.map((year) => {
                  const sm = parseInt(String(monthRange?.start ?? '4'), 10);
                  const em = parseInt(String(monthRange?.end ?? '3'), 10);
                  const range =
                    sm <= em
                      ? `${year}年${sm}月〜${year}年${em}月`
                      : `${year}年${sm}月〜${year + 1}年${em}月`;
                  const isSorted = sortYear === year;
                  return (
                    <th key={year}
                      onClick={() => handleSortYear(year)}
                      title={isSorted ? `${sortDir === 'desc' ? '降順' : '昇順'}（再クリックで切替）` : `クリックで${sortKeyLabel}順`}
                      className="px-2 md:px-6 py-3 md:py-4 text-center border-l border-green-800 min-w-[120px] sticky top-0 z-10 bg-green-900 cursor-pointer hover:bg-green-800 transition-colors select-none">
                      <div className="flex items-center justify-center gap-1">
                        <span>{year}年度</span>
                        {isSorted ? (
                          sortDir === 'desc'
                            ? <ArrowDownRight size={14} className="text-amber-300" />
                            : <ArrowUpRight size={14} className="text-amber-300" />
                        ) : (
                          <ArrowUpDown size={12} className="opacity-40" />
                        )}
                      </div>
                      <div className="text-[10px] font-normal opacity-80 mt-0.5 leading-tight">{range}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>

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

              {displayData.length === 0 && (
                <tr>
                  <td colSpan={years.length + 2} className="px-4 py-12 text-center text-slate-300 italic">
                    該当するデータがありません
                  </td>
                </tr>
              )}
            </tbody>
              {visibleData.map((row, idx) => {
                const isOpen = canExpand && expanded.has(row.name);
                return (
                  <DashRowGroup key={row.name ?? idx}
                    row={row} years={years} viewMode={viewMode} isLeafLevel={isLeafLevel} canExpand={canExpand}
                    isChecked={checkedItems.has(row.name)} isOpen={isOpen}
                    childRows={isOpen ? (factoryChildren.get(row.name) || NO_CHILDREN) : NO_CHILDREN}
                    showFactoryInfo={showFactoryInfo}
                    address={showFactoryInfo ? (factoryAddressByBranch.get(row.name) || '').trim() : ''}
                    phone={showFactoryInfo ? (factoryPhoneByBranch.get(row.name) || '').trim() : ''}
                    fmtAmt={fmtAmt} showProfit={showProfit}
                    onToggleCheck={toggleCheck} onToggleExpand={toggleExpand}
                    onDrillDown={onDrillDown} onNavigateTo={onNavigateTo} />
                );
              })}
              {!printing && visibleData.length < displayData.length && (
                <tbody className="no-print">
                  <tr ref={moreRef}>
                    <td colSpan={years.length + 2} className="px-4 py-6 text-center text-xs font-bold text-slate-400">
                      読み込み中… {visibleData.length.toLocaleString()} / {displayData.length.toLocaleString()} 行
                    </td>
                  </tr>
                </tbody>
              )}
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

/** タブ価格更新 bat の置き場所（⋯メニューの更新手順に表示） */
const TAB_UPDATE_FOLDER = 'H:\\dev\\mente_web\\タブ価格更新';

/** 登録用CSVの出力順（4社固定） */
const TAB_LEASE_ORDER = ['OR', 'NCS', '西出', 'MAL'];
const TAB_RATE_CATEGORIES = ['オルタネーター', 'スターター', 'コンプレッサー'];
/** 掛率の既定値（TAB価格 = 原価 ÷ 掛率 → 100円切り上げ） */
const TAB_RATE_DEFAULTS = {
  OR:     { 'オルタネーター': 0.70, 'スターター': 0.70, 'コンプレッサー': 0.62 },
  NCS:    { 'オルタネーター': 0.80, 'スターター': 0.75, 'コンプレッサー': 0.72 },
  '西出': { 'オルタネーター': 0.70, 'スターター': 0.70, 'コンプレッサー': 0.62 },
  MAL:    { 'オルタネーター': 0.70, 'スターター': 0.70, 'コンプレッサー': 0.62 },
};
const TAB_RATES_LS_KEY = 'tab_price_rates_v1';

/** localStorage の掛率を既定値にマージして返す（壊れていれば既定値） */
const loadTabRates = () => {
  const out = {};
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TAB_RATES_LS_KEY) || 'null'); } catch { saved = null; }
  for (const lease of TAB_LEASE_ORDER) {
    out[lease] = {};
    for (const cat of TAB_RATE_CATEGORIES) {
      const v = Number(saved?.[lease]?.[cat]);
      out[lease][cat] = v > 0 && v <= 1 ? v : TAB_RATE_DEFAULTS[lease][cat];
    }
  }
  return out;
};

/** 同系品番の基底: 最後の "R-" までを品番本体とみなす（506010-1770R-T / -DK → 506010-1770R） */
const tabBaseCode = code => {
  const s = String(code);
  const i = s.lastIndexOf('R-');
  return i >= 0 ? s.slice(0, i + 1) : s;
};

/** 日付 → "YYYY年M月D日"（tab_data.csv の適用日書式） */
const fmtTabDate = d => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;

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
  const [tabRates, setTabRates]     = useState(loadTabRates);
  const [showMenu, setShowMenu]     = useState(false);   // ⋯ メニュー
  const [showRateModal, setShowRateModal] = useState(false);
  const [showUpdateGuide, setShowUpdateGuide] = useState(false);
  const [guideCopied, setGuideCopied] = useState(false);

  const updateTabRate = useCallback((lease, cat, raw) => {
    const v = Number(raw);
    if (!(v > 0 && v <= 1)) return; // 不正値は保存せず前の値を維持
    setTabRates(prev => {
      const next = { ...prev, [lease]: { ...prev[lease], [cat]: v } };
      try { localStorage.setItem(TAB_RATES_LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const resetTabRates = useCallback(() => {
    try { localStorage.removeItem(TAB_RATES_LS_KEY); } catch {}
    setTabRates(loadTabRates());
  }, []);

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

  // 登録用Excel: 未設定品番ごとに4社ぶん（登録済みは備考「登録済み」）を tab_data 形式で出力
  const handleExportRegisterCsv = () => {
    if (!tabData) return;
    const { tabMap } = tabData;

    // 対象品番 = 未設定品番（リース会社フィルター反映済み）
    const targetCodes = new Set(missingItems.map(m => String(m.productCode)));

    // 品番ごとの代表情報（最新の売上行で上書き）
    const rowDateVal = r => {
      const t = Date.parse(String(r.date));
      return Number.isNaN(t) ? toCalendarYear(r.fiscalYear, r.month) * 100 + r.month : t;
    };
    const info = new Map();
    for (const r of applicableDateFilteredRows) {
      const code = String(r.productCode);
      if (!targetCodes.has(code)) continue;
      const item = normTabItem(r.item);
      if (!TAB_ALLOWED_ITEM_NORMS.has(item)) continue;
      const dv = rowDateVal(r);
      const ex = info.get(code);
      if (ex && ex.dateVal >= dv) continue;
      const lineCost = r.sales - r.profit;
      info.set(code, {
        code, item,
        makerCode: r.makerCode,
        unitCost:  r.quantity > 0 ? lineCost / r.quantity : lineCost,
        dateVal:   dv,
      });
    }

    // コンプレッサーの同系品番インデックス（tab_data 登録済み）: 基底品番 → [{lease, code, ...}]
    // 「…R-T」「…R-DK」は仕入先違いの同一品なので売価を揃える必要がある
    const siblingIndex = new Map();
    for (const lease of TAB_LEASE_ORDER) {
      const codesMap = tabMap.get(lease);
      if (!codesMap) continue;
      for (const [c, reg] of codesMap) {
        const base = tabBaseCode(c);
        if (!siblingIndex.has(base)) siblingIndex.set(base, []);
        siblingIndex.get(base).push({ lease, code: c, makerCode: reg.makerCode, price: reg.price, dateStr: reg.dateStr });
      }
    }

    const today = fmtTabDate(new Date());
    const codes = [...info.keys()].sort((a, b) => a.localeCompare(b));
    // groups: 品番ごとに4行 { lease, code, makerCode, price, dateStr, note, registered } ＋ siblings（同系登録済み）
    const groups = codes.map(code => {
      const e = info.get(code);
      const siblings = e.item === 'コンプレッサー'
        ? (siblingIndex.get(tabBaseCode(code)) || []).filter(s => s.code !== code)
        : [];
      const rows = TAB_LEASE_ORDER.map(lease => {
        const reg = tabMap.get(lease)?.get(code);
        if (reg !== undefined) {
          return { lease, code, makerCode: reg.makerCode || e.makerCode, price: reg.price, dateStr: reg.dateStr, note: '登録済み', registered: true };
        }
        const rate = tabRates[lease]?.[e.item];
        const hasCost = e.unitCost > 0 && rate > 0;
        const price = hasCost ? Math.ceil(e.unitCost / rate / 100) * 100 : null;
        let note = hasCost ? '' : '原価なし';
        // 同じリース会社に同系品番が登録済みなら価格差を備考に
        const sib = siblings.find(s => s.lease === lease);
        if (sib && price != null) {
          note = sib.price === price ? `同系 ${sib.code} と同額` : `要確認: 同系 ${sib.code} は ¥${sib.price.toLocaleString()}`;
        }
        return { lease, code, makerCode: e.makerCode, price, dateStr: today, note, registered: false };
      });
      return { code, item: e.item, unitCost: e.unitCost, rows, siblings };
    });

    writeTabRegisterXlsx(groups, `タブ価格登録用_${new Date().toISOString().slice(0, 10)}.xlsx`)
      .catch(err => alert(`Excel出力に失敗しました: ${err.message}`));
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

        {section === 'missing' && (
          <>
            <button onClick={handleExportRegisterCsv} disabled={tabLoading || !tabData}
              title="未設定品番を4社ぶん（原価÷掛率）tab_data形式のExcelで出力"
              className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-600 text-white text-xs font-black hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-40">
              <FileSpreadsheet size={14} />
              登録用Excel
            </button>

            {/* ⋯ メニュー */}
            <div className="relative">
              <button onClick={() => setShowMenu(v => !v)}
                className="flex items-center justify-center w-10 h-10 rounded-2xl bg-white border border-slate-200 text-slate-500 hover:text-emerald-600 hover:border-emerald-300 transition-colors shadow-sm">
                <MoreHorizontal size={16} />
              </button>
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setShowMenu(false)} />
                  <div className="absolute right-0 mt-2 w-44 bg-white border border-slate-200 rounded-2xl shadow-lg z-40 overflow-hidden">
                    <button onClick={() => { setShowMenu(false); setShowRateModal(true); }}
                      className="w-full flex items-center gap-2 px-4 py-3 text-xs font-black text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors">
                      <SlidersHorizontal size={14} /> 掛率設定
                    </button>
                    <button onClick={() => { setShowMenu(false); setShowUpdateGuide(true); }}
                      className="w-full flex items-center gap-2 px-4 py-3 text-xs font-black text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors border-t border-slate-100">
                      <BookOpen size={14} /> タブ価格の更新手順
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* タブ価格の更新手順モーダル */}
      {showUpdateGuide && (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4" onClick={() => setShowUpdateGuide(false)}>
          <div className="bg-white rounded-3xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BookOpen size={18} className="text-emerald-500" />
                <h3 className="text-lg font-black text-slate-800">タブ価格の更新手順</h3>
              </div>
              <button onClick={() => setShowUpdateGuide(false)} className="text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3 text-sm text-slate-700">
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">フォルダ（bat が1個だけ入ってる）</p>
                <div className="flex items-center gap-2">
                  <p className="flex-1 font-mono text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 break-all select-all">{TAB_UPDATE_FOLDER}</p>
                  <button onClick={() => { navigator.clipboard?.writeText(TAB_UPDATE_FOLDER); setGuideCopied(true); setTimeout(() => setGuideCopied(false), 1500); }}
                    className="shrink-0 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-black hover:bg-emerald-700 transition-colors">
                    {guideCopied ? 'コピー済' : 'コピー'}
                  </button>
                </div>
              </div>
              <ol className="list-decimal pl-5 space-y-1.5 font-bold">
                <li>リース会社タブ価格のExcel（tab_data シート）を最新にして保存</li>
                <li>上の「コピー」→ エクスプローラーのアドレス欄に貼り付けて Enter（フォルダが開く）</li>
                <li>そのExcelを、フォルダ内の <span className="text-emerald-700">タブExcelドロップ更新.bat</span> のアイコンにドラッグ＆ドロップ（bat をダブルクリックはNG）</li>
                <li>黒い画面で 変換 → commit → push まで自動。「Done.」が出たら何かキーで閉じる</li>
                <li>1〜2分でサイトに自動反映（Vercel）。開き直して「適用日」が新しい日付になっていればOK</li>
              </ol>
              <ul className="text-[11px] text-slate-400 font-bold space-y-0.5">
                <li>・列は見出し名（メンテ / 品番 / メーカーコード / TAB価格 / 適用日）で読むので、列の追加・並び替えはOK</li>
                <li>・中身が前と同じなら「NO CHANGES」で何もせず終了</li>
                <li>・このWEBの「登録用Excel」は未設定品番の登録依頼用。確定後のExcelを上の手順で反映する</li>
              </ul>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setShowUpdateGuide(false)}
                className="px-4 py-2 rounded-xl bg-slate-700 text-white text-xs font-black hover:bg-slate-800 transition-colors">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 掛率設定モーダル */}
      {showRateModal && (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4" onClick={() => setShowRateModal(false)}>
          <div className="bg-white rounded-3xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={18} className="text-emerald-500" />
                <h3 className="text-lg font-black text-slate-800">タブ価格 掛率設定</h3>
              </div>
              <button onClick={() => setShowRateModal(false)} className="text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-2 py-2 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">リース会社</th>
                    {TAB_RATE_CATEGORIES.map(cat => (
                      <th key={cat} className="px-2 py-2 text-center text-[10px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">{cat}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TAB_LEASE_ORDER.map(lease => (
                    <tr key={lease} className="border-b border-slate-50">
                      <td className="px-2 py-2 font-black text-slate-800">{lease}</td>
                      {TAB_RATE_CATEGORIES.map(cat => (
                        <td key={cat} className="px-2 py-2 text-center">
                          <input type="number" step="0.01" min="0.01" max="1"
                            value={tabRates[lease][cat]}
                            onChange={e => updateTabRate(lease, cat, e.target.value)}
                            className="w-20 bg-slate-50 border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-mono font-bold text-slate-700 text-right focus:border-emerald-400 outline-none" />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-slate-400 font-bold">
              TAB価格 = 原価 ÷ 掛率 を100円単位で切り上げ。変更は即保存（このブラウザのみ）。
            </p>
            <div className="mt-4 flex justify-between">
              <button onClick={resetTabRates}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black text-rose-500 border border-rose-200 hover:bg-rose-50 transition-colors">
                <RotateCcw size={12} /> 既定に戻す
              </button>
              <button onClick={() => setShowRateModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-700 text-white text-xs font-black hover:bg-slate-800 transition-colors">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

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

// ===== NCS訪問管理（ターゲット抽出 → 訪問記録 → 訪問後の受注チェック） =====
const NCS_RESULTS = ['好感触', '様子見', '脈なし'];
/** ターゲット（訪問リストを作る元の工場）は lists シートに予約IDの1行で持つ（GAS の変更なしで共有できる） */
const NCS_TARGET_LIST_ID = 'ncs_targets';
/** リスト群の工場をまとめる（同じ工場は最初の1回だけ） */
const ncsUnionFactories = (lists) => {
  const seen = new Set();
  const out = [];
  for (const l of lists) for (const x of l.factories || []) {
    if (!seen.has(x.key)) { seen.add(x.key); out.push(x); }
  }
  return out;
};
const NCS_RESULT_STYLE = {
  '好感触': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  '様子見': 'bg-amber-100 text-amber-700 border-amber-200',
  '脈なし': 'bg-slate-200 text-slate-600 border-slate-300',
};
/** 最終訪問からこの日数を過ぎて NCS 未受注なら再訪問候補（既定値。画面で変えるとこのブラウザに保存） */
const NCS_REVISIT_DAYS = 90;
const NCS_REVISIT_LS_KEY = 'ncs_revisit_days_v1';
/** ターゲット抽出の基準「判定年度の他社 ◯台以上」（このブラウザに保存） */
const NCS_MIN_OTHER_LS_KEY = 'ncs_min_other_v1';
const ncsLsGet = (key) => {
  try { return localStorage.getItem(key) ?? ''; } catch (e) { console.warn(`${key} を読めなかったよ`, e); return ''; }
};
const ncsLsSet = (key, v) => {
  try { localStorage.setItem(key, v); } catch (e) { console.warn(`${key} を保存できなかったよ`, e); }
};
const ncsLoadRevisitDays = () => {
  try {
    const n = Number(localStorage.getItem(NCS_REVISIT_LS_KEY));
    return Number.isInteger(n) && n >= 1 ? n : NCS_REVISIT_DAYS;
  } catch (e) {
    console.warn('再訪問候補の日数を読めなかったので既定値にするよ', e);
    return NCS_REVISIT_DAYS;
  }
};
/** ターゲット一覧の表示上限（多いときは地域で絞る誘導） */
const NCS_TARGET_CAP = 300;

const ncsItemOk = r => !!r.item && ALLOWED_ITEM_NORM_SET.has(norm(r.item));
const ncsTodayIso = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ncsCsvQ = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const ncsDownload = (blob, fileName) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

const NcsResultBadge = ({ result }) => (
  result
    ? <span className={`inline-block px-2 py-0.5 rounded-lg border text-[10px] font-black ${NCS_RESULT_STYLE[result] || 'bg-slate-100 text-slate-500 border-slate-200'}`}>{result}</span>
    : null
);

const NcsVisitView = ({ rows, leaseCompanies }) => {
  const [tab, setTab] = useState('target'); // 'target' | 'work'

  // ---- 実績（全行1回だけ走査して工場ごとにまとめる） ----
  const index = useMemo(() => buildFactoryIndex(rows, ncsItemOk), [rows]);
  const defaultFY = useMemo(() => latestCompleteFiscalYear(index.lastDate, index.fiscalYears), [index]);
  const [judgeFY, setJudgeFY] = useState(defaultFY);
  useEffect(() => { if (!index.fiscalYears.includes(judgeFY)) setJudgeFY(defaultFY); }, [index, defaultFY, judgeFY]);
  const todayNum = dateNum(ncsTodayIso());
  const [revisitDays, setRevisitDaysState] = useState(ncsLoadRevisitDays);
  const setRevisitDays = useCallback((n) => {
    setRevisitDaysState(n);
    try { localStorage.setItem(NCS_REVISIT_LS_KEY, String(n)); } catch (e) { console.warn('再訪問候補の日数を保存できなかったよ', e); }
  }, []);

  // ---- 保存データ（訪問リスト・訪問記録） ----
  const [mode, setMode] = useState(storeMode); // 'shared' | 'needKey' | 'local'
  const [lists, setLists] = useState([]);
  const [visits, setVisits] = useState([]);
  const [storeError, setStoreError] = useState(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [leftovers, setLeftovers] = useState(null); // 共有前にこのブラウザだけに保存した分
  const [keyInput, setKeyInput] = useState('');
  const reload = useCallback(async () => {
    if (storeMode() === 'needKey') return;
    setStoreLoading(true);
    try {
      const { lists: l, visits: v } = await loadAll();
      setLists(l);
      setVisits(v);
      setStoreError(null);
    } catch (e) {
      console.error(e);
      if (e?.code === 'unauthorized') {
        setShareKey('');
        setMode('needKey');
      }
      setStoreError(e?.message || String(e));
    } finally {
      setStoreLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload, mode]);
  useEffect(() => {
    if (mode !== 'shared') { setLeftovers(null); return; }
    localLeftovers().then(d => setLeftovers(d.lists.length || d.visits.length ? d : null));
  }, [mode]);

  const handleSetKey = () => {
    if (!keyInput.trim()) return;
    setShareKey(keyInput);
    setKeyInput('');
    setStoreError(null);
    setMode(storeMode());
  };
  const handleMigrate = async () => {
    if (!window.confirm(`このブラウザだけに保存していた 訪問リスト ${leftovers.lists.length}件・訪問記録 ${leftovers.visits.length}件 を共有に移す？`)) return;
    try {
      await migrateLocalToShared();
      setLeftovers(null);
      await reload();
    } catch (e) {
      alert(`移せなかったよ: ${e?.message || e}`);
    }
  };

  /** 訪問リスト（ターゲット行を除く） */
  const visitLists = useMemo(() => lists.filter(l => l.id !== NCS_TARGET_LIST_ID), [lists]);
  /** ターゲット。まだ保存がなければ、これまでの訪問リストの工場をターゲット扱いにする */
  const pool = useMemo(() => {
    const saved = lists.find(l => l.id === NCS_TARGET_LIST_ID);
    return saved ? saved.factories : ncsUnionFactories(visitLists);
  }, [lists, visitLists]);
  const poolKeys = useMemo(() => new Set(pool.map(x => x.key)), [pool]);
  /** ターゲットを書き換える。ほかの人の追加を消さないよう、保存の直前に最新を読み直してから足し引きする */
  const updatePool = useCallback(async (fn) => {
    const fresh = await loadAll();
    const saved = fresh.lists.find(l => l.id === NCS_TARGET_LIST_ID);
    const cur = saved ? saved.factories : ncsUnionFactories(fresh.lists.filter(l => l.id !== NCS_TARGET_LIST_ID));
    await saveList({ id: NCS_TARGET_LIST_ID, name: 'ターゲット', createdAt: saved?.createdAt || new Date().toISOString(), factories: fn(cur) });
    await reload();
  }, [reload]);
  const addTargets = useCallback((entries) => updatePool(cur => {
    const have = new Set(cur.map(x => x.key));
    return [...cur, ...entries.filter(x => !have.has(x.key))];
  }), [updatePool]);
  const removeTargets = useCallback((keys) => {
    const drop = new Set(keys);
    return updatePool(cur => cur.filter(x => !drop.has(x.key)));
  }, [updatePool]);

  /** 保存・削除した記録を手元にも反映（共有だと全件読み直しが遅いので） */
  const onVisitSaved = useCallback((v) => {
    setVisits(prev => [...prev.filter(x => x.id !== v.id), v]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt))));
  }, []);
  const onVisitDeleted = useCallback((id) => setVisits(prev => prev.filter(x => x.id !== id)), []);
  const saveVisitAndShow = useCallback(async (v) => { await saveVisit(v); onVisitSaved(v); }, [onVisitSaved]);
  const deleteVisitAndHide = useCallback(async (v) => { await deleteVisit(v.id); onVisitDeleted(v.id); }, [onVisitDeleted]);

  /** 工場 → 訪問記録（日付の古い順） */
  const visitsByFactory = useMemo(() => {
    const m = new Map();
    for (const v of visits) {
      if (!m.has(v.factoryKey)) m.set(v.factoryKey, []);
      m.get(v.factoryKey).push(v);
    }
    return m;
  }, [visits]);

  /** 訪問した工場ごとの「初回訪問の翌日以降」の受注 */
  const postStats = useMemo(() => {
    const targets = [];
    visitsByFactory.forEach((vs, key) => {
      targets.push({ key, tel: vs[vs.length - 1].tel || vs[0].tel, since: dateNum(vs[0].date) });
    });
    return buildPostVisitStats(rows, ncsItemOk, targets);
  }, [rows, visitsByFactory]);

  /** 工場ごとの状況（訪問・成果タブ／ターゲット抽出の訪問列） */
  const statusOf = useCallback((key) => {
    const vs = visitsByFactory.get(key);
    if (!vs?.length) return null;
    const first = vs[0];
    const last = vs[vs.length - 1];
    const since = dateNum(first.date);
    const lastNum = dateNum(last.date);
    const stats = postStats.get(key);
    const ncsWon = (stats?.ncsQty || 0) > 0;
    const waiting = index.lastDate <= since; // 訪問日より後の実績がまだCSVに無い
    const elapsed = lastNum ? daysBetween(lastNum, todayNum) : 0;
    const nextNum = dateNum(last.nextDate);
    const revisit = !ncsWon && ((nextNum && nextNum <= todayNum) || elapsed >= revisitDays);
    return { vs, first, last, stats, ncsWon, waiting, elapsed, nextNum, revisit };
  }, [visitsByFactory, postStats, index.lastDate, todayNum, revisitDays]);

  /** 方針書用：期間内の訪問と、その後の受注を Excel に */
  const exportReport = useCallback(async (from, to) => {
    const poolMap = new Map(pool.map(x => [x.key, x]));
    const infoOf = key => {
      const f = index.factories.get(key);
      const p = poolMap.get(key);
      const address = p?.address || f?.address || '';
      return { area: areaOf(address), address, tel: p?.tel || f?.tel || '' };
    };
    const report = buildVisitReport({
      rows, itemOk: ncsItemOk, visits, from, to, lastDate: index.lastDate,
      targetCount: pool.length, todayNum, revisitDays, infoOf,
    });
    await writeNcsReportXlsx(report, `NCS訪問実績_${from.replace(/-/g, '')}-${to.replace(/-/g, '')}.xlsx`);
  }, [rows, visits, index, pool, todayNum, revisitDays]);

  // ---- バックアップ ----
  const fileRef = useRef(null);
  const [showMenu, setShowMenu] = useState(false);
  const handleExportJson = async () => {
    try {
      const data = await exportAll();
      const d = ncsTodayIso().replace(/-/g, '');
      ncsDownload(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `NCS訪問データ_${d}.json`);
    } catch (e) {
      alert(`書き出しに失敗したよ: ${e?.message || e}`);
    }
  };
  const handleImportJson = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await importAll(JSON.parse(await file.text()));
      await reload();
      alert(`読み込んだよ（訪問リスト ${res.lists}件・訪問記録 ${res.visits}件）`);
    } catch (err) {
      alert(`読み込みに失敗したよ: ${err?.message || err}`);
    }
  };

  const tabBtn = (key, label, Icon, count) => (
    <button key={key} onClick={() => setTab(key)}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-black transition-all ${
        tab === key ? 'bg-white text-slate-800 shadow' : 'text-slate-500 hover:text-slate-700'}`}>
      <Icon size={16} /> {label}
      {count != null && <span className="text-[10px] font-black text-slate-400">{count}</span>}
    </button>
  );

  return (
    <div className="space-y-6 animate-fade-in-up">
      {mode === 'needKey' && (
        <div className="bg-white rounded-3xl shadow-sm border border-emerald-200 p-6 space-y-3">
          <div className="font-black text-slate-800">共有キーを入れてね</div>
          <div className="text-xs font-bold text-slate-500">訪問データはみんなで共有してるよ。たかたかから聞いた共有キーを1回入れれば、このブラウザで使えるようになる。</div>
          <div className="flex flex-wrap gap-2">
            <input value={keyInput} onChange={e => setKeyInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleSetKey(); }}
              placeholder="共有キー" type="password"
              className="px-4 py-2.5 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-300" />
            <button onClick={handleSetKey} className="px-5 py-2.5 rounded-2xl text-xs font-black bg-green-900 text-white hover:bg-emerald-600">使いはじめる</button>
          </div>
        </div>
      )}

      {leftovers && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex flex-wrap items-center gap-3 text-amber-800 no-print">
          <AlertCircle size={18} />
          <span className="font-bold text-sm">
            このブラウザだけに保存した訪問データ（リスト {leftovers.lists.length}件・記録 {leftovers.visits.length}件）があるよ。
          </span>
          <button onClick={handleMigrate} className="ml-auto px-4 py-2 rounded-xl text-xs font-black bg-amber-600 text-white hover:bg-amber-700">共有に移す</button>
        </div>
      )}

      {storeError && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center gap-3 text-rose-700">
          <AlertCircle size={18} />
          <span className="font-bold text-sm">訪問データの読み書きに失敗しました: {storeError}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 no-print">
        <div className="flex items-center gap-2 mr-2">
          <MapPin size={22} className="text-emerald-600" />
          <h2 className="text-2xl font-black text-slate-800 tracking-tight">NCS訪問管理</h2>
        </div>
        <div className="inline-flex flex-wrap gap-1 bg-slate-100 p-1.5 rounded-3xl">
          {tabBtn('target', 'ターゲット抽出', Target)}
          {tabBtn('work', '訪問・成果', ClipboardList, visitsByFactory.size)}
        </div>
        {storeLoading && <Loader2 size={16} className="animate-spin text-slate-400" />}

        {/* 実績CSVの最終日（成果チェックはここまでの受注で判定） */}
        {index.lastDate > 0 && (
          <span className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-slate-200 text-xs font-black text-slate-600 shadow-sm">
            <Calendar size={13} className="text-emerald-600" />
            最新データ {fmtDateNum(index.lastDate)} 現在
          </span>
        )}

        {/* ⋯ メニュー */}
        <div className={`relative ${index.lastDate > 0 ? '' : 'ml-auto'}`}>
          <button onClick={() => setShowMenu(v => !v)}
            className="flex items-center justify-center w-10 h-10 rounded-2xl bg-white border border-slate-200 text-slate-500 hover:text-emerald-600 hover:border-emerald-300 transition-colors shadow-sm">
            <MoreHorizontal size={16} />
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 rounded-2xl shadow-lg z-40 overflow-hidden">
                <div className="px-4 py-3 text-[11px] font-bold text-slate-500 space-y-1.5 leading-relaxed">
                  <div className="font-black text-slate-700">
                    保存先：{mode === 'local' ? 'このブラウザだけ' : 'スプレッドシート（特販部_営業訪問ログ）で共有'}
                  </div>
                  <div>ほかのリース会社では受注があるのに NCS だけ無い工場を拾って、訪問と訪問後の受注を追うページ。</div>
                  <div>受注数＝オルタネーター・スターター・コンプレッサー / 年度は10月〜9月 / データ最終日 {fmtDateNum(index.lastDate)}</div>
                  <div>訪問後の受注は初回訪問の翌日〜データ最終日。再訪問候補＝NCS未受注のまま最終訪問から{revisitDays}日たった工場（日数は訪問・成果タブで変えられる）。</div>
                </div>
                {mode === 'shared' && (
                  <button onClick={() => { setShowMenu(false); reload(); }} className="w-full flex items-center gap-2 px-4 py-3 text-xs font-black text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors border-t border-slate-100">
                    <RefreshCcw size={14} /> 再読込（ほかの人の記録も取り込む）
                  </button>
                )}
                <button onClick={() => { setShowMenu(false); handleExportJson(); }} className="w-full flex items-center gap-2 px-4 py-3 text-xs font-black text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors border-t border-slate-100">
                  <Download size={14} /> バックアップ（JSON）
                </button>
                <button onClick={() => { setShowMenu(false); fileRef.current?.click(); }} className="w-full flex items-center gap-2 px-4 py-3 text-xs font-black text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors border-t border-slate-100">
                  <Upload size={14} /> バックアップを読み込む
                </button>
                {mode === 'shared' && (
                  <button onClick={() => { setShowMenu(false); if (window.confirm('共有キーを入れ直す？')) { setShareKey(''); setMode('needKey'); } }} className="w-full flex items-center gap-2 px-4 py-3 text-xs font-black text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors border-t border-slate-100">
                    <RotateCcw size={14} /> 共有キーを変える
                  </button>
                )}
              </div>
            </>
          )}
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportJson} />
        </div>
      </div>

      {tab === 'target' && (
        <NcsTargetTab
          index={index} leaseCompanies={leaseCompanies}
          judgeFY={judgeFY} setJudgeFY={setJudgeFY}
          poolKeys={poolKeys} visitLists={visitLists} statusOf={statusOf}
          onAddTargets={addTargets}
        />
      )}
      {tab === 'work' && (
        <NcsWorkTab
          index={index} judgeFY={judgeFY} pool={pool} visitsByFactory={visitsByFactory} statusOf={statusOf}
          revisitDays={revisitDays} onChangeRevisitDays={setRevisitDays}
          onSaveVisit={saveVisitAndShow} onDeleteVisit={deleteVisitAndHide} onRemoveTargets={removeTargets} onExportReport={exportReport}
        />
      )}
    </div>
  );
};

const NCS_TH = 'px-3 py-3 text-[11px] font-black whitespace-nowrap';
const ncsYmd = () => ncsTodayIso().replace(/-/g, '');

/** タブ1: ターゲット抽出 */
const NcsTargetTab = ({ index, leaseCompanies, judgeFY, setJudgeFY, poolKeys, visitLists, statusOf, onAddTargets }) => {
  const [compareLeases, setCompareLeases] = useState(new Set()); // 空＝NCS以外すべて
  const [phone, setPhone] = useState('');
  const [pref, setPref] = useState('');
  const [keyword, setKeyword] = useState('');
  const [onlyTargets, setOnlyTargets] = useState(true);
  const [minOther, setMinOtherState] = useState(() => ncsLsGet(NCS_MIN_OTHER_LS_KEY)); // 判定年度の他社 ◯台以上（空＝絞らない）
  const setMinOther = v => { setMinOtherState(v); ncsLsSet(NCS_MIN_OTHER_LS_KEY, v); };
  const [checked, setChecked] = useState(new Set());
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');

  const targets = useMemo(
    () => buildNcsTargets(index.factories, { judgeFY, compareLeases, phone, pref, keyword, onlyTargets, minOther: Number(minOther) || 0 }),
    [index, judgeFY, compareLeases, phone, pref, keyword, onlyTargets, minOther]
  );
  const shown = useMemo(() => targets.slice(0, NCS_TARGET_CAP), [targets]);
  /** 絞り込み後の全工場（表示上限より先も含む）の判定年度 他社台数 */
  const otherTotal = useMemo(() => targets.reduce((t, x) => t + x.judge.other, 0), [targets]);
  const shownYears = useMemo(() => index.fiscalYears.filter(fy => fy <= judgeFY).slice(-4), [index, judgeFY]);
  const compareSet = compareLeases.size ? compareLeases : null;
  const otherLeases = useMemo(() => leaseCompanies.filter(l => l !== NCS && l !== '(未分類)'), [leaseCompanies]);
  /** 訪問リストに入っている工場 → リスト名（ターゲット列のマウスオーバー用） */
  const listedIn = useMemo(() => {
    const m = new Map();
    for (const l of visitLists) for (const x of l.factories) {
      if (!m.has(x.key)) m.set(x.key, []);
      m.get(x.key).push(l.name);
    }
    return m;
  }, [visitLists]);

  const toggleLease = l => setCompareLeases(prev => {
    const n = new Set(prev);
    n.has(l) ? n.delete(l) : n.add(l);
    return n;
  });
  const toggleCheck = key => setChecked(prev => {
    const n = new Set(prev);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });

  const picked = () => [...checked].map(k => index.factories.get(k)).filter(Boolean);
  const toEntry = f => ({ key: f.key, tel: f.tel, address: f.address, pref: f.pref, contact: topOrderers(f, judgeFY).join('、') });

  const handleAddTargets = async () => {
    const fs = picked().filter(f => !poolKeys.has(f.key));
    if (!fs.length) { alert('チェックした工場はもう全部ターゲットに入ってるよ'); return; }
    setAdding(true);
    try {
      await onAddTargets(fs.map(toEntry));
      setChecked(new Set());
      setNotice(`${fs.length}件をターゲットに追加したよ`);
      setTimeout(() => setNotice(''), 4000);
    } catch (e) {
      alert(`追加に失敗したよ: ${e?.message || e}`);
    } finally {
      setAdding(false);
    }
  };
  const handleRouteExport = async () => {
    const fs = picked();
    if (!fs.length) { alert('ルートに入れる工場にチェックしてね'); return; }
    try {
      await writeRoutePlanXlsx(fs.map(f => ({ name: f.key, address: f.address, tel: f.tel, contact: topOrderers(f, judgeFY).join('、') })));
    } catch (e) {
      console.error(e);
      alert(e?.message || 'ルート計画書の作成に失敗したよ');
    }
  };

  const inputCls = 'w-full px-4 py-2.5 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-300';
  const labelCls = 'text-[10px] font-black text-slate-400 tracking-widest ml-1';

  return (
    <div className="space-y-6">
      {/* 条件 */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 space-y-5 no-print">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <label className="space-y-1"><div className={labelCls}>電話番号（市外局番）</div>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="022" className={inputCls} /></label>
          <label className="space-y-1"><div className={labelCls}>都道府県</div>
            <input value={pref} onChange={e => setPref(e.target.value)} placeholder="宮城県" className={inputCls} /></label>
          <label className="space-y-1"><div className={labelCls}>住所・工場名キーワード</div>
            <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="仙台市" className={inputCls} /></label>
          <label className="space-y-1"><div className={labelCls}>判定年度（この年度に NCS ゼロ）</div>
            <select value={judgeFY} onChange={e => setJudgeFY(Number(e.target.value))} className={inputCls}>
              {index.fiscalYears.map(fy => (
                <option key={fy} value={fy}>{fy}年度（{fy}/10〜{fy + 1}/9）</option>
              ))}
            </select></label>
        </div>
        <div className="space-y-2">
          <div className={labelCls}>比較するリース会社（この会社の受注があれば対象。未選択＝NCS以外すべて）</div>
          <div className="flex flex-wrap gap-2">
            {otherLeases.map(l => {
              const on = compareLeases.has(l);
              return (
                <button key={l} onClick={() => toggleLease(l)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black border transition-all ${
                    on ? 'bg-emerald-500 text-white border-emerald-500 shadow' : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-emerald-300'}`}>
                  {on ? <CheckSquare size={12} /> : <Square size={12} />}{l}
                </button>
              );
            })}
            {compareLeases.size > 0 && (
              <button onClick={() => setCompareLeases(new Set())}
                className="px-3 py-1.5 rounded-xl text-xs font-black text-rose-500 border border-rose-200 hover:bg-rose-50">クリア</button>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs font-black text-slate-600">
          {judgeFY}年度の他社
          <input type="number" min="0" inputMode="numeric" value={minOther} onChange={e => setMinOther(e.target.value)}
            placeholder="0" className="w-24 px-3 py-1.5 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 text-right focus:outline-none focus:ring-2 focus:ring-emerald-300" />
          台以上 <span className="text-slate-400 font-bold">— 基準としてこのブラウザに保存。空＝絞らない</span>
        </label>
        <label className="inline-flex items-center gap-2 text-xs font-black text-slate-600 cursor-pointer">
          <input type="checkbox" checked={onlyTargets} onChange={e => setOnlyTargets(e.target.checked)} className="accent-emerald-600" />
          対象（NCSゼロ）だけ表示 <span className="text-slate-400 font-bold">— 外すと NCS ありの工場も灰色で出る</span>
        </label>
      </div>

      {/* 操作 */}
      <div className="flex flex-wrap items-center gap-2 no-print">
        <div className="text-sm font-black text-slate-700 mr-2">
          {onlyTargets ? '対象' : '該当'} {targets.length.toLocaleString()} 工場
          <span className="ml-3 text-emerald-700">他社 {judgeFY}年度 合計 {otherTotal.toLocaleString()} 台</span>
          {targets.length > NCS_TARGET_CAP && <span className="text-xs text-amber-600 ml-2">（先頭{NCS_TARGET_CAP}件を表示。地域で絞ってね）</span>}
        </div>
        <button onClick={() => setChecked(prev => new Set([...prev, ...shown.filter(x => x.isTarget).map(x => x.f.key)]))}
          className="px-3 py-1.5 rounded-xl text-xs font-black text-emerald-700 border border-emerald-200 hover:bg-emerald-50">表示中の対象を全部チェック</button>
        <button onClick={() => setChecked(new Set())} disabled={!checked.size}
          className="px-3 py-1.5 rounded-xl text-xs font-black text-slate-500 border border-slate-200 hover:bg-slate-50 disabled:opacity-40">チェックを外す</button>
        <div className="ml-auto flex flex-wrap gap-2">
          {notice && <span className="self-center text-xs font-black text-amber-700">{notice}</span>}
          <span className="self-center text-xs font-black text-slate-500">チェック {checked.size}件</span>
          <button onClick={handleRouteExport} disabled={!checked.size}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl text-xs font-black border border-green-900 text-green-900 hover:bg-green-50 disabled:opacity-40">
            <FileSpreadsheet size={14} /> ルート計画書Excel
          </button>
          <button onClick={handleAddTargets} disabled={!checked.size || adding}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl text-xs font-black bg-green-900 text-white hover:bg-emerald-600 disabled:opacity-40 shadow-lg">
            <Plus size={14} /> {adding ? '追加中…' : 'ターゲットに追加'}
          </button>
        </div>
      </div>

      {/* 一覧 */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-x-auto">
        <table className="w-full min-w-[900px] table-fixed text-sm">
          <colgroup>
            <col style={{ width: 56 }} />
            <col style={{ width: 72 }} />
            <col style={{ width: 280 }} />
            {shownYears.map(fy => <React.Fragment key={fy}><col /><col /></React.Fragment>)}
            <col style={{ width: 130 }} />
          </colgroup>
          <thead className="bg-green-900 text-white sticky top-0 z-10">
            <tr>
              <th className={NCS_TH} rowSpan={2}>選択</th>
              <th className={NCS_TH} rowSpan={2}>ターゲット</th>
              <th className={`${NCS_TH} text-left`} rowSpan={2}>工場</th>
              {shownYears.map(fy => (
                <th key={fy} className={`${NCS_TH} border-l border-green-800 ${fy === judgeFY ? 'bg-green-800' : ''}`} colSpan={2}>
                  {fy}年度<div className="text-[9px] font-bold text-green-300">{fy}/10〜{fy + 1}/9</div>
                </th>
              ))}
              <th className={`${NCS_TH} border-l border-green-800`} rowSpan={2}>訪問</th>
            </tr>
            <tr>
              {shownYears.map(fy => (
                <React.Fragment key={fy}>
                  <th className={`${NCS_TH} border-l border-green-800 ${fy === judgeFY ? 'bg-green-800' : ''}`}>NCS</th>
                  <th className={`${NCS_TH} ${fy === judgeFY ? 'bg-green-800' : ''}`}>他社</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ f, judge, isTarget }) => {
              const st = statusOf(f.key);
              const inPool = poolKeys.has(f.key);
              const inLists = listedIn.get(f.key);
              const rowCls = inPool ? 'bg-amber-50 hover:bg-amber-100/60' : isTarget ? 'hover:bg-emerald-50/40' : 'bg-slate-50 text-slate-400';
              return (
                <tr key={f.key} className={`border-b border-slate-100 align-top ${rowCls}`}>
                  <td className="px-3 py-3 text-center">
                    <button onClick={() => toggleCheck(f.key)} className="text-emerald-600">
                      {checked.has(f.key) ? <CheckSquare size={18} /> : <Square size={18} className="text-slate-300" />}
                    </button>
                  </td>
                  <td className="px-3 py-3 text-center" title={inPool ? `ターゲット${inLists ? `／訪問リスト: ${inLists.join('、')}` : ''}` : ''}>
                    {inPool && <Check size={18} strokeWidth={3} className="inline text-amber-600" />}
                  </td>
                  <td className="px-3 py-3 break-words">
                    <div className="font-black text-slate-800">{f.key}
                      {!isTarget && <span className="ml-2 text-[10px] font-black px-2 py-0.5 rounded-lg bg-slate-200 text-slate-500">NCSあり</span>}
                    </div>
                    <div className="text-xs text-slate-500">{f.address}</div>
                    <div className="text-xs text-slate-500">TEL: {f.tel}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {judge.leases.map(([l, q]) => (
                        <span key={l} className={`text-[10px] font-black px-1.5 py-0.5 rounded ${l === NCS ? 'bg-rose-100 text-rose-600' : 'bg-slate-100 text-slate-600'}`}>{l} {q}</span>
                      ))}
                    </div>
                  </td>
                  {shownYears.map(fy => {
                    const s = splitFy(f, fy, compareSet);
                    const hi = fy === judgeFY ? 'bg-emerald-50/50' : '';
                    return (
                      <React.Fragment key={fy}>
                        <td className={`px-3 py-3 text-right font-black border-l border-slate-100 ${hi} ${s.ncs > 0 ? 'text-rose-600' : 'text-slate-300'}`}>{s.ncs || ''}</td>
                        <td className={`px-3 py-3 text-right font-black ${hi} text-slate-700`}>{s.other || ''}</td>
                      </React.Fragment>
                    );
                  })}
                  <td className="px-3 py-3 border-l border-slate-100 whitespace-nowrap text-xs">
                    {st ? (
                      <div className="space-y-1">
                        <div className="font-bold text-slate-600">{st.last.date.replace(/-/g, '/')}（{st.vs.length}回）</div>
                        <NcsResultBadge result={st.last.result} />
                      </div>
                    ) : <span className="text-slate-300 font-bold">未訪問</span>}
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={4 + shownYears.length * 2} className="px-3 py-10 text-center text-slate-400 font-bold">条件に合う工場がないよ</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** 前年比（工場別 年次実績比較と同じ表示。前年0は出さない） */
const NcsYoY = ({ curr, prev }) => {
  const y = calcYoY(curr, prev);
  if (y == null) return null;
  const n = Number(y);
  return <span className={`ml-1 text-[10px] font-bold ${n >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{n >= 0 ? '↗' : '↘'}{n}%</span>;
};

/** 工場1件の年度別 受注数＋メンテ別内訳（訪問記録の小窓に出す） */
const NcsFactoryYears = ({ f, years }) => {
  if (!f) return <div className="text-xs text-slate-400 font-bold">この工場の実績データが見つからないよ</div>;
  const qty = (fy, l) => f.byFy.get(fy)?.get(l) || 0;
  const total = fy => { let t = 0; f.byFy.get(fy)?.forEach(q => { t += q; }); return t; };
  const sum = new Map();
  years.forEach(fy => f.byFy.get(fy)?.forEach((q, l) => sum.set(l, (sum.get(l) || 0) + q)));
  const leases = [...sum].filter(([, q]) => q).sort((a, b) => b[1] - a[1]).map(([l]) => l);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border border-slate-100 rounded-xl">
        <thead className="bg-green-900 text-white">
          <tr>
            <th className="px-3 py-1.5 text-left font-black w-28"></th>
            {years.map(fy => (
              <th key={fy} className="px-3 py-1.5 font-black text-right whitespace-nowrap">
                {fy}年度<span className="ml-1 text-[9px] font-bold text-green-300">{fy}/10〜{fy + 1}/9</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="bg-emerald-50/60 border-b border-slate-100">
            <td className="px-3 py-1.5 font-black text-emerald-700">受注数</td>
            {years.map(fy => (
              <td key={fy} className="px-3 py-1.5 text-right font-black text-slate-800 whitespace-nowrap">
                {total(fy) || ''}<NcsYoY curr={total(fy)} prev={total(fy - 1)} />
              </td>
            ))}
          </tr>
          {leases.map(l => (
            <tr key={l} className={`border-b border-slate-50 ${l === NCS ? 'bg-rose-50/60' : ''}`}>
              <td className={`px-3 py-1 font-black ${l === NCS ? 'text-rose-600' : 'text-slate-600'}`}>{l}</td>
              {years.map(fy => (
                <td key={fy} className="px-3 py-1 text-right font-bold text-slate-700 whitespace-nowrap">
                  {qty(fy, l) || ''}<NcsYoY curr={qty(fy, l)} prev={qty(fy - 1, l)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const NCS_JUDGE_ORDER = { revisit: 0, none: 1, open: 2, waiting: 3, won: 4 };
const NCS_JUDGE_LABEL = {
  revisit: { label: '再訪問候補', cls: 'bg-rose-100 text-rose-600' },
  none: { label: '未訪問', cls: 'bg-white text-slate-400 border border-slate-200' },
  open: { label: '未受注', cls: 'bg-amber-100 text-amber-700' },
  waiting: { label: 'データ待ち', cls: 'bg-slate-100 text-slate-500' },
  won: { label: 'NCS受注あり', cls: 'bg-emerald-100 text-emerald-700' },
};
const NCS_WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const ncsIsoOfNum = n => `${Math.floor(n / 10000)}-${String(Math.floor(n / 100) % 100).padStart(2, '0')}-${String(n % 100).padStart(2, '0')}`;
const ncsSlash = iso => String(iso || '').replace(/-/g, '/');

/** 月カレンダー。日付を押す＝訪問日えらび、日付の下のエリアを押す＝その工場を表の上に寄せる */
const NcsCalendar = ({ selected, onSelect, areasByDate, focus, onFocus }) => {
  const selNum = dateNum(selected);
  const todayNum = dateNum(ncsTodayIso());
  const [ym, setYm] = useState(() => ({ y: Math.floor(selNum / 10000), m: Math.floor(selNum / 100) % 100 }));
  const move = d => setYm(({ y, m }) => {
    const t = new Date(y, m - 1 + d, 1);
    return { y: t.getFullYear(), m: t.getMonth() + 1 };
  });
  const first = new Date(ym.y, ym.m - 1, 1).getDay();
  const days = new Date(ym.y, ym.m, 0).getDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => ym.y * 10000 + ym.m * 100 + i + 1)];
  while (cells.length % 7) cells.push(null);

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-emerald-200 p-4 no-print">
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => move(-1)} aria-label="前の月" className="p-1.5 rounded-xl text-slate-500 hover:bg-slate-100"><ChevronRight size={16} className="rotate-180" /></button>
        <div className="font-black text-slate-800 w-28 text-center">{ym.y}年{ym.m}月</div>
        <button onClick={() => move(1)} aria-label="次の月" className="p-1.5 rounded-xl text-slate-500 hover:bg-slate-100"><ChevronRight size={16} /></button>
        <div className="ml-3 text-[11px] font-bold text-slate-400">日付を押す＝訪問日にする ／ エリアを押す＝その日の工場を表の上に出す</div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {NCS_WEEK.map((w, i) => (
          <div key={w} className={`text-center text-[10px] font-black ${i === 0 ? 'text-rose-400' : i === 6 ? 'text-sky-500' : 'text-slate-400'}`}>{w}</div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`b${i}`} />;
          const areas = areasByDate.get(d) || [];
          const isSel = d === selNum;
          return (
            <div key={d} className={`min-h-[64px] rounded-xl border p-1 ${isSel ? 'border-emerald-500 bg-emerald-50' : 'border-slate-100'}`}>
              <button onClick={() => onSelect(ncsIsoOfNum(d))} aria-label={`${fmtDateNum(d)}を訪問日にする`}
                className={`w-6 h-6 rounded-lg text-xs font-black ${isSel ? 'bg-emerald-600 text-white' : d === todayNum ? 'ring-2 ring-emerald-300 text-slate-700' : 'text-slate-600 hover:bg-slate-100'}`}>
                {d % 100}
              </button>
              <div className="mt-0.5 space-y-0.5">
                {areas.map(a => {
                  const on = focus?.date === d && focus?.area === a.area;
                  return (
                    <button key={a.area} onClick={() => onFocus(on ? null : { date: d, area: a.area, keys: a.keys })}
                      title={[...a.keys].join('、')}
                      className={`block w-full truncate text-left px-1 py-0.5 rounded text-[10px] font-black ${on ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
                      {a.area} {a.keys.size}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** 工場1件の訪問記録を書く小窓（過去の記録の直し・削除、年次実績も） */
const NcsVisitModal = ({ row, visits, defaultDate, years, factory, onSave, onDelete, onClose }) => {
  const [editing, setEditing] = useState(null); // 直している記録（null＝新しい記録）
  const [date, setDate] = useState(defaultDate);
  const [result, setResult] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startEdit = v => { setEditing(v); setDate(v.date); setResult(v.result || ''); setMemo(v.memo || ''); };
  const startNew = () => { setEditing(null); setDate(defaultDate); setResult(''); setMemo(''); };
  const submit = async () => {
    if (!date) { alert('訪問日を入れてね'); return; }
    setSaving(true);
    try {
      await onSave({ date, result, memo: memo.trim() }, editing);
      onClose();
    } catch (e) {
      console.error(e);
      alert(`保存に失敗したよ: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };
  const cls = 'w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-300';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 overflow-y-auto no-print" onClick={onClose}>
      <div role="dialog" aria-label={`${row.key} の訪問記録`} onClick={e => e.stopPropagation()}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl mt-10 p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-lg font-black text-slate-800">{row.key}</div>
            <div className="text-xs font-bold text-slate-500">{row.address}</div>
            <div className="text-xs font-bold text-slate-400">TEL: {row.tel}{row.contact && ` ／ 注文者: ${row.contact}`}</div>
          </div>
          <button onClick={onClose} aria-label="閉じる" className="p-2 rounded-xl text-slate-400 hover:bg-slate-100"><X size={18} /></button>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
          <div className="text-[10px] font-black text-emerald-700 tracking-widest">{editing ? `${ncsSlash(editing.date)} の記録を直す` : '新しい訪問記録'}</div>
          <div className="grid grid-cols-1 md:grid-cols-[10rem_8rem_1fr] gap-2">
            <input type="date" aria-label="訪問日" value={date} onChange={e => setDate(e.target.value)} className={cls} />
            <select aria-label="感触" value={result} onChange={e => setResult(e.target.value)} className={cls}>
              <option value="">感触 —</option>
              {NCS_RESULTS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <input aria-label="メモ" value={memo} onChange={e => setMemo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); }}
              autoFocus placeholder="NCSの車は入ってるか、窓口の人、次に持っていく話 など" className={cls} />
          </div>
          <div className="flex justify-end gap-2">
            {editing && <button onClick={startNew} className="px-4 py-2 rounded-xl text-xs font-black text-slate-500 hover:bg-slate-100">直すのをやめる</button>}
            <button onClick={submit} disabled={saving}
              className="px-5 py-2 rounded-xl text-xs font-black bg-green-900 text-white hover:bg-emerald-600 disabled:opacity-50">
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>

        <div>
          <div className="text-[10px] font-black text-slate-400 tracking-widest mb-2">これまでの訪問（{visits.length}回）</div>
          {!visits.length && <div className="text-xs font-bold text-slate-300">まだ記録がないよ</div>}
          <div className="space-y-1">
            {[...visits].reverse().map(v => (
              <div key={v.id} className={`flex items-start gap-3 text-xs rounded-xl px-2 py-1.5 ${editing?.id === v.id ? 'bg-emerald-50' : ''}`}>
                <div className="w-20 font-black text-slate-700">{ncsSlash(v.date)}</div>
                <div className="w-16"><NcsResultBadge result={v.result} /></div>
                <div className="flex-1 text-slate-600 whitespace-pre-wrap">{v.memo}</div>
                <button onClick={() => startEdit(v)} title="直す" className="p-1 text-slate-400 hover:text-emerald-600"><Pencil size={14} /></button>
                <button onClick={() => onDelete(v)} title="この記録を消す" className="p-1 text-slate-400 hover:text-rose-500"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-black text-slate-400 tracking-widest mb-2">実績（受注数）</div>
          <NcsFactoryYears f={factory} years={years} />
        </div>
      </div>
    </div>
  );
};

/** タブ2: 訪問・成果（ターゲット＋訪問した工場を1枚で。ダブルクリックで訪問記録） */
const NcsWorkTab = ({ index, judgeFY, pool, visitsByFactory, statusOf, revisitDays = NCS_REVISIT_DAYS, onChangeRevisitDays, onSaveVisit, onDeleteVisit, onRemoveTargets, onExportReport }) => {
  const [phone, setPhone] = useState('');
  const [pref, setPref] = useState('');
  const [keyword, setKeyword] = useState('');
  const [onlyRevisit, setOnlyRevisit] = useState(false);
  const [visitFilter, setVisitFilter] = useState('all'); // 'all' | 'visited' | 'unvisited'
  const [daysInput, setDaysInput] = useState(String(revisitDays)); // 入力途中（空など）を許すため文字で持つ
  useEffect(() => { setDaysInput(String(revisitDays)); }, [revisitDays]);
  const changeDays = v => {
    setDaysInput(v);
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n !== revisitDays) onChangeRevisitDays?.(n);
  };
  const [visitDate, setVisitDate] = useState(ncsTodayIso); // 新しく書く記録の訪問日
  const [showCal, setShowCal] = useState(false);
  const [focus, setFocus] = useState(null); // カレンダーで選んだ { date, area, keys }
  const [checked, setChecked] = useState(new Set());
  const [modalKey, setModalKey] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [repFrom, setRepFrom] = useState(() => {
    const t = ncsTodayIso();
    return `${fiscalYearOct(Number(t.slice(0, 4)), Number(t.slice(5, 7)))}-10-01`; // 今期（10月始まり）の初日
  });
  const [repTo, setRepTo] = useState(ncsTodayIso);
  const [repBusy, setRepBusy] = useState(false);
  const handleReport = async () => {
    if (!repFrom || !repTo || repFrom > repTo) { alert('期間を正しく入れてね（開始日 ≦ 終了日）'); return; }
    setRepBusy(true);
    try {
      await onExportReport(repFrom, repTo);
    } catch (e) {
      console.error(e);
      alert(`Excelを作れなかったよ: ${e?.message || e}`);
    } finally {
      setRepBusy(false);
    }
  };
  const years = useMemo(() => index.fiscalYears.slice(-4), [index]);

  /** ターゲット＋訪問記録のある工場（ターゲットから外した工場も記録があれば出す） */
  const all = useMemo(() => {
    const entries = new Map(pool.map(x => [x.key, { ...x, inPool: true }]));
    visitsByFactory.forEach((vs, key) => {
      if (!entries.has(key)) entries.set(key, { key, tel: vs[vs.length - 1].tel || '', inPool: false });
    });
    return [...entries.values()].map(x => {
      const f = index.factories.get(x.key);
      const st = statusOf(x.key);
      const address = x.address || f?.address || '';
      return {
        ...x, address, pref: x.pref || f?.pref || '', tel: x.tel || f?.tel || '', phones: f?.phones,
        area: areaOf(address), st, judge: ncsJudge(st), fy: f ? splitFy(f, judgeFY, null) : null,
      };
    });
  }, [pool, visitsByFactory, statusOf, index, judgeFY]);
  /** カレンダーは市まで（横浜市・仙台市）でまとめる */
  const cityOfKey = useMemo(() => {
    const m = new Map(all.map(r => [r.key, cityOf(r.address)]));
    return key => m.get(key) || cityOf(index.factories.get(key)?.address);
  }, [all, index]);
  const areasByDate = useMemo(() => {
    const vs = [];
    visitsByFactory.forEach(list => vs.push(...list));
    return visitAreasByDate(vs, cityOfKey);
  }, [visitsByFactory, cityOfKey]);

  const shown = useMemo(() => {
    const hit = r => (focus?.keys.has(r.key) ? 0 : 1);
    return all
      .filter(r => factoryMatches(r, { phone, pref, keyword }) && (visitFilter === 'all' || (visitFilter === 'visited') === !!r.st) && (!onlyRevisit || r.judge === 'revisit'))
      .sort((a, b) => hit(a) - hit(b) || NCS_JUDGE_ORDER[a.judge] - NCS_JUDGE_ORDER[b.judge]
        || a.area.localeCompare(b.area, 'ja') || a.key.localeCompare(b.key, 'ja'));
  }, [all, phone, pref, keyword, visitFilter, onlyRevisit, focus]);

  const count = j => all.filter(r => r.judge === j).length;
  const cards = [
    ['ターゲット', pool.length, 'text-slate-800'],
    ['訪問した工場', all.filter(r => r.st).length, 'text-slate-800'],
    ['NCS受注あり', count('won'), 'text-emerald-600'],
    ['未受注', count('open') + count('revisit'), 'text-amber-600'],
    ['再訪問候補', count('revisit'), 'text-rose-600'],
  ];

  const toggle = key => setChecked(prev => {
    const n = new Set(prev);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });
  const handleRouteExport = async () => {
    const fs = all.filter(r => checked.has(r.key));
    if (!fs.length) { alert('ルートに入れる工場にチェックしてね'); return; }
    try {
      await writeRoutePlanXlsx(fs.map(r => ({ name: r.key, address: r.address, tel: r.tel, contact: r.contact })));
    } catch (e) {
      console.error(e);
      alert(e?.message || 'ルート計画書の作成に失敗したよ');
    }
  };
  const handleRemove = async (r) => {
    if (!window.confirm(`「${r.key}」をターゲットから外す？（訪問記録はそのまま）`)) return;
    try {
      await onRemoveTargets([r.key]);
      setChecked(prev => { const n = new Set(prev); n.delete(r.key); return n; });
    } catch (e) {
      alert(`外せなかったよ: ${e?.message || e}`);
    }
  };
  /** チェックした工場のうちターゲットに入っているものをまとめて外す */
  const checkedInPool = all.filter(r => r.inPool && checked.has(r.key));
  const handleRemoveChecked = async () => {
    const keys = checkedInPool.map(r => r.key);
    if (!keys.length) return;
    if (!window.confirm(`チェックした ${keys.length}件 をターゲットから外す？（訪問記録はそのまま）`)) return;
    try {
      await onRemoveTargets(keys);
      setChecked(new Set());
    } catch (e) {
      alert(`外せなかったよ: ${e?.message || e}`);
    }
  };
  const handleSave = (r, form, base) => onSaveVisit(base
    ? { ...base, ...form }
    : { id: newId(), listId: '', factoryKey: r.key, tel: r.tel, createdAt: new Date().toISOString(), ...form });
  const handleDelete = async (v) => {
    if (!window.confirm(`${ncsSlash(v.date)} の訪問記録を消す？`)) return;
    try {
      await onDeleteVisit(v);
    } catch (e) {
      alert(`消せなかったよ: ${e?.message || e}`);
    }
  };
  const handleExportCsv = () => {
    const headers = ['判定', 'エリア', '工場', '住所', 'TEL', '訪問回数', '初回訪問', '最終訪問', '最終の感触', 'メモ', '最終訪問からの日数',
      '訪問後NCS受注数', '訪問後NCS売上', 'NCS初受注日', '訪問後 全体受注数', '訪問後 全体売上', '訪問後 メンテ別'];
    const lines = [headers.map(ncsCsvQ).join(',')];
    shown.forEach(({ key, st, judge, address, area, tel }) => {
      const s = st?.stats;
      lines.push([
        ncsCsvQ(NCS_JUDGE_LABEL[judge].label), ncsCsvQ(area), ncsCsvQ(key), ncsCsvQ(address), ncsCsvQ(tel),
        st?.vs.length || 0, ncsCsvQ(st?.first.date), ncsCsvQ(st?.last.date), ncsCsvQ(st?.last.result),
        ncsCsvQ(st?.last.memo), st ? st.elapsed : '',
        s?.ncsQty || 0, Math.round(s?.ncsSales || 0), ncsCsvQ(fmtDateNum(s?.ncsFirst)),
        s?.allQty || 0, Math.round(s?.allSales || 0),
        ncsCsvQ([...(s?.byLease || new Map())].filter(([, q]) => q).map(([l, q]) => `${l}${q}`).join(' ')),
      ].join(','));
    });
    ncsDownload(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `NCS訪問成果_${ncsYmd()}.csv`);
  };

  const inputCls = 'w-full px-4 py-2.5 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-300';
  const labelCls = 'text-[10px] font-black text-slate-400 tracking-widest ml-1';
  const th = 'px-2 py-2.5 text-[11px] font-black whitespace-nowrap';
  const modalRow = modalKey && all.find(r => r.key === modalKey);

  if (!all.length) {
    return (
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-10 text-center text-slate-400 font-bold">
        まだターゲットがないよ。「ターゲット抽出」で工場にチェックして「ターゲットに追加」してね。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ダイジェスト */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {cards.map(([label, n, cls]) => (
          <div key={label} className="bg-white rounded-2xl shadow-sm border border-slate-100 px-4 py-3">
            <div className="text-[10px] font-black text-slate-400 tracking-widest">{label}</div>
            <div className={`text-2xl font-black ${cls}`}>{n}</div>
          </div>
        ))}
      </div>

      {/* 絞り込み＋訪問日 */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-4 no-print">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1.4fr_auto] gap-3 items-end">
          <label className="space-y-1"><div className={labelCls}>電話番号（市外局番）</div>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="022" className={inputCls} /></label>
          <label className="space-y-1"><div className={labelCls}>都道府県</div>
            <input value={pref} onChange={e => setPref(e.target.value)} placeholder="宮城県" className={inputCls} /></label>
          <label className="space-y-1"><div className={labelCls}>エリア・住所・工場名</div>
            <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="仙台市" className={inputCls} /></label>
          <div className="space-y-1"><div className={labelCls}>訪問日</div>
            <button onClick={() => setShowCal(v => !v)} aria-expanded={showCal} aria-label={`訪問日 ${ncsSlash(visitDate)}（カレンダー）`}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl border text-sm font-black whitespace-nowrap ${showCal ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-200 hover:border-emerald-300'}`}>
              <Calendar size={15} /> {ncsSlash(visitDate)} {showCal ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>
      </div>

      {showCal && (
        <NcsCalendar selected={visitDate} onSelect={setVisitDate} areasByDate={areasByDate} focus={focus} onFocus={setFocus} />
      )}

      {/* 操作 */}
      <div className="flex flex-wrap items-center gap-2 no-print">
        <span className="text-sm font-black text-slate-700 mr-1">{shown.length}工場</span>
        <button onClick={() => setChecked(prev => new Set([...prev, ...shown.map(r => r.key)]))}
          className="px-3 py-1.5 rounded-xl text-xs font-black text-emerald-700 border border-emerald-200 hover:bg-emerald-50">表示中を全部チェック</button>
        <button onClick={() => setChecked(new Set())} disabled={!checked.size}
          className="px-3 py-1.5 rounded-xl text-xs font-black text-slate-500 border border-slate-200 hover:bg-slate-50 disabled:opacity-40">チェックを外す</button>
        <span className="text-xs font-black text-slate-500">チェック {checked.size}件</span>
        <div className="inline-flex gap-0.5 bg-slate-100 p-0.5 rounded-xl ml-2">
          {[['all', 'すべて'], ['visited', '訪問済み'], ['unvisited', '未訪問']].map(([k, label]) => (
            <button key={k} onClick={() => setVisitFilter(k)} aria-pressed={visitFilter === k}
              className={`px-3 py-1 rounded-lg text-xs font-black ${visitFilter === k ? 'bg-white text-emerald-700 shadow' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>
          ))}
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-black text-slate-600 cursor-pointer">
          <input type="checkbox" checked={onlyRevisit} onChange={e => setOnlyRevisit(e.target.checked)} className="accent-rose-500" />
          再訪問候補だけ
        </label>
        <label className="inline-flex items-center gap-1 text-xs font-bold text-slate-500">
          （最終訪問から
          <input type="number" min="1" inputMode="numeric" aria-label="再訪問候補の日数" value={daysInput}
            onChange={e => changeDays(e.target.value)} onBlur={() => setDaysInput(String(revisitDays))}
            className="w-16 px-2 py-1 rounded-lg border border-slate-200 bg-white text-xs font-black text-slate-700 text-right focus:outline-none focus:ring-2 focus:ring-rose-200" />
          日以上・NCS未受注）
        </label>
        {focus && (
          <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-amber-100 text-amber-800 text-xs font-black">
            {fmtDateNum(focus.date)} {focus.area} の{focus.keys.size}工場を上に表示中
            <button onClick={() => setFocus(null)} aria-label="上に寄せるのをやめる" className="ml-1 hover:text-rose-600"><X size={13} /></button>
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={handleRemoveChecked} disabled={!checkedInPool.length}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black text-rose-500 border border-rose-200 hover:bg-rose-50 disabled:opacity-40">
            <Trash2 size={14} /> チェックした{checkedInPool.length}件を外す
          </button>
          <button onClick={handleRouteExport} disabled={!checked.size}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black border border-green-900 text-green-900 hover:bg-green-50 disabled:opacity-40">
            <FileSpreadsheet size={14} /> ルート計画書Excel
          </button>
          <button onClick={handleExportCsv} disabled={!shown.length}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black bg-green-900 text-white hover:bg-emerald-600 disabled:opacity-40">
            <Download size={14} /> CSV出力
          </button>
          <button onClick={() => setShowReport(v => !v)} aria-expanded={showReport}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black bg-emerald-600 text-white hover:bg-emerald-700">
            <FileSpreadsheet size={14} /> 実績Excel（方針書用）
          </button>
        </div>
      </div>

      {showReport && (
        <div className="bg-white rounded-3xl shadow-sm border border-emerald-200 p-4 flex flex-wrap items-end gap-3 no-print">
          <label className="space-y-1"><div className={labelCls}>訪問期間（開始）</div>
            <input type="date" aria-label="レポート開始日" value={repFrom} onChange={e => setRepFrom(e.target.value)} className={inputCls} /></label>
          <label className="space-y-1"><div className={labelCls}>訪問期間（終了）</div>
            <input type="date" aria-label="レポート終了日" value={repTo} onChange={e => setRepTo(e.target.value)} className={inputCls} /></label>
          <button onClick={handleReport} disabled={repBusy}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl text-xs font-black bg-green-900 text-white hover:bg-emerald-600 disabled:opacity-50">
            <Download size={14} /> {repBusy ? '作成中…' : 'Excelを出す'}
          </button>
          <div className="text-[11px] font-bold text-slate-400 basis-full">
            シート：サマリー（数字＋月別推移）／工場別成果／訪問記録。期間内に訪問した工場の、期間内の初回訪問の翌日〜終了日（データ最終日まで）の受注を数えるよ。上の絞り込みは効かず、全工場が対象。
          </div>
        </div>
      )}

      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-green-900 text-white">
            <tr>
              <th className={`${th} w-10 text-center`}>選択</th>
              <th className={`${th} text-center`}>判定</th>
              <th className={`${th} text-center`}>エリア</th>
              <th className={`${th} text-center`}>工場名</th>
              <th className={`${th} text-center bg-green-800`} title={`${judgeFY}/10〜${judgeFY + 1}/9`}>NCS<div className="text-[9px] font-bold text-green-300">{judgeFY}年度</div></th>
              <th className={`${th} text-center bg-green-800`} title={`${judgeFY}/10〜${judgeFY + 1}/9`}>他社<div className="text-[9px] font-bold text-green-300">{judgeFY}年度</div></th>
              <th className={`${th} text-center`}>最終訪問</th>
              <th className={`${th} text-center`}>経過</th>
              <th className={`${th} text-center`}>訪問後 NCS</th>
              <th className={`${th} text-center`}>訪問後 全体</th>
              <th className={`${th} text-center`}></th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const { st } = r;
              const s = st?.stats;
              const jl = NCS_JUDGE_LABEL[r.judge];
              const on = checked.has(r.key);
              const hit = focus?.keys.has(r.key);
              return (
                <tr key={r.key} onDoubleClick={() => setModalKey(r.key)} title="ダブルクリックで訪問記録"
                  className={`border-t border-slate-100 align-top cursor-pointer select-none ${hit ? 'bg-amber-50' : on ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
                  <td className="px-2 py-2 text-center" onClick={() => toggle(r.key)} onDoubleClick={e => e.stopPropagation()}>
                    {on ? <CheckSquare size={18} className="inline text-emerald-600" aria-label="チェック済み" /> : <Square size={18} className="inline text-slate-300" aria-label="未チェック" />}
                  </td>
                  <td className="px-2 py-2 text-center whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded-lg text-[10px] font-black ${jl.cls}`}>{jl.label}</span>
                  </td>
                  <td className="px-2 py-2 text-xs font-bold text-slate-600 whitespace-nowrap">{r.area}</td>
                  <td className="px-2 py-2 max-w-[15rem]">
                    <div className="font-black text-slate-800 text-sm truncate" title={r.key}>{r.key}</div>
                    <div className="text-[11px] text-slate-400 whitespace-nowrap">TEL: {r.tel}{!r.inPool && <span className="ml-1 text-slate-300">（ターゲット外）</span>}</div>
                    {st?.last.memo && <div className="text-[11px] text-slate-500 truncate" title={st.last.memo}>{st.last.memo}</div>}
                  </td>
                  <td className={`px-2 py-2 text-right font-black bg-emerald-50/50 ${r.fy?.ncs > 0 ? 'text-rose-600' : 'text-slate-300'}`}>{r.fy?.ncs || ''}</td>
                  <td className="px-2 py-2 text-right font-black bg-emerald-50/50 text-slate-700">{r.fy?.other || ''}</td>
                  <td className="px-2 py-2 text-xs whitespace-nowrap">
                    {st ? (
                      <>
                        <div className="flex items-center gap-1.5"><span className="font-bold text-slate-700">{ncsSlash(st.last.date)}</span><NcsResultBadge result={st.last.result} /></div>
                        <div className="text-[10px] font-bold text-slate-400">{st.vs.length}回目</div>
                      </>
                    ) : <span className="text-slate-300 font-bold">未訪問</span>}
                  </td>
                  <td className={`px-2 py-2 text-right text-xs font-black whitespace-nowrap ${st?.elapsed >= revisitDays ? 'text-rose-600' : 'text-slate-600'}`}>{st ? `${st.elapsed}日` : ''}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    {st && <div className={`text-xs font-black ${s?.ncsQty > 0 ? 'text-emerald-600' : 'text-slate-300'}`}>{s?.ncsQty || 0}件</div>}
                    {s?.ncsQty > 0 && <div className="text-[10px] text-slate-500 font-bold">¥{Math.round(s.ncsSales).toLocaleString()} / 初 {fmtDateNum(s.ncsFirst)}</div>}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {st && <div className="text-xs font-black text-slate-700">{s?.allQty || 0}件</div>}
                    <div className="flex flex-wrap justify-end gap-1 mt-0.5">
                      {[...(s?.byLease || new Map())].filter(([, q]) => q).sort((a, b) => b[1] - a[1]).map(([l, q]) => (
                        <span key={l} className={`text-[10px] font-black px-1.5 py-0.5 rounded ${l === NCS ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{l} {q}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap no-print" onDoubleClick={e => e.stopPropagation()}>
                    <button onClick={() => setModalKey(r.key)} title="訪問記録を書く" className="p-1 text-slate-400 hover:text-emerald-600"><Pencil size={14} /></button>
                    {r.inPool && (
                      <button onClick={() => handleRemove(r)} title="ターゲットから外す（訪問記録はそのまま）"
                        className="ml-1 px-2 py-1 rounded-lg text-[11px] font-black text-slate-400 hover:text-rose-500 hover:bg-rose-50">外す</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={11} className="px-3 py-10 text-center text-slate-400 font-bold">
                {onlyRevisit && !phone && !pref && !keyword ? '再訪問候補はいまないよ'
                  : visitFilter === 'visited' && !phone && !pref && !keyword ? 'まだ訪問記録がないよ' : '条件に合う工場がないよ'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] font-bold text-slate-400 no-print">工場の行をダブルクリック（または鉛筆）で訪問記録を書けるよ。訪問日の初期値は上で選んだ日。</div>

      {modalRow && (
        <NcsVisitModal
          key={modalRow.key}
          row={modalRow} visits={modalRow.st?.vs || []} defaultDate={visitDate} years={years}
          factory={index.factories.get(modalRow.key)}
          onSave={(form, base) => handleSave(modalRow, form, base)} onDelete={handleDelete}
          onClose={() => setModalKey(null)}
        />
      )}
    </div>
  );
};

export default App;
/** テスト用 */
export { LeaseReportView, NcsWorkTab };
