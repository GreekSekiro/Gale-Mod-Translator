(() => {
  const out = [];
  out.push('URL: ' + location.href);
  const describe = (el, depth, maxDepth, max) => {
    if (!el || depth > maxDepth || out.length > max) return;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(' | ');
    const chained = [el.tagName.toLowerCase(), cls].filter(Boolean).join('.');
    out.push(`${'  '.repeat(depth)}<${chained}${el.getAttribute('role') ? ' role=' + el.getAttribute('role') : ''}>${own ? ' TEXT: ' + own.slice(0, 80) : ''}`);
    for (const c of el.children) describe(c, depth + 1, maxDepth, max);
  };
  describe(document.body, 0, 5, 120);

  out.push('');
  out.push('=== 含英文文本的节点及其归类 ===');
  const CHROME = 'nav,header,footer,button,select,option,input,textarea,[role="menubar"],[role="menu"],[role="menuitem"]';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  let i = 0;
  while ((n = walker.nextNode()) && i < 60) {
    const t = (n.nodeValue || '').trim();
    if (!t || !/[A-Za-z]{2,}/.test(t) || /[\u4e00-\u9fff]/.test(t)) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE)$/.test(el.tagName)) continue;
    const chrome = el.closest(CHROME);
    const inA = el.closest('a');
    const tags = [];
    if (chrome) tags.push('CHROME:' + chrome.tagName.toLowerCase());
    if (inA) tags.push('A');
    if (el.closest('code,pre')) tags.push('CODE');
    out.push(`[${tags.join(',') || 'CONTENT'}] <${el.tagName.toLowerCase()}.${String(el.className || '').split(/\s+/).slice(0, 2).join('.')}> ${t.slice(0, 70)}`);
    i++;
  }
  return out.join('\n');
})()
