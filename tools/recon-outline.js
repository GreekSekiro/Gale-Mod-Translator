(() => {
  const out = [];
  out.push('URL: ' + location.href);
  out.push('TITLE: ' + document.title);
  out.push('BODY CLASS: ' + document.body.className);
  out.push('SCRIPTS: ' + [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).join(', '));
  out.push('STYLES: ' + [...document.querySelectorAll('link[rel=stylesheet]')].map(s => s.getAttribute('href')).join(', '));
  out.push('--- OUTLINE ---');
  const skip = new Set(['SCRIPT', 'STYLE', 'SVG', 'PATH', 'NOSCRIPT', 'LINK', 'META']);
  let count = 0;
  const walk = (el, depth) => {
    if (count > 400 || depth > 7) return;
    if (skip.has(el.tagName)) return;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.');
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' | ');
    const isTexty = own.length > 0;
    const hasKids = el.children.length > 0;
    if (!isTexty && !hasKids) return;
    const id = el.id ? '#' + el.id : '';
    const attrs = ['data-testid', 'role', 'aria-label', 'href', 'placeholder', 'type']
      .map(a => el.getAttribute && el.getAttribute(a) ? ` ${a}="${String(el.getAttribute(a)).slice(0, 60)}"` : '')
      .join('');
    const info = `${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}${attrs}>${isTexty ? ' TEXT: ' + own.slice(0, 120) : ''}`;
    out.push(info);
    count++;
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  return out.join('\n');
})()
