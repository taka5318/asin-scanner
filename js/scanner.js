// =====================================================================
//  バーコード読み取り
//
//  1) BarcodeDetector（Android Chrome等のブラウザ内蔵。速くて正確）
//  2) ZXing（同梱。iPhoneのSafariは1)が無いのでこちらを使う）
//  の順に使う。どちらもダメな環境向けに「写真を撮って読む」経路も用意する。
// =====================================================================

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'code_128'];

let zxingReader = null;

function zxing() {
  const Z = window.ZXing;
  if (!Z) throw new Error('バーコード読み取りライブラリを読み込めませんでした');
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

function decodeCanvasZxing(canvas) {
  const { Z, reader } = zxing();
  try {
    const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
    const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
    const result = reader.decode(bitmap);
    return result ? result.getText() : null;
  } catch (e) {
    return null;   // 見つからないのは普通のこと。例外にしない
  } finally {
    reader.reset();
  }
}

let detector = null;
async function decodeCanvasNative(canvas) {
  if (!('BarcodeDetector' in window)) return null;
  if (!detector) detector = new window.BarcodeDetector({ formats: FORMATS });
  try {
    const found = await detector.detect(canvas);
    return found && found.length ? found[0].rawValue : null;
  } catch (e) {
    return null;
  }
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
  }

  async start() {
    if (this.running) return;
    if (!isCameraAvailable()) throw new Error('このブラウザではカメラを使えません（HTTPSでない可能性）');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },   // 背面カメラ
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');   // iOSで全画面に乗っ取られないため必須
    this.video.muted = true;
    await this.video.play();
    this.track = this.stream.getVideoTracks()[0] || null;
    this.running = true;
    this.onStatus('バーコードを枠に合わせてください');
    this._loop();
  }

  stop() {
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
    this.canvas.width = v.videoWidth;
    this.canvas.height = bandH;
    this.ctx.drawImage(v, 0, sy, v.videoWidth, bandH, 0, 0, v.videoWidth, bandH);

    let code = await decodeCanvasNative(this.canvas);
    if (!code) code = decodeCanvasZxing(this.canvas);
    if (!code) return;

    code = normalizeCode(code);
    if (!isValidGtin(code)) return;   // 検算NGは誤読として捨てる

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

  let code = await decodeCanvasNative(canvas);
  if (!code) code = decodeCanvasZxing(canvas);
  if (!code) throw new Error('写真からバーコードを読み取れませんでした');
  code = normalizeCode(code);
  if (!isValidGtin(code)) throw new Error('読み取れましたが値が不正です（撮り直してください）');
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
