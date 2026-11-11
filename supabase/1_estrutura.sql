-- Bosque · Painel em tempo real
-- Rodar no Supabase (o MESMO projeto do sistema de pedidos e da análise) → SQL Editor → New query → colar tudo → Run.
-- Cria só tabelas com prefixo pt_ ; não mexe nas tabelas dos pedidos nem nas da análise (an_).

-- Noites de evento. As noites normais (quinta a domingo) o coletor reconhece sozinho; esta tabela guarda as extras
-- (feriado, segunda etc.) que a Annie marca no calendário.
create table if not exists pt_noites (
  dia           date primary key,               -- dia em que a noite começa
  evento        text not null default '',
  extra         boolean not null default false, -- true = marcada à mão pela Annie
  ativa         boolean not null default true,
  criado_em     timestamptz not null default now()
);

-- Pessoas com acesso ao painel. O link e o PIN ficam só como hash (não dá para ler de volta).
create table if not exists pt_pessoas (
  id             bigint generated always as identity primary key,
  nome           text not null,
  modelo         text not null default '',        -- sócios_bsqnt | socios_sexta | socios_sabado | socios_sambinha | full | operacional | outro
  chave_hash     text not null unique,            -- hash do link pessoal
  pin_hash       text not null,                   -- hash do PIN de 6 dígitos
  dias           smallint[] not null default '{}',-- 0 = domingo … 6 = sábado
  datas          date[] not null default '{}',    -- datas avulsas (feriado / dia extra)
  perm_contagem  boolean not null default true,   -- na casa, gênero, lista, gráfico de horário de entrada
  perm_bilheteria boolean not null default false, -- Sympla, porta, cortesia, valores, ticket médio da bilheteria
  perm_bar       boolean not null default false,  -- faturamento do bar, ticket médio do bar, gráfico de consumo
  ativo          boolean not null default true,
  validade       date,                            -- vazio = sem validade
  erros_pin      smallint not null default 0,
  bloqueado_ate  timestamptz,
  criado_em      timestamptz not null default now()
);

-- Quem entrou e quando (para a Annie ver quem está acessando).
create table if not exists pt_acessos (
  id          bigint generated always as identity primary key,
  pessoa_id   bigint not null references pt_pessoas(id) on delete cascade,
  em          timestamptz not null default now(),
  aparelho    text not null default '',           -- identificador do aparelho (hash), para contar aparelhos por link
  noite       date
);
create index if not exists pt_acessos_pessoa_em on pt_acessos (pessoa_id, em desc);

-- Último dado bom de cada fonte, por noite: cada fonte guarda a própria hora de atualização.
create table if not exists pt_fontes (
  noite         date not null,
  fonte         text not null,                    -- sympla | zig_ingressos | zig_bar | ugo
  dados         jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz,                      -- última vez com sucesso
  tentativa_em  timestamptz,                      -- última vez que tentou
  erro          text not null default '',         -- último erro (vazio = ok)
  primary key (noite, fonte)
);

-- Painel consolidado da noite (o que a tela lê).
create table if not exists pt_painel (
  noite         date primary key,
  dados         jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

-- Configurações (ex.: token da Zig, que muda toda semana; guardado criptografado).
create table if not exists pt_config (
  chave         text primary key,
  valor         text not null default '',
  atualizado_em timestamptz not null default now()
);

-- Segurança: ninguém acessa estas tabelas pela internet; só o servidor, com a chave secreta.
alter table pt_noites   enable row level security;
alter table pt_pessoas  enable row level security;
alter table pt_acessos  enable row level security;
alter table pt_fontes   enable row level security;
alter table pt_painel   enable row level security;
alter table pt_config   enable row level security;
