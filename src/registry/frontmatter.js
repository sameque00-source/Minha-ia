/**
 * Parser do subconjunto de YAML usado nos frontmatters do MASTER (agentes e SKILL.md):
 * `chave: valor`, blocos dobrados `chave: >` / literais `chave: |` com indentação,
 * e valores entre aspas. Sem dependência externa.
 */
function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: String(text) };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-' || val === '') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i].trim());
      }
      if (val === '' && block.length === 0) { data[key] = ''; continue; }
      data[key] = val.startsWith('|') ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
      if (val === '' && block.every((b) => b.startsWith('- '))) data[key] = block.map((b) => b.slice(2).trim());
    } else {
      data[key] = val.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { data, body: String(text).slice(m[0].length) };
}

module.exports = { parseFrontmatter };
