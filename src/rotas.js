// Rotas da tela e da administração (acesso por pessoa). Respostas em JSON; nada de dado pessoal em log.
import { MODELOS, ehSocio, ehAdmin, novaChaveLink, hashLink, pinAleatorio, pinValido, hashPin, conferePin, criarCookie, cookieSair,
  pessoaDaSessao, podeVerNoite, permissoes, filtrarPainel, guardarTokenZig, lerTokenZig, rotuloAparelho } from './auth.js';
import { agoraBR, decidirModo } from './coletor.js';

const json = (obj, status, extra) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {})
});
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const BLOQUEIO_FIM = '2099-12-31T00:00:00Z';

function chaveTeste(url, env) { // chave de emergência / testes (ver Etapa 6: removida na virada)
  const c = url.searchParams.get('chave') || '', k = String(env.TESTE_CHAVE || '');
  if (!k || c.length !== k.length) return false;
  let d = 0; for (let i = 0; i < k.length; i++) d |= c.charCodeAt(i) ^ k.charCodeAt(i);
  return d === 0;
}
async function corpo(request) { try { return await request.json(); } catch (e) { return {}; } }

async function extrasDb(db) {
  try { const r = await db.sel('pt_noites', { select: 'dia', ativa: 'eq.true' }); return new Set((r || []).map((x) => x.dia)); } catch (e) { return new Set(); }
}
export async function noiteAtual(db) {
  const agora = agoraBR();
  const dec = decidirModo(agora, await extrasDb(db));
  return { hoje: dec.modo !== 'off' ? dec.dia : null, agora: agora.dia };
}

// ---------- resposta de pessoa (sem hashes) ----------
const publica = (p) => ({
  id: p.id, nome: p.nome, modelo: p.modelo, dias: p.dias || [], datas: p.datas || [],
  perm_contagem: p.perm_contagem, perm_bilheteria: p.perm_bilheteria, perm_bar: p.perm_bar,
  ativo: p.ativo, validade: p.validade, bloqueado: !!(p.bloqueado_ate && new Date(p.bloqueado_ate) > new Date()), criado_em: p.criado_em
});

function normalizar(d, atual) {
  const modelo = (d.modelo !== undefined ? d.modelo : (atual && atual.modelo)) || 'outro';
  if (!MODELOS[modelo] || modelo === 'admin' && !(atual && atual.modelo === 'admin')) throw new Error('Modelo inválido.');
  const base = MODELOS[modelo];
  const pick = (k, padrao) => (d[k] !== undefined ? d[k] : (atual ? atual[k] : padrao));
  const dias = (pick('dias', base.dias) || []).map(Number).filter((n) => n >= 0 && n <= 6);
  const datas = (pick('datas', []) || []).filter((x) => DATA.test(x));
  const out = {
    nome: String(pick('nome', '') || '').trim().slice(0, 80), modelo,
    dias: [...new Set(dias)], datas: [...new Set(datas)],
    perm_contagem: !!pick('perm_contagem', base.contagem),
    perm_bilheteria: !!pick('perm_bilheteria', base.bilheteria),
    perm_bar: !!pick('perm_bar', base.bar),
    validade: pick('validade', null) || null,
    ativo: pick('ativo', true) !== false
  };
  if (!out.nome) throw new Error('Informe o nome.');
  if (out.validade && !DATA.test(out.validade)) throw new Error('Validade inválida.');
  if (ehSocio(modelo)) out.perm_bar = false; // sócio de noite nunca vê o bar
  if (modelo === 'admin') { out.perm_contagem = out.perm_bilheteria = out.perm_bar = true; }
  return out;
}

// ---------- entrar / sair / eu ----------
async function entrar(request, env, db) {
  const b = await corpo(request);
  const k = String(b.k || ''), pin = String(b.pin || '');
  if (!k || !pinValido(pin)) return json({ erro: 'Digite os 6 números do PIN.' }, 400);
  const r = await db.sel('pt_pessoas', { chave_hash: 'eq.' + (await hashLink(k)) });
  const p = r && r[0];
  if (!p || !p.ativo) return json({ erro: 'Link inválido ou desativado. Peça um novo à Annie.' }, 403);
  if (p.bloqueado_ate && new Date(p.bloqueado_ate) > new Date()) return json({ erro: 'Acesso bloqueado por muitos erros de PIN. Peça à Annie para liberar.' }, 423);
  if (!(await conferePin(pin, p.pin_hash))) {
    const erros = (p.erros_pin || 0) + 1;
    const dados = { erros_pin: erros };
    if (erros >= 5) dados.bloqueado_ate = BLOQUEIO_FIM;
    await db.upd('pt_pessoas', { id: 'eq.' + p.id }, dados);
    return json({ erro: erros >= 5 ? 'PIN errado 5 vezes: acesso bloqueado. Peça à Annie para liberar.' : 'PIN incorreto. Restam ' + (5 - erros) + ' tentativa(s).' }, 403);
  }
  if (p.validade && p.validade < agoraBR().dia) return json({ erro: 'Este acesso venceu.' }, 403);
  if (p.erros_pin) await db.upd('pt_pessoas', { id: 'eq.' + p.id }, { erros_pin: 0 });
  const { hoje, agora } = await noiteAtual(db);
  await db.ins('pt_acessos', [{ pessoa_id: p.id, aparelho: await rotuloAparelho(request), noite: hoje || agora }]);
  const cookie = await criarCookie(env, p, new URL(request.url).protocol === 'https:');
  return json({ ok: true, admin: ehAdmin(p) }, 200, { 'Set-Cookie': cookie });
}

// ---------- tela ----------
async function painelDaPessoa(request, url, env, db, p, legado) {
  const { hoje, agora } = await noiteAtual(db);
  const perm = legado ? { contagem: true, bilheteria: true, bar: true } : permissoes(p);
  const pede = url.searchParams.get('noite') || '';
  let noite = pede;
  if (pede && !DATA.test(pede)) return json({ erro: 'Noite inválida.' }, 400);
  if (!noite) {
    if (hoje && (legado || podeVerNoite(p, hoje))) noite = hoje;
    else {
      const ult = await db.sel('pt_painel', { select: 'noite', order: 'noite.desc', limit: 60 });
      const ok = (ult || []).map((x) => x.noite).find((n) => legado || podeVerNoite(p, n));
      noite = ok || '';
    }
  }
  if (!noite) return json({ hoje: hoje || agora, noite: null, painel: null, sem_noite: true, nome: legado ? 'Teste' : p.nome, admin: legado || ehAdmin(p) });
  if (!legado && !podeVerNoite(p, noite)) return json({ erro: 'Seu acesso não inclui essa noite.' }, 403);
  const r = await db.sel('pt_painel', { select: 'dados', noite: 'eq.' + noite });
  if (!legado) await db.ins('pt_config', [{ chave: 'visto_' + p.id, valor: String(Date.now()), atualizado_em: new Date().toISOString() }], { upsert: true, conflito: 'chave' }).catch(() => {});
  return json({ hoje: hoje || agora, ao_vivo: !!hoje && noite === hoje, noite, painel: filtrarPainel((r && r[0] && r[0].dados) || null, perm), nome: legado ? 'Teste' : p.nome, admin: legado || ehAdmin(p) });
}
async function noitesDaPessoa(db, p, legado) {
  const r = await db.sel('pt_painel', { select: 'noite,evento:dados->>evento', order: 'noite.desc', limit: 300 });
  const lista = (r || []).filter((x) => legado || podeVerNoite(p, x.noite)).map((x) => ({ data: x.noite, evento: x.evento || '' }));
  return json({ noites: lista });
}

// ---------- administração ----------
async function admin(request, url, env, db, p) {
  const rota = url.pathname.replace('/api/admin/', '');
  const b = request.method === 'POST' ? await corpo(request) : {};
  const origem = url.origin;

  if (rota === 'pessoas' && request.method === 'GET') {
    const r = await db.sel('pt_pessoas', { order: 'nome.asc' });
    return json({ pessoas: (r || []).map(publica), modelos: Object.fromEntries(Object.entries(MODELOS).filter(([k]) => k !== 'admin').map(([k, v]) => [k, v])) });
  }
  if (rota === 'pessoas' && request.method === 'POST') {
    const d = normalizar(b);
    if (d.modelo === 'admin') throw new Error('Modelo inválido.');
    const pin = b.pin ? String(b.pin) : pinAleatorio();
    if (!pinValido(pin)) throw new Error('O PIN precisa ter 6 números.');
    const chave = novaChaveLink();
    const novo = await db.ins('pt_pessoas', [Object.assign(d, { chave_hash: await hashLink(chave), pin_hash: await hashPin(pin) })], { retorna: true });
    return json({ pessoa: publica(novo[0]), link: origem + '/a/' + chave, pin });
  }
  let m = rota.match(/^pessoas\/(\d+)\/(atualizar|novo-link|novo-pin|desbloquear|excluir)$/);
  if (m && request.method === 'POST') {
    const id = Number(m[1]), acao = m[2];
    const r = await db.sel('pt_pessoas', { id: 'eq.' + id });
    const alvo = r && r[0];
    if (!alvo) return json({ erro: 'Pessoa não encontrada.' }, 404);
    if (acao === 'atualizar') {
      const d = normalizar(b, alvo);
      if (alvo.modelo === 'admin') d.modelo = 'admin';
      const novo = await db.upd('pt_pessoas', { id: 'eq.' + id }, d);
      return json({ pessoa: publica(novo[0]) });
    }
    if (acao === 'novo-link') {
      if (alvo.modelo === 'admin' && alvo.id !== p.id) return json({ erro: 'Só o próprio administrador troca o seu link.' }, 403);
      const chave = novaChaveLink();
      const dados = { chave_hash: await hashLink(chave), erros_pin: 0, bloqueado_ate: null };
      let pin = null;
      if (b.novo_pin !== false) { pin = pinAleatorio(); dados.pin_hash = await hashPin(pin); }
      await db.upd('pt_pessoas', { id: 'eq.' + id }, dados);
      return json({ link: origem + '/a/' + chave, pin });
    }
    if (acao === 'novo-pin') {
      const pin = b.pin ? String(b.pin) : pinAleatorio();
      if (!pinValido(pin)) throw new Error('O PIN precisa ter 6 números.');
      await db.upd('pt_pessoas', { id: 'eq.' + id }, { pin_hash: await hashPin(pin), erros_pin: 0, bloqueado_ate: null });
      return json({ pin });
    }
    if (acao === 'desbloquear') { await db.upd('pt_pessoas', { id: 'eq.' + id }, { erros_pin: 0, bloqueado_ate: null }); return json({ ok: true }); }
    if (acao === 'excluir') {
      if (alvo.modelo === 'admin') return json({ erro: 'O administrador não pode ser excluído.' }, 403);
      await db.del('pt_pessoas', { id: 'eq.' + id }); return json({ ok: true });
    }
  }
  if (rota === 'acessos' && request.method === 'GET') {
    const [pessoas, acessos, vistos] = await Promise.all([
      db.sel('pt_pessoas', { select: 'id,nome,modelo' }),
      db.sel('pt_acessos', { order: 'em.desc', limit: 150 }),
      db.sel('pt_config', { select: 'chave,valor', chave: 'like.visto_*' })
    ]);
    const nome = {}; for (const x of pessoas || []) nome[x.id] = x;
    const online = (vistos || []).filter((v) => Date.now() - Number(v.valor) < 90000).map((v) => nome[Number(v.chave.slice(6))]).filter(Boolean).map((x) => ({ id: x.id, nome: x.nome }));
    const aparelhos = {};
    for (const a of acessos || []) { (aparelhos[a.pessoa_id] = aparelhos[a.pessoa_id] || new Set()).add(a.aparelho); }
    return json({
      online,
      aparelhos_por_pessoa: Object.fromEntries(Object.entries(aparelhos).map(([k, v]) => [k, v.size])),
      recentes: (acessos || []).slice(0, 80).map((a) => ({ pessoa: (nome[a.pessoa_id] || {}).nome || '?', em: a.em, aparelho: a.aparelho, noite: a.noite }))
    });
  }
  if (rota === 'noites' && request.method === 'GET') {
    const r = await db.sel('pt_noites', { order: 'dia.desc', limit: 60 });
    return json({ noites: r || [] });
  }
  if (rota === 'noites' && request.method === 'POST') {
    if (!DATA.test(String(b.dia || ''))) throw new Error('Data inválida.');
    await db.ins('pt_noites', [{ dia: b.dia, evento: String(b.evento || '').slice(0, 80), extra: true, ativa: b.ativa !== false }], { upsert: true, conflito: 'dia' });
    return json({ ok: true });
  }
  if (rota === 'noites/excluir' && request.method === 'POST') {
    if (!DATA.test(String(b.dia || ''))) throw new Error('Data inválida.');
    await db.del('pt_noites', { dia: 'eq.' + b.dia }); return json({ ok: true });
  }
  if (rota === 'fontes' && request.method === 'GET') {
    const { hoje, agora } = await noiteAtual(db);
    let noite = hoje;
    if (!noite) { const u = await db.sel('pt_painel', { select: 'noite', order: 'noite.desc', limit: 1 }); noite = (u && u[0] && u[0].noite) || agora; }
    const f = await db.sel('pt_fontes', { noite: 'eq.' + noite });
    const tz = await lerTokenZig(env, db);
    return json({
      noite, ao_vivo: !!hoje,
      fontes: (f || []).map((x) => ({ fonte: x.fonte, atualizado_em: x.atualizado_em, tentativa_em: x.tentativa_em, erro: x.erro })),
      token_zig: { guardado: !!tz, atualizado_em: tz ? tz.atualizado_em : null, variavel_antiga: !!env.ZIG_TOKEN }
    });
  }
  if (rota === 'zig-token' && request.method === 'POST') {
    const t = String(b.token || '').trim().replace(/^Bearer\s+/i, '');
    if (t.length < 20 || /\s/.test(t)) throw new Error('Esse texto não parece um token da Zig. Cole o token inteiro, sem espaços.');
    await guardarTokenZig(env, db, t);
    return json({ ok: true });
  }
  return json({ erro: 'Rota desconhecida.' }, 404);
}

// ---------- roteador /api/* ----------
export async function api(request, url, env, db) {
  const rota = url.pathname;
  try {
    // 1) criar / recuperar o acesso da administradora (só com a chave de emergência)
    if (rota === '/api/admin/iniciar' && request.method === 'POST') {
      if (!chaveTeste(url, env)) return json({ erro: 'Acesso negado.' }, 403);
      const b = await corpo(request);
      const pin = String(b.pin || '');
      if (!pinValido(pin)) return json({ erro: 'Escolha um PIN com 6 números.' }, 400);
      const chave = novaChaveLink();
      const dados = { chave_hash: await hashLink(chave), pin_hash: await hashPin(pin), erros_pin: 0, bloqueado_ate: null, ativo: true };
      const ex = await db.sel('pt_pessoas', { modelo: 'eq.admin', order: 'id.asc', limit: 1 });
      if (ex && ex[0]) await db.upd('pt_pessoas', { id: 'eq.' + ex[0].id }, dados);
      else await db.ins('pt_pessoas', [Object.assign({ nome: String(b.nome || 'Annie').trim().slice(0, 80) || 'Annie', modelo: 'admin', dias: [0, 1, 2, 3, 4, 5, 6], perm_contagem: true, perm_bilheteria: true, perm_bar: true }, dados)]);
      return json({ link: url.origin + '/a/' + chave });
    }
    if (rota === '/api/entrar' && request.method === 'POST') return await entrar(request, env, db);
    if (rota === '/api/sair') return json({ ok: true }, 200, { 'Set-Cookie': cookieSair() });

    const legado = chaveTeste(url, env); // link de teste da Fase 3 continua valendo até a virada
    const p = legado ? null : await pessoaDaSessao(request, env, db);
    if (!legado && !p) return json({ erro: 'Sessão expirada. Abra de novo o link que você recebeu e digite o PIN.', sem_sessao: true }, 401);

    if (rota === '/api/eu') return json({ nome: legado ? 'Teste' : p.nome, admin: legado ? false : ehAdmin(p), perm: legado ? { contagem: true, bilheteria: true, bar: true } : permissoes(p) });
    if (rota === '/api/painel') return await painelDaPessoa(request, url, env, db, p, legado);
    if (rota === '/api/noites') return await noitesDaPessoa(db, p, legado);
    if (rota.startsWith('/api/admin/')) {
      if (legado || !ehAdmin(p)) return json({ erro: 'Somente o administrador.' }, 403);
      return await admin(request, url, env, db, p);
    }
    return json({ erro: 'Rota desconhecida.' }, 404);
  } catch (e) {
    return json({ erro: String((e && e.message) || e) }, 400);
  }
}
