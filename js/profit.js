// =====================================================================
//  手数料・手残り・仕入れ判定
//
//  計算式は既存の「Keepa Amazon手残りミニパネル」(apps/keepa_net_proceeds)と
//  そろえてある。同じ商品を別ツールで見たときに数字が食い違わないようにするため、
//  ここを変えるときは向こうも一緒に直すこと。
// =====================================================================

export const REFERRAL_TAX_RATE = 0.1;   // Amazonの手数料表示は税抜なので10%足す

export const DEFAULT_THRESHOLDS = {
  minMarginPct: 15,     // これ未満の利益率は「微妙」
  minProfitYen: 300,    // これ未満の粗利は「微妙」
  minDrops30: 3,        // 30日のランキング下落回数（≒販売数）がこれ未満は「微妙」
  maxCountNew: 15,      // 新品出品者がこれより多いと価格競争になりやすい
};

/**
 * 手数料と手残り・粗利を計算する。
 *   price   : 想定販売価格（円）
 *   cost    : 仕入原価（円・ポイント差引後の実質値を入れる想定）
 *   other   : その他費用（送料・梱包・広告など）
 */
export function calcProfit(input) {
  const price = num(input.price);
  const cost = num(input.cost);
  const other = num(input.otherCost);
  const referralPercent = clamp(num(input.referralPercent), 0, 99.99);
  const fba = num(input.fbaFee);
  const includeTax = input.includeReferralTax !== false;

  const referralBase = price * (referralPercent / 100);
  const referralFee = includeTax ? referralBase * (1 + REFERRAL_TAX_RATE) : referralBase;
  const totalFee = referralFee + fba + other;

  const net = price - totalFee;          // 手残り（仕入れ前）
  const profit = net - cost;             // 粗利
  return {
    price,
    cost,
    referralPercent,
    referralBase,
    referralFee,
    fbaFee: fba,
    otherCost: other,
    totalFee,
    net,
    profit,
    // 利益率は売価に対する粗利。ROIは仕入れに対する粗利（何%増えて戻るか）
    marginPct: price > 0 ? (profit / price) * 100 : null,
    roiPct: cost > 0 ? (profit / cost) * 100 : null,
  };
}

/**
 * 「仕入れていいか」を判定して、理由付きで返す。
 * 数字を隠して○×だけ出すと判断を誤るので、必ず理由も一緒に返す。
 */
export function judge(product, profit, restriction, thresholds) {
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const reasons = [];
  let level = 'good';

  const bump = (next) => {
    const rank = { good: 0, warning: 1, critical: 2 };
    if (rank[next] > rank[level]) level = next;
  };

  // --- 出品規制（これだけは他がどれだけ良くても覆らない） ---
  const rs = restriction && restriction.status;
  if (rs === '✕') {
    bump('critical');
    reasons.push({ level: 'critical', text: '出品不可（規制）' });
  } else if (rs === '△') {
    bump('warning');
    reasons.push({ level: 'warning', text: '要申請（規制あり）' });
  } else if (rs === '◯') {
    reasons.push({ level: 'good', text: '出品可' });
  } else {
    bump('warning');
    reasons.push({ level: 'warning', text: '規制は未確認' });
  }

  // --- 利益 ---
  if (profit.cost <= 0) {
    reasons.push({ level: 'info', text: '仕入値を入れると利益判定します' });
  } else if (profit.profit <= 0) {
    bump('critical');
    reasons.push({ level: 'critical', text: '赤字' });
  } else {
    if (profit.profit < th.minProfitYen) {
      bump('warning');
      reasons.push({ level: 'warning', text: `粗利が薄い（${yen(profit.profit)}）` });
    }
    if (profit.marginPct !== null && profit.marginPct < th.minMarginPct) {
      bump('warning');
      reasons.push({ level: 'warning', text: `利益率${profit.marginPct.toFixed(1)}%（目標${th.minMarginPct}%）` });
    }
    if (level === 'good') {
      reasons.push({ level: 'good', text: `粗利${yen(profit.profit)}・利益率${profit.marginPct.toFixed(1)}%` });
    }
  }

  // --- 売れ行き ---
  const drops = product.drops30;
  if (drops === null) {
    bump('warning');
    reasons.push({ level: 'warning', text: '販売数の実績データなし' });
  } else if (drops < th.minDrops30) {
    bump('warning');
    reasons.push({ level: 'warning', text: `30日で${drops}回しか売れていない` });
  } else {
    reasons.push({ level: 'good', text: `30日で約${drops}回売れている` });
  }

  // --- ライバル ---
  const cn = product.current.countNew;
  if (cn !== null && cn > th.maxCountNew) {
    bump('warning');
    reasons.push({ level: 'warning', text: `新品出品者が${cn}人と多い` });
  }

  // Amazon本体が今も売っているなら、カートはほぼ取れない
  if (product.current.amazon !== null) {
    bump('warning');
    reasons.push({ level: 'warning', text: 'Amazon本体が販売中' });
  }

  return { level, reasons, costEntered: profit.cost > 0 };
}

export const JUDGE_LABEL = {
  good: '仕入れOK',
  warning: '要検討',
  critical: '見送り',
};

// 仕入値を入れる前は利益が分からない。売れ行き・規制だけの下見であることを言葉で示す
// （ここで「仕入れOK」と出すと、値段を見ないまま買ってしまう）
export const JUDGE_LABEL_PRESCREEN = {
  good: '候補アリ',
  warning: '要検討',
  critical: '見送り',
};

export function judgeLabel(verdict) {
  const table = verdict.costEntered ? JUDGE_LABEL : JUDGE_LABEL_PRESCREEN;
  return table[verdict.level];
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function yen(v) {
  return '¥' + Math.round(v).toLocaleString('ja-JP');
}
