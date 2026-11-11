// Acesso ao banco (Supabase) pela API REST, com a chave secreta que fica só no servidor.
// (mesmo módulo do sistema de pedidos, sem a parte de fotos)

export class ErroApp extends Error {}

export function criarDb(env) {
  // Só o endereço do projeto (https://xxxx.supabase.co): se vier com /rest/v1 ou outro caminho colado junto, descarta.
  let base = String(env.SUPABASE_URL || '').trim();
  try { base = new URL(/^https?:\/\//i.test(base) ? base : 'https://' + base).origin; } catch (e) { base = ''; }
  const key = String(env.SUPABASE_SERVICE_KEY || '').trim();
  if (!base || !key) throw new ErroApp('Servidor sem configuração do banco (SUPABASE_URL / SUPABASE_SERVICE_KEY).');

  const cab = { apikey: key };
  // chave antiga (JWT "eyJ...") também vai no Authorization; a nova (sb_secret_...) só no apikey
  if (/^eyJ/.test(key)) cab.Authorization = 'Bearer ' + key;

  async function req(method, caminho, body, extra) {
    const headers = Object.assign({}, cab, extra || {});
    let corpo;
    if (body !== undefined && !(body instanceof Uint8Array)) {
      headers['Content-Type'] = 'application/json';
      corpo = JSON.stringify(body);
    } else corpo = body;
    let ultimoErro;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(base + caminho, { method, headers, body: corpo });
        const txt = await r.text();
        if (r.status >= 500 && t < 2) { ultimoErro = new Error('Banco indisponível (' + r.status + ')'); await espera(300 * (t + 1)); continue; }
        if (!r.ok) {
          let msg = txt;
          try { const j = JSON.parse(txt); msg = j.message || j.error || j.msg || txt; } catch (e) {}
          if (/invalid api key|no api key/i.test(msg)) {
            const tipo = /^sb_secret_/.test(key) ? 'secret (sb_secret_…)' : /^sb_publishable_/.test(key) ? 'publishable (pública, não serve)' : /^eyJ/.test(key) ? 'JWT (anon ou service_role)' : 'formato desconhecido';
            throw new ErroApp('O Supabase recusou a chave. Chave lida: ' + tipo + ', ' + key.length + ' caracteres; banco: ' + base.replace(/^https?:\/\//, '') + '. Confira se a chave é a secret/service_role deste mesmo projeto.');
          }
          const err = new Error('Banco: ' + msg);
          err.status = r.status; err.corpo = txt;
          throw err;
        }
        if (!txt) return null;
        try { return JSON.parse(txt); } catch (e) { return txt; }
      } catch (e) {
        if (e.status) throw e;           // erro de verdade do banco: não repete
        ultimoErro = e;
        if (t < 2) await espera(300 * (t + 1));
      }
    }
    throw new Error('Falha de conexão com o banco: ' + (ultimoErro && ultimoErro.message));
  }

  const q = obj => Object.keys(obj || {}).filter(k => obj[k] !== undefined)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');

  return {
    // filtros no formato do PostgREST: { dia: 'eq.2026-10-23', order: 'criado_em.asc' }
    sel: (tabela, filtros) => req('GET', '/rest/v1/' + tabela + '?' + q(Object.assign({ select: '*' }, filtros))),
    ins: (tabela, linhas, opc) => {
      opc = opc || {};
      const pref = ['return=' + (opc.retorna ? 'representation' : 'minimal')];
      if (opc.upsert) pref.push('resolution=merge-duplicates');
      if (opc.ignora) pref.push('resolution=ignore-duplicates');
      const extra = opc.conflito ? '?on_conflict=' + encodeURIComponent(opc.conflito) : '';
      return req('POST', '/rest/v1/' + tabela + extra, linhas, { Prefer: pref.join(',') });
    },
    upd: (tabela, filtros, dados) =>
      req('PATCH', '/rest/v1/' + tabela + '?' + q(filtros), dados, { Prefer: 'return=representation' }),
    del: (tabela, filtros) => req('DELETE', '/rest/v1/' + tabela + '?' + q(filtros), undefined, { Prefer: 'return=representation' }),
    rpc: (fn, args) => req('POST', '/rest/v1/rpc/' + fn, args || {})
  };
}

const espera = ms => new Promise(r => setTimeout(r, ms));
