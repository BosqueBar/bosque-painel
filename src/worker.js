// Painel em tempo real · Bosque (Cloudflare Workers + Supabase).
// Esta é a base: só confere se o app e o banco estão de pé. Coleta, painel e acessos entram nas próximas etapas.
import { criarDb } from './db.js';
import { rodarAgendado, rodarAntecipado } from './coletor.js';
import { rodarExportacao } from './exportar.js';
import { api } from './rotas.js';

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
    if (url.pathname.startsWith('/api/')) { let db; try { db = criarDb(env); } catch (e) { return json({ erro: 'Servidor sem configuração do banco.' }, 500); } return api(request, url, env, db); }
    if (url.pathname.startsWith('/a/')) return env.ASSETS.fetch(new Request(new URL('/entrar', url).toString(), request)); // link pessoal → tela do PIN
    return env.ASSETS.fetch(request);
  },

  // A cada minuto: decide se é horário de evento e lê as fontes (cada uma separada, com o último dado bom guardado).
  async scheduled(event, env, ctx) {
    if (event.cron === '10 8 * * *' || event.cron === '0 13 * * *') { // 5h10 e 10h de Brasília: grava na planilha
      ctx.waitUntil((async () => {
        try { await rodarExportacao(env, criarDb(env), event.cron === '10 8 * * *' ? 'fechamento' : 'refaz'); } catch (e) { console.log('exportação falhou: ' + (e && e.message || e)); }
      })());
      return;
    }
    ctx.waitUntil((async () => {
      try { await rodarAgendado(env, criarDb(env)); } catch (e) { console.log('coleta falhou: ' + (e && e.message || e)); }
    })());
    ctx.waitUntil((async () => { // noites que ainda vão acontecer (antecipado e lista), de hora em hora
      try { await rodarAntecipado(env, criarDb(env)); } catch (e) { console.log('antecipado falhou: ' + (e && e.message || e)); }
    })());
  }
};
