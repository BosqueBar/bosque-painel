// Coletor: roda a cada minuto (agendador da Cloudflare). Cada fonte é lida e guardada SEPARADA, com tempo máximo próprio:
// se uma fonte falha ou demora, as outras seguem e a tela mostra o último dado bom daquela fonte (com a hora da última leitura).
import { coletarSympla } from './fontes/sympla.js';
import { coletarZigIngressos } from './fontes/zig_ingressos.js';
import { coletarZigBar } from './fontes/zig_bar.js';
import { coletarUgo } from './fontes/ugo.js';
import { montarConsolidado } from './consolidado.js';
import { somarDias, diaSemana } from './util.js';

const FONTES = ['sympla', 'zig_ingressos', 'zig_bar', 'ugo'];
const SYMPLA_CAMPOS_UGO = ['sympla_entradas', 'sympla_entradas_f', 'sympla_entradas_m', 'sympla_entradas_sem_genero',
  'sympla_cortesia_entradas', 'sympla_cortesia_f', 'sympla_cortesia_m', 'sympla_cortesia_sem_genero', 'horas_sympla'];

// Janelas de evento por dia da semana (0 = domingo). Segunda a quarta só existem como noite extra marcada no calendário (pt_noites).
const JANELAS = { 0: [19, 4], 4: [20, 5], 5: [20, 5], 6: [20, 5] };
const JANELA_EXTRA = [20, 5];

// "Agora" em horário de Brasília (UTC-3, sem horário de verão), como partes de data.
export function agoraBR(ms) {
  const d = new Date((ms || Date.now()) - 3 * 3600e3);
  return { dia: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), minuto: d.getUTCMinutes() };
}

// Decide o que fazer agora: { modo: 'evento'|'standby'|'off', dia }.
export function decidirModo(agora, extras) {
  const janela = (dia) => (extras.has(dia) ? JANELA_EXTRA : JANELAS[diaSemana(dia)]) || null;
  const hoje = agora.dia, ontem = somarDias(hoje, -1);
  const jh = janela(hoje), jo = janela(ontem);
  if (jh && agora.min >= jh[0] * 60) return { modo: 'evento', dia: hoje };
  if (jo && agora.min < jo[1] * 60) return { modo: 'evento', dia: ontem };
  if (jh && agora.min >= 14 * 60) return { modo: 'standby', dia: hoje }; // dia de evento, antes da abertura: só venda antecipada mudando
  return { modo: 'off', dia: hoje };
}

async function lerFontes(db, dia) {
  const rows = await db.sel('pt_fontes', { noite: 'eq.' + dia });
  const m = {};
  for (const r of rows || []) m[r.fonte] = r;
  return m;
}

async function gravarFonte(db, dia, fonte, antes, resultado, erro) {
  const agora = new Date().toISOString();
  const linha = { noite: dia, fonte, tentativa_em: agora };
  if (erro) { linha.erro = String(erro).slice(0, 300); linha.dados = (antes && antes.dados) || {}; linha.atualizado_em = (antes && antes.atualizado_em) || null; }
  else { linha.erro = ''; linha.dados = resultado; linha.atualizado_em = agora; }
  await db.ins('pt_fontes', [linha], { upsert: true, conflito: 'noite,fonte' });
}

// Lê uma fonte e guarda. Nunca lança: erro de uma fonte vira "erro" naquela fonte e o dado anterior continua valendo.
async function atualizarFonte(env, db, dia, fonte, antes, hashes) {
  try {
    let r;
    if (fonte === 'sympla') r = await coletarSympla(env, db, dia);
    else if (fonte === 'zig_ingressos') {
      r = await coletarZigIngressos(env, dia);
      // o token da SuperTicket aponta para o evento atual do dia da semana: em noite já passada ele pode devolver "zero". Nunca troca um valor bom por zero.
      if (r.semVendas && antes && antes.dados && antes.dados.ingressos_emitidos > 0) return { ok: true, mantido: true };
    } else if (fonte === 'zig_bar') r = await coletarZigBar(env, dia);
    else if (fonte === 'ugo') {
      r = await coletarUgo(env, db, dia, hashes);
      if (r.aviso_ingressos_sympla && antes && antes.dados) for (const k of SYMPLA_CAMPOS_UGO) if (antes.dados[k] !== undefined) r[k] = antes.dados[k];
    }
    if (r && r.semEvento) { await gravarFonte(db, dia, fonte, antes, r, null); return { ok: true, semEvento: true }; }
    await gravarFonte(db, dia, fonte, antes, r, null);
    return { ok: true };
  } catch (e) {
    await gravarFonte(db, dia, fonte, antes, null, (e && e.message) || e).catch(() => {});
    return { ok: false, erro: (e && e.message) || String(e) };
  }
}

// Junta o que está guardado das 4 fontes e grava o painel da noite (pt_painel).
export async function consolidarNoite(db, dia) {
  const f = await lerFontes(db, dia);
  const d = (n) => (f[n] && f[n].dados) || null;
  const painel = montarConsolidado(dia, d('sympla'), d('zig_ingressos'), d('zig_bar'), d('ugo'));
  const frescor = {};
  for (const n of FONTES) frescor[n] = f[n] ? { atualizado_em: f[n].atualizado_em, tentativa_em: f[n].tentativa_em, erro: f[n].erro || '' } : null;
  painel.fontes = frescor;
  const agora = new Date().toISOString();
  painel.atualizado_em = agora;
  await db.ins('pt_painel', [{ noite: dia, dados: painel, atualizado_em: agora }], { upsert: true, conflito: 'noite' });
  return painel;
}

// Lê as 4 fontes da noite `dia` (em paralelo, cada uma com o seu tempo máximo) e consolida.
// `agoraMs` e `minimo` permitem respeitar o intervalo de 1–2 min da UGO.
export async function coletarNoite(env, db, dia, opcoes) {
  const o = opcoes || {};
  const antes = await lerFontes(db, dia);
  const hashes = antes.sympla && antes.sympla.dados && antes.sympla.dados.hash_emails_pagos
    ? { pagos: antes.sympla.dados.hash_emails_pagos, cortesia: antes.sympla.dados.hash_emails_cortesia } : null;
  const agora = Date.now();
  const pular = (fonte, segundos) => !o.forcar && antes[fonte] && antes[fonte].tentativa_em && (agora - new Date(antes[fonte].tentativa_em).getTime()) < segundos * 1000;

  const quais = o.fontes || FONTES;
  const resultados = {};
  // Leitura forçada: Sympla primeiro, para a UGO cruzar com os e-mails (hash) desta mesma leitura.
  let h = hashes;
  if (o.forcar && quais.includes('sympla')) {
    resultados.sympla = await atualizarFonte(env, db, dia, 'sympla', antes.sympla, null);
    const novo = await lerFontes(db, dia);
    const d = novo.sympla && novo.sympla.dados;
    if (d && d.hash_emails_pagos) h = { pagos: d.hash_emails_pagos, cortesia: d.hash_emails_cortesia };
  }
  return coletarRestante(env, db, dia, antes, quais.filter((n) => !resultados[n]), h, pular, resultados);
}

async function coletarRestante(env, db, dia, antes, quais, hashes, pular, resultados) {
  await Promise.all(quais.map(async (fonte) => {
    if (fonte === 'ugo' && pular('ugo', 100)) { resultados.ugo = { ok: true, pulada: 'intervalo da UGO' }; return; }
    resultados[fonte] = await atualizarFonte(env, db, dia, fonte, antes[fonte], hashes);
  }));
  const painel = await consolidarNoite(db, dia);
  return { painel, resultados };
}

// Chamado pelo agendador a cada minuto.
export async function rodarAgendado(env, db) {
  const agora = agoraBR();
  let extras = new Set();
  try { const r = await db.sel('pt_noites', { select: 'dia', ativa: 'eq.true' }); extras = new Set((r || []).map((x) => x.dia)); } catch (e) { /* sem calendário: só as noites normais */ }
  const dec = decidirModo(agora, extras);
  if (dec.modo === 'off') return { modo: 'off' };
  if (dec.modo === 'standby' && agora.minuto !== 0) return { modo: 'standby', pulou: true }; // standby: 1 leitura por hora

  // trava simples: se a leitura anterior ainda não terminou (menos de 90 s), esta passa a vez
  const chave = 'trava_coleta';
  try {
    const t = await db.sel('pt_config', { select: 'valor', chave: 'eq.' + chave });
    if (t && t[0] && Date.now() - Number(t[0].valor) < 90000) return { modo: dec.modo, pulou: 'leitura anterior em andamento' };
    await db.ins('pt_config', [{ chave, valor: String(Date.now()), atualizado_em: new Date().toISOString() }], { upsert: true, conflito: 'chave' });
  } catch (e) { /* sem trava: segue */ }

  const r = await coletarNoite(env, db, dec.dia, {});
  return { modo: dec.modo, dia: dec.dia, resultados: r.resultados };
}
