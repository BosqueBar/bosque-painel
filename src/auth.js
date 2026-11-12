// Acesso por pessoa: link pessoal (guardado só como hash) + PIN de 6 dígitos, sessão em cookie assinado,
// permissões (Contagem / Bilheteria / Bar), dias liberados e token da Zig criptografado.
import { sha256, diaSemana } from './util.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- modelos de acesso ----------
// dias: 0 = domingo … 6 = sábado. Sócio de noite NUNCA vê o bar.
export const MODELOS = {
  socios_bsqnt:    { rotulo: 'Sócios BSQNT (quinta)',  dias: [4], contagem: true,  bilheteria: true,  bar: false },
  socios_sexta:    { rotulo: 'Sócios Sexta',           dias: [5], contagem: true,  bilheteria: true,  bar: false },
  socios_sabado:   { rotulo: 'Sócios Sábado',          dias: [6], contagem: true,  bilheteria: true,  bar: false },
  socios_sambinha: { rotulo: 'Sócios Sambinha (domingo)', dias: [0], contagem: true, bilheteria: true, bar: false },
  full:            { rotulo: 'Acesso Full Bosque',     dias: [0, 1, 2, 3, 4, 5, 6], contagem: true, bilheteria: true, bar: true },
  operacional:     { rotulo: 'Operacional Bosque',     dias: [0, 4, 5, 6], contagem: true, bilheteria: false, bar: false },
  outro:           { rotulo: 'Personalizado',          dias: [], contagem: true, bilheteria: false, bar: false },
  admin:           { rotulo: 'Administrador',          dias: [0, 1, 2, 3, 4, 5, 6], contagem: true, bilheteria: true, bar: true }
};
export const ehSocio = (modelo) => /^socios_/.test(modelo || '');

// ---------- chaves derivadas (sem variável nova: sai da chave do banco que já existe) ----------
async function chaveDerivada(env, rotulo, uso) {
  const base = await crypto.subtle.digest('SHA-256', enc.encode('painel|' + rotulo + '|' + String(env.SUPABASE_SERVICE_KEY || '')));
  if (uso === 'hmac') return crypto.subtle.importKey('raw', base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.importKey('raw', base, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// ---------- link e PIN ----------
export function novaChaveLink() { return b64u(crypto.getRandomValues(new Uint8Array(24))); }
export const hashLink = (k) => sha256('link|' + k);
export function pinAleatorio() { const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000; return String(n).padStart(6, '0'); }
export const pinValido = (p) => /^\d{6}$/.test(String(p || ''));

async function pbkdf2(pin, saltHex) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
export async function hashPin(pin) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return salt + ':' + (await pbkdf2(pin, salt));
}
export async function conferePin(pin, guardado) {
  const [salt, h] = String(guardado || '').split(':');
  if (!salt || !h) return false;
  const calc = await pbkdf2(String(pin), salt);
  let d = 0; for (let i = 0; i < h.length; i++) d |= h.charCodeAt(i) ^ (calc.charCodeAt(i) || 0);
  return d === 0 && calc.length === h.length;
}

// ---------- sessão (cookie assinado) ----------
const COOKIE = 'bosque_sessao';
const DIAS_SESSAO = 30;
const versao = (p) => String(p.chave_hash).slice(0, 6) + String(p.pin_hash).slice(-6); // trocar link ou PIN derruba as sessões antigas
async function assinar(env, texto) {
  const k = await chaveDerivada(env, 'sessao', 'hmac');
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(texto)));
}
export async function criarCookie(env, pessoa, https) {
  const exp = Math.floor(Date.now() / 1000) + DIAS_SESSAO * 86400;
  const corpo = pessoa.id + '.' + exp + '.' + versao(pessoa);
  const valor = pessoa.id + '.' + exp + '.' + (await assinar(env, corpo));
  return COOKIE + '=' + valor + '; Path=/; Max-Age=' + DIAS_SESSAO * 86400 + '; HttpOnly; SameSite=Lax' + (https ? '; Secure' : '');
}
export const cookieSair = () => COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';

// Devolve a pessoa logada (ou null). Confere assinatura, validade e se a pessoa continua ativa.
export async function pessoaDaSessao(request, env, db) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'));
  if (!m) return null;
  const [id, exp, sig] = m[1].split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  const r = await db.sel('pt_pessoas', { id: 'eq.' + Number(id) });
  const p = r && r[0];
  if (!p || !p.ativo) return null;
  const esperado = await assinar(env, p.id + '.' + exp + '.' + versao(p));
  if (esperado.length !== sig.length) return null;
  let d = 0; for (let i = 0; i < sig.length; i++) d |= esperado.charCodeAt(i) ^ sig.charCodeAt(i);
  if (d !== 0) return null;
  if (p.validade && p.validade < new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) return null;
  if (p.bloqueado_ate && new Date(p.bloqueado_ate) > new Date()) return null;
  return p;
}

// ---------- regras de acesso ----------
export const ehAdmin = (p) => !!p && p.modelo === 'admin';
export function podeVerNoite(p, noite) {
  if (!p) return false;
  if (ehAdmin(p)) return true;
  return (p.dias || []).includes(diaSemana(noite)) || (p.datas || []).includes(noite);
}
export function permissoes(p) {
  if (ehAdmin(p)) return { contagem: true, bilheteria: true, bar: true };
  return { contagem: !!p.perm_contagem, bilheteria: !!p.perm_bilheteria, bar: !!p.perm_bar && !ehSocio(p.modelo) };
}

// ---------- o que cada permissão enxerga (filtrado NO SERVIDOR: o que não pode ver nem chega ao aparelho) ----------
const CAMPOS_BASE = ['evento', 'data', 'atualizado_em'];
const CAMPOS_CONTAGEM = ['pessoas_na_casa', 'falta_entrar_antecipado', 'falta_entrar_antecipado_feminino', 'falta_entrar_antecipado_masculino',
  'falta_entrar_porta_feminino', 'falta_entrar_porta_masculino', 'na_casa_feminino', 'na_casa_masculino',
  'cortesia_validada_feminino', 'cortesia_validada_masculino', 'cortesia_validada_sem_genero',
  'lista_convidados', 'lista_entraram', 'entradas_por_hora'];
const CAMPOS_BILHETERIA = ['bilheteria_total', 'bilheteria_sympla', 'bilheteria_porta', 'quantidade_venda_sympla', 'quantidade_checkin_sympla',
  'quantidade_venda_porta', 'quantidade_checkin_porta', 'cortesia_validada_total', 'ticket_medio_bilheteria'];
const CAMPOS_BAR = ['faturamento_bar', 'faturamento_bar_recebido', 'consumo_por_hora', 'ticket_medio_bar'];

export function filtrarPainel(d, perm) {
  if (!d) return null;
  const naCasa = Number(d.pessoas_na_casa) || 0;
  const x = Object.assign({}, d, {
    cortesia_validada_total: (Number(d.cortesia_validada_feminino) || 0) + (Number(d.cortesia_validada_masculino) || 0) + (Number(d.cortesia_validada_sem_genero) || 0),
    ticket_medio_bilheteria: naCasa ? (Number(d.bilheteria_total) || 0) / naCasa : 0,
    ticket_medio_bar: naCasa ? (Number(d.faturamento_bar_recebido) || 0) / naCasa : 0
  });
  const campos = CAMPOS_BASE.concat(perm.contagem ? CAMPOS_CONTAGEM : [], perm.bilheteria ? CAMPOS_BILHETERIA : [], perm.bar ? CAMPOS_BAR : []);
  const saida = {};
  for (const c of campos) if (x[c] !== undefined) saida[c] = x[c];
  // frescor das fontes só para quem enxerga dinheiro/contagem completa (admin vê tudo na tela de saúde)
  if (perm.contagem && perm.bilheteria && perm.bar) saida.fontes = d.fontes;
  saida.perm = perm;
  return saida;
}

// ---------- token da Zig (muda toda semana; fica criptografado e nunca volta para a tela) ----------
export async function guardarTokenZig(env, db, token) {
  const k = await chaveDerivada(env, 'cripto', 'aes');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(token)));
  const junto = new Uint8Array(iv.length + ct.length); junto.set(iv); junto.set(ct, iv.length);
  const agora = new Date().toISOString();
  await db.ins('pt_config', [{ chave: 'zig_token', valor: b64u(junto), atualizado_em: agora }], { upsert: true, conflito: 'chave' });
}
export async function lerTokenZig(env, db) {
  try {
    const r = await db.sel('pt_config', { select: 'valor,atualizado_em', chave: 'eq.zig_token' });
    if (!r || !r[0] || !r[0].valor) return null;
    const b = deB64(r[0].valor.replace(/-/g, '+').replace(/_/g, '/'));
    const k = await chaveDerivada(env, 'cripto', 'aes');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, k, b.slice(12));
    return { token: new TextDecoder().decode(pt), atualizado_em: r[0].atualizado_em };
  } catch (e) { return null; } // chave do banco trocada ou dado corrompido: cai para a variável antiga
}
// Ambiente com o token mais recente (o colado na tela de admin vale mais do que a variável antiga).
export async function envComTokenZig(env, db) {
  const t = await lerTokenZig(env, db);
  return t ? Object.assign({}, env, { ZIG_TOKEN: t.token }) : env;
}

// ---------- aparelho ----------
export async function rotuloAparelho(request) {
  const ua = request.headers.get('User-Agent') || '';
  const so = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : 'Outro';
  const nav = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return so + (nav ? ' · ' + nav : '') + ' · ' + (await sha256('ap|' + ua)).slice(0, 6);
}
