// Gravação na planilha antiga (Painel_Consolidado), para o bosque-analise e o resto continuarem lendo de lá.
//  - 6h (fechamento): relê a noite que acabou de fechar, todas as fontes, e grava.
//  - 10h (refaz): Sympla das noites de evento da SEMANA ATUAL (estornos/ajustes), Zig (porta e bar) das 2 mais recentes; grava essas noites.
//    Semanas anteriores nunca são reescritas (a Annie confere toda segunda e edita à mão). Na segunda-feira o refaz não faz nada.
// Só roda se EXPORTAR_URL e EXPORTAR_CHAVE estiverem configuradas na Cloudflare. A linha da noite é substituída, nunca duplicada.
import { coletarNoite, calendarioDb, agoraBR, ehNoiteDeEvento } from './coletor.js';
import { somarDias, diaSemana } from './util.js';

// Noites de evento entre ontem e `nDias` atrás, da mais recente para a mais antiga.
export function noitesAnteriores(hoje, cal, nDias) {
  const r = [];
  for (let i = 1; i <= nDias; i++) { const d = somarDias(hoje, -i); if (ehNoiteDeEvento(d, cal)) r.push(d); }
  return r;
}

// Quais noites o refaz/botão pode reescrever na planilha (a Annie confere toda segunda e depois disso nada da semana anterior muda):
//  - segunda-feira até as 10h: quinta a domingo da semana anterior (4 dias antes); a partir das 10h de segunda: nada;
//  - terça a domingo: só as noites da semana atual (de segunda até ontem).
// `doCron` = a gravação automática das 10h (pode rodar na segunda mesmo com 1–2 minutos de atraso).
export function noitesParaRefazer(hoje, cal, minutoDoDia, doCron) {
  if (diaSemana(hoje) !== 1) return noitesDaSemanaAtual(hoje, cal);
  if (!doCron && minutoDoDia >= 600) return [];
  const r = [];
  for (let i = 1; i <= 4; i++) { const d = somarDias(hoje, -i); if (ehNoiteDeEvento(d, cal)) r.push(d); }
  return r;
}

// Noites de evento da SEMANA ATUAL (de segunda até ontem). Na segunda-feira a lista é vazia: a semana anterior já foi conferida pela Annie e não pode mais ser reescrita.
export function noitesDaSemanaAtual(hoje, cal) {
  const r = [], voltar = (diaSemana(hoje) + 6) % 7; // 0 na segunda, 6 no domingo
  for (let i = 1; i <= voltar; i++) { const d = somarDias(hoje, -i); if (ehNoiteDeEvento(d, cal)) r.push(d); }
  return r;
}

// Campos de valor/saldo: se o painel não tiver o dado (vem 0), NÃO envia, e a planilha mantém o que já estava lá (a coluna fica como está).
const MANTER_SE_ZERO = new Set(['bilheteria_total', 'bilheteria_sympla', 'bilheteria_porta', 'faturamento_bar', 'faturamento_bar_recebido',
  'pessoas_na_casa', 'quantidade_venda_sympla', 'quantidade_venda_porta', 'quantidade_checkin_sympla', 'quantidade_checkin_porta',
  'na_casa_feminino', 'na_casa_masculino', 'valor_vendas_liquido']);
const CHAVES_FORA = new Set(['fontes', 'origem', 'porta_lotes', 'perm']);
function brasilia(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 3600e3); if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}
// Dados do painel → colunas da planilha (mesmos nomes de hoje; os gráficos por hora vão como texto JSON).
export function linhaParaPlanilha(d) {
  const o = {};
  for (const k of Object.keys(d || {})) {
    if (CHAVES_FORA.has(k) || k.startsWith('origem_') || d[k] === undefined || d[k] === null) continue;
    if (MANTER_SE_ZERO.has(k) && (Number(d[k]) === 0 || d[k] === '')) continue; // zerado: mantém a versão que a planilha já tem
    if (k === 'entradas_por_hora' || k === 'consumo_por_hora') o[k] = JSON.stringify(d[k]);
    else if (k === 'atualizado_em') o[k] = brasilia(d[k]);
    else o[k] = d[k];
  }
  return o;
}

// "Conferido nos sistemas": a Annie marca (zig, sympla, bar) e a planilha deixa de receber aquelas colunas dessa noite.
const COLUNAS_SISTEMA = {
  sympla: (k) => k.includes('sympla') || k.startsWith('falta_entrar_antecipado'),
  zig: (k) => k.includes('porta'),
  bar: (k) => k.startsWith('faturamento_bar') || k.startsWith('consumo')
};
const TOTAIS_JUNTOS = new Set(['bilheteria_total', 'pessoas_na_casa', 'na_casa_feminino', 'na_casa_masculino', 'cortesias_total', 'entradas_por_hora']);
export async function lerConferido(db, dia) {
  try { const g = await db.sel('pt_config', { select: 'valor', chave: 'eq.conferido_' + dia }); return g && g[0] && g[0].valor ? JSON.parse(g[0].valor) : {}; } catch (e) { return {}; }
}
export function aplicarConferido(linha, conf) {
  const marcados = Object.keys(COLUNAS_SISTEMA).filter((s) => conf && conf[s]);
  if (!marcados.length) return linha;
  const o = {};
  for (const k of Object.keys(linha)) {
    if (k === 'data' || k === 'evento') { o[k] = linha[k]; continue; }
    if (marcados.some((s) => COLUNAS_SISTEMA[s](k)) || TOTAIS_JUNTOS.has(k)) continue; // conferido: não mexe (os totais juntos também, porque dependem dos três)
    o[k] = linha[k];
  }
  return o;
}

export function exportarConfigurado(env) { return !!(env.EXPORTAR_URL && env.EXPORTAR_CHAVE); }

export async function enviarParaPlanilha(env, db, dias) {
  if (!exportarConfigurado(env)) return { ok: false, erro: 'Falta configurar EXPORTAR_URL e EXPORTAR_CHAVE na Cloudflare.' };
  const noites = [], ignoradasConf = [];
  for (const dia of dias) {
    const r = await db.sel('pt_painel', { select: 'dados', noite: 'eq.' + dia });
    const conf = await lerConferido(db, dia);
    if (conf.zig && conf.sympla && conf.bar) { ignoradasConf.push(dia); continue; } // noite conferida: a planilha não recebe mais nada dela
    if (r && r[0] && r[0].dados) noites.push(aplicarConferido(linhaParaPlanilha(r[0].dados), conf));
  }
  if (!noites.length) return { ok: true, gravadas: [], aviso: ignoradasConf.length ? 'noites conferidas, nada enviado: ' + ignoradasConf.join(', ') : 'nenhuma noite com painel guardado' };
  let resp, texto;
  try {
    resp = await fetch(env.EXPORTAR_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ chave: env.EXPORTAR_CHAVE, noites }), redirect: 'follow' });
    texto = await resp.text();
  } catch (e) { return { ok: false, erro: 'não consegui falar com o Apps Script: ' + ((e && e.message) || e) }; }
  let j; try { j = JSON.parse(texto); } catch (e) { return { ok: false, erro: 'o Apps Script não respondeu como esperado (confira se a implantação está como "Qualquer pessoa" e se foi publicada uma nova versão). Status ' + resp.status }; }
  return j;
}

async function guardarStatus(db, modo, resultado) {
  try { await db.ins('pt_config', [{ chave: 'exportar_status', valor: JSON.stringify({ em: new Date().toISOString(), modo, resultado }).slice(0, 4000), atualizado_em: new Date().toISOString() }], { upsert: true, conflito: 'chave' }); } catch (e) { /* sem status */ }
}

export async function rodarExportacao(env, db, modo) {
  if (!exportarConfigurado(env)) return { pulou: 'exportação não configurada' };
  const hoje = agoraBR().dia, cal = await calendarioDb(db);
  const resumo = { modo, leituras: {} };
  let dias;
  if (modo === 'fechamento') {
    dias = noitesAnteriores(hoje, cal, 1);
    for (const d of dias) { try { await coletarNoite(env, db, d, { forcar: true }); resumo.leituras[d] = 'ok'; } catch (e) { resumo.leituras[d] = String((e && e.message) || e).slice(0, 120); } }
  } else {
    dias = noitesParaRefazer(hoje, cal, agoraBR().min, true);
    if (!dias.length) { resumo.pulou = 'nenhuma noite a refazer hoje (semana anterior já conferida)'; await guardarStatus(db, modo, resumo); return resumo; }
    const duas = new Set(dias.slice(0, 2));
    for (const d of dias) {
      const conf = await lerConferido(db, d);
      const fontes = (duas.has(d) ? ['sympla', 'zig_ingressos', 'zig_bar'] : ['sympla']).filter((f) => !(f === 'sympla' && conf.sympla) && !(f === 'zig_ingressos' && conf.zig) && !(f === 'zig_bar' && conf.bar));
      if (!fontes.length) { resumo.leituras[d] = 'conferido: não relido'; continue; }
      try { await coletarNoite(env, db, d, { forcar: true, fontes }); resumo.leituras[d] = fontes.join('+'); } catch (e) { resumo.leituras[d] = String((e && e.message) || e).slice(0, 120); }
    }
  }
  resumo.envio = await enviarParaPlanilha(env, db, dias);
  await guardarStatus(db, modo, resumo);
  return resumo;
}
