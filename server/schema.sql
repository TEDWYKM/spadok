-- ═══════════════════════════════════════════════════════════════════
-- СПАДОК · СХЕМА СЕРВЕРНОЇ ЧАСТИНИ
--
-- Проєкт і причини — docs/server.md. Тут те саме, але виконуване:
-- схему можна підняти локально й перевірити, що правила справді
-- тримаються, ДО того як платити за хостинг.
--
--   psql -f server/schema.sql
--   psql -f server/test.sql        -- 20 перевірок, жодного мокання
--
-- Головна ідея файлу в одному рядку:
--
--     foreign key (account_id, point_id) references visit (...)
--
-- Голос і коментар фізично не можуть існувати без відвідин тієї самої
-- точки тим самим акаунтом. Це не перевірка в коді, яку можна забути
-- під час рефакторингу, і не політика доступу, яку можна вимкнути —
-- це обмеження бази. Правило 1 зі спеки перестає бути домовленістю
-- і стає структурою.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Акаунт ─────────────────────────────────────────────────────────
-- Спершу анонімний, прив'язаний до пристрою. Пошта додається пізніше
-- і добровільно — тоді, коли накопичене вже шкода втратити.
create table account (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text,
  mark        text not null default 'path',
  -- Видимість профілю вимкнена за замовчуванням. Публічний профіль
  -- зі списком, де людина була і коли, — це історія переміщень.
  public      boolean not null default false,
  banned_at   timestamptz
);

create table device (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references account(id) on delete cascade,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

-- ── Каталог ────────────────────────────────────────────────────────
-- Переїжджає з www/js/data.js. Після переїзду зміна статусу перестає
-- вимагати релізу застосунку й стає редакційною роботою.
create table point (
  id         text primary key,
  region     text not null,
  lat        double precision not null,
  lon        double precision not null,
  status     text not null default 'ok'
             check (status in ('ok', 'warn', 'closed', 'occupied')),
  status_at  date not null default current_date
);

-- ── Відвідини ──────────────────────────────────────────────────────
-- Координат тут немає й не буде. Сервер отримує їх у момент
-- підтвердження, міряє відстань до точки, записує verified — і
-- викидає. Лишається «був у цій точці тоді-то» плюс похибка GPS,
-- за якою можна судити про надійність підтвердження.
--
-- Спека, правило 6: різниця між цим і журналом переміщень у наших
-- умовах може виявитись дуже великою.
create table visit (
  account_id  uuid not null references account(id) on delete cascade,
  point_id    text not null references point(id) on delete cascade,
  at          timestamptz not null default now(),
  verified    boolean not null,
  accuracy_m  int,
  primary key (account_id, point_id)
);

-- ── Вердикт місцю ──────────────────────────────────────────────────
create table vote (
  account_id  uuid not null,
  point_id    text not null,
  value       smallint not null check (value in (-1, 1)),
  reason      text,
  at          timestamptz not null default now(),
  primary key (account_id, point_id),
  foreign key (account_id, point_id)
    references visit (account_id, point_id) on delete cascade,
  -- Голий мінус і є замовчаний мінус: він каже, що щось не так,
  -- і не каже що. Тому причина обов'язкова — і на рівні бази теж,
  -- а не лише в застосунку, який можна обійти прямим запитом.
  constraint minus_needs_reason check (
    (value = 1 and reason is null) or (value = -1 and reason is not null)
  ),
  constraint known_reason check (
    reason is null or reason in ('closed', 'road', 'nothing', 'price', 'danger', 'wrong')
  )
);

-- ── Коментарі ──────────────────────────────────────────────────────
-- Пам'ятка і є тема, під нею — гілка. Ніхто не створює нових тем,
-- тож модерація втричі легша, а кожне слово прив'язане до місця,
-- яке людина бачила.
create table comment (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null,
  point_id    text not null,
  body        text not null check (length(btrim(body)) between 1 and 2000),
  at          timestamptz not null default now(),
  edited_at   timestamptz,
  hidden_at   timestamptz,
  foreign key (account_id, point_id)
    references visit (account_id, point_id) on delete cascade,
  -- Потрібно, щоб голос за коментар міг послатися на пару
  -- (коментар, точка) і не з'їхати на чужу точку.
  unique (id, point_id)
);

-- ── Голоси за коментарі ────────────────────────────────────────────
-- Два складені зовнішні ключі роблять усю роботу:
--   (account_id, point_id) → visit    ви були в цій точці;
--   (comment_id, point_id) → comment  коментар саме з цієї точки.
-- Разом вони означають: голосувати за коментар може лише той, хто
-- був там, де цей коментар написаний. Жодного коду, лише структура.
create table comment_vote (
  account_id  uuid not null,
  comment_id  uuid not null,
  point_id    text not null,
  value       smallint not null check (value in (-1, 1)),
  at          timestamptz not null default now(),
  primary key (account_id, comment_id),
  foreign key (account_id, point_id)
    references visit (account_id, point_id) on delete cascade,
  foreign key (comment_id, point_id)
    references comment (id, point_id) on delete cascade
);

-- Свій коментар не піднімають. Реддіт автоматично ставить автору плюс;
-- тут карма означає «інші вважають це корисним», тож власний голос
-- зробив би її самопроголошеною.
create or replace function no_self_vote() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from comment c
             where c.id = new.comment_id and c.account_id = new.account_id) then
    raise exception 'не можна голосувати за власний коментар';
  end if;
  return new;
end $$;

create trigger comment_vote_no_self
  before insert or update on comment_vote
  for each row execute function no_self_vote();

-- ── Оновлення статусу ──────────────────────────────────────────────
-- Статус точки — це те, через що люди їдуть або не їдуть за сто
-- кілометрів. Тому карма нараховується не за твердження, а за
-- підтверджене твердження: інакше її можна накрутити за вечір,
-- позначивши «зачинено» на всіх точках поспіль.
create table status_report (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  point_id      text not null,
  status        text not null
                check (status in ('ok', 'warn', 'closed', 'occupied')),
  at            timestamptz not null default now(),
  confirmed_at  timestamptz,
  foreign key (account_id, point_id)
    references visit (account_id, point_id) on delete cascade
);

-- Взаємне підтвердження: другий, хто сказав те саме про ту саму точку,
-- підтверджує і себе, і першого. Модератор може підтвердити окремо.
create or replace function confirm_status_reports() returns trigger
language plpgsql as $$
declare mate uuid;
begin
  select id into mate from status_report
   where point_id = new.point_id
     and status = new.status
     and account_id <> new.account_id
     and confirmed_at is null
     and at > now() - interval '60 days'
   order by at limit 1;

  if mate is not null then
    update status_report set confirmed_at = now() where id = mate;
    new.confirmed_at := now();
    update point set status = new.status, status_at = current_date
     where id = new.point_id;
  end if;
  return new;
end $$;

create trigger status_report_confirm
  before insert on status_report
  for each row execute function confirm_status_reports();

-- ── Скарги й блокування ────────────────────────────────────────────
create table report (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references account(id) on delete cascade,
  target_type  text not null check (target_type in ('comment', 'account')),
  target_id    text not null,
  reason       text not null,
  at           timestamptz not null default now(),
  resolved_at  timestamptz
);

create table block (
  account_id  uuid not null references account(id) on delete cascade,
  blocked_id  uuid not null references account(id) on delete cascade,
  at          timestamptz not null default now(),
  primary key (account_id, blocked_id),
  check (account_id <> blocked_id)
);

-- ── Порядок: нижня межа інтервалу Вілсона ──────────────────────────
-- Не «плюси мінус мінуси»: проста різниця винагороджує прохідність,
-- а не якість, і площа Ринок назавжди обжене забуту фортецю.
-- Тут — «яка частка схвалює, з поправкою на те, наскільки ми в цьому
-- впевнені». Мала вибірка притягується до середини.
create or replace function wilson(up bigint, down bigint)
returns double precision
language sql immutable as $$
  select case when up + down = 0 then 0::double precision else
    (
      (up::double precision / (up + down))
      + 1.96 * 1.96 / (2 * (up + down))
      - 1.96 * sqrt(
          ( (up::double precision / (up + down))
            * (1 - up::double precision / (up + down))
            + 1.96 * 1.96 / (4 * (up + down))
          ) / (up + down)
        )
    ) / (1 + 1.96 * 1.96 / (up + down))
  end
$$;

-- ── Рахунок місця ──────────────────────────────────────────────────
-- Матеріалізуємо на запис, а не рахуємо на читання: карту з тисячею
-- точок відкривають частіше, ніж голосують.
create table point_score (
  point_id    text primary key references point(id) on delete cascade,
  up          bigint not null default 0,
  down        bigint not null default 0,
  score       double precision not null default 0,
  updated_at  timestamptz not null default now()
);

create or replace function refresh_point_score() returns trigger
language plpgsql as $$
declare pid text;
begin
  pid := coalesce(new.point_id, old.point_id);
  insert into point_score (point_id, up, down, score, updated_at)
  select pid,
         count(*) filter (where value = 1),
         count(*) filter (where value = -1),
         wilson(count(*) filter (where value = 1), count(*) filter (where value = -1)),
         now()
    from vote where point_id = pid
  on conflict (point_id) do update
    set up = excluded.up, down = excluded.down,
        score = excluded.score, updated_at = excluded.updated_at;
  return null;
end $$;

create trigger vote_score
  after insert or update or delete on vote
  for each row execute function refresh_point_score();

-- ── Карма ──────────────────────────────────────────────────────────
-- Не за кілометри. Таблиця «хто відвідав більше точок» винагороджує
-- накат: більше і швидше їздити, зокрема тоді, коли їхати не варто.
-- Рахуємо внесок — те, завдяки чому застосунок став кращим для інших.
--
-- Окремо варте уваги: «голоси лише від тих, хто там був» тут ніде
-- не написано умовою. Це випливає зі структури — інших голосів
-- у comment_vote просто не може існувати.
create view account_karma as
  select a.id as account_id,
         coalesce(k.karma, 0)  as karma,
         coalesce(c.comments, 0) as comments,
         coalesce(s.checks, 0)   as checks
    from account a
    left join (
      select c.account_id, sum(cv.value)::bigint as karma
        from comment c join comment_vote cv on cv.comment_id = c.id
       where c.hidden_at is null
       group by c.account_id
    ) k on k.account_id = a.id
    left join (
      select account_id, count(*)::bigint as comments
        from comment where hidden_at is null group by account_id
    ) c on c.account_id = a.id
    left join (
      select account_id, count(*)::bigint as checks
        from status_report where confirmed_at is not null group by account_id
    ) s on s.account_id = a.id;

-- Порядок коментарів у гілці — той самий Вілсон, що й для місць.
create view comment_ranked as
  select c.*,
         coalesce(v.up, 0) as up,
         coalesce(v.down, 0) as down,
         wilson(coalesce(v.up, 0), coalesce(v.down, 0)) as score
    from comment c
    left join (
      select comment_id,
             count(*) filter (where value = 1)  as up,
             count(*) filter (where value = -1) as down
        from comment_vote group by comment_id
    ) v on v.comment_id = c.id
   where c.hidden_at is null;
