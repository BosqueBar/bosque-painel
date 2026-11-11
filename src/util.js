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
