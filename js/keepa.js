// =====================================================================
//  Keepa API クライアント + 履歴データのデコード
//
//  Keepaの価格は「そのロケールの最小通貨単位の整数」で返る。
//  日本(domain=5)の最小単位は「円」なので、割り算も掛け算も不要でそのまま円。
//  （ユーロ圏だけがセント単位で100分の1になる。ここを間違えると100倍ズレる）
// =====================================================================

export const KEEPA_DOMAIN_JP = 5;

// csv[] のインデックス。使うものだけ名前を付けておく
export const CSV = {
  AMAZON: 0,        // Amazon本体の価格
  NEW: 1,           // 新品最安（送料別）
  USED: 2,
  SALES: 3,         // 売れ筋ランキング
  NEW_FBM_SHIPPING: 7,
  NEW_FBA: 10,      // 新品FBA最安
  COUNT_NEW: 11,    // 新品出品者数
  COUNT_USED: 12,
  RATING: 16,       // 評価（実値の10倍）
  COUNT_REVIEWS: 17,
  BUY_BOX: 18,      // カート価格（送料込み）
};

// [時刻, 価格, 送料] の3つ組で入っている系列。
// 他は [時刻, 値] の2つ組なので、読み方を変える必要がある
const TRIPLE_INDEXES = new Set([7, 18, 19, 20, 21, 22]);

// Keepaの時刻は「2011-01-01 00:00 UTC からの分数」。unix msに直す
export function keepaMinutesToMs(minutes) {
  return (minutes + 21564000) * 60000;
}

/**
 * csv[i] を [{t: unix ms, v: 値}] の配列にする。
 * v が -1（データ無し＝在庫切れ等）の点は null として残す。
 * グラフ側で null を「線を切る」目印に使いたいので捨てない。
 */
export function decodeSeries(csv, index) {
  const raw = csv && csv[index];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const step = TRIPLE_INDEXES.has(index) ? 3 : 2;
  const out = [];
  for (let i = 0; i + step - 1 < raw.length; i += step) {
    const t = keepaMinutesToMs(raw[i]);
    let v = raw[i + 1];
    if (v < 0) {
      out.push({ t, v: null });
      continue;
    }
    // 3つ組の系列は「価格＋送料」で実際の支払額になる。送料が-1なら不明として価格のみ
    if (step === 3) {
      const ship = raw[i + 2];
      if (ship > 0) v += ship;
    }
    if (index === CSV.RATING) v = v / 10;   // 評価だけ10倍で入っている
    out.push({ t, v });
  }
  return out;
}

// 系列の中で「指定時刻以降」だけ取り出す
export function sliceSince(series, sinceMs) {
  if (!sinceMs) return series;
  const out = series.filter((p) => p.t >= sinceMs);
  // 期間の左端より前の最後の点を1つ足しておくと、線が左端から始まって見た目が切れない
  const before = series.filter((p) => p.t < sinceMs).pop();
  if (before) out.unshift({ t: sinceMs, v: before.v });
  return out;
}

// 系列の最後の有効値（在庫切れ中なら null）
export function lastValue(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].v !== null) return series[i].v;
  }
  return null;
}

// statsの current[] などは「-1 = データ無し」。nullに正規化する
function stat(arr, index) {
  if (!Array.isArray(arr)) return null;
  const v = arr[index];
  return typeof v === 'number' && v >= 0 ? v : null;
}

/**
 * Keepaのproductオブジェクトを、アプリが使いやすい形に整える
 */
export function normalizeProduct(p) {
  const csv = p.csv || [];
  const s = p.stats || {};
  const images = String(p.imagesCSV || '').split(',').filter(Boolean);

  const series = {
    amazon: decodeSeries(csv, CSV.AMAZON),
    newPrice: decodeSeries(csv, CSV.NEW),
    buyBox: decodeSeries(csv, CSV.BUY_BOX),
    rank: decodeSeries(csv, CSV.SALES),
    countNew: decodeSeries(csv, CSV.COUNT_NEW),
  };

  // 紹介料%はKeepaのバージョンによってフィールド名が違う。両方見る
  const referral = firstNumber([p.referralFeePercentage, p.referralFeePercent]);
  const fbaFee = p.fbaFees && p.fbaFees.pickAndPackFee >= 0 ? p.fbaFees.pickAndPackFee : null;

  const categoryTree = Array.isArray(p.categoryTree) ? p.categoryTree.map((c) => c.name) : [];

  return {
    asin: p.asin || '',
    title: p.title || '',
    brand: p.brand || p.manufacturer || '',
    image: images[0] ? 'https://images-na.ssl-images-amazon.com/images/I/' + images[0] : '',
    category: categoryTree.length ? categoryTree[categoryTree.length - 1] : '',
    categoryTree,
    isAdult: !!p.isAdultProduct,
    hazmat: p.hazardousMaterialType || 0,
    referralPercent: referral,
    fbaFee,
    packageWeightG: p.packageWeight > 0 ? p.packageWeight : null,
    current: {
      amazon: stat(s.current, CSV.AMAZON),
      newPrice: stat(s.current, CSV.NEW),
      buyBox: s.buyBoxPrice > 0 ? s.buyBoxPrice : stat(s.current, CSV.BUY_BOX),
      rank: stat(s.current, CSV.SALES),
      countNew: stat(s.current, CSV.COUNT_NEW),
      rating: stat(s.current, CSV.RATING) === null ? null : stat(s.current, CSV.RATING) / 10,
      reviews: stat(s.current, CSV.COUNT_REVIEWS),
    },
    avg30: {
      buyBox: stat(s.avg30, CSV.BUY_BOX),
      newPrice: stat(s.avg30, CSV.NEW),
      rank: stat(s.avg30, CSV.SALES),
    },
    avg90: {
      buyBox: stat(s.avg90, CSV.BUY_BOX),
      newPrice: stat(s.avg90, CSV.NEW),
      rank: stat(s.avg90, CSV.SALES),
    },
    // ランキングの下落回数＝おおよその販売回数。Keepaが公式に出している指標
    drops30: numOrNull(s.salesRankDrops30),
    drops90: numOrNull(s.salesRankDrops90),
    drops180: numOrNull(s.salesRankDrops180),
    // Amazon本体が在庫切れだった期間の割合（高いほど本体が居ない＝狙い目）
    oosAmazon90: s.outOfStockPercentage90 ? numOrNull(s.outOfStockPercentage90[CSV.AMAZON]) : null,
    series,
    raw: p,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && v >= 0 ? v : null;
}

function firstNumber(list) {
  for (const v of list) {
    if (typeof v === 'number' && v > 0) return v;
  }
  return null;
}

/**
 * Keepaから商品を引く。
 *   query: {code: JAN} または {asin: ASIN}
 * まずブラウザから直接叩き、CORS等で失敗したらGAS経由に切り替える。
 * （Keepa APIキーをGAS側に置いておけば、スマホにキーを持たせずに済む）
 */
export async function fetchProducts(query, opts) {
  const { apiKey, gasUrl, preferProxy, offers } = opts || {};
  const params = {
    domain: String(KEEPA_DOMAIN_JP),
    stats: '180',
    history: '1',
    buybox: '1',
    rating: '1',
  };
  if (offers) params.offers = '20';
  if (query.code) params.code = query.code;
  if (query.asin) params.asin = query.asin;

  const errors = [];

  const tryDirect = async () => {
    if (!apiKey) throw new Error('Keepa APIキーが未設定です');
    const url = 'https://api.keepa.com/product?' + new URLSearchParams({ key: apiKey, ...params });
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('Keepa HTTP ' + res.status);
    return res.json();
  };

  const tryProxy = async () => {
    if (!gasUrl) throw new Error('GASのURLが未設定です');
    const url = gasUrl + (gasUrl.includes('?') ? '&' : '?')
      + new URLSearchParams({ action: 'keepa', ...params });
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('GAS HTTP ' + res.status);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'GAS側でKeepa取得に失敗');
    return body.data;
  };

  const order = preferProxy ? [tryProxy, tryDirect] : [tryDirect, tryProxy];
  let data = null;
  for (const fn of order) {
    try {
      data = await fn();
      break;
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  if (!data) throw new Error(errors.join(' / '));

  if (data.error) throw new Error(data.error.message || 'Keepaがエラーを返しました');
  const products = (data.products || []).filter((p) => p && p.asin);
  return {
    products: products.map(normalizeProduct),
    tokensLeft: typeof data.tokensLeft === 'number' ? data.tokensLeft : null,
  };
}

/**
 * 出品規制をGAS(SP-API)に問い合わせる。
 * GAS未設定なら「未確認」を返し、画面側でセラセンへのリンクを出す
 */
export async function fetchRestriction(asin, gasUrl) {
  if (!gasUrl) return { status: '?', code: 'NO_GAS', message: 'GAS未設定' };
  try {
    const url = gasUrl + (gasUrl.includes('?') ? '&' : '?')
      + new URLSearchParams({ action: 'restriction', asin });
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (!body.ok || !body.restriction) throw new Error(body.error || '応答が不正');
    return body.restriction;
  } catch (e) {
    return { status: '?', code: 'ERROR', message: String(e.message || e) };
  }
}
