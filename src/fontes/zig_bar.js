// Fonte: ZigPay / ZigCore ERP (bar). Porta do painel atual (zigFetchPaginado_ / buscarZigPayBarHoje_ + consumo por hora).
// Regras que vêm do painel atual e foram conferidas em noites reais:
//  - Autenticação: cabeçalho "Authorization: <token>" (sem "Bearer"). Token da Zig muda toda semana.
//  - A Zig IGNORA o parâmetro "page" em /erp/saida-produtos: a primeira resposta já traz a noite inteira. Por isso a leitura
//    para assim que uma página não traz nenhum item novo (antes o painel baixava o mesmo conteúdo 50 vezes, ~60 s, e travava).
//  - A noite é identificada pelo eventId dos itens cujo eventDate é o dia da noite (a madrugada seguinte carrega o mesmo eventId).
//  - Valores em centavos. "Recebido" = faturamento SEM a forma de pagamento BÔNUS. A gorjeta (type "Tip") está DENTRO do recebido.
//  - Venda de produtos: ignora type "Entrance". Consumo por hora: ignora Entrance, Tip (hora = abertura, não é consumo) e as linhas
//    de bônus (colaborador "CORTESIA", "CORTESIA 2"…; conferido em 01/11: soma = linha BÔNUS do faturamento).
//  - transactionDate vem em UTC sem "Z": subtrair 3 h para Brasília. O gráfico é escalado para fechar com o "recebido".
import { buscarJson, somarDias, horaDaNoite } from '../util.js';

const BASE = 'https://api.zigcore.com.br/integration';
export const BAR_INCLUI_GORJETA = true; // decisão da Annie: o cartão do Bar inclui a gorjeta

async function paginado(env, endpoint, params) {
  let resultados = [], pagina = 1;
  const vistos = new Set();
  while (pagina <= 5) {
    const qs = Object.keys(Object.assign({}, params, { page: pagina })).map((k) => k + '=' + encodeURIComponent(k === 'page' ? pagina : params[k])).join('&');
    const j = await buscarJson(BASE + endpoint + '?' + qs, { headers: { Authorization: env.ZIG_TOKEN } }, 25000);
    const dados = Array.isArray(j) ? j : [];
    if (!dados.length) break;
    let novos = 0;
    const chaves = dados.map((it) => JSON.stringify(it));
    for (const c of chaves) if (!vistos.has(c)) novos++;
    if (!novos) break;
    for (const c of chaves) vistos.add(c);
    resultados = resultados.concat(dados);
    pagina++;
  }
  return resultados;
}

// UTC (sem "Z") -> horário local de Brasília (UTC-3, sem horário de verão)
function utcParaLocal(iso) {
  const t = String(iso || '').substring(0, 19);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t)) return '';
  return new Date(new Date(t + 'Z').getTime() - 3 * 3600e3).toISOString().substring(0, 19);
}

const valorItem = (it) => ((it.unitValue || 0) * (it.count || 1) - (it.discountValue || 0)) / 100;

export async function coletarZigBar(env, dia) {
  if (!env.ZIG_TOKEN) throw new Error('falta a variável ZIG_TOKEN');
  if (!env.ZIG_LOJA_ID) throw new Error('falta a variável ZIG_LOJA_ID');
  const params = { dtinicio: dia, dtfim: somarDias(dia, 1), loja: env.ZIG_LOJA_ID };

  const [saidasBrutas, faturBruto] = await Promise.all([paginado(env, '/erp/saida-produtos', params), paginado(env, '/erp/faturamento', params)]);

  const eventIds = new Set([].concat(saidasBrutas, faturBruto).filter((it) => String(it.eventDate || '').substring(0, 10) === dia).map((it) => it.eventId));
  if (!eventIds.size) return { semVendas: true, dia, faturamento_bar: 0, total_recebimentos_bar: 0, gorjeta_bar: 0, consumo_por_hora: {} };

  const vs = new Set();
  const saidas = saidasBrutas.filter((it) => eventIds.has(it.eventId)).filter((it) => {
    const k = it.transactionId + '_' + it.productId + '_' + it.unitValue + '_' + it.count;
    if (vs.has(k)) return false; vs.add(k); return true;
  });
  const vf = new Set();
  const fatur = faturBruto.filter((f) => eventIds.has(f.eventId)).filter((f) => {
    const k = f.paymentId + '_' + f.value + '_' + f.eventId;
    if (vf.has(k)) return false; vf.add(k); return true;
  });

  let vendas = 0, gorjeta = 0;
  for (const it of saidas) {
    if (it.type === 'Tip') gorjeta += valorItem(it);
    if (it.type !== 'Entrance') vendas += valorItem(it);
  }
  let recebido = 0;
  for (const f of fatur) {
    const m = String(f.paymentName || '').toUpperCase();
    if (m.includes('BONUS') || m.includes('BÔNUS') || m.includes('BÃNUS')) continue;
    recebido += (f.value || 0) / 100;
  }
  if (!BAR_INCLUI_GORJETA) recebido = Math.max(0, recebido - gorjeta);

  // consumo por hora (R$), escalado para fechar com o recebido
  const porHora = {}; let janela = 0;
  for (const it of saidas) {
    if (it.type === 'Entrance' || it.type === 'Tip') continue;
    if (/^\s*cortesia/i.test(String(it.employeeName || ''))) continue;
    const h = horaDaNoite(utcParaLocal(it.transactionDate), dia);
    if (h) { const v = valorItem(it); porHora[h] = (porHora[h] || 0) + v; janela += v; }
  }
  const fator = janela > 0 && recebido > 0 ? recebido / janela : 1;
  const consumo = {};
  for (const h of Object.keys(porHora)) consumo[h] = Math.round(porHora[h] * fator);

  const r2 = (n) => Math.round(n * 100) / 100;
  return { dia, faturamento_bar: r2(vendas), total_recebimentos_bar: r2(recebido), gorjeta_bar: r2(gorjeta), consumo_por_hora: consumo, itens_saida: saidas.length, linhas_faturamento: fatur.length };
}
