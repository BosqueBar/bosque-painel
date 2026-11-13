// Consolidado da noite: junta Sympla + Zig (porta) + Zig (bar) + UGO nos mesmos números do painel atual.
// Porta de montarLinhaConsolidada_ (painel_bosque_tempo_real.gs). Regras fechadas com a Annie:
//  - "Na casa" (opção A) = check-in pago (sem cortesia) Sympla + Zig + cortesia validada (Sympla + Zig + lista UGO).
//  - Check-in da Sympla = o MAIOR entre a API da Sympla e o que a UGO viu entrar (a UGO lê o QR na hora; a API atrasa).
//  - Cortesia da Sympla que entrou: idem (maior entre API e UGO).
//  - Entradas por hora = Zig (venda = entrada) + cortesia de lista (UGO) + Sympla (UGO).
//  - Bilheteria = Sympla + porta. Bar recebido exclui BÔNUS e inclui gorjeta.
const somaOuNull = (a, b) => (a == null && b == null) ? null : (a || 0) + (b || 0);
function somarMapas(...mapas) {
  const r = {};
  for (const m of mapas) for (const h of Object.keys(m || {})) r[h] = (r[h] || 0) + (Number(m[h]) || 0);
  return r;
}
export function nomeEventoPadrao(dia) {
  const [a, m, d] = dia.split('-').map(Number);
  const nomes = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
  return 'BOSQUE - ' + nomes[new Date(Date.UTC(a, m - 1, d)).getUTCDay()] + ' - ' + String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0');
}

export function montarConsolidado(dia, sympla, zigIng, zigBar, ugo, nomeEvento) {
  const s = sympla || {}, z = zigIng || {}, b = zigBar || {}, u = ugo || {};

  let symValF = Math.max(0, (s.qtd_feminino_pago || 0) - (s.falta_entrar_feminino || 0));
  let symValM = Math.max(0, (s.qtd_masculino_pago || 0) - (s.falta_entrar_masculino || 0));

  // cortesia da Sympla que entrou: maior entre API e UGO
  const cortApi = s.cortesia_validada || 0, cortUgo = u.sympla_cortesia_entradas || 0;
  const cortUgoAcima = cortUgo > cortApi;
  const symCortTotal = Math.max(cortApi, cortUgo);
  const symCortF = cortUgoAcima ? (u.sympla_cortesia_f || 0) : (s.cortesia_validada_feminino || 0);
  const symCortM = cortUgoAcima ? (u.sympla_cortesia_m || 0) : (s.cortesia_validada_masculino || 0);
  const symCortSem = cortUgoAcima ? (u.sympla_cortesia_sem_genero || 0) : 0;

  const cortValF = symCortF + (z.cortesia_validada_feminino || 0) + (u.validadas_f || 0);
  const cortValM = symCortM + (z.cortesia_validada_masculino || 0) + (u.validadas_m || 0);
  const cortValTotal = symCortTotal + (z.cortesia_validada_feminino || 0) + (z.cortesia_validada_masculino || 0) + (u.validadas || 0);

  // check-in da Sympla: o maior entre API e UGO
  const ckApi = s.checkin_realizados || 0, ckUgo = u.sympla_entradas || 0;
  const ckUsado = Math.max(ckApi, ckUgo);
  const ugoAcima = ckUgo > ckApi;
  const extraSympla = s.ingressos_estimados_sem_lista || 0; // ingressos que a Sympla não lista (pedidos sem participante), estimados
  let faltaAnt = (s.checkin_restantes || 0) + extraSympla, faltaAntF = s.falta_entrar_feminino || 0, faltaAntM = s.falta_entrar_masculino || 0;
  if (ugoAcima) {
    symValF = u.sympla_entradas_f || 0;
    symValM = u.sympla_entradas_m || 0;
    faltaAnt = Math.max(0, faltaAnt - (ckUgo - ckApi));
    faltaAntF = Math.max(0, (s.qtd_feminino_pago || 0) - symValF);
    faltaAntM = Math.max(0, (s.qtd_masculino_pago || 0) - symValM);
  }

  const entradasPorHora = somarMapas(z.entradas_por_hora, u.horas_lista, u.horas_sympla);
  const consumoPorHora = b.consumo_por_hora || {};

  return {
    evento: nomeEvento || z.evento_nome || nomeEventoPadrao(dia), // nome marcado no calendário (noites extras) vale primeiro
    data: dia,
    pessoas_na_casa: ckUsado + (z.ingressos_validados || 0) + cortValTotal,
    falta_entrar_antecipado: faltaAnt,
    falta_entrar_antecipado_feminino: faltaAntF,
    falta_entrar_antecipado_masculino: faltaAntM,
    falta_entrar_porta_feminino: 0,
    falta_entrar_porta_masculino: 0,
    na_casa_feminino: symValF + (z.validado_feminino || 0) + cortValF,
    na_casa_masculino: symValM + (z.validado_masculino || 0) + cortValM,
    bilheteria_total: (s.valor_vendas_liquido || 0) + (z.total_vendas || 0),
    bilheteria_sympla: s.valor_vendas_liquido || 0,
    bilheteria_porta: z.total_vendas || 0,
    quantidade_venda_sympla: (s.quantidade_venda_sympla || 0) + extraSympla,
    venda_sympla_estimada: extraSympla,
    quantidade_checkin_sympla: ckUsado,
    quantidade_cortesia_validada_sympla: symCortTotal,
    quantidade_venda_porta: z.ingressos_emitidos || 0,
    quantidade_checkin_porta: z.ingressos_validados || 0,
    quantidade_cortesia_validada_porta: (z.cortesia_validada_feminino || 0) + (z.cortesia_validada_masculino || 0),
    faturamento_bar: b.faturamento_bar || 0,
    faturamento_bar_recebido: b.total_recebimentos_bar || 0,
    cortesias_total: (s.cortesias || 0) + (z.cortesias || 0),
    cortesia_validada_feminino: cortValF,
    cortesia_validada_masculino: cortValM,
    cortesia_validada_sem_genero: (u.validadas_sem_genero || 0) + symCortSem,
    quantidade_cortesia_validada_lista: u.validadas || 0,
    entradas_por_hora: entradasPorHora,
    consumo_por_hora: consumoPorHora,
    // "Por onde entrou" fecha com "Na casa": a lista que pagou paga na porta (já está nos ingressos da porta), então sai da bilheteria da porta
    origem_sympla_pago: Math.max(0, ckUsado),
    origem_porta_pago: Math.max(0, (z.ingressos_validados || 0) - Math.min(z.ingressos_validados || 0, u.lista_pagantes_entraram || 0)),
    origem_lista_paga: Math.min(z.ingressos_validados || 0, u.lista_pagantes_entraram || 0),
    origem_cortesia_sympla: symCortTotal,
    origem_cortesia_porta: (z.cortesia_validada_feminino || 0) + (z.cortesia_validada_masculino || 0),
    origem_cortesia_lista: u.validadas || 0,
    porta_lotes: z.porta_lotes || [],
    antecipado_lotes: s.antecipado_lotes || [],
    lista_convidados: u.lista_convidados || 0,
    lista_entraram: u.lista_entraram || 0,
    checkin_sympla_api: ckApi,
    checkin_sympla_ugo: ckUgo,
    quantidade_cortesia_emitida_lista: u.emitidas || 0,
    sympla_pedidos_nao_aprovados: s.pedidos_nao_aprovados || 0,
    qtd_feminino_total: somaOuNull(s.qtd_feminino, z.qtd_feminino),
    qtd_masculino_total: somaOuNull(s.qtd_masculino, z.qtd_masculino)
  };
}
