-- ═══════════════════════════════════════════════════════════════════
-- СПАДОК · ПЕРЕВІРКА СХЕМИ
--
-- Сенс файлу: довести, що правила тримаються базою, а не обіцянкою.
-- Кожна перевірка або друкує «✓», або валить скрипт.
--
--   psql -f server/schema.sql -f server/test.sql
-- ═══════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

-- Дрібний помічник: очікуємо, що запит впаде. Якщо він пройшов —
-- правило не працює, і це провал.
create or replace function must_fail(sql text, what text) returns void
language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    raise notice '  ✓ % (база: %)', what, left(sqlerrm, 60);
    return;
  end;
  raise exception '  ✗ % — запит пройшов, хоча не мав', what;
end $$;

create or replace function must_be(cond boolean, what text) returns void
language plpgsql as $$
begin
  if cond then raise notice '  ✓ %', what;
  else raise exception '  ✗ %', what;
  end if;
end $$;

-- ── Підготовка ─────────────────────────────────────────────────────
insert into point (id, region, lat, lon) values
  ('olesko', 'lviv', 49.9686, 24.8963),
  ('tustan', 'lviv', 49.1361, 23.4139);

insert into account (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Бандура'),
  ('22222222-2222-2222-2222-222222222222', 'Друга'),
  ('33333333-3333-3333-3333-333333333333', 'Третій');

-- Перший був в Олеську, друга теж, третій — ніде.
insert into visit (account_id, point_id, verified, accuracy_m) values
  ('11111111-1111-1111-1111-111111111111', 'olesko', true, 8),
  ('22222222-2222-2222-2222-222222222222', 'olesko', true, 12);

\echo ''
\echo 'СПАДОК · перевірка схеми'
\echo ''
\echo '── Правило 1: усе, що впливає на інших, робиться з місця ──'

-- ── Гейт правила 1 ─────────────────────────────────────────────────
select must_fail($$
  insert into vote (account_id, point_id, value)
  values ('33333333-3333-3333-3333-333333333333', 'olesko', 1)
$$, 'вердикт без відвідин відхилено');

select must_fail($$
  insert into vote (account_id, point_id, value)
  values ('11111111-1111-1111-1111-111111111111', 'tustan', 1)
$$, 'вердикт іншій точці, де людина не була, відхилено');

select must_fail($$
  insert into comment (account_id, point_id, body)
  values ('33333333-3333-3333-3333-333333333333', 'olesko', 'Гарно')
$$, 'коментар без відвідин відхилено');

-- ── Мінус без причини ──────────────────────────────────────────────
\echo ''
\echo '── Мінус мусить пояснювати себе ──'

select must_fail($$
  insert into vote (account_id, point_id, value)
  values ('11111111-1111-1111-1111-111111111111', 'olesko', -1)
$$, 'мінус без причини відхилено');

select must_fail($$
  insert into vote (account_id, point_id, value, reason)
  values ('11111111-1111-1111-1111-111111111111', 'olesko', -1, 'настрій')
$$, 'мінус із вигаданою причиною відхилено');

select must_fail($$
  insert into vote (account_id, point_id, value, reason)
  values ('11111111-1111-1111-1111-111111111111', 'olesko', 1, 'closed')
$$, 'плюс із причиною відхилено — причина тільки на мінусі');

insert into vote (account_id, point_id, value) values
  ('11111111-1111-1111-1111-111111111111', 'olesko', 1);
insert into vote (account_id, point_id, value, reason) values
  ('22222222-2222-2222-2222-222222222222', 'olesko', -1, 'road');
select must_be((select count(*) from vote) = 2, 'правильні вердикти прийнято');

-- ── Голоси за коментарі ────────────────────────────────────────────
\echo ''
\echo '── Голосувати за коментар може лише той, хто там був ──'

insert into comment (id, account_id, point_id, body) values
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 'olesko',
   'Каса зачиняється о 17:00, встигайте.');

select must_fail($$
  insert into comment_vote (account_id, comment_id, point_id, value)
  values ('33333333-3333-3333-3333-333333333333',
          'aaaaaaaa-0000-0000-0000-000000000001', 'olesko', 1)
$$, 'голос за коментар від того, хто там не був, відхилено');

select must_fail($$
  insert into comment_vote (account_id, comment_id, point_id, value)
  values ('22222222-2222-2222-2222-222222222222',
          'aaaaaaaa-0000-0000-0000-000000000001', 'tustan', 1)
$$, 'голос із підміненою точкою відхилено');

select must_fail($$
  insert into comment_vote (account_id, comment_id, point_id, value)
  values ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000001', 'olesko', 1)
$$, 'голос за власний коментар відхилено');

insert into comment_vote (account_id, comment_id, point_id, value) values
  ('22222222-2222-2222-2222-222222222222',
   'aaaaaaaa-0000-0000-0000-000000000001', 'olesko', 1);
select must_be(
  (select karma from account_karma
    where account_id = '11111111-1111-1111-1111-111111111111') = 1,
  'карма нарахувалась із голосу того, хто був на місці');

-- ── Оновлення статусу ──────────────────────────────────────────────
\echo ''
\echo '── Карма за статус — тільки після підтвердження ──'

insert into status_report (account_id, point_id, status) values
  ('11111111-1111-1111-1111-111111111111', 'olesko', 'closed');
select must_be(
  (select checks from account_karma
    where account_id = '11111111-1111-1111-1111-111111111111') = 0,
  'саме твердження карми ще не дає');
select must_be(
  (select status from point where id = 'olesko') = 'ok',
  'статус точки від одного повідомлення не змінився');

insert into status_report (account_id, point_id, status) values
  ('22222222-2222-2222-2222-222222222222', 'olesko', 'closed');
select must_be(
  (select checks from account_karma
    where account_id = '11111111-1111-1111-1111-111111111111') = 1
  and (select checks from account_karma
    where account_id = '22222222-2222-2222-2222-222222222222') = 1,
  'друге таке саме повідомлення підтвердило обидва');
select must_be(
  (select status from point where id = 'olesko') = 'closed',
  'підтверджене повідомлення змінило статус точки');

-- ── Порядок за Вілсоном ────────────────────────────────────────────
\echo ''
\echo '── Порядок: не «плюси мінус мінуси» ──'

select must_be(wilson(3, 0) < wilson(4000, 1000),
  'три голоси не б''ють чотири тисячі: ' ||
  round(wilson(3,0)::numeric, 3) || ' < ' || round(wilson(4000,1000)::numeric, 3));
select must_be(wilson(50, 0) > wilson(4000, 1000),
  'але й пʼятдесят одностайних не програють розміру: ' ||
  round(wilson(50,0)::numeric, 3) || ' > ' || round(wilson(4000,1000)::numeric, 3));
select must_be(wilson(0, 0) = 0, 'без голосів рахунок нульовий, а не помилка');
select must_be(
  (select round(score::numeric, 3) from point_score where point_id = 'olesko') =
  round(wilson(1, 1)::numeric, 3),
  'рахунок точки перерахувався сам при голосуванні');

-- ── Приватність ────────────────────────────────────────────────────
\echo ''
\echo '── Чого в схемі немає ──'

select must_be(
  not exists (
    select 1 from information_schema.columns
     where table_name = 'visit' and column_name in ('lat', 'lon')
  ),
  'у відвідинах немає координат — це не журнал переміщень');
select must_be(
  (select bool_and(not public) from account),
  'профіль за замовчуванням непублічний');

\echo ''
\echo 'Схема тримає правила без жодного рядка застосунку.'
\echo ''
