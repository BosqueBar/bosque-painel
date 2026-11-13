/**
 * exportar_painel.gs — recebe do painel novo (Cloudflare) as noites e grava na aba Painel_Consolidado.
 * Arquivo NOVO: não mexe em nenhum outro arquivo do projeto.
 *
 * Antes de usar: Configurações do projeto > Propriedades do script > adicionar
 *   EXPORTAR_CHAVE = a senha longa que você também coloca na Cloudflare (EXPORTAR_CHAVE)
 * (Se este script NÃO estiver dentro da planilha, adicione também PLANILHA_ID = o código que aparece no endereço da planilha.)
 *
 * Regras: a linha da noite é SUBSTITUÍDA (nunca duplicada), só nas colunas que o painel novo envia;
 * colunas que não existem na planilha são ignoradas; as demais colunas da linha ficam como estão.
 */
var ABA_PAINEL = 'Painel_Consolidado';

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var corpo = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var chave = PropertiesService.getScriptProperties().getProperty('EXPORTAR_CHAVE');
    if (!chave || corpo.chave !== chave) return saidaExportar_({ ok: false, erro: 'chave inválida' });
    lock.waitLock(25000);
    return saidaExportar_(gravarNoitesPainel_(corpo.noites || []));
  } catch (err) {
    return saidaExportar_({ ok: false, erro: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* sem trava */ }
  }
}

function saidaExportar_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function dataIsoExportar_(v, fuso) {
  if (v instanceof Date) return Utilities.formatDate(v, fuso, 'yyyy-MM-dd');
  var s = String(v || '').trim(), m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

function gravarNoitesPainel_(noites) {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss && props.getProperty('PLANILHA_ID')) ss = SpreadsheetApp.openById(props.getProperty('PLANILHA_ID'));
  if (!ss) return { ok: false, erro: 'planilha não encontrada (defina PLANILHA_ID nas propriedades do script)' };
  var sh = ss.getSheetByName(ABA_PAINEL);
  if (!sh) return { ok: false, erro: 'aba ' + ABA_PAINEL + ' não encontrada' };
  var fuso = ss.getSpreadsheetTimeZone();
  var nCols = sh.getLastColumn(), ult = sh.getLastRow();
  var cab = sh.getRange(1, 1, 1, nCols).getValues()[0].map(function (x) { return String(x).trim(); });
  var iData = cab.indexOf('data');
  if (iData < 0 || cab.indexOf('pessoas_na_casa') < 0) return { ok: false, erro: 'não achei o cabeçalho na linha 1 (colunas data e pessoas_na_casa)' };
  var iAtual = cab.indexOf('atualizado_em');

  var corpoAtual = ult > 1 ? sh.getRange(2, 1, ult - 1, nCols).getValues() : [];
  var linhaDaData = {};
  for (var i = 0; i < corpoAtual.length; i++) {
    var iso = dataIsoExportar_(corpoAtual[i][iData], fuso);
    if (iso) linhaDaData[iso] = i; // se houver repetida, vale a última
  }
  var ultima = corpoAtual.length ? corpoAtual[corpoAtual.length - 1] : null;
  var modeloData = ultima ? ultima[iData] : '';
  var modeloAtual = ultima && iAtual >= 0 ? ultima[iAtual] : '';

  var gravadas = [], ignoradas = {};
  noites.forEach(function (n) {
    var dia = dataIsoExportar_(n.data, fuso);
    if (!dia) return;
    var existe = linhaDaData[dia] !== undefined;
    var linha = existe ? corpoAtual[linhaDaData[dia]].slice() : cab.map(function () { return ''; });
    Object.keys(n).forEach(function (k) {
      var c = cab.indexOf(k);
      if (c < 0) { ignoradas[k] = true; return; }
      if (k === 'data') return; // a data da linha existente não muda
      var v = n[k];
      if (k === 'atualizado_em' && modeloAtual instanceof Date) {
        var p = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
        if (p) v = Utilities.parseDate(p[3] + '-' + p[2] + '-' + p[1] + ' ' + p[4] + ':' + p[5] + ':' + p[6], 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm:ss');
      }
      linha[c] = v;
    });
    if (!existe) { // linha nova: a data no mesmo formato das linhas que já existem
      var d = dia.split('-');
      if (modeloData instanceof Date) linha[iData] = Utilities.parseDate(dia, fuso, 'yyyy-MM-dd');
      else if (String(modeloData).indexOf('/') >= 0) linha[iData] = d[2] + '/' + d[1] + '/' + d[0];
      else linha[iData] = dia;
    }
    if (existe) {
      sh.getRange(linhaDaData[dia] + 2, 1, 1, nCols).setValues([linha]);
      corpoAtual[linhaDaData[dia]] = linha;
    } else {
      var alvo = sh.getLastRow() + 1;
      sh.getRange(alvo, 1, 1, nCols).setValues([linha]);
      corpoAtual.push(linha);
      linhaDaData[dia] = corpoAtual.length - 1;
    }
    gravadas.push({ dia: dia, acao: existe ? 'atualizada' : 'nova' });
  });
  SpreadsheetApp.flush();
  return { ok: true, gravadas: gravadas, ignoradas: Object.keys(ignoradas) };
}

/** Teste manual (opcional): rode no editor para ver se o arquivo está sem erro de sintaxe. Não grava nada. */
function testeExportarPainel() {
  Logger.log('Arquivo ok. Propriedade EXPORTAR_CHAVE definida? ' + (PropertiesService.getScriptProperties().getProperty('EXPORTAR_CHAVE') ? 'sim' : 'NÃO'));
}
