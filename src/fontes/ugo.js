// Fonte: UGO (listas e cortesias; check-in da porta dos ingressos Sympla). Porta do ugo_cortesia_lista.gs.
// Regras que vêm do painel atual:
//  - Cortesia de lista = convite com origin "lista", courtesy true e inviteStatus APPROVED. "Entrou" = checkInAt preenchido.
//  - Mesma pessoa repetida (mesmo nome + mesma hora de entrada) conta uma vez. Lista paga NÃO entra aqui (já vem pela Zig).
//  - Gênero SEMPRE pelo primeiro nome (não pelo cadastro da UGO nem pelo nome da lista).
//  - Entradas de quem comprou na Sympla: cruza os ingressos da UGO (check-in da porta) com os e-mails dos compradores da Sympla.
//    Aqui o cruzamento é por HASH do e-mail (SHA-256); e-mail e nome nunca são guardados nem aparecem em resposta ou log.
//  - A UGO pede intervalo de 1 a 2 minutos na noite em andamento (o agendador respeita isso).
import { buscarJson, sha256, horaDaNoite } from '../util.js';

const BASE = 'https://partner.ugopass.com.br';

/* ===================== GÊNERO PELO PRIMEIRO NOME ===================== */
const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function primeiroNome(nome) {
  const t = norm(nome).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return t.length ? t[0] : '';
}
const FEM = new Set(('abril astrid avril azul carmem carmen carol ellen ester esther evelyn felicitas felizitas helin ines ingrid ingryd ' +
  'irati isabel isabelli jade jhenifer jenifer jennifer josy katrin leonor lilian lillyan lucy maite manyfe matilde ' +
  'melani miren miryam monique nicoli nikole paz raquel rachel beatriz elizabeth liz ruth iris isis doris mel nicole ' +
  'socorro consuelo stephanni sydney vivian yasmin zenab abigail miriam mirian thais lais luz maribel lua').split(' '));
const MASC = new Set(('luca mattia gael joshua jonas elias felipe jorge andre guilherme alexandre henrique wallace maurice dante jose davi ' +
  'enrique eugene gabriele michele nikita ramiro bruce tiago thiago vinicius lucas matias mathias tomas tomaz jesus ' +
  'moises johnny jhony anthony henry harley rene weslley wesley noah elijah micah dennys denys luis luiz denis dennis ' +
  'alex felix nelson wayne ney sasha kaue kaike kayke igor ivan').split(' '));

// 'F' | 'M' | '' (quando não dá para saber, ex.: "Convidado importado")
export function classificarGeneroPorNome(nome) {
  const p = primeiroNome(nome);
  if (!p || p === 'convidado' || p === 'importado') return '';
  if (FEM.has(p)) return 'F';
  if (MASC.has(p)) return 'M';
  if (/(a|ah)$/.test(p)) return 'F';
  if (/(elle|ele|ane|ine|ice|ise|yse|ie|ly|lly|ny|ley|th|iz)$/.test(p)) return 'F';
  if (/(ne|le|ce|se)$/.test(p)) return 'F';
  return 'M';
}

/* ===================== CONTAGENS (funções puras) ===================== */
export function contarCortesiaLista(convites, dia) {
  const r = { emitidas: 0, validadas: 0, validadas_f: 0, validadas_m: 0, validadas_sem_genero: 0, lista_convidados: 0, lista_entraram: 0, lista_pagantes_entraram: 0, horas_lista: {}, origens_entradas: {} };
  const vistos = new Set();
  for (const c of convites || []) {
    if (String(c.inviteStatus || '').toUpperCase() !== 'APPROVED') continue;
    const origem = String(c.origin || '').toLowerCase();
    const entrou = !!c.checkInAt;
    if (entrou) r.origens_entradas[origem] = (r.origens_entradas[origem] || 0) + 1;
    if (origem === 'lista') { r.lista_convidados++; if (entrou) r.lista_entraram++; }
    if (origem === 'lista' && c.courtesy !== true && entrou) r.lista_pagantes_entraram++;
    if (origem === 'lista' && c.courtesy === true) {
      r.emitidas++;
      if (!entrou) continue;
      const chave = 'L|' + norm(c.name) + '|' + c.checkInAt;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      r.validadas++;
      const h = horaDaNoite(c.checkInAt, dia);
      if (h) r.horas_lista[h] = (r.horas_lista[h] || 0) + 1;
      const g = classificarGeneroPorNome(c.name);
      if (g === 'F') r.validadas_f++; else if (g === 'M') r.validadas_m++; else r.validadas_sem_genero++;
    }
  }
  return r;
}

// Ingressos da UGO COM check-in cujo e-mail (em hash) é de comprador da Sympla. Pago tem prioridade se o e-mail estiver nos dois.
export async function contarSymplaPorHash(ingressos, hashPagos, hashCortesia, dia) {
  const r = { sympla_entradas: 0, sympla_entradas_f: 0, sympla_entradas_m: 0, sympla_entradas_sem_genero: 0,
    sympla_ingressos_total: 0, sympla_cortesia_entradas: 0, sympla_cortesia_f: 0, sympla_cortesia_m: 0, sympla_cortesia_sem_genero: 0, horas_sympla: {} };
  const pagos = new Set(hashPagos || []), cort = new Set(hashCortesia || []);
  for (const t of ingressos || []) {
    const e = String(t.accountEmail || '').trim().toLowerCase();
    if (!e) continue;
    const h = await sha256(e);
    const ePago = pagos.has(h), eCort = cort.has(h);
    if (ePago) r.sympla_ingressos_total++; // todos os ingressos da UGO de compradores da Sympla (entrando ou não): serve para conferir o total vendido
    if (!t.checkin || !t.checkin.length) continue;
    if (!ePago && !eCort) continue;
    const g = classificarGeneroPorNome(t.name);
    const primeira = t.checkin.map((c) => String(c.registerAt || '')).filter(Boolean).sort()[0];
    const hora = horaDaNoite(primeira, dia);
    if (hora) r.horas_sympla[hora] = (r.horas_sympla[hora] || 0) + 1;
    if (ePago) { r.sympla_entradas++; if (g === 'F') r.sympla_entradas_f++; else if (g === 'M') r.sympla_entradas_m++; else r.sympla_entradas_sem_genero++; }
    else { r.sympla_cortesia_entradas++; if (g === 'F') r.sympla_cortesia_f++; else if (g === 'M') r.sympla_cortesia_m++; else r.sympla_cortesia_sem_genero++; }
  }
  return r;
}

/* ===================== CHAMADAS À API ===================== */
async function get(env, caminho) {
  let ultimo = '';
  for (let i = 0; i < 2; i++) { // 2 tentativas em falha temporária
    try { return await buscarJson(BASE + caminho, { headers: { ClientB2B: env.UGO_CLIENT_B2B } }, 20000); }
    catch (e) {
      if (e.status === 401 || e.status === 404) throw e;
      ultimo = e.message;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
  throw new Error('UGO falhou após 2 tentativas: ' + ultimo);
}

async function uidDaSessao(env, db, dia) {
  const chave = 'ugo_sessao_' + dia;
  const g = await db.sel('pt_config', { select: 'valor', chave: 'eq.' + chave });
  if (g && g[0] && g[0].valor) return g[0].valor;
  let pagina = 1, total = 1;
  while (pagina <= total && pagina <= 10) {
    const j = await get(env, '/api/v1/event?page=' + pagina + '&page_size=50');
    total = (j.pagination && j.pagination.page_count) || 1;
    const lista = j.data || [];
    const achada = lista.find((s) => String(s.startDateTimeEvent || '').substring(0, 10) === dia);
    if (achada) {
      await db.ins('pt_config', [{ chave, valor: String(achada.uid), atualizado_em: new Date().toISOString() }], { upsert: true, conflito: 'chave' });
      return String(achada.uid);
    }
    const datas = lista.map((s) => String(s.startDateTimeEvent || '').substring(0, 10)).filter(Boolean);
    if (datas.length && datas.every((d) => d < dia)) break; // sessões vêm da mais recente para a mais antiga
    pagina++;
  }
  return null;
}

// hashes: { pagos: [...], cortesia: [...] } (e-mails da Sympla já em hash). Devolve só contagens.
export async function coletarUgo(env, db, dia, hashes) {
  if (!env.UGO_CLIENT_B2B) throw new Error('falta a variável UGO_CLIENT_B2B');
  const uid = await uidDaSessao(env, db, dia);
  if (!uid) return { semSessao: true, dia };
  const j = await get(env, '/api/v1/ticket/event/' + uid + '/invites-report');
  const r = contarCortesiaLista(j.data || [], dia);
  const temHash = hashes && ((hashes.pagos || []).length || (hashes.cortesia || []).length);
  if (temHash) {
    try {
      const ing = await get(env, '/api/v1/ticket/event/' + uid);
      Object.assign(r, await contarSymplaPorHash(ing.data || [], hashes.pagos, hashes.cortesia, dia));
      r.ugo_ingressos_api = (ing.data || []).length;
      try { // diagnóstico sem dados pessoais: campos do ingresso e contagem por valor (só campos com poucos valores diferentes)
        const arr = ing.data || [], cont = {}, campos = new Set();
        const pagos = new Set(hashes.pagos || []);
        for (const t of arr) {
          const e = String(t.accountEmail || '').trim().toLowerCase();
          const casa = e && pagos.has(await sha256(e));
          for (const k of Object.keys(t)) {
            campos.add(k);
            const v = t[k];
            if (v === null || typeof v === 'object' || (typeof v === 'string' && v.length > 25) || /mail|name|phone|cpf|document|uid|id$/i.test(k)) continue;
            const c = (cont[k] = cont[k] || {}); const kk = String(v);
            if (Object.keys(c).length > 8 && !(kk in c)) { c._muitos = 1; continue; }
            c[kk] = c[kk] || { todos: 0, casados: 0 }; c[kk].todos++; if (casa) c[kk].casados++;
          }
        }
        for (const k of Object.keys(cont)) if (cont[k]._muitos) delete cont[k];
        r.ugo_campos_ingresso = [...campos]; r.ugo_valores_ingresso = cont;
      } catch (e) { r.ugo_valores_ingresso = { erro: e.message }; } // diagnóstico: total de ingressos que a UGO devolve (sem cruzar e-mail)
    } catch (e) { r.aviso_ingressos_sympla = 'UGO (ingressos Sympla) falhou: ' + e.message + ' — manter o último valor guardado'; }
  }
  return r;
}
