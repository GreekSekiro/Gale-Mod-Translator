(() => {
  const st = window.__galeTrans && window.__galeTrans.state;
  if (!st) return 'no instance';
  const cfg = st.config;
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','KBD','SAMP','TT','SVG','TEXTAREA','INPUT','OPTION','IFRAME']);
  const CHROME = 'nav,header,footer,button,select,option,input,textarea,[role="menubar"],[role="menu"],[role="menuitem"],[role="tooltip"],[contenteditable="true"]';
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n, shown = 0, latin = 0;
  while ((n = walker.nextNode()) && shown < 25) {
    const s = (n.nodeValue || '').trim();
    if (s.length < 3 || !/[A-Za-z]{2,}/.test(s)) continue;
    latin++;
    const el = n.parentElement;
    const reasons = [];
    if (CJK.test(s)) reasons.push('CJK');
    if (!el) reasons.push('no-el');
    else {
      if (SKIP.has(el.tagName)) reasons.push('skip-tag:' + el.tagName);
      if (el.closest('code,pre,kbd,samp,svg,script,style,[contenteditable="true"]')) reasons.push('inside-code');
      if (st.protectedNodes && st.protectedNodes.has(n)) reasons.push('PROTECTED');
      if (el.closest(CHROME)) reasons.push('chrome:' + el.closest(CHROME).tagName);
      if (el.closest('a') && !el.closest('.markdown,[class*="markdown"]')) reasons.push('anchor');
    }
    out.push(`[${reasons.length ? reasons.join(',') : 'CANDIDATE'}] <${el ? el.tagName.toLowerCase() : '?'}> ${s.slice(0, 62)}`);
    shown++;
  }
  return 'config=' + JSON.stringify(cfg) + '\nlatinTexts=' + latin + '\nprotected=' + (st.protectedNodes ? st.protectedNodes.size : -1) + '\n' + out.join('\n');
})()
