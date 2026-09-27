// Keepaのmodel/partNumber、または商品名にある「HQ1996-001」型の品番を拾う。
// サイズ (25.0cm) やASINを型番と誤認しないよう、タイトルではハイフン付きだけを対象にする。
const HYPHENS = /[‐‑‒–—−ー－]/g;
const MODEL_IN_TITLE = /(?:^|[^A-Z0-9])([A-Z0-9]{2,12}(?:-[A-Z0-9]{2,12}){1,2})(?=$|[^A-Z0-9])/g;
const PLAIN_MODEL = /(?:^|[^A-Z0-9])([A-Z0-9]{5,20})(?=$|[^A-Z0-9])/g;
const ASIN = /^(B[0-9A-Z]{9}|\d{9}[\dX])$/;

const canonical = (value) => String(value || '').normalize('NFKC').toUpperCase().replace(HYPHENS, '-');
const looksLikeModel = (value) => /[A-Z]/.test(value) && /\d/.test(value) && !ASIN.test(value);

function firstModel(value, pattern) {
  for (const match of canonical(value).matchAll(pattern)) {
    if (looksLikeModel(match[1])) return match[1];
  }
  return '';
}

export function extractModelNumber(product, fallbackTitle = '') {
  for (const field of [product.model, product.partNumber]) {
    const model = firstModel(field, MODEL_IN_TITLE) || firstModel(field, PLAIN_MODEL);
    if (model) return model;
  }
  return firstModel(product.title, MODEL_IN_TITLE)
    || firstModel(fallbackTitle, MODEL_IN_TITLE);
}

export function matchesModel(product, model) {
  const normalized = canonical(model);
  if (!normalized || !looksLikeModel(normalized)) return false;
  const compact = normalized.replace(/-/g, '');
  return [product.model, product.partNumber, product.title].some((field) => {
    const text = canonical(field);
    if (!text) return false;
    // Amazonタイトルでは品番のハイフンが省かれることもあるが、前方一致は誤商品を拾う。
    return [...text.matchAll(MODEL_IN_TITLE), ...text.matchAll(PLAIN_MODEL)]
      .some((match) => match[1].replace(/-/g, '') === compact);
  });
}

export function variationEntries(rawVariations) {
  if (!Array.isArray(rawVariations)) return [];
  const seen = new Set();
  return rawVariations.flatMap((item) => {
    const asin = canonical(item && item.asin);
    if (!ASIN.test(asin) || seen.has(asin)) return [];
    seen.add(asin);
    const attributes = Array.isArray(item.attributes) ? item.attributes : [];
    const label = attributes
      .map((attr) => [attr && attr.dimension, attr && attr.value]
        .filter(Boolean).map(String).join(': '))
      .filter(Boolean).join(' / ');
    return [{ asin, label }];
  });
}
