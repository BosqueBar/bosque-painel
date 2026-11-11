// Utilidades comuns: busca com tempo máximo, datas de Brasília e hash.

// fetch com tempo máximo: se a fonte demorar, desiste daquela fonte (as outras seguem).
export async function buscar(url, opcoes, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    return await fetch(url, Object.assign({}, opcoes, { signal: ctl.signal }));
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('tempo esgotado (' + Math.round((ms || 20000) / 1000) + ' s) em ' + new URL(url).host);
    throw e;
  } finally { clearTimeout(t); }
}

export async function buscarJson(url, opcoes, ms) {
  const r = await buscar(url, opcoes, ms);
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('resposta que não é JSON (' + r.status + ') em ' + new URL(url).host); }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + new URL(url).host + (j && (j.message || j.error) ? ': ' + (j.message || j.error) : ''));
  return j;
}

// SHA-256 em hexadecimal (usado para guardar e-mails só como hash, nunca em texto).
export async function sha256(txt) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(txt)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Soma dias a uma data AAAA-MM-DD (sem depender do fuso do servidor).
export function somarDias(dia, n) {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}
// Dia da semana de uma data AAAA-MM-DD: 0 = domingo … 6 = sábado.
export function diaSemana(dia) {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}
// Recebe um horário local (AAAA-MM-DDTHH:mm…) e devolve 'HH' se cair na noite `dia` (18h do dia até 06h do seguinte); senão null.
export function horaDaNoite(iso, dia) {
  const t = String(iso || '');
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}/.test(t) || !dia) return null;
  const d = t.substring(0, 10), h = t.substring(11, 13);
  if (d === dia && h >= '18') return h;
  if (d === somarDias(dia, 1) && h < '06') return h;
  return null;
}
