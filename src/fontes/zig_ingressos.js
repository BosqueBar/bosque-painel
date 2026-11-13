// Fonte: ZigTickets / SuperTicket (venda na porta). Dias sem evento fixo (segunda, terça, quarta) só precisam do token quando houver evento extra. Porta do painel atual (buscarZigTicketsHoje_).
// Regras que vêm do painel atual:
//  - Um token por dia da semana (SUPERTICKET_TOKEN_QUI/SEX/SAB/DOM e QUA). O token aponta para o evento daquele dia da semana:
//    a API não filtra por data, então só dá para reler a noite enquanto ela é o evento atual daquele token.
//  - Catraca nova: venda = entrada (sem etapa de validação). "Validado" = ingresso emitido pago, SEM cortesia.
//  - Cortesia = nome do lote com "cortesia" ou preço 0. Gênero pelo setor (começa com "fem"/"masc").
//  - purchase_date vem com "Z" mas JÁ é horário de Brasília: não converter.
import { buscarJson, diaSemana, horaDaNoite } from '../util.js';

const BASE = 'https://public-api.superticket.com.br';
const PROP_POR_DIA = { 0: 'SUPERTICKET_TOKEN_DOM', 1: 'SUPERTICKET_TOKEN_SEG', 2: 'SUPERTICKET_TOKEN_TER', 3: 'SUPERTICKET_TOKEN_QUA', 4: 'SUPERTICKET_TOKEN_QUI', 5: 'SUPERTICKET_TOKEN_SEX', 6: 'SUPERTICKET_TOKEN_SAB' };

const ehCortesia = (t) => String(t.lot_name || '').toLowerCase().includes('cortesia') || Number(t.price) === 0;
function porGenero(itens) {
  let f = 0, m = 0;
  for (const it of itens) { const s = String(it.sector_name || '').toLowerCase(); if (s.startsWith('fem')) f++; else if (s.startsWith('masc')) m++; }
  return { f, m };
}

async function todosTickets(token) {
  let pagina = 1, todos = [], total = null;
  while (pagina <= 200) {
    let j;
    try { j = await buscarJson(BASE + '/tickets?page=' + pagina + '&perPage=1000', { headers: { Authorization: 'Bearer ' + token } }, 25000); }
    catch (e) {
      // 404 "No tickets found for the provided Event ID" = o evento do token ainda não vendeu nenhum ingresso (normal antes da porta abrir).
      // Não é erro: conta como zero. Token inválido (401/403) e falhas de rede continuam sendo erro.
      if (e.status === 404 && pagina === 1) return { itens: [], total: 0 };
      throw e;
    }
    const dados = j.data || [];
    todos = todos.concat(dados);
    total = j.total != null ? j.total : total;
    if (dados.length === 0 || (total != null && todos.length >= total)) break;
    pagina++;
  }
  return { itens: todos, total };
}

export async function coletarZigIngressos(env, dia) {
  const nomeProp = PROP_POR_DIA[diaSemana(dia)];
  if (!nomeProp) throw new Error('sem token configurado para o dia da semana de ' + dia);
  const token = env[nomeProp];
  if (!token) throw new Error('falta a variável ' + nomeProp);

  const { itens, total } = await todosTickets(token);
  if (!itens.length) return { semVendas: true, dia, ingressos_emitidos: 0, ingressos_validados: 0, qtd_feminino: 0, qtd_masculino: 0, cortesias: 0, cortesia_validada_feminino: 0, cortesia_validada_masculino: 0, total_vendas: 0, entradas_por_hora: {} };

  const pagos = itens.filter((t) => !ehCortesia(t));
  const cort = itens.filter(ehCortesia);
  const emitido = porGenero(itens), pago = porGenero(pagos), cg = porGenero(cort);
  const porHora = {};
  for (const t of itens) { const h = horaDaNoite(String(t.purchase_date || '').substring(0, 19), dia); if (h) porHora[h] = (porHora[h] || 0) + 1; }

  // por lote: mostra, por exemplo, quem entrou num lote "lista" pagando mais barato na porta
  const lotes = {};
  for (const t of pagos) { const n = String(t.lot_name || 'Sem lote').trim() || 'Sem lote'; const l = lotes[n] || (lotes[n] = { lote: n, qtd: 0, valor: 0 }); l.qtd++; l.valor += Number(t.price) || 0; }
  const porta_lotes = Object.values(lotes).sort((a, b) => b.qtd - a.qtd).slice(0, 12);

  return {
    porta_lotes,
    evento_nome: itens[0].event_name, data_primeira_compra: String(itens[0].purchase_date || '').substring(0, 10), dia,
    ingressos_emitidos: total != null ? total : itens.length,
    ingressos_validados: pagos.length,
    qtd_feminino: emitido.f, qtd_masculino: emitido.m,
    validado_feminino: pago.f, validado_masculino: pago.m,
    cortesias: cort.length,
    cortesia_validada_feminino: cg.f, cortesia_validada_masculino: cg.m,
    total_vendas: itens.reduce((s, t) => s + (Number(t.price) || 0), 0),
    entradas_por_hora: porHora
  };
}
