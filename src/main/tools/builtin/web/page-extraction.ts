/** Runs in the sandboxed page. Never executes page-provided code or actions. */
export const FETCH_SCRIPT = String.raw`(async () => {
  const clean = value => String(value || '').replace(/[\t\r ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Give client-rendered article/link content a bounded opportunity to settle.
  let previous = '';
  let stable = 0;
  for (let i = 0; i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const signature = (document.body?.innerText || '').length + ':' + document.querySelectorAll('a[href]').length;
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (i >= 3 && stable >= 2 && (document.body?.innerText || '').trim().length > 120) break;
  }
  const title = clean(document.title);
  const visibleText = clean(document.body?.innerText || '');
  const blocked = /^(?:just a moment|access denied|403 forbidden|404 not found|robot check|百度安全验证|安全验证|页面不存在)/i.test(title) ||
    (visibleText.length < 2000 && /verify you are human|checking your browser|请完成安全验证|请输入验证码|访问过于频繁/i.test(visibleText));
  const clone = document.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template,svg,canvas,iframe').forEach(node => node.remove());
  const links = [];
  const byUrl = new Map();
  let linksTruncated = false;
  const resolveLink = anchor => {
    try {
      const raw = anchor.getAttribute('href');
      if (!raw || raw.startsWith('#')) return null;
      const parsed = new URL(raw, document.baseURI);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
      const current = new URL(location.href); current.hash = '';
      const target = new URL(parsed.href); target.hash = '';
      if (target.href === current.href) return null;
      return parsed.href;
    } catch { return null; }
  };
  for (const anchor of clone.querySelectorAll('a[href]')) {
    const url = resolveLink(anchor);
    if (!url || byUrl.has(url)) continue;
    if (links.length >= 500) { linksTruncated = true; continue; }
    const text = clean(anchor.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || url).slice(0, 200);
    const link = { id: 'L' + (links.length + 1), text, url,
      kind: /\.(?:pdf|docx?|xlsx?|pptx?|zip)(?:[?#]|$)/i.test(url) || anchor.hasAttribute('download') ? 'document' : 'page' };
    links.push(link); byUrl.set(url, link);
  }
  const controls = [...clone.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')]
    .map(node => clean(node.textContent || node.getAttribute('aria-label') || node.getAttribute('value'))).filter(Boolean).slice(0, 20);
  clone.querySelectorAll('nav,footer,form').forEach(node => node.remove());
  const root = clone.querySelector('article, main, [role="main"]') || clone.body || clone.documentElement;
  const inline = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName.toLowerCase() === 'a') {
      const link = byUrl.get(resolveLink(node));
      if (link) return clean(node.textContent || link.text) + ' [' + link.id + '](' + link.url + ')';
    }
    if (node.tagName.toLowerCase() === 'br') return '\n';
    return [...node.childNodes].map(inline).join('');
  };
  const lines = [];
  const push = value => { const text = clean(value); if (text && lines[lines.length - 1] !== text) lines.push(text); };
  const visit = node => {
    if (node.nodeType === Node.TEXT_NODE) { push(node.textContent); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) { push('#'.repeat(Number(tag[1])) + ' ' + inline(node)); return; }
    if (['p', 'blockquote', 'li', 'a'].includes(tag)) {
      push((tag === 'li' ? '- ' : tag === 'blockquote' ? '> ' : '') + inline(node)); return;
    }
    if (tag === 'pre') { const fence = String.fromCharCode(96).repeat(3); push(fence + '\n' + node.textContent + '\n' + fence); return; }
    if (tag === 'table') {
      for (const row of node.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll(':scope > th, :scope > td')].map(cell => clean(inline(cell)));
        if (cells.length) push('| ' + cells.join(' | ') + ' |');
      }
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return { title, url: location.href, markdown: lines.join('\n\n'), links, controls, linksTruncated, blocked };
})()`
