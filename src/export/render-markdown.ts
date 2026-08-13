/** Minimal safe Markdown renderer for Packrat's own generated Markdown subset. */
export function renderMarkdownHtml(markdown: string, remoteImages: boolean): string {
  const escaped = escapeHtml(markdown);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let inCode = false;
  let list: 'ul' | 'ol' | null = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      if (inCode) out.push('</code></pre>'); else out.push('<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(line + '\n'); continue; }
    if (!line.trim()) { closeList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeList(); const n = heading[1].length; out.push(`<h${n}>${inline(heading[2], remoteImages)}</h${n}>`); continue; }
    const unordered = line.match(/^[-*]\s+(.*)$/);
    if (unordered) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(unordered[1], remoteImages)}</li>`); continue; }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ordered[1], remoteImages)}</li>`); continue; }
    if (line.startsWith('&gt; ')) { closeList(); out.push(`<blockquote>${inline(line.slice(5), remoteImages)}</blockquote>`); continue; }
    closeList();
    out.push(`<p>${inline(line, remoteImages)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function inline(text: string, remoteImages: boolean): string {
  let value = text;
  value = value.replace(/!\[([^\]]*)\]\(&lt;(https?:\/\/.*?)&gt;(?:\s+&quot;((?:(?!&quot;).)*)&quot;)?\)/g,
    (_m, alt, url, title) => remoteImages
      ? `<img src="${url}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="image-placeholder">[Image: ${alt || new URL(decodeHtmlEntities(url)).hostname}]</span>`);
  value = value.replace(/\[([^\]]+)\]\(&lt;(https?:\/\/.*?)&gt;\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(?<!\*)\*([^*]+)\*/g, '<em>$1</em>');
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  return value;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
