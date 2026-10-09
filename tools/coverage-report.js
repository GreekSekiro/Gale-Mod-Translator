// 覆盖率体检：把当前页面上的英文文本按"已译 / 被规则保护 / 疑似漏译"分类
(() => {
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  const LATIN = /[A-Za-z]{2,}/;
  const CHROME = 'nav,header,footer,button,select,option,input,textarea,[role="menubar"],[role="menu"],[role="menuitem"],[role="tooltip"]';
  const st = window.__galeTrans && window.__galeTrans.state;

  const buckets = { translated: [], protectedShape: [], chrome: [], code: [], toTranslate: [] };
  const isProtectedShape = (t) => {
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return true;
    if (/^[\d\s.,:%+\-/()[\]]+[a-zA-Z]{0,3}$/.test(t)) return true;
    if (/_/.test(t) && t.split(/[\s,，、]+/).filter(Boolean).length >= 2) return true;
    const words = t.split(/\s+/);
    const core = t.replace(/[\s.!?,;:，。！？；：、"')\]】]+$/, '');
    if (/[.!?,;:，。！？；：]/.test(core) || words.length > 3) return false;
    if (/^[A-Z0-9\s._\-+*/#]+$/.test(t) && t.length > 1 && !/[a-z]/.test(t)) return true;
    if (/[a-z][A-Z]/.test(t)) return true;
    if (/\.(dll|yml|yaml|json|cfg|md|ini|txt|zip|exe|log)$/i.test(t)) return true;
    if (/\d/.test(t) && !/\s/.test(t)) return true;
    if (words.length === 1) {
      if (t.length <= 2) return true;
      if (/[._/\\]/.test(t)) return true;
      return false;
    }
    return false;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const raw = (n.nodeValue || '').trim();
    if (!raw || !LATIN.test(raw)) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE)$/.test(el.tagName)) continue;
    if (CJK.test(raw)) {
      buckets.translated.push(raw.slice(0, 70));
      continue;
    }
    if (el.closest('code,pre,kbd,samp')) {
      buckets.code.push(raw.slice(0, 60));
      continue;
    }
    if (el.closest(CHROME)) {
      buckets.chrome.push(raw.slice(0, 60));
      continue;
    }
    if (isProtectedShape(raw)) {
      buckets.protectedShape.push(raw.slice(0, 60));
      continue;
    }
    buckets.toTranslate.push(raw.slice(0, 80));
  }
  const out = [`页面: ${location.pathname}`];
  out.push(`已译节点(含中文): ${buckets.translated.length}`);
  out.push(`疑似漏译: ${buckets.toTranslate.length}`);
  out.push(`被形状规则保护: ${buckets.protectedShape.length}`);
  out.push(`在界面框架内(跳过): ${buckets.chrome.length}`);
  out.push(`在代码块内(跳过): ${buckets.code.length}`);
  out.push('--- 疑似漏译样本 ---');
  out.push([...new Set(buckets.toTranslate)].slice(0, 14).join('\n') || '（无）');
  out.push('--- 被保护样本 ---');
  out.push([...new Set(buckets.protectedShape)].slice(0, 8).join('\n'));
  out.push('--- 框架内样本 ---');
  out.push([...new Set(buckets.chrome)].slice(0, 8).join('\n'));
  void st;
  return out.join('\n');
})()
