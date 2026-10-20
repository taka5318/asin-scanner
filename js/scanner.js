// =====================================================================
//  バーコード読み取り
//
//  1) BarcodeDetector（Android Chrome等のブラウザ内蔵。速くて正確）
//  2) ZXing（同梱。iPhoneのSafariは1)が無いのでこちらを使う）
//  のどちらか一方を使う。どちらもダメな環境向けに「写真を撮って読む」経路も用意する。
// =====================================================================

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'code_128'];
const ZXING_SRC = new URL('../vendor/zxing.min.js', import.meta.url).href;
const ZXING_ERROR = 'バーコード読み取りライブラリを読み込めませんでした';

let zxingReader = null;
let zxingLoading = null;
let zxingFailedAt = 0;

// ZXingは330KBあり、起動のたびに読むと遅い。BarcodeDetectorで読める端末では一度も読まず、
// 必要になったとき（iPhoneでカメラを開いた・写真を予備で読む）に1回だけ読み込む
export function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingLoading) {
    // 失敗した直後にカメラの毎コマで読み直さない。少し待てば電波が戻ったときに読み直せる
    if (Date.now() - zxingFailedAt < 10000) return Promise.reject(new Error(ZXING_ERROR));
    zxingLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ZXING_SRC;
      script.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error(ZXING_ERROR)));
      script.onerror = () => { script.remove(); reject(new Error(ZXING_ERROR)); };
      document.head.appendChild(script);
    }).catch((e) => {
      zxingLoading = null;
      zxingFailedAt = Date.now();
      throw e;
    });
  }
  return zxingLoading;
}

function zxing() {
  const Z = window.ZXing;
  if (!Z) throw new Error(ZXING_ERROR);
  if (!zxingReader) {
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
      Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
      Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODE_128,
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zxingReader = new Z.MultiFormatReader();
    zxingReader.setHints(hints);
  }
  return { Z, reader: zxingReader };
}

// どちらの読み取り器も { text, format } を返す。UPC-E は8桁でEAN-8と見分けが
// つかないので、形式を捨てると正しいUPC-Eを検算で落としてしまう
function decodeCanvasZxing(canvas) {
  const { Z, reader } = zxing();
  try {
    const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
    const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
    const result = reader.decode(bitmap);
    if (!result) return null;
    return { text: result.getText(), format: result.getBarcodeFormat() === Z.BarcodeFormat.UPC_E ? 'upc_e' : '' };
  } catch (e) {
    return null;   // 見つからないのは普通のこと。例外にしない
  } finally {
    reader.reset();
  }
}

let detector = null;
let nativeSupport = null;
let nativeBroken = false;

// BarcodeDetector があっても、JANの形式に対応していない端末（読み取り部品が無い等）がある
function nativeReady() {
  if (!nativeSupport) {
    nativeSupport = (async () => {
      if (!('BarcodeDetector' in window)) return false;
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        return Array.isArray(formats) && formats.includes('ean_13');
      } catch (e) {
        return false;
      }
    })();
  }
  return nativeSupport.then((ok) => ok && !nativeBroken);
}

async function decodeCanvasNative(canvas) {
  if (!detector) detector = new window.BarcodeDetector({ formats: FORMATS });
  try {
    const found = await detector.detect(canvas);
    return found && found.length ? { text: found[0].rawValue, format: found[0].format } : null;
  } catch (e) {
    nativeBroken = true;   // 使えない端末だった。以後はZXingで読む
    return null;
  }
}

/**
 * 絵の中のバーコードを読む。使える読み取り器は1つだけ使う
 * （カメラの毎コマで両方を回すと、Androidで処理が2倍になって電池を食う）。
 * 写真は撮り直しが手間なので、BarcodeDetectorで読めなければZXingでも試す
 */
async function decodeCanvas(canvas, { retryWithZxing = false } = {}) {
  if (await nativeReady()) {
    const read = await decodeCanvasNative(canvas);
    if (read || (!retryWithZxing && !nativeBroken)) return read;
  }
  await loadZxing();
  return decodeCanvasZxing(canvas);
}

/**
 * UPC-E（8桁: ナンバーシステム + 6桁 + チェック）をUPC-A（12桁）に戻す。
 * チェックディジットは展開後のUPC-Aのものなので、EAN-8の重みでは検算できない。
 * 形が合わない・検算が合わないときは '' を返す。
 */
export function expandUpcE(code) {
  if (!/^[01]\d{7}$/.test(code)) return '';
  const ns = code[0];
  const [d1, d2, d3, d4, d5, d6] = code.slice(1, 7);
  const check = code[7];
  let body;
  if ('012'.includes(d6)) body = d1 + d2 + d6 + '0000' + d3 + d4 + d5;
  else if (d6 === '3') body = d1 + d2 + d3 + '00000' + d4 + d5;
  else if (d6 === '4') body = d1 + d2 + d3 + d4 + '00000' + d5;
  else body = d1 + d2 + d3 + d4 + d5 + '0000' + d6;
  const upcA = ns + body + check;
  return isValidGtin(upcA) ? upcA : '';
}

// 読み取った生の値を、Keepaに渡せる検算済みのコードにする。駄目なら ''
export function toCheckedCode(text, format) {
  let code = String(text || '').trim();
  if (format === 'upc_e' && code.length === 8) {
    code = expandUpcE(code);
    if (!code) return '';
  }
  code = normalizeCode(code);
  return isValidGtin(code) ? code : '';
}

/**
 * EAN-13 / EAN-8 / UPC-A のチェックディジットを検算する。
 * カメラの誤読を弾く最後の砦。ここを通さないと1桁違いのASINを拾って事故る
 */
export function isValidGtin(code) {
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  // 右端（チェックディジットの隣）から3,1,3,1... の重みを掛ける
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

// UPC-A(12桁)はEAN-13の先頭0付き。Keepaに渡す形に揃える
export function normalizeCode(code) {
  const c = String(code || '').trim();
  if (c.length === 12 && isValidGtin(c)) return '0' + c;
  return c;
}

export function isCameraAvailable() {
  return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export class BarcodeScanner {
  /**
   * video   : 映像を出す <video>
   * onResult: (code) => void  ※チェックディジット検算済みの値だけ来る
   */
  constructor({ video, onResult, onStatus }) {
    this.video = video;
    this.onResult = onResult;
    this.onStatus = onStatus || (() => {});
    this.stream = null;
    this.running = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.lastCode = null;
    this.lastSeenAt = 0;
    this.track = null;
    this.starting = null;   // 起動中の Promise。二重起動でカメラを2本開かないため
    this.generation = 0;    // stop() のたびに進む。起動の途中で止められたかの判定に使う
  }

  // running はカメラが開き終わってから立つので、それだけで二重起動は防げない。
  // 起動中は同じ Promise を返し、途中で stop() されたら開いたカメラをその場で閉じる
  start() {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    if (!isCameraAvailable()) return Promise.reject(new Error('このブラウザではカメラを使えません（HTTPSでない可能性）'));
    const gen = ++this.generation;
    // iPhoneはZXingの読み込みを、カメラが開くのを待つ間に済ませる。
    // 読み込めなければ、カメラが開いた後もその理由を出しておく（読めない理由が分からないため）
    let decoderError = '';
    nativeReady().then((ok) => (ok ? null : loadZxing())).catch((e) => {
      decoderError = String(e.message || e);
      if (gen === this.generation && this.running) this.onStatus(decoderError);
    });
    const run = (async () => {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },   // 背面カメラ
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (gen !== this.generation) return;   // 開いている間に止められた → finally で閉じる
        this.stream = stream;
        this.video.srcObject = stream;
        this.video.setAttribute('playsinline', '');   // iOSで全画面に乗っ取られないため必須
        this.video.muted = true;
        await this.video.play();
        if (gen !== this.generation) return;
        this.track = stream.getVideoTracks()[0] || null;
        this.running = true;
        stream = null;   // ここから先は stop() が閉じる
        this.onStatus(decoderError || 'バーコードを枠に合わせてください');
        this._loop();
      } catch (e) {
        if (gen !== this.generation) return;   // 止めたせいで play() が失敗しただけ
        throw e;
      } finally {
        // 起動できなかったカメラは必ず閉じる（開きっぱなしで電池を食わせない）
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          if (this.stream === stream) { this.stream = null; this.video.srcObject = null; }
        }
      }
    })();
    this.starting = run;
    run.finally(() => { if (this.starting === run) this.starting = null; }).catch(() => {});
    return run;
  }

  stop() {
    this.generation++;
    this.starting = null;   // 止めた直後の start() は、古い起動を待たずに開き直す
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
  }

  // 暗い棚でも読めるようにライトを点ける（対応端末のみ）
  hasTorch() {
    if (!this.track || !this.track.getCapabilities) return false;
    const caps = this.track.getCapabilities();
    return !!(caps && caps.torch);
  }

  async setTorch(on) {
    if (!this.hasTorch()) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch (e) {
      return false;
    }
  }

  _loop() {
    if (!this.running) return;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this._scanFrame();
      } catch (e) {
        // 1フレーム失敗しても止めない
      }
      if (this.running) setTimeout(() => requestAnimationFrame(tick), 110);
    };
    requestAnimationFrame(tick);
  }

  async _scanFrame() {
    const v = this.video;
    if (!v.videoWidth) return;
    // 画面中央の帯だけを切り出して読む。全画面を毎回読むより速く、誤読も減る
    const bandH = Math.round(v.videoHeight * 0.42);
    const sy = Math.round((v.videoHeight - bandH) / 2);
    // 大きさの代入は同じ値でも描画領域を作り直す。毎コマやらない
    if (this.canvas.width !== v.videoWidth) this.canvas.width = v.videoWidth;
    if (this.canvas.height !== bandH) this.canvas.height = bandH;
    this.ctx.drawImage(v, 0, sy, v.videoWidth, bandH, 0, 0, v.videoWidth, bandH);

    const read = await decodeCanvas(this.canvas);
    if (!read) return;

    const code = toCheckedCode(read.text, read.format);
    if (!code) return;   // 検算NGは誤読として捨てる

    // 同じ値を2回続けて読めたときだけ確定する（1回だけの読みは信用しない）
    const now = Date.now();
    if (this.lastCode === code && now - this.lastSeenAt < 2500) {
      this.lastCode = null;
      feedback();
      this.onResult(code);
      return;
    }
    this.lastCode = code;
    this.lastSeenAt = now;
  }
}

/** 写真1枚からバーコードを読む（カメラを直接使えない環境むけ） */
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  // 大きすぎる写真は縮めてから読む（そのままだと重いだけで精度も上がらない）
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const read = await decodeCanvas(canvas, { retryWithZxing: true });
  if (!read) throw new Error('写真からバーコードを読み取れませんでした');
  const code = toCheckedCode(read.text, read.format);
  if (!code) throw new Error('読み取れましたが値が不正です（撮り直してください）');
  feedback();
  return code;
}

// 読み取れたことを音と振動で伝える。画面を見ずにスキャンし続けられるように。
//
// iPhone対策で AudioContext は「使い回し」にしてある。
// iOSはユーザー操作の中で作られたAudioContext以外を suspended のまま止めるので、
// 読み取りのたびに new AudioContext() すると**永久に音が鳴らない**。
// しかもiOSには navigator.vibrate が無いので、そうなると合図がゼロになる。
// → ボタンを押したとき（＝操作の中）に unlockFeedbackAudio() で先に作って解錠しておく。
let audioCtx = null;

export function unlockFeedbackAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // 無音を一度鳴らしておくと、iOSが確実に解錠する
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.01);
  } catch (e) { /* 音が出せない環境でも読み取り自体は動かす */ }
}

function feedback() {
  try { navigator.vibrate && navigator.vibrate(60); } catch (e) { /* iPhoneは未対応。音だけになる */ }
  try {
    if (!audioCtx) unlockFeedbackAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.14);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) { /* 鳴らせなくても読み取りは続ける */ }
}
