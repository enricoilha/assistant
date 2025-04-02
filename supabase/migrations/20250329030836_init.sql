-- Enable RLS (Row Level Security)
alter table if exists public.users enable row level security;
alter table if exists public.tasks enable row level security;
alter table if exists public.notifications enable row level security;
alter table if exists public.user_settings enable row level security;

-- Create users table (extends Supabase auth.users)
create table if not exists public.users (
  id uuid references auth.users not null primary key,
  email text not null,
  full_name text,
  phone_number text,
  push_token text,
  whatsapp_connected boolean default false,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- Create tasks table
create table if not exists public.tasks (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users not null,
  title text not null,
  description text,
  scheduled_date timestamp with time zone not null,
  location text,
  participants text[],
  status text default 'pending' not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- Create notifications table
create table if not exists public.notifications (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users not null,
  task_id uuid references public.tasks,
  type text not null,
  title text,
  body text not null,
  scheduled_at timestamp with time zone not null,
  sent_at timestamp with time zone,
  status text default 'scheduled' not null,
  error_message text,
  created_at timestamp with time zone default now() not null
);

-- Create user_settings table
create table if not exists public.user_settings (
  user_id uuid references public.users primary key,
  whatsapp_notifications boolean default true,
  push_notifications boolean default true,
  reminder_times jsonb default '{"hour": 1, "minute": 15}',
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- Add indexes for performance
create index if not exists tasks_user_id_idx on public.tasks (user_id);
create index if not exists tasks_scheduled_date_idx on public.tasks (scheduled_date);
create index if not exists tasks_status_idx on public.tasks (status);
create index if not exists notifications_user_id_idx on public.notifications (user_id);
create index if not exists notifications_task_id_idx on public.notifications (task_id);
create index if not exists notifications_status_idx on public.notifications (status);
create index if not exists notifications_scheduled_at_idx on public.notifications (scheduled_at);

-- Add Row Level Security (RLS) policies
-- Users table policies
create policy "Users can view their own data" on public.users
  for select using (auth.uid() = id);

create policy "Users can update their own data" on public.users
  for update using (auth.uid() = id);

-- Tasks table policies
create policy "Users can view their own tasks" on public.tasks
  for select using (auth.uid() = user_id);

create policy "Users can insert their own tasks" on public.tasks
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own tasks" on public.tasks
  for update using (auth.uid() = user_id);

create policy "Users can delete their own tasks" on public.tasks
  for delete using (auth.uid() = user_id);

-- Notifications table policies
create policy "Users can view their own notifications" on public.notifications
  for select using (auth.uid() = user_id);

-- User settings table policies
create policy "Users can view their own settings" on public.user_settings
  for select using (auth.uid() = user_id);

create policy "Users can update their own settings" on public.user_settings
  for update using (auth.uid() = user_id);

-- Create triggers
-- Update timestamp trigger function
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Add trigger to users table
create trigger update_users_updated_at
before update on public.users
for each row execute procedure public.update_updated_at_column();

-- Add trigger to tasks table
create trigger update_tasks_updated_at
before update on public.tasks
for each row execute procedure public.update_updated_at_column();

-- Add trigger to user_settings table
create trigger update_user_settings_updated_at
before update on public.user_settings
for each row execute procedure public.update_updated_at_column();

-- Create a function to handle new user signup
create or replace function public.handle_new_user_signup()
returns trigger as $$
begin
  -- Insert into public users table
  insert into public.users (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  
  -- Create default user settings
  insert into public.user_settings (user_id)
  values (new.id);
  
  return new;
end;
$$ language plpgsql security definer;

-- Trigger for new user signup
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user_signup();

-- Function to check for upcoming tasks and schedule notifications
create or replace function public.schedule_task_notifications()
returns void as $$
declare
  task_record record;
  user_setting record;
  hour_before timestamp with time zone;
  minutes_before timestamp with time zone;
begin
  -- Loop through tasks that are upcoming and don't have notifications scheduled
  for task_record in 
    select t.* 
    from public.tasks t
    where t.status = 'pending'
    and t.scheduled_date > now()
    and not exists (
      select 1 from public.notifications n 
      where n.task_id = t.id and n.status = 'scheduled'
    )
  loop
    -- Get the user's notification settings
    select * into user_setting 
    from public.user_settings 
    where user_id = task_record.user_id;
    
    -- Calculate notification times
    hour_before := task_record.scheduled_date - interval '1 hour';
    minutes_before := task_record.scheduled_date - interval '15 minutes';
    
    -- Schedule push notification 1 hour before if enabled
    if user_setting.push_notifications and hour_before > now() then
      insert into public.notifications (
        user_id, task_id, type, title, body, scheduled_at, status
      ) values (
        task_record.user_id,
        task_record.id,
        'push',
        'Lembrete de Compromisso',
        'Você tem "' || task_record.title || '" em 1 hora.',
        hour_before,
        'scheduled'
      );
    end if;
    
    -- Schedule WhatsApp notification 15 minutes before if enabled
    if user_setting.whatsapp_notifications and minutes_before > now() then
      insert into public.notifications (
        user_id, task_id, type, title, body, scheduled_at, status
      ) values (
        task_record.user_id,
        task_record.id,
        'whatsapp',
        null,
        '⏰ *Lembrete*: Você tem "' || task_record.title || '" em 15 minutos.',
        minutes_before,
        'scheduled'
      );
    end if;
  end loop;
end;
$$ language plpgsql security definer;


create table if not exists public.conversation_states (
  id uuid default gen_random_uuid() primary key,
  phone_number text not null unique,
  state text not null,
  task_data jsonb not null default '{}'::jsonb,
  last_update_time timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null
);

-- Add indexes for performance
create index if not exists conversation_states_phone_number_idx on public.conversation_states (phone_number);
create index if not exists conversation_states_state_idx on public.conversation_states (state);
create index if not exists conversation_states_last_update_time_idx on public.conversation_states (last_update_time);

-- Enable RLS (Row Level Security)
alter table if exists public.conversation_states enable row level security;

-- Add RLS policies
create policy "Service accounts can manage conversation states" on public.conversation_states
  using (true)
  with check (true);

  -- Create conversation_history table
CREATE TABLE IF NOT EXISTS public.conversation_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Add index for phone number for faster queries
CREATE INDEX IF NOT EXISTS conversation_history_phone_number_idx ON public.conversation_history (phone_number);

-- Add index for updated_at to help with cleanup of old records
CREATE INDEX IF NOT EXISTS conversation_history_updated_at_idx ON public.conversation_history (updated_at);

-- Enable Row Level Security (RLS)
ALTER TABLE IF EXISTS public.conversation_history ENABLE ROW LEVEL SECURITY;

-- Add RLS policy to allow service account to manage history
CREATE POLICY "Service accounts can manage conversation history" ON public.conversation_history
  USING (true)
  WITH CHECK (true);

-- Add auto-update timestamp function (if not already exists)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add trigger to automatically update the updated_at column
DROP TRIGGER IF EXISTS update_conversation_history_updated_at ON public.conversation_history;
CREATE TRIGGER update_conversation_history_updated_at
BEFORE UPDATE ON public.conversation_history
FOR EACH ROW EXECUTE PROCEDURE public.update_updated_at_column();

-- Optional: Add a cleanup function to remove old conversation histories
-- This can be called periodically via a cron job
CREATE OR REPLACE FUNCTION public.cleanup_old_conversation_histories(days_to_keep INTEGER)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.conversation_history
  WHERE updated_at < (NOW() - (days_to_keep || ' days')::INTERVAL);
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Comment on table and columns for documentation
COMMENT ON TABLE public.conversation_history IS 'Stores conversation history for the WhatsApp assistant';
COMMENT ON COLUMN public.conversation_history.phone_number IS 'The WhatsApp phone number of the user';
COMMENT ON COLUMN public.conversation_history.messages IS 'JSON array of message objects with role, content, and timestamp';