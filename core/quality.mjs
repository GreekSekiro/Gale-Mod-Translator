// 译文质量评分：多节点并发翻译后择优，或用它对单个候选打分
// 评分维度：目标语言是否成立、术语是否保留、机翻痕迹、长度合理性、与已有译法的一致性、回译相似度
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD = /[A-Za-z][A-Za-z'-]{2,}/g;

const isChinese = (target) => /^zh/i.test(String(target || ''));
const countMatches = (s, re) => (String(s).match(re) || []).length;
const tokens = (s) => (String(s).toLowerCase().match(LATIN_WORD) || []).filter((w) => w.length >= 4);

/** 术语（专名/代码）是否被保留：原文里出现的拉丁词，译文里应当仍能找到 */
function termScore(src, dst, glossary) {
  const keep = new Set();
  for (const t of glossary || []) {
    const from = typeof t === 'string' ? t : t?.from;
    if (!from) continue;
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(src)) keep.add(String(from));
  }
  if (!keep.size) return { delta: 0, missing: [] };
  const missing = [...keep].filter((t) => !dst.toLowerCase().includes(t.toLowerCase()));
  return { delta: missing.length ? -12 * missing.length : 6, missing };
}

/** 机翻常见毛病：重复片段、残留英文过多、叠字、异常标点 */
function artifactScore(src, dst, target) {
  const reasons = [];
  let delta = 0;
  const zh = isChinese(target);
  const chinese = countMatches(dst, CJK);
  const visible = dst.replace(/\s/g, '').length || 1;

  if (zh) {
    const ratio = chinese / visible;
    if (ratio < 0.25) {
      delta -= 45;
      reasons.push('译文几乎没有中文（可能没翻）');
    } else if (ratio < 0.5) {
      delta -= 18;
      reasons.push('中文占比偏低');
    }
    const latinWords = tokens(dst).length;
    if (latinWords > 6 && latinWords > visible / 6) {
      delta -= 12;
      reasons.push('残留英文词偏多');
    }
  }

  // 重复 4 字片段
  const seen = new Map();
  let total = 0;
  for (let i = 0; i + 4 <= dst.length; i++) {
    const g = dst.slice(i, i + 4);
    if (!/[a-zA-Z\u4e00-\u9fff]/.test(g)) continue;
    total++;
    seen.set(g, (seen.get(g) || 0) + 1);
  }
  const repeated = [...seen.values()].filter((n) => n >= 3).length;
  if (repeated > 2) {
    delta -= Math.min(24, repeated * 4);
    reasons.push('存在重复片段');
  }
  // 多样性：4 字片段的去重比例过低说明整段在复读
  if (total >= 8) {
    const diversity = seen.size / total;
    if (diversity < 0.6) {
      delta -= 30;
      reasons.push(`内容高度重复(多样性 ${diversity.toFixed(2)})`);
    } else if (diversity < 0.78) {
      delta -= 10;
      reasons.push('内容重复偏多');
    }
  }
  if (/[。，、]{2,}/.test(dst) || /(.)\1{3,}/.test(dst)) {
    delta -= 6;
    reasons.push('标点/字符异常重复');
  }

  // 长度合理性（中英长度比通常在 0.35~1.2 之间）
  const lenRatio = dst.length / Math.max(6, src.length);
  if (zh && (lenRatio < 0.25 || lenRatio > 2.4)) {
    delta -= 14;
    reasons.push(`长度比例异常(${lenRatio.toFixed(2)})`);
  }
  return { delta, reasons };
}

/** 与已有译法的一致性：和相似的已译句子译文越接近越加分 */
function consistencyScore(src, dst, neighbors) {
  if (!neighbors || !neighbors.length) return { delta: 0 };
  const a = new Set(tokens(dst));
  const b = new Set(tokens(neighbors[0].dst));
  if (!a.size || !b.size) {
    // 中文之间比较字面重叠
    const common = [...new Set(dst)].filter((c) => CJK.test(c) && neighbors[0].dst.includes(c)).length;
    const ratio = common / Math.max(4, new Set(dst).size);
    return { delta: Math.round(ratio * 8) };
  }
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return { delta: Math.round((inter / Math.max(a.size, b.size)) * 8) };
}

/** 回译相似度：把候选译文翻回英文，与原文比对（越像越说明信息没丢） */
function backTranslationScore(src, back) {
  const a = new Set(tokens(src));
  const b = new Set(tokens(back));
  if (!a.size || !b.size) return { delta: 0, similarity: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const sim = inter / Math.max(a.size, b.size);
  return { delta: Math.round(sim * 25), similarity: Number(sim.toFixed(3)) };
}

/**
 * 给一个候选译文打分
 * @returns {{score:number, reasons:string[], detail:object}}
 */
export function scoreCandidate(src, dst, { target = 'zh-CN', glossary = [], neighbors = [], back = null } = {}) {
  if (!dst || dst === src) return { score: -100, reasons: ['与原文相同'], detail: {} };
  let score = 50;
  const reasons = [];

  const art = artifactScore(src, dst, target);
  score += art.delta;
  reasons.push(...art.reasons);

  const term = termScore(src, dst, glossary);
  score += term.delta;
  if (term.missing.length) reasons.push('丢失专名: ' + term.missing.join(','));

  const cons = consistencyScore(src, dst, neighbors);
  score += cons.delta;
  if (cons.delta > 4) reasons.push('与已有译法一致');

  const detail = { artifact: art.delta, terms: term.delta, consistency: cons.delta };
  if (back != null) {
    const bt = backTranslationScore(src, back);
    score += bt.delta;
    detail.back = bt.delta;
    detail.similarity = bt.similarity;
    if (bt.similarity >= 0.5) reasons.push(`回译相似度高(${bt.similarity})`);
    else if (bt.similarity > 0 && bt.similarity < 0.2) reasons.push(`回译相似度低(${bt.similarity})`);
  }
  return { score: Math.round(score), reasons, detail };
}

/**
 * 多候选择优
 * @param {string} src 原文
 * @param {Array<{provider:string,dst:string}>} candidates
 * @param {object} ctx {target, glossary, neighbors, backTranslate?: (text)=>Promise<string>}
 */
export async function pickBest(src, candidates, ctx = {}) {
  const list = candidates.filter((c) => c && c.dst && c.dst !== src);
  if (!list.length) return { best: null, ranked: [] };
  const ranked = [];
  for (const c of list) {
    let back = null;
    if (ctx.backTranslate) {
      try {
        back = await ctx.backTranslate(c.dst);
      } catch {
        back = null;
      }
    }
    const r = scoreCandidate(src, c.dst, { ...ctx, back });
    ranked.push({ provider: c.provider, dst: c.dst, score: r.score, reasons: r.reasons, detail: r.detail, back });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { best: ranked[0], ranked };
}
