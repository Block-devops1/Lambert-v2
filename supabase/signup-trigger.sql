-- Every new signup gets a 'pending' row in user_access, so you can see and
-- approve them. Run in the staging project (and in production at cutover,
-- if production does not already have an equivalent).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_access (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill users who signed up before the trigger existed.
insert into public.user_access (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- To approve someone (replace the email):
-- update public.user_access set status = 'approved'
-- where user_id = (select id from auth.users where email = 'person@example.com');
