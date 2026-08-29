// =====================================================================
//  時系列の折れ線グラフ（canvas・ライブラリ非依存）
//
//  ・y軸は必ず1本だけ。単位の違うもの（価格・出品者数・ランキング）は
//    同じ絵に重ねず、グラフを分けて縦に並べる。
//  ・色はCSSカスタムプロパティから読むので、ダークモードは勝手に付いてくる。
// =====================================================================

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export class TimeChart {
  /**
   * canvas : 描画先
   * opts.series : [{key, label, color, points:[{t,v}], dashed}]
   * opts.format : (v) => 表示文字列
   * opts.invertY: 小さいほど良い指標（ランキング）で上下を反転する
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = Object.assign({ format: (v) => String(v), invertY: false, minHeight: 150 }, opts);
    this.series = [];
    this.hover = null;
    this.tooltip = null;
    this._bind();
  }

  setSeries(series) {
    this.series = (series || []).filter((s) => s.points && s.points.some((p) => p.v !== null));
    this.draw();
  }

  setTooltipEl(el) {
    this.tooltip = el;
  }

  _bind() {
    const move = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      if (x < 0 || x > rect.width) return this._clearHover();
      this.hover = x;
      this.draw();
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerdown', move);
    this.canvas.addEventListener('pointerleave', () => this._clearHover());
    this.canvas.addEventListener('pointercancel', () => this._clearHover());
    window.addEventListener('resize', () => this.draw());

    // 非表示のまま描くと幅0の絵ができあがる。表示された/回転した瞬間に描き直す
    if ('ResizeObserver' in window) {
      let lastW = 0;
      new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (w > 0 && w !== lastW) { lastW = w; this.draw(); }
      }).observe(this.canvas);
    }
  }

  _clearHover() {
    this.hover = null;
    if (this.tooltip) this.tooltip.hidden = true;
    this.draw();
  }

  _bounds() {
    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const s of this.series) {
      for (const p of s.points) {
        if (p.t < tMin) tMin = p.t;
        if (p.t > tMax) tMax = p.t;
        if (p.v === null) continue;
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      }
    }
    if (!Number.isFinite(vMin)) return null;
    if (vMin === vMax) { vMin -= 1; vMax += 1; }
    // 上下に少し余白。線が枠に張り付くと読みにくい
    const pad = (vMax - vMin) * 0.12;
    return { tMin, tMax, vMin: Math.max(0, vMin - pad), vMax: vMax + pad };
  }

  draw() {
    const c = this.canvas;
    const box = c.getBoundingClientRect();
    const w = Math.max(1, box.width);
    const h = Math.max(this.opts.minHeight, box.height || this.opts.minHeight);
    const dpr = DPR();
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const ink = cssVar(c, '--text-muted', '#898781');
    const grid = cssVar(c, '--grid', '#e1e0d9');
    const axis = cssVar(c, '--axis', '#c3c2b7');
    const surface = cssVar(c, '--surface-1', '#fcfcfb');

    const b = this._bounds();
    if (!b) {
      ctx.fillStyle = ink;
      ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('データがありません', w / 2, h / 2);
      return;
    }

    // 右側は最新値の直接ラベル用に広めに空ける
    const padL = 6, padR = 74, padT = 10, padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const xOf = (t) => padL + ((t - b.tMin) / Math.max(1, b.tMax - b.tMin)) * plotW;
    const yOf = (v) => {
      const r = (v - b.vMin) / Math.max(1e-9, b.vMax - b.vMin);
      const rr = this.opts.invertY ? r : 1 - r;
      return padT + rr * plotH;
    };

    // --- 目盛り（4本の水平線。控えめに） ---
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = b.vMin + ((b.vMax - b.vMin) * i) / ticks;
      const y = yOf(v);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.fillText(this.opts.format(v), padL + plotW + 6, y);
    }

    // --- x軸の日付（左端と右端だけ。中身を邪魔しない） ---
    ctx.strokeStyle = axis;
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(padT + plotH) + 0.5);
    ctx.lineTo(padL + plotW, Math.round(padT + plotH) + 0.5);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDate(b.tMin), padL, padT + plotH + 5);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDate(b.tMax), padL + plotW, padT + plotH + 5);

    // --- 線本体 ---
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(s.dashed ? [4, 4] : []);
      ctx.beginPath();
      let pen = false;
      for (const p of s.points) {
        if (p.v === null) { pen = false; continue; }   // 在庫切れ期間は線を切る
        const x = xOf(p.t), y = yOf(p.v);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- 最新値を線の右端に直接書く（凡例と色だけに頼らないため） ---
    for (const s of this.series) {
      const last = [...s.points].reverse().find((p) => p.v !== null);
      if (!last) continue;
      const x = Math.min(xOf(last.t), padL + plotW);
      const y = yOf(last.v);
      ctx.fillStyle = surface;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- ホバー（十字線＋吹き出し） ---
    if (this.hover !== null && this.tooltip) {
      const t = b.tMin + ((this.hover - padL) / Math.max(1, plotW)) * (b.tMax - b.tMin);
      ctx.strokeStyle = axis;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      const hx = Math.max(padL, Math.min(padL + plotW, this.hover));
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      const rows = [];
      for (const s of this.series) {
        const p = valueAt(s.points, t);
        rows.push(`<span class="tt-key"><i style="background:${s.color}"></i>${s.label}</span>`
          + `<span class="tt-val">${p === null ? '—' : this.opts.format(p)}</span>`);
        if (p !== null) {
          const y = yOf(p);
          ctx.fillStyle = surface;
          ctx.beginPath(); ctx.arc(hx, y, 5.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = s.color;
          ctx.beginPath(); ctx.arc(hx, y, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      this.tooltip.innerHTML = `<div class="tt-date">${fmtDate(t, true)}</div>${rows.join('')}`;
      this.tooltip.hidden = false;
      const tw = this.tooltip.offsetWidth || 140;
      this.tooltip.style.left = Math.max(0, Math.min(w - tw, hx - tw / 2)) + 'px';
      this.tooltip.style.top = '0px';
    }
  }
}

// 指定時刻の「その時点で有効だった値」。Keepaの履歴は階段状なので直近の点を拾う
function valueAt(points, t) {
  let v = null;
  for (const p of points) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

function fmtDate(ms, withYear) {
  const d = new Date(ms);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return withYear ? `${d.getFullYear()}/${md}` : md;
}
