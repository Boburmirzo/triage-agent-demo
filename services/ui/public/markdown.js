export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Intentionally small Markdown renderer: no HTML, embeds, or executable links.
export function markdown(text) {
  const lines = text.split(/\r?\n/);
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
    } else if (line.startsWith('|') && /^\|?[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      html += `<div class="table-wrap"><table><thead><tr>${cells(line).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
      i++;
      while (lines[i + 1]?.startsWith('|')) html += `<tr>${cells(lines[++i]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      html += '</tbody></table></div>';
    } else if (/^#{1,6} /.test(line)) {
      const level = line.startsWith('###') ? 'h3' : 'h2';
      html += `<${level}>${inline(line.replace(/^#+ /, ''))}</${level}>`;
    } else if (/^(\d+\.|[-*]) /.test(line)) {
      const ordered = /^\d/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const pattern = ordered ? /^\d+\. / : /^[-*] /;
      html += `<${tag}>`;
      do { html += `<li>${inline(lines[i].replace(pattern, ''))}</li>`; i++; } while (pattern.test(lines[i] || ''));
      i--;
      html += `</${tag}>`;
    } else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return html;
}
