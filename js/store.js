// =====================================================================
//  設定とスキャン履歴の保存（端末内のlocalStorageのみ）
//
//  ページ自体は公開リポジトリで配信するので、鍵もGASのURLも一切埋め込まない。
//  GASの /exec は認証なしで叩けるため、URLも「持っている人だけが使える鍵」として扱う
//  （既定値に書くと公開サイトのソースから誰でも拾える）。
// =====================================================================

const SETTINGS_KEY = 'asinScanner.settings.v1';
const HISTORY_KEY = 'asinScanner.history.v1';
const HISTORY_LIMIT = 300;

export const DEFAULT_SETTINGS = {
  // 手入力のKeepaキー。空でよい（空ならKeepaはGAS経由で引き、キーは端末に置かない）
  keepaApiKey: '',
  gasUrl: '',
  preferProxy: false,       // 手入力キーがあっても、KeepaをGAS経由で引きたいとき
  fetchOffers: false,       // 出品者一覧まで取る（Keepaのトークンを多く消費する）
  includeReferralTax: true, // 紹介料に消費税10%を足す
  defaultOtherCost: 0,      // 送料・梱包などの既定値
  rangeDays: 90,
  minMarginPct: 15,
  minProfitYen: 300,
  minDrops30: 3,
  maxCountNew: 15,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    // 以前の版はGASから降りてきたKeepaキーを syncedKeepaKey として端末に保存していた。
    // 今はキーを端末に置かない方針なので、残っていたら消して保存し直す
    if ('syncedKeepaKey' in saved) {
      delete saved.syncedKeepaKey;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
    }
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (e) {
    return false;
  }
}

export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function addHistory(entry) {
  const list = loadHistory();
  // 同じASINを何度もスキャンしたら、古い行を消して1件にまとめる
  const filtered = list.filter((x) => x.asin !== entry.asin);
  filtered.unshift(entry);
  const capped = filtered.slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(capped));
  } catch (e) { /* 容量超過時は保存を諦める（画面は動かす） */ }
  return capped;
}

export function removeHistory(asin) {
  const list = loadHistory().filter((x) => x.asin !== asin);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* noop */ }
  return list;
}

export function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* noop */ }
  return [];
}

/** 履歴をCSVにする。Excel(cp932)でも文字化けしないようBOMを付ける */
export function historyToCsv(list) {
  const head = ['日時', 'JAN', 'ASIN', '商品名', '判定', '出品規制',
    '想定売価', '仕入値', '粗利', '利益率%', '30日販売数', '新品出品者数'];
  const rows = list.map((x) => [
    x.ts ? new Date(x.ts).toLocaleString('ja-JP') : '',
    x.jan || '', x.asin || '', x.title || '',
    x.judgeLabel || '', x.restriction || '',
    round(x.price), round(x.cost), round(x.profit),
    x.marginPct === null || x.marginPct === undefined ? '' : x.marginPct.toFixed(1),
    x.drops30 ?? '', x.countNew ?? '',
  ]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

function round(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : '';
}
