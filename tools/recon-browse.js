(() => {
  const out = [];
  const describe = (el, depth, maxDepth) => {
    if (!el || depth > maxDepth) return;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' | ');
    const kids = el.children.length;
    out.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${el.getAttribute('title') ? ' title=' + JSON.stringify(el.getAttribute('title')) : ''}>${own ? ' TEXT: ' + own.slice(0, 200) : ''}${kids ? '' : ' [leaf]'}`);
    for (const c of el.children) describe(c, depth + 1, maxDepth);
  };

  const vl = document.querySelector('svelte-virtual-list-contents');
  out.push('=== VIRTUAL LIST ===');
  out.push('rows: ' + (vl ? vl.children.length : 'none'));
  if (vl) {
    const rows = [...vl.children];
    out.push('--- row[0] subtree ---');
    describe(rows[0], 0, 4);
    if (rows[1]) { out.push('--- row[1] subtree ---'); describe(rows[1], 0, 4); }
  }

  out.push('');
  out.push('=== RIGHT DETAIL PANEL ===');
  const panel = document.querySelector('div.w-\\[40\\%\\]') || document.querySelectorAll('div.relative.flex.grow.overflow-hidden > div')[1];
  if (panel) describe(panel, 0, 4);

  out.push('');
  out.push('=== ALL TEXT NODES (visible, latin) ===');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = [];
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t || t.length < 2) continue;
    if (!/[A-Za-z]/.test(t)) continue;
    if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement?.tagName || '')) continue;
    seen.push(n.parentElement.tagName.toLowerCase() + ' :: ' + t.slice(0, 90));
  }
  out.push('count: ' + seen.length);
  out.push(seen.slice(0, 60).join('\n'));
  return out.join('\n');
})()
