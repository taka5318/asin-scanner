# vendor

外部ライブラリをそのまま置いてある。CDNから読むとオフラインや電波の弱い店内で
アプリが開かなくなるので、あえて同梱している。

| ファイル | 中身 | 出所 | ライセンス |
|---|---|---|---|
| `zxing.min.js` | バーコードのデコーダ（`@zxing/library` 0.21.3 の UMD ビルド） | https://github.com/zxing-js/library | 同梱の `zxing-LICENSE.txt` を参照 |

ライセンス表記は配布物の中で食い違っている（npmの `package.json` は MIT、
同梱の LICENSE ファイルは本家ZXing由来の Apache License 2.0）。
どちらでも再配布は問題ないので、原文の LICENSE をそのまま置いてある。

iPhoneのSafariにはブラウザ内蔵の `BarcodeDetector` が無いので、
この同梱版が実際に使われる。Android Chrome等では内蔵の方が優先される。

## 更新のしかた

```
npm pack @zxing/library@<version>
tar xzf zxing-library-<version>.tgz
cp package/umd/index.min.js apps/asin_scanner/web/vendor/zxing.min.js
cp package/LICENSE          apps/asin_scanner/web/vendor/zxing-LICENSE.txt
```
