// Fonte: Sympla (venda antecipada). Porta do painel atual (buscarEventosSympla_ / buscarDetalheSympla_ / buscarValorPedidosSympla_).
// Regras que vêm do painel atual e foram conferidas em noites reais:
//  - Participantes: só pedidos APPROVED contam. Gênero pelo nome do ingresso (feminin/masculin); formulário "Gênero" só de reserva.
//  - Cortesia = ingresso de preço 0 ou com "cortesia" no nome. Check-in e "falta entrar" NÃO incluem cortesia.
//  - VALOR: vem dos PEDIDOS (soma de order_total_net_value dos APPROVED). A rota de participantes deixa de listar alguns
//    ingressos pagos que não entraram (05/11: R$ 1.580); os pedidos batem com o "Total a receber" do portal (R$ 52.540).
//  - E-mails dos compradores só servem para cruzar com a UGO; aqui ficam apenas como HASH (nunca em texto).
import { buscarJson, sha256 } from '../util.js';

const BASE = 'https://api.sympla.com.br/public/v1.5.1';
const CAMPO_GENERO = 'Gênero';

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

async function todasPaginas(url, token) {
  let todos = [], pagina = 1, temMais = true;
  while (temMais && pagina <= 100) {
    const j = await buscarJson(url + '?page=' + pagina, { headers: { s_token: token } }, 25000);
    const d = j.data || [];
    todos = todos.concat(d);
    temMais = d.length > 0 && j.pagination && pagina < j.pagination.total_page;
    pagina++;
  }
  return todos;
}

// Devolve os números da noite `dia` (YYYY-MM-DD) ou { semEvento: true }.
export async function coletarSympla(env, db, dia) {
  const token = env.SYMPLA_TOKEN;
  if (!token) throw new Error('falta a variável SYMPLA_TOKEN');
  const eventId = await achaEventoId(db, token, dia);
  if (!eventId) return { semEvento: true, dia };

  // participantes e pedidos ao mesmo tempo
  const [todosPart, pedidos] = await Promise.all([
    todasPaginas(BASE + '/events/' + eventId + '/participants', token),
    todasPaginas(BASE + '/events/' + eventId + '/orders', token).catch((e) => { return { erro: e.message }; })
  ]);

  const naoAprovados = {};
  todosPart.forEach((p) => { if (p.order_status !== 'APPROVED') { const s = p.order_status || '(vazio)'; naoAprovados[s] = (naoAprovados[s] || 0) + 1; } });
  const part = todosPart.filter((p) => p.order_status === 'APPROVED');

  let checkinRealizados = 0, checkinRestantes = 0, cortesias = 0;
  let cortesiaValidada = 0, cortesiaValidadaF = 0, cortesiaValidadaM = 0;
  let qtdF = 0, qtdM = 0, qtdFPago = 0, qtdMPago = 0, faltaF = 0, faltaM = 0;
  let valorParticipantes = 0;
  const hashPagos = [], hashCortesia = [];

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
    valorParticipantes += (Number(p.ticket_sale_price) || 0) - (Number(p.order_discount) || 0);
  }

  // valor: pelos pedidos (completo); se a rota de pedidos falhar, usa a soma dos participantes e avisa
  let valorLiquido = valorParticipantes, valorOrigem = 'participantes', aviso = '';
  if (Array.isArray(pedidos) && pedidos.length) {
    valorLiquido = pedidos.filter((o) => o.order_status === 'APPROVED').reduce((s, o) => s + (Number(o.order_total_net_value) || 0), 0);
    valorOrigem = 'pedidos';
    if (Math.abs(valorLiquido - valorParticipantes) > 0.5) aviso = 'participantes deixaram de fora R$ ' + (valorLiquido - valorParticipantes).toFixed(2) + '; usado o valor dos pedidos';
  } else if (pedidos && pedidos.erro) aviso = 'pedidos indisponíveis (' + pedidos.erro + '); valor pela soma dos participantes';

  const totalGenero = qtdF + qtdM;
  return {
    evento_id: eventId, data: dia,
    valor_vendas_liquido: Math.round(valorLiquido * 100) / 100, valor_origem: valorOrigem, aviso,
    quantidade_venda_sympla: part.length,
    checkin_realizados: checkinRealizados, checkin_restantes: checkinRestantes,
    cortesia_validada: cortesiaValidada, cortesia_validada_feminino: cortesiaValidadaF, cortesia_validada_masculino: cortesiaValidadaM,
    falta_entrar_feminino: faltaF, falta_entrar_masculino: faltaM,
    pct_feminino: totalGenero ? Math.round((qtdF / totalGenero) * 100) : null,
    pct_masculino: totalGenero ? Math.round((qtdM / totalGenero) * 100) : null,
    qtd_feminino: qtdF, qtd_masculino: qtdM, qtd_feminino_pago: qtdFPago, qtd_masculino_pago: qtdMPago,
    cortesias, pedidos_nao_aprovados: Object.values(naoAprovados).reduce((a, b) => a + b, 0),
    hash_emails_pagos: hashPagos, hash_emails_cortesia: hashCortesia
  };
}
