// =====================================================================
//  ASINスキャナ — 画面まわりの制御
// =====================================================================
import { fetchJanName, fetchProducts, fetchRestriction, fetchSharedConfig, sliceSince } from './keepa.js';
import { calcProfit, judge, judgeLabel } from './profit.js';
import { TimeChart } from './chart.js';
import { BarcodeScanner, decodeImageFile, isCameraAvailable, isValidGtin, normalizeCode, unlockFeedbackAudio } from './scanner.js';
import * as store from './store.js';

// 直したらここを上げる。ヘッダーに出るので「更新したつもりで古いまま」に気づける
export const APP_VERSION = '1.4.0';

const ASIN_RE = /^(B[0-9A-Z]{9}|\d{9}[\dX])$/i;

const $ = (id) => document.getElementById(id);
const yen = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : '¥' + Math.round(v).toLocaleString('ja-JP'));
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('ja-JP'));

const state = {
  settings: store.loadSettings(),
  product: null,
  restriction: null,
  jan: '',
  rangeDays: 90,
  charts: {},
  scanner: null,
  cameraWasOn: false,
};

/* =============================== 起動 =============================== */

function init() {
  $('app-version').textContent = 'v' + APP_VERSION;
  state.rangeDays = state.settings.rangeDays || 90;

  adoptGasUrlFromLink();

  buildCharts();
  bindScanView();
  bindResultView();
  bindSettingsView();
  renderHistory();
  checkSetup();
  syncFromGas();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン化は無くても動く */ });
  }
}

// 実際にKeepaへ使うキー。手入力があればそれを優先し、無ければGASから降りてきた方を使う
function effectiveKeepaKey() {
  return state.settings.keepaApiKey || state.settings.syncedKeepaKey || '';
}

/**
 * GASの共有設定からKeepaのAPIキーを取ってくる。
 * 仕入れSKUキャプチャが全端末で同期しているキーをそのまま使うので、
 * スキャナ側で入力するのはGASのURLだけで済む（毎回キーを打たなくてよい）。
 */
async function syncFromGas() {
  if (!state.settings.gasUrl) return;
  try {
    const cfg = await fetchSharedConfig(state.settings.gasUrl);
    if (cfg.keepaKey && cfg.keepaKey !== state.settings.syncedKeepaKey) {
      state.settings.syncedKeepaKey = cfg.keepaKey;
      store.saveSettings(state.settings);
    }
    state.gasVersion = cfg.gasVersion;
  } catch (e) {
    state.gasError = String(e.message || e);
  }
  checkSetup();
  updateKeepaKeyStatus();
}

// 別の端末やPCから渡されたリンクにGASのURLが入っていたら、それを取り込む。
//   https://…/asin-scanner/?gas=https%3A%2F%2Fscript.google.com%2F…%2Fexec
// 取り込んだらアドレスバーからは消す（URLを見られてもGASのURLが残らないように）
function adoptGasUrlFromLink() {
  try {
    const params = new URLSearchParams(location.search);
    const gas = params.get('gas');
    if (gas && /^https:\/\/script\.google\.com\//.test(gas)) {
      state.settings.gasUrl = gas;
      store.saveSettings(state.settings);
    }
    if (params.has('gas')) {
      params.delete('gas');
      const rest = params.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
    }
  } catch (e) { /* 取り込めなくても手入力で使える */ }
}

// 設定が足りないときは、何が足りないかを最初の画面で言う
function checkSetup() {
  const box = $('setup-warning');
  if (!state.settings.gasUrl) {
    box.hidden = false;
    box.innerHTML = '右上の⚙で<b>GASのウェブアプリURL</b>を入れてください。'
      + 'KeepaのAPIキーはそこから自動で取り込むので、入力はこの1つだけです。';
    return;
  }
  if (!effectiveKeepaKey() && !state.settings.preferProxy) {
    box.hidden = false;
    box.innerHTML = 'KeepaのAPIキーをGASから取得できませんでした'
      + (state.gasError ? `（${escapeHtml(state.gasError)}）` : '')
      + '。仕入れSKUキャプチャの⚙でKeepaキーを保存するか、この画面の⚙で直接入力してください。';
    return;
  }
  box.hidden = true;
}

function showView(name) {
  for (const v of ['scan', 'result', 'settings']) {
    $('view-' + v).hidden = v !== name;
  }
  window.scrollTo(0, 0);
}

/* ============================ スキャン画面 ============================ */

function bindScanView() {
  $('btn-start-cam').addEventListener('click', startCamera);
  $('btn-stop-cam').addEventListener('click', stopCamera);
  $('btn-torch').addEventListener('click', toggleTorch);

  $('input-photo').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    unlockFeedbackAudio();
    try {
      const code = await decodeImageFile(file);
      lookup({ code });
    } catch (e) {
      showView('result');
      showError(String(e.message || e));
    }
  });

  $('form-manual').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const raw = $('input-code').value.trim();
    if (!raw) return;
    $('input-code').value = '';
    submitCode(raw);
  });

  $('btn-export').addEventListener('click', exportCsv);
  $('btn-clear-history').addEventListener('click', () => {
    if (!confirm('スキャン履歴を全部消しますか？')) return;
    store.clearHistory();
    renderHistory();
  });

  $('btn-settings').addEventListener('click', () => { fillSettingsForm(); showView('settings'); });
}

// 入力された文字列がASINかJANかを見分けて調べに行く
function submitCode(raw) {
  const value = raw.replace(/\s/g, '');
  if (ASIN_RE.test(value)) return lookup({ asin: value.toUpperCase() });
  const code = normalizeCode(value);
  if (/^\d{8,14}$/.test(code)) {
    if (!isValidGtin(code)) {
      showView('result');
      showError(`「${value}」はJANの検算が合いません。入力を確認してください。`);
      return;
    }
    return lookup({ code });
  }
  showView('result');
  showError(`「${raw}」はJANコードにもASINにも見えません。`);
}

async function startCamera() {
  // iOSは「操作の中」で作ったAudioContextしか鳴らせないので、ここで解錠しておく
  unlockFeedbackAudio();
  $('scanner-frame').hidden = false;
  try {
    if (!state.scanner) {
      state.scanner = new BarcodeScanner({
        video: $('video'),
        onResult: (code) => {
          stopCamera({ keepFlag: true });
          lookup({ code });
        },
        onStatus: (msg) => { $('scan-status').textContent = msg; },
      });
    }
    await state.scanner.start();
    state.cameraWasOn = true;
    $('btn-torch').hidden = !state.scanner.hasTorch();
  } catch (e) {
    $('scanner-frame').hidden = true;
    state.cameraWasOn = false;
    const msg = String(e.message || e);
    $('setup-warning').hidden = false;
    $('setup-warning').textContent = 'カメラを開けませんでした: ' + msg
      + '（「写真を撮って読む」か、JAN直接入力なら使えます）';
  }
}

function stopCamera(opts) {
  if (state.scanner) state.scanner.stop();
  $('scanner-frame').hidden = true;
  if (!(opts && opts.keepFlag)) state.cameraWasOn = false;
}

async function toggleTorch() {
  if (!state.scanner) return;
  const btn = $('btn-torch');
  const on = btn.getAttribute('aria-pressed') !== 'true';
  const ok = await state.scanner.setTorch(on);
  if (ok) btn.setAttribute('aria-pressed', String(on));
}

/* ============================ 取得と表示 ============================ */

function keepaOpts() {
  return {
    apiKey: effectiveKeepaKey(),
    gasUrl: state.settings.gasUrl,
    preferProxy: state.settings.preferProxy,
    offers: state.settings.fetchOffers,
  };
}

async function lookup(query) {
  showView('result');
  $('error-box').hidden = true;
  $('fallback-note').hidden = true;
  $('candidates').hidden = true;
  $('result').hidden = true;
  $('loading').hidden = false;
  $('loading-text').textContent = 'Keepaに問い合わせ中…';

  state.jan = query.code || '';
  state.foundBy = null;

  try {
    const { products } = await fetchProducts(query, keepaOpts());

    if (products.length === 0) {
      // JANがKeepaに無い商品は珍しくないので、商品名から探し直す
      if (query.code) return await lookupByName(query.code);
      $('loading').hidden = true;
      showError(`${query.asin} の情報を取得できませんでした。`);
      return;
    }
    if (products.length > 1) {
      $('loading').hidden = true;
      showCandidates(products);
      return;
    }
    await showProduct(products[0]);
  } catch (e) {
    $('loading').hidden = true;
    showError(String(e.message || e));
  }
}

/**
 * JANがKeepaに登録されていないときの回り道。
 *   JAN →（GAS経由で Yahoo!/楽天/Google/AI から）商品名 → その名前でKeepaを検索
 *
 * 名前で引いた結果は「JANが一致している保証が無い」ので、1件しか出なくても
 * 黙って確定させず、必ず断り書き付きの候補として人に選ばせる。
 */
async function lookupByName(code) {
  let found;
  try {
    $('loading-text').textContent = 'Keepaに無い商品。商品名を調べています…';
    found = await fetchJanName(code, state.settings.gasUrl);
  } catch (e) {
    $('loading').hidden = true;
    showError(`JAN ${code} はKeepaに登録がありませんでした。`
      + `商品名からの検索もできません（${String(e.message || e)}）`);
    return;
  }

  try {
    // AmazonカタログがASINを返したときは推測ではないので、候補に並べず直行する
    const byAsin = !!found.asin;
    $('loading-text').textContent = byAsin
      ? `${found.asin} をKeepaで確認中…`
      : `「${found.term}」でKeepaを検索中…`;
    const { products } = await fetchProducts(
      byAsin ? { asin: found.asin } : { term: found.term }, keepaOpts());
    $('loading').hidden = true;
    if (products.length === 0) {
      showError(byAsin
        ? `JAN ${code} は${found.source}で ${found.asin} と分かりましたが、`
          + 'Keepaにその商品のデータがありませんでした。'
        : `JAN ${code} はKeepaに登録がありません。`
          + `${found.source}で調べた商品名「${found.name || found.term}」でも見つかりませんでした。`);
      return;
    }
    state.foundBy = found;
    if (byAsin) {
      await showProduct(products[0]);
      return;
    }
    // 商品名検索は最大40件返る。棚の前で見比べられる数に絞る
    showCandidates(products.slice(0, 12), found);
  } catch (e) {
    $('loading').hidden = true;
    showError(String(e.message || e));
  }
}

function showCandidates(products, found) {
  if (found) {
    $('candidates-title').textContent = '商品名から探した候補';
    $('candidates-hint').textContent = `JAN ${state.jan} はKeepaに登録がありませんでした。`
      + `${found.source}で調べた「${found.name || found.term}」を`
      + `「${found.term}」として検索した結果です。`
      + 'JANが一致する保証はないので、現物と見比べてから選んでください。';
  } else {
    $('candidates-title').textContent = '候補が複数あります';
    $('candidates-hint').textContent = 'このJANに複数のASINが紐づいています。出品するものを選んでください。';
  }
  const ul = $('candidate-list');
  ul.innerHTML = '';
  for (const p of products) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `${p.image ? `<img src="${p.image}" alt="">` : ''}
      <span><strong>${escapeHtml(p.title || p.asin)}</strong><br>
      <small class="mono">${p.asin}</small> ·
      <small>${p.current.buyBox ? yen(p.current.buyBox) : '価格不明'} ·
      30日${p.drops30 ?? '—'}回</small></span>`;
    btn.addEventListener('click', () => {
      $('candidates').hidden = true;
      $('loading').hidden = false;
      showProduct(p);
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
  $('candidates').hidden = false;
}

async function showProduct(product) {
  state.product = product;
  $('loading').hidden = false;
  $('loading-text').textContent = '出品規制を確認中…';

  // 商品名から辿り着いた商品は、スキャンしたJANの商品とは限らない。
  // 結果画面でも出どころを出し続ける（候補画面の断り書きは隠れてしまうため）
  const found = state.foundBy;
  const note = $('fallback-note');
  note.hidden = !found;
  if (found && found.exact) {
    // AmazonカタログのJAN→ASINは推測ではないので、警告ではなく事実として出す
    note.className = 'notice notice-ok';
    note.textContent = `JAN ${state.jan} はKeepaに登録がありませんでしたが、`
      + `${found.source}でこのASINと判明しました。`;
  } else if (found) {
    note.className = 'notice notice-warn';
    note.textContent = `JAN ${state.jan} ではKeepaに見つからず、`
      + `${found.source}で調べた商品名「${found.term}」から探した商品です。`
      + '現物とJANが一致しているか確かめてください。';
  }

  // 規制の問い合わせが遅くても、商品の中身は先に描いて待たせない。
  // ただしcanvasは「表示されてから」でないと幅が0のまま描かれるので、
  // 先にカードを出してから renderProduct を呼ぶ（順番を入れ替えないこと）
  $('loading').hidden = true;
  $('result').hidden = false;
  renderProduct(product);

  state.restriction = { status: '?', code: 'PENDING', message: '確認中' };
  renderProfitAndVerdict();

  state.restriction = await fetchRestriction(product.asin, state.settings.gasUrl);
  renderProfitAndVerdict();
}

function renderProduct(p) {
  const img = $('product-image');
  if (p.image) { img.src = p.image; img.alt = p.title || ''; img.hidden = false; } else { img.hidden = true; }
  $('product-title').textContent = p.title || '(タイトル不明)';
  $('product-asin').textContent = p.asin;
  $('product-brand').textContent = p.brand || '';
  $('product-category').textContent = p.category || '';

  $('link-amazon').href = 'https://www.amazon.co.jp/dp/' + p.asin;
  $('link-keepa').href = 'https://keepa.com/#!product/5-' + p.asin;
  $('link-seller').href = 'https://sellercentral.amazon.co.jp/productsearch?q=' + p.asin;

  // 入力欄の初期値。売価はカート価格→新品最安の順で拾う
  const price = p.current.buyBox ?? p.current.newPrice ?? 0;
  $('in-price').value = price ? Math.round(price) : '';
  $('in-referral').value = p.referralPercent ?? '';
  $('in-fba').value = p.fbaFee ?? '';
  $('in-other').value = state.settings.defaultOtherCost || 0;
  $('in-tax').checked = state.settings.includeReferralTax !== false;
  $('in-cost').value = '';

  const src = [];
  src.push(p.referralPercent ? `紹介料${p.referralPercent}%はKeepaの実データ` : '紹介料はKeepaに無いので手入力してください');
  src.push(p.fbaFee !== null ? 'FBA手数料もKeepaの実データ' : 'FBA手数料はKeepaに無いので手入力してください');
  $('fee-source').textContent = src.join(' / ') + '。';

  renderStats(p);
  setRange(state.rangeDays);
}

function renderStats(p) {
  const cells = [];
  const push = (label, value, note, tone) => cells.push(
    `<div class="stat"><span class="stat-label">${label}</span>
     <span class="stat-value${tone ? ' is-' + tone : ''}">${value}</span>
     ${note ? `<span class="stat-note">${note}</span>` : ''}</div>`);

  push('カート価格', yen(p.current.buyBox), p.avg90.buyBox ? `90日平均 ${yen(p.avg90.buyBox)}` : '');
  push('新品最安', yen(p.current.newPrice), '');
  push('Amazon本体', p.current.amazon === null ? '不在' : yen(p.current.amazon),
    p.current.amazon === null ? '本体は今売っていない' : 'カートは取りにくい',
    p.current.amazon === null ? 'good' : 'warning');
  push('30日の販売数', p.drops30 === null ? '—' : `約${p.drops30}回`,
    p.drops90 === null ? '' : `90日で約${p.drops90}回`,
    p.drops30 === null ? null : (p.drops30 >= state.settings.minDrops30 ? 'good' : 'critical'));
  push('新品出品者', p.current.countNew === null ? '—' : `${p.current.countNew}人`, '',
    p.current.countNew === null ? null : (p.current.countNew > state.settings.maxCountNew ? 'critical' : 'good'));
  push('ランキング', p.current.rank === null ? '—' : '#' + num(p.current.rank), p.category || '');

  $('stats').innerHTML = cells.join('');
}

/* ------- 利益と判定（入力のたびに引き直す） ------- */

function renderProfitAndVerdict() {
  const p = state.product;
  if (!p) return;

  const profit = calcProfit({
    price: $('in-price').value,
    cost: $('in-cost').value,
    otherCost: $('in-other').value,
    referralPercent: $('in-referral').value,
    fbaFee: $('in-fba').value,
    includeReferralTax: $('in-tax').checked,
  });

  $('bd-price').textContent = yen(profit.price);
  $('bd-referral').textContent = '-' + yen(profit.referralFee).replace('¥', '¥');
  $('bd-fba').textContent = '-' + yen(profit.fbaFee);
  $('bd-other').textContent = '-' + yen(profit.otherCost);
  $('bd-net').textContent = yen(profit.net);
  $('bd-cost').textContent = profit.cost ? '-' + yen(profit.cost) : '—';

  const pv = $('bd-profit');
  pv.textContent = profit.cost ? yen(profit.profit) : '仕入値を入力';
  pv.className = 'profit-value' + (profit.cost ? (profit.profit > 0 ? ' is-good' : ' is-critical') : '');
  $('bd-margin').textContent = profit.marginPct === null || !profit.cost ? '—' : profit.marginPct.toFixed(1) + '%';
  $('bd-roi').textContent = profit.roiPct === null ? '—' : profit.roiPct.toFixed(0) + '%';

  const verdict = judge(p, profit, state.restriction, {
    minMarginPct: Number(state.settings.minMarginPct),
    minProfitYen: Number(state.settings.minProfitYen),
    minDrops30: Number(state.settings.minDrops30),
    maxCountNew: Number(state.settings.maxCountNew),
  });
  state.verdict = verdict;
  state.profit = profit;

  const box = $('verdict');
  box.className = 'verdict verdict-' + verdict.level;
  $('verdict-icon').textContent = { good: '◎', warning: '△', critical: '✕' }[verdict.level];
  $('verdict-label').textContent = judgeLabel(verdict);
  $('reasons').innerHTML = verdict.reasons
    .map((r) => `<li class="r-${r.level}">${escapeHtml(r.text)}</li>`).join('');
}

/* ------------------------------ グラフ ------------------------------ */

function buildCharts() {
  state.charts.price = new TimeChart($('chart-price'), { format: (v) => '¥' + Math.round(v).toLocaleString('ja-JP') });
  state.charts.price.setTooltipEl($('tip-price'));

  state.charts.sellers = new TimeChart($('chart-sellers'), { format: (v) => Math.round(v) + '人' });
  state.charts.sellers.setTooltipEl($('tip-sellers'));

  // ランキングは数字が小さいほど良いので、上下を反転して「上＝売れている」にする
  state.charts.rank = new TimeChart($('chart-rank'), {
    format: (v) => '#' + Math.round(v).toLocaleString('ja-JP'),
    invertY: true,
  });
  state.charts.rank.setTooltipEl($('tip-rank'));

  for (const btn of $('range-tabs').querySelectorAll('button')) {
    btn.addEventListener('click', () => setRange(Number(btn.dataset.days)));
  }
}

function setRange(days) {
  state.rangeDays = days;
  state.settings.rangeDays = days;
  store.saveSettings(state.settings);
  for (const btn of $('range-tabs').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === days));
  }
  drawCharts();
}

function seriesColor(n) {
  return getComputedStyle(document.documentElement).getPropertyValue('--series-' + n).trim();
}

/**
 * Keepa公式のグラフ画像を出す。
 * キー不要の公開URL（graph.keepa.com）なのでAPIトークンを消費せず、
 * GAS経由設定(preferProxy)でも同じように出る。
 * 落ちてきたら表示、駄目なら隠す。自前グラフが下にあるので消えても困らない。
 */
function renderKeepaGraph(p) {
  const box = $('keepa-graph-box');
  const img = $('keepa-graph');
  $('keepa-graph-link').href = 'https://keepa.com/#!product/5-' + encodeURIComponent(p.asin);
  box.hidden = true;
  img.onload = () => { box.hidden = false; };
  img.onerror = () => { box.hidden = true; };
  img.src = 'https://graph.keepa.com/pricehistory.png?'
    + new URLSearchParams({
      asin: p.asin,
      domain: 'co.jp',
      range: String(state.rangeDays || 90),
      salesrank: '1',
      width: '600',
      height: '250',
    });
}

function drawCharts() {
  const p = state.product;
  if (!p) return;
  renderKeepaGraph(p);
  const since = state.rangeDays ? Date.now() - state.rangeDays * 86400000 : 0;
  const cut = (s) => sliceSince(s, since);

  const priceSeries = [
    { key: 'buyBox', label: 'カート価格', color: seriesColor(1), points: cut(p.series.buyBox) },
    { key: 'new', label: '新品最安', color: seriesColor(2), points: cut(p.series.newPrice) },
    { key: 'amazon', label: 'Amazon本体', color: seriesColor(3), points: cut(p.series.amazon) },
  ];
  state.charts.price.setSeries(priceSeries);
  // 凡例は色だけに頼らないための保険。線が1本でも出しておく
  $('legend-price').innerHTML = priceSeries
    .filter((s) => s.points.some((x) => x.v !== null))
    .map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');

  state.charts.sellers.setSeries([
    { key: 'countNew', label: '新品出品者数', color: seriesColor(1), points: cut(p.series.countNew) },
  ]);
  state.charts.rank.setSeries([
    { key: 'rank', label: 'ランキング', color: seriesColor(1), points: cut(p.series.rank) },
  ]);

  renderDataTable(p, since);
}

// グラフが読めない/読みにくいときのための数値表。月ごとにまとめる
function renderDataTable(p, since) {
  const months = new Map();
  const bucket = (key, series, pick) => {
    for (const pt of series) {
      if (pt.v === null || pt.t < since) continue;
      const d = new Date(pt.t);
      const k = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!months.has(k)) months.set(k, {});
      const row = months.get(k);
      if (!row[key]) row[key] = [];
      row[key].push(pt.v);
    }
  };
  bucket('buyBox', p.series.buyBox);
  bucket('countNew', p.series.countNew);
  bucket('rank', p.series.rank);

  const avg = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const rows = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `
    <tr><td>${k}</td>
    <td>${v.buyBox ? yen(Math.min(...v.buyBox)) : '—'}</td>
    <td>${v.buyBox ? yen(avg(v.buyBox)) : '—'}</td>
    <td>${v.countNew ? Math.round(avg(v.countNew)) + '人' : '—'}</td>
    <td>${v.rank ? '#' + num(Math.round(avg(v.rank))) : '—'}</td></tr>`);

  $('data-table').innerHTML = `<thead><tr>
      <th>月</th><th>カート最安</th><th>カート平均</th><th>出品者数(平均)</th><th>ランキング(平均)</th>
    </tr></thead><tbody>${rows.join('') || '<tr><td colspan="5">この期間のデータがありません</td></tr>'}</tbody>`;
}

/* ============================ 結果画面の操作 ============================ */

function bindResultView() {
  for (const id of ['in-price', 'in-cost', 'in-referral', 'in-fba', 'in-other']) {
    $(id).addEventListener('input', renderProfitAndVerdict);
  }
  $('in-tax').addEventListener('change', renderProfitAndVerdict);

  $('btn-back').addEventListener('click', () => showView('scan'));
  $('btn-save').addEventListener('click', saveAndNext);
}

function saveAndNext() {
  const p = state.product;
  if (!p) return;
  store.addHistory({
    ts: Date.now(),
    jan: state.jan,
    asin: p.asin,
    title: p.title,
    image: p.image,
    price: state.profit ? state.profit.price : null,
    cost: state.profit ? state.profit.cost : null,
    profit: state.profit ? state.profit.profit : null,
    marginPct: state.profit ? state.profit.marginPct : null,
    judgeLabel: state.verdict ? judgeLabel(state.verdict) : '',
    judgeLevel: state.verdict ? state.verdict.level : '',
    restriction: state.restriction ? state.restriction.status : '?',
    drops30: p.drops30,
    countNew: p.current.countNew,
  });
  renderHistory();
  showView('scan');
  // 続けてスキャンできるよう、カメラを使っていたなら開き直す
  if (state.cameraWasOn) startCamera();
}

function showError(msg) {
  const box = $('error-box');
  box.hidden = false;
  box.textContent = msg;
  $('result').hidden = true;
}

/* ============================== 履歴 ============================== */

function renderHistory() {
  const list = store.loadHistory();
  $('history-block').hidden = list.length === 0;
  const ul = $('history-list');
  ul.innerHTML = '';
  for (const x of list.slice(0, 50)) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-open';
    open.innerHTML = `${x.image ? `<img src="${x.image}" alt="">` : ''}
      <span class="history-main">
        <p class="history-title">${escapeHtml(x.title || x.asin)}</p>
        <p class="history-sub">${x.asin} · ${x.profit ? '粗利 ' + yen(x.profit) : '仕入値未入力'}
          · ${new Date(x.ts).toLocaleDateString('ja-JP')}</p>
      </span>`;
    open.addEventListener('click', () => lookup({ asin: x.asin }));

    const badge = document.createElement('span');
    badge.className = 'history-badge badge-' + (x.judgeLevel || 'warning');
    badge.textContent = x.judgeLabel || '—';

    li.append(open, badge);
    ul.appendChild(li);
  }
}

function exportCsv() {
  const list = store.loadHistory();
  if (list.length === 0) return;
  const blob = new Blob([store.historyToCsv(list)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `asinスキャナ_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================== 設定 ============================== */

// Keepaキーがどこから来ているかを設定画面に出す。
// 「入れたつもりで効いていない」を防ぐため、出どころを必ず明示する
function updateKeepaKeyStatus() {
  const el = $('keepa-key-status');
  if (!el) return;
  const tail = (k) => '…' + String(k).slice(-4);
  if (state.settings.keepaApiKey) {
    el.className = 'key-status is-ok';
    el.textContent = `この端末に直接入力したキーを使っています（${tail(state.settings.keepaApiKey)}）`;
  } else if (state.settings.syncedKeepaKey) {
    el.className = 'key-status is-ok';
    el.textContent = `GASから自動取得済み（${tail(state.settings.syncedKeepaKey)}）。入力は不要です。`;
  } else if (!state.settings.gasUrl) {
    el.className = 'key-status';
    el.textContent = '上のGASのURLを入れると自動で取り込みます。';
  } else {
    el.className = 'key-status is-warn';
    el.textContent = 'GASから取得できませんでした'
      + (state.gasError ? `（${state.gasError}）` : '')
      + '。仕入れSKUキャプチャの⚙でKeepaキーを保存すると共有されます。';
  }
}

function fillSettingsForm() {
  const s = state.settings;
  $('set-keepa').value = s.keepaApiKey || '';
  $('set-gas').value = s.gasUrl || '';
  updateKeepaKeyStatus();
  $('set-proxy').checked = !!s.preferProxy;
  $('set-offers').checked = !!s.fetchOffers;
  $('set-tax').checked = s.includeReferralTax !== false;
  $('set-other').value = s.defaultOtherCost || 0;
  $('set-margin').value = s.minMarginPct;
  $('set-profit').value = s.minProfitYen;
  $('set-drops').value = s.minDrops30;
  $('set-sellers').value = s.maxCountNew;
  $('settings-saved').hidden = true;
}

function bindSettingsView() {
  $('btn-settings-back').addEventListener('click', () => showView('scan'));
  $('form-settings').addEventListener('submit', (ev) => {
    ev.preventDefault();
    state.settings = {
      ...state.settings,
      keepaApiKey: $('set-keepa').value.trim(),
      gasUrl: $('set-gas').value.trim(),
      preferProxy: $('set-proxy').checked,
      fetchOffers: $('set-offers').checked,
      includeReferralTax: $('set-tax').checked,
      defaultOtherCost: Number($('set-other').value) || 0,
      minMarginPct: Number($('set-margin').value) || 0,
      minProfitYen: Number($('set-profit').value) || 0,
      minDrops30: Number($('set-drops').value) || 0,
      maxCountNew: Number($('set-sellers').value) || 0,
    };
    store.saveSettings(state.settings);
    $('settings-saved').hidden = false;
    checkSetup();
    // GASのURLを入れ直したら、その場でKeepaキーを取りに行く
    syncFromGas().then(fillSettingsForm);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
