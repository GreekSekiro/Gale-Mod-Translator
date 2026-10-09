(() => {
  const out = [];
  const row = document.querySelectorAll('svelte-virtual-list-contents > *')[1];
  out.push('=== ROW[1] innerHTML ===');
  out.push(row ? row.innerHTML.replace(/\s{2,}/g, ' ').slice(0, 2000) : 'none');
  out.push('');
  out.push('=== 详情面板头部 innerHTML ===');
  const panel = [...document.querySelectorAll('div.relative.flex.grow > div')].find(d => d.querySelector('.markdown')) || document.querySelector('div.w-\\[40\\%\\]');
  if (panel) {
    const head = panel.querySelector('.-mr-3.grow') || panel;
    out.push(head.innerHTML.replace(/\s{2,}/g, ' ').slice(0, 2500));
  }
  out.push('');
  out.push('=== markdown 容器 innerHTML 前 1500 ===');
  const md = document.querySelector('.markdown');
  out.push(md ? md.innerHTML.replace(/\s{2,}/g, ' ').slice(0, 1500) : 'none');
  out.push('');
  out.push('=== 页面级容器判定 ===');
  for (const sel of ['nav', 'header', '[role=menubar]', 'svelte-virtual-list-contents', '.markdown', 'button']) {
    out.push(`${sel}: ${document.querySelectorAll(sel).length}`);
  }
  out.push('');
  out.push('=== 所有含英文文本的元素 -> 是否在 chrome 内 ===');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n, i = 0;
  while ((n = walker.nextNode()) && i < 40) {
    const t = n.textContent.trim();
    if (!t || !/[A-Za-z]{2}/.test(t) || /[\u4e00-\u9fff]/.test(t)) continue;
    const p = n.parentElement;
    if (/^(SCRIPT|STYLE)$/.test(p.tagName)) continue;
    const chrome = p.closest('nav, header, footer, button, select, option, input, textarea, [role=menubar], [role=menu]');
    out.push(`[${chrome ? 'CHROME:' + chrome.tagName.toLowerCase() : 'CONTENT'}] <${p.tagName.toLowerCase()}.${(typeof p.className === 'string' ? p.className : '').split(/\s+/).slice(0,2).join('.')}> ${t.slice(0, 70)}`);
    i++;
  }
  return out.join('\n');
})()
