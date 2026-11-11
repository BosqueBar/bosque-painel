// Painel em tempo real · Bosque (Cloudflare Workers + Supabase).
// Esta é a base: só confere se o app e o banco estão de pé. Coleta, painel e acessos entram nas próximas etapas.
import { criarDb } from './db.js';

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

// /saude: confirma que o Worker responde, que as variáveis existem e que o banco tem as tabelas pt_*.
async function saude(env) {
  const r = { app: 'ok', variaveis: {}, banco: '' };
  r.variaveis.SUPABASE_URL = env.SUPABASE_URL ? 'ok' : 'FALTA';
  r.variaveis.SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY ? 'ok' : 'FALTA';
  if (r.variaveis.SUPABASE_URL === 'ok' && r.variaveis.SUPABASE_SERVICE_KEY === 'ok') {
    try {
      const db = criarDb(env);
      await db.sel('pt_noites', { select: 'dia', limit: 1 });
      await db.sel('pt_pessoas', { select: 'id', limit: 1 });
      await db.sel('pt_fontes', { select: 'noite', limit: 1 });
      r.banco = 'ok (tabelas pt_* encontradas)';
    } catch (e) {
      r.banco = 'ERRO: ' + (e && e.message || e);
    }
  } else r.banco = 'não testado (faltam variáveis)';
  r.tudo_certo = r.app === 'ok' && r.banco.startsWith('ok') && Object.values(r.variaveis).every((v) => v === 'ok');
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/saude') return json(await saude(env));
    return env.ASSETS.fetch(request);
  },

  // A cada minuto. Etapa 2 em diante: decide se é horário de evento e coleta as fontes.
  async scheduled(event, env, ctx) {
    // base: nada a coletar ainda
  }
};
