// Painel em tempo real · Bosque (Cloudflare Workers + Supabase).
// Esta é a base: só confere se o app e o banco estão de pé. Coleta, painel e acessos entram nas próximas etapas.
import { criarDb } from './db.js';
import { coletarSympla } from './fontes/sympla.js';
import { coletarZigIngressos } from './fontes/zig_ingressos.js';

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

// Rotas de TESTE (temporárias, só leitura): conferem uma fonte contra o painel atual. Protegidas por TESTE_CHAVE.
// Mostram só números; e-mails e dados pessoais nunca aparecem.
function chaveOk(url, env) {
  const c = url.searchParams.get('chave') || '', k = String(env.TESTE_CHAVE || '');
  if (!k || c.length !== k.length) return false;
  let d = 0; for (let i = 0; i < k.length; i++) d |= c.charCodeAt(i) ^ k.charCodeAt(i);
  return d === 0;
}
async function teste(url, env) {
  if (!chaveOk(url, env)) return json({ erro: 'Acesso negado.' }, 403);
  const fonte = url.pathname.slice('/teste/'.length);
  const dia = url.searchParams.get('dia') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return json({ erro: 'Use ?dia=AAAA-MM-DD' }, 400);
  const t0 = Date.now();
  try {
    if (fonte === 'sympla') {
      const r = await coletarSympla(env, criarDb(env), dia);
      const { hash_emails_pagos, hash_emails_cortesia, ...resto } = r;
      resto.emails_pagos_lidos = (hash_emails_pagos || []).length;
      resto.emails_cortesia_lidos = (hash_emails_cortesia || []).length;
      resto.segundos = Math.round((Date.now() - t0) / 100) / 10;
      return json(resto);
    }
    if (fonte === 'zig_ingressos') {
      const r = await coletarZigIngressos(env, dia);
      r.segundos = Math.round((Date.now() - t0) / 100) / 10;
      return json(r);
    }
    return json({ erro: 'Fonte desconhecida.' }, 404);
  } catch (e) { return json({ erro: String(e && e.message || e), segundos: Math.round((Date.now() - t0) / 100) / 10 }, 500); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/saude') return json(await saude(env));
    if (url.pathname.startsWith('/teste/')) return teste(url, env);
    return env.ASSETS.fetch(request);
  },

  // A cada minuto. Etapa 2 em diante: decide se é horário de evento e coleta as fontes.
  async scheduled(event, env, ctx) {
    // base: nada a coletar ainda
  }
};
