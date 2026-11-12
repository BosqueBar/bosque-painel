// Importação do histórico da planilha antiga (Painel_Consolidado): converte cada linha para o formato do painel novo.
const TEXTO = new Set(['evento', 'data', 'atualizado_em', 'entradas_por_hora', 'consumo_por_hora']);

// "1.253" → 1253 · "205954,08" → 205954.08 · "0,00" → 0 · "35560" → 35560
export function numeroBR(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/^R\$\s*/, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function dataISO(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}
function instante(v) { // "29/08/2026 11:56:03" (Brasília) → ISO UTC
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 3, +m[5], +(m[6] || 0)));
  return isNaN(d) ? null : d.toISOString();
}
function mapaHora(v) {
  if (!v) return null;
  try { const o = typeof v === 'string' ? JSON.parse(v) : v; return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}

// Devolve { noite, dados } ou null se a linha não tiver data válida.
export function converterLinha(linha) {
  const noite = dataISO(linha.data);
  if (!noite) return null;
  const dados = { evento: String(linha.evento || '').trim(), data: noite, origem: 'planilha antiga' };
  for (const k of Object.keys(linha)) {
    if (TEXTO.has(k) || !k) continue;
    const n = numeroBR(linha[k]);
    if (n !== null) dados[k] = n;
  }
  const iso = instante(linha.atualizado_em);
  if (iso) dados.atualizado_em = iso;
  const eh = mapaHora(linha.entradas_por_hora); if (eh) dados.entradas_por_hora = eh;
  const ch = mapaHora(linha.consumo_por_hora); if (ch) dados.consumo_por_hora = ch;
  return { noite, dados };
}
