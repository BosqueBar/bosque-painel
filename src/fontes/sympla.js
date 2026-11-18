// Fonte: Sympla (venda antecipada). Porta do painel atual (buscarEventosSympla_ / buscarDetalheSympla_ / buscarValorPedidosSympla_).
// Regras que vêm do painel atual e foram conferidas em noites reais:
//  - Participantes: só pedidos APPROVED contam. Gênero pelo nome do ingresso (feminin/masculin); formulário "Gênero" só de reserva.
//  - Cortesia = ingresso de preço 0 ou com "cortesia" no nome. Check-in e "falta entrar" NÃO incluem cortesia.
//  - VALOR: vem dos PEDIDOS (soma de order_total_net_value dos APPROVED). A rota de participantes deixa de listar alguns
//    ingressos pagos que não entraram (05/11: R$ 1.580); os pedidos batem com o "Total a receber" do portal (R$ 52.540).
//  - E-mails dos compradores só servem para cruzar com a UGO; aqui ficam apenas como HASH (nunca em texto).
import { buscarJson, sha256 } from '../util.js';

const BASE = 'https://api.sympla.com.br/public/v1.5.1';
const BASE160 = 'https://api.sympla.com.br/public/v1.6.0';
const CAMPO_GENERO = 'Gênero';

// Lista os eventos da Sympla que começam em `dia` (para a Annie escolher quais somar).
export async function eventosDaData(token, dia) {
  const r = []; let pagina = 1;
  while (pagina <= 50) {
    const j = await buscarJson(BASE + '/events?page=' + pagina, { headers: { s_token: token } }, 20000);
    const dados = j.data || [];
    for (const e of dados) if (String(e.start_date || '').substring(0, 10) === dia) r.push({ id: String(e.id), nome: String(e.name || ''), inicio: String(e.start_date || '') });
    if (!(j.pagination && j.pagination.has_next) || !dados.length) break;
    pagina++;
  }
  return r;
}
// Ids guardados para a noite (um ou vários, separados por vírgula).
export async function idsGuardados(db, dia) {
  const g = await db.sel('pt_config', { select: 'valor', chave: 'eq.sympla_evento_' + dia });
  return g && g[0] && g[0].valor ? String(g[0].valor).split(',').map((x) => x.trim()).filter(Boolean) : [];
}

async function achaEventoId(db, token, dia) {
  const chave = 'sympla_evento_' + dia;
  const guardado = await db.sel('pt_config', { select: 'valor', chave: 'eq.' + chave });
  if (guardado && guardado[0] && guardado[0].valor) return guardado[0].valor;
  let pagina = 1;
  while (pagina <= 50) {
    const j = await buscarJson(BASE + '/events?page=' + pagina, { headers: { s_token: token } }, 20000);
    const dados = j.data || [];
    const achado = dados.find((e) => String(e.start_date || '').substring(0, 10) === dia);
    if (achado) {
      await db.ins('pt_config', [{ chave, valor: String(achado.id), atualizado_em: new Date().toISOString() }], { upsert: true, conflito: 'chave' });
      return String(achado.id);
    }
    if (!(j.pagination && j.pagination.has_next) || !dados.length) break;
    pagina++;
  }
  return null;
}

// Lê TODAS as páginas até vir uma vazia (não confia no total de páginas que a Sympla informa: ele pode vir menor que o real).
// Pede 200 por página e tira repetidos pelo id.
async function todasPaginas(url, token, info, v160) {
  const todos = [], vistos = new Set();
  let pagina = 1, ultimaMarca = '', cursor = '';
  while (pagina <= 200) {
    const tam = v160 ? 500 : 200;
    const q = cursor ? '?cursor=' + encodeURIComponent(cursor) + '&page_size=' + tam : (v160 ? '?page_size=' + tam : '?page=' + pagina + '&page_size=' + tam);
    const j = await buscarJson(url + q, { headers: { s_token: token } }, 25000);
    if (info && pagina === 1) info.paginacao = Object.keys(j.pagination || {}); // só os NOMES dos campos de paginação (diagnóstico)
    const d = j.data || [];
    if (d.length === 0) break;
    const marca = JSON.stringify(d[0]) + '|' + d.length;
    if (marca === ultimaMarca) break; // a página veio igual à anterior: a Sympla está repetindo, acabou
    ultimaMarca = marca;
    let novos = 0;
    for (const x of d) {
      const k = x && x.id !== undefined && x.id !== null ? String(x.id) : null;
      if (k !== null) { if (vistos.has(k)) continue; vistos.add(k); }
      todos.push(x); novos++;
    }
    if (novos === 0) break;
    const prox = j.pagination && (j.pagination.next_cursor || j.pagination.nextCursor);
    if (prox) { cursor = String(prox); if (info) info.usouCursor = true; } else if (cursor || v160) break; // acabou o cursor (v1.6.0 só pagina por cursor)
    pagina++;
  }
  return todos;
}

// Devolve os números da noite `dia` (YYYY-MM-DD) ou { semEvento: true }.
export async function coletarSympla(env, db, dia) {
  const token = env.SYMPLA_TOKEN;
  if (!token) throw new Error('falta a variável SYMPLA_TOKEN');
  const achado = await achaEventoId(db, token, dia);
  if (!achado) return { semEvento: true, dia };
  const ids = String(achado).split(',').map((x) => x.trim()).filter(Boolean); // uma noite pode ter mais de um evento na Sympla: soma todos
  const eventId = ids.join(',');

  // participantes e pedidos (de todos os eventos da noite) ao mesmo tempo
  let todosPart = [], pedidos = [];
  const infoPag = {};
  for (const id of ids) {
    const [pp, oo] = await Promise.all([
      // PARTICIPANTES pela v1.6.0: a v1.5.1 deixa de listar ~45% dos ingressos de alguns eventos (19/11: 167 contra 312). A v1.6.0 bate com o borderô.
      todasPaginas(BASE160 + '/events/' + id + '/participants', token, infoPag, true).catch(() => { infoPag.caiuParaV151 = true; return todasPaginas(BASE + '/events/' + id + '/participants', token, infoPag); }),
      todasPaginas(BASE + '/events/' + id + '/orders', token).catch((e) => { return { erro: e.message }; })
    ]);
    todosPart = todosPart.concat(pp);
    if (Array.isArray(pedidos) && Array.isArray(oo)) pedidos = pedidos.concat(oo); else pedidos = Array.isArray(oo) ? pedidos : oo;
  }

  const naoAprovados = {};
  todosPart.forEach((p) => { if (p.order_status !== 'APPROVED') { const s = p.order_status || '(vazio)'; naoAprovados[s] = (naoAprovados[s] || 0) + 1; } });
  const part = todosPart.filter((p) => p.order_status === 'APPROVED');

  let checkinRealizados = 0, checkinRestantes = 0, cortesias = 0;
  let cortesiaValidada = 0, cortesiaValidadaF = 0, cortesiaValidadaM = 0;
  let qtdF = 0, qtdM = 0, qtdFPago = 0, qtdMPago = 0, faltaF = 0, faltaM = 0;
  let valorParticipantes = 0;
  const hashPagos = [], hashCortesia = [], hashSemLista = [];
  let mediaIngPedido = 0, idsPedidos = [];
  const numerosIng = part.map((p) => String(p.ticket_number || p.id || '')).filter(Boolean);
  const lotesAnt = {}; // por nome do ingresso: vendidos, entraram (check-in pela API) e valor

  for (const p of part) {
    const fezCheckin = !!(p.checkin && p.checkin.check_in);
    const eCortesia = Number(p.ticket_sale_price) === 0 || (p.ticket_name && String(p.ticket_name).toLowerCase().includes('cortesia'));
    const email = String(p.email || '').trim().toLowerCase();
    if (email) (eCortesia ? hashCortesia : hashPagos).push(await sha256(email));

    if (eCortesia) { if (fezCheckin) cortesiaValidada++; }
    else if (fezCheckin) checkinRealizados++; else checkinRestantes++;

    const nome = String(p.ticket_name || '').toLowerCase();
    let g = null;
    if (nome.includes('feminin')) g = 'feminino';
    else if (nome.includes('masculin')) g = 'masculino';
    else { const f = (p.custom_form || []).find((x) => x.name === CAMPO_GENERO); g = f ? String(f.value).toLowerCase() : null; }

    if (g && g.startsWith('f')) {
      qtdF++;
      if (eCortesia) { if (fezCheckin) cortesiaValidadaF++; } else { qtdFPago++; if (!fezCheckin) faltaF++; }
    } else if (g && g.startsWith('m')) {
      qtdM++;
      if (eCortesia) { if (fezCheckin) cortesiaValidadaM++; } else { qtdMPago++; if (!fezCheckin) faltaM++; }
    }
    if (eCortesia) cortesias++;
    else { // ingresso pago: soma por nome do lote/ingresso
      const nl = String(p.ticket_name || 'Sem nome').trim() || 'Sem nome';
      const l = lotesAnt[nl] || (lotesAnt[nl] = { lote: nl, vendidos: 0, entraram: 0, valor: 0 });
      l.vendidos++; if (fezCheckin) l.entraram++; l.valor += (Number(p.ticket_sale_price) || 0) - (Number(p.order_discount) || 0);
    }
    valorParticipantes += (Number(p.ticket_sale_price) || 0) - (Number(p.order_discount) || 0);
  }

  // valor: pelos pedidos (completo); se a rota de pedidos falhar, usa a soma dos participantes e avisa
  let valorLiquido = valorParticipantes, valorOrigem = 'participantes', aviso = '';
  if (Array.isArray(pedidos) && pedidos.length) {
    valorLiquido = pedidos.filter((o) => o.order_status === 'APPROVED').reduce((s, o) => s + (Number(o.order_total_net_value) || 0), 0);
    valorOrigem = 'pedidos';
    if (Math.abs(valorLiquido - valorParticipantes) > 0.5) aviso = 'participantes deixaram de fora R$ ' + (valorLiquido - valorParticipantes).toFixed(2) + '; usado o valor dos pedidos';
  } else if (pedidos && pedidos.erro) aviso = 'pedidos indisponíveis (' + pedidos.erro + '); valor pela soma dos participantes';

  // diagnóstico: o que os pedidos trazem (só NOMES dos campos e contagens, nunca dados de pessoas)
  let pedidosCampos = null, ingressosNosPedidos = null;
  if (Array.isArray(pedidos) && pedidos.length) {
    pedidosCampos = Object.keys(pedidos[0]).slice(0, 40);
    const q = (o) => Array.isArray(o.tickets) ? o.tickets.length : (Number(o.ticket_quantity) || Number(o.order_total_quantity) || Number(o.quantity) || Number(o.total_tickets) || null);
    if (pedidos.every((o) => q(o) !== null)) ingressosNosPedidos = pedidos.filter((o) => o.order_status === 'APPROVED').reduce((a, o) => a + q(o), 0);
  }
  // diagnóstico dos pedidos que NÃO aparecem na lista de participantes (só contagens e datas, nada de pessoas)
  let faltantes = null, estimadosSemLista = 0;
  if (Array.isArray(pedidos) && pedidos.length) {
    const comPart = new Set(todosPart.map((p) => String(p.order_id !== undefined ? p.order_id : '')));
    const aprov = pedidos.filter((o) => o.order_status === 'APPROVED');
    idsPedidos = aprov.map((o) => String(o.id));
    const falta = aprov.filter((o) => !comPart.has(String(o.id)));
    const porTipo = {}; let minD = '', maxD = '', valorFalta = 0;
    for (const o of falta) {
      const t = String(o.transaction_type || '(vazio)'); porTipo[t] = (porTipo[t] || 0) + 1;
      const d = String(o.approved_date || o.order_date || ''); if (d && (!minD || d < minD)) minD = d; if (d && d > maxD) maxD = d;
      valorFalta += Number(o.order_total_net_value) || 0;
    }
    // quem comprou nesses pedidos também precisa ser reconhecido na catraca (cruzamento por e-mail com a UGO)
    const ja = new Set(hashPagos);
    for (const o of falta) {
      const em = String(o.buyer_email || '').trim().toLowerCase();
      if (!em) { hashSemLista.push(''); continue; }
      const h = await sha256(em);
      hashSemLista.push(h); // um por pedido (pode repetir): serve para ver quais pedidos a UGO ainda não recebeu
      if (!ja.has(h)) { ja.add(h); hashPagos.push(h); }
    }
    // estimativa dos ingressos desses pedidos: média de ingressos por pedido entre os pedidos que TÊM lista
    const pedidosComLista = aprov.length - falta.length;
    const pagosLista = part.filter((p) => !(Number(p.ticket_sale_price) === 0 || (p.ticket_name && String(p.ticket_name).toLowerCase().includes('cortesia')))).length;
    mediaIngPedido = pedidosComLista > 0 ? pagosLista / pedidosComLista : 0;
    estimadosSemLista = pedidosComLista > 0 ? Math.round(falta.length * (pagosLista / pedidosComLista)) : 0;
    // testes de rota alternativa para os pedidos sem participante (só contagens; nunca e-mails nem nomes)
    const amostra = {};
    const tenta = async (nome, caminho) => {
      try { const x = await buscarJson(BASE + caminho, { headers: { s_token: token } }, 15000); amostra[nome] = (x.data || []).length; }
      catch (e) { amostra[nome] = 'erro: ' + String((e && e.message) || e).slice(0, 60); }
    };
    if (falta.length) {
      const o1 = falta[0], o2 = falta[falta.length - 1];
      await tenta('pedido_primeiro', '/events/' + ids[0] + '/orders/' + o1.id + '/participants');
      await tenta('pedido_primeiro_incluindo_cancelados', '/events/' + ids[0] + '/orders/' + o1.id + '/participants?cancelled_filter=include');
      await tenta('pedido_ultimo', '/events/' + ids[0] + '/orders/' + o2.id + '/participants');
      await tenta('busca_por_email_primeiro', '/events/' + ids[0] + '/participants?participant_email=' + encodeURIComponent(String(o1.buyer_email || '')));
      await tenta('busca_por_email_ultimo', '/events/' + ids[0] + '/participants?participant_email=' + encodeURIComponent(String(o2.buyer_email || '')));
      await tenta('lista_incluindo_cancelados', '/events/' + ids[0] + '/participants?cancelled_filter=include&page_size=500');
    }
    const porDia = {}; for (const o of falta) { const d = String(o.approved_date || o.order_date || '').substring(0, 10); if (d) porDia[d] = (porDia[d] || 0) + 1; }
    const comPartPorDia = {}; for (const o of aprov) { if (comPart.has(String(o.id))) { const d = String(o.approved_date || o.order_date || '').substring(0, 10); if (d) comPartPorDia[d] = (comPartPorDia[d] || 0) + 1; } }
    const ultimoComLista = Object.keys(comPartPorDia).sort().pop() || '';
    faltantes = { pedidos_aprovados: aprov.length, pedidos_sem_participante: falta.length, valor_sem_participante: Math.round(valorFalta * 100) / 100, por_tipo: porTipo, de: minD, ate: maxD, testes_rotas: amostra, sem_lista_por_dia: porDia, ultimo_dia_com_lista: ultimoComLista, participantes_com_order_id: todosPart.filter((p) => p.order_id !== undefined).length };
  }
  const totalGenero = qtdF + qtdM;
  return {
    evento_id: eventId, eventos: ids.length, data: dia,
    valor_vendas_liquido: Math.round(valorLiquido * 100) / 100, valor_origem: valorOrigem, aviso,
    quantidade_venda_sympla: part.length, participantes_brutos: todosPart.length, pedidos_na_api: Array.isArray(pedidos) ? pedidos.length : null, pedidos_campos: pedidosCampos, paginacao_participantes: infoPag, faltantes, ingressos_nos_pedidos: ingressosNosPedidos, status_nao_aprovados: naoAprovados,
    checkin_realizados: checkinRealizados, checkin_restantes: checkinRestantes,
    cortesia_validada: cortesiaValidada, cortesia_validada_feminino: cortesiaValidadaF, cortesia_validada_masculino: cortesiaValidadaM,
    falta_entrar_feminino: faltaF, falta_entrar_masculino: faltaM,
    pct_feminino: totalGenero ? Math.round((qtdF / totalGenero) * 100) : null,
    pct_masculino: totalGenero ? Math.round((qtdM / totalGenero) * 100) : null,
    qtd_feminino: qtdF, qtd_masculino: qtdM, qtd_feminino_pago: qtdFPago, qtd_masculino_pago: qtdMPago,
    antecipado_lotes: Object.values(lotesAnt).map((l) => ({ lote: l.lote, vendidos: l.vendidos, entraram: l.entraram, valor: Math.round(l.valor * 100) / 100 })).sort((a, b) => b.vendidos - a.vendidos).slice(0, 12),
    cortesias, pedidos_nao_aprovados: Object.values(naoAprovados).reduce((a, b) => a + b, 0),
    ingressos_estimados_sem_lista: estimadosSemLista, hash_emails_pagos: hashPagos, hash_emails_cortesia: hashCortesia, hash_pedidos_sem_lista: hashSemLista, ids_pedidos: idsPedidos, ids_ingressos: numerosIng, media_ingressos_pedido: mediaIngPedido
  };
}

// ===== VARREDURA (diagnóstico para o admin): só contagens, nunca nomes nem e-mails =====
// Compara as formas de ler a Sympla para o MESMO evento: versões 1.5.1 e 1.6.0, com e sem cancelados, e a paginação.
export async function varreduraSympla(token, ids) {
  const saida = {};
  for (const id of ids) {
    const g = (v, caminho) => buscarJson('https://api.sympla.com.br/public/' + v + '/events/' + id + caminho, { headers: { s_token: token } }, 25000);
    const r = {};
    const contar = async (v, filtro) => {
      const o = { total: 0, pedidos_distintos: 0, ticket_status: {}, order_status: {}, paginas: 0 };
      const ordens = new Set(); let cursor = '', pag = 1;
      try {
        for (let i = 0; i < 80; i++) {
          const ps = v === 'v1.6.0' ? 500 : 200;
          const q = '?' + (cursor ? 'cursor=' + encodeURIComponent(cursor) : 'page=' + pag) + '&page_size=' + ps + (filtro ? '&' + filtro : '');
          const j = await g(v, '/participants' + q), d = j.data || [];
          if (i === 0) o.meta_pagina_1 = Object.fromEntries(Object.entries(j.pagination || {}).filter(([k, x]) => typeof x === 'number' || typeof x === 'boolean'));
          if (!d.length) break;
          o.paginas++; o.total += d.length;
          for (const p of d) { const a = String(p.ticket_status || '(vazio)'), b = String(p.order_status || '(vazio)'); o.ticket_status[a] = (o.ticket_status[a] || 0) + 1; o.order_status[b] = (o.order_status[b] || 0) + 1; ordens.add(String(p.order_id)); }
          const prox = j.pagination && j.pagination.next_cursor;
          if (prox) cursor = String(prox); else { cursor = ''; pag++; if (v === 'v1.6.0' && !(j.pagination && j.pagination.has_next)) break; }
        }
      } catch (e) { o.erro = String((e && e.message) || e).slice(0, 100); }
      o.pedidos_distintos = ordens.size;
      return o;
    };
    r.p_v3 = await contar('v3', '');
    r.p_v3_cancelados = await contar('v3', 'cancelled_filter=include');
    r.p151 = await contar('v1.5.1', '');
    r.p151_cancelados = await contar('v1.5.1', 'cancelled_filter=include');
    r.p160 = await contar('v1.6.0', '');
    r.p160_cancelados = await contar('v1.6.0', 'cancelled_filter=include');
    r.p160_so_cancelados = await contar('v1.6.0', 'cancelled_filter=only');
    // pedidos (valor e quantidade por status) nas duas versões
    for (const v of ['v3', 'v1.5.1', 'v1.6.0']) {
      const o = { total: 0, por_status: {}, valor_aprovado: 0 };
      try {
        let pag = 1, cursor = '';
        for (let i = 0; i < 80; i++) {
          const j = await g(v, '/orders?' + (cursor ? 'cursor=' + encodeURIComponent(cursor) : 'page=' + pag) + '&page_size=200'), d = j.data || [];
          if (!d.length) break;
          o.total += d.length;
          for (const x of d) { const s = String(x.order_status || '(vazio)'); o.por_status[s] = (o.por_status[s] || 0) + 1; if (s === 'APPROVED' || s === 'A') o.valor_aprovado += Number(x.order_total_net_value) || 0; }
          const prox = j.pagination && j.pagination.next_cursor; if (prox) cursor = String(prox); else { cursor = ''; pag++; }
        }
      } catch (e) { o.erro = String((e && e.message) || e).slice(0, 100); }
      o.valor_aprovado = Math.round(o.valor_aprovado * 100) / 100;
      r['pedidos_' + v.replace(/\./g, '')] = o;
    }
    saida[id] = r;
  }
  return saida;
}
