export const SITUATIONS_MIGRATION = `
  alter table listen_contexts add column user_id text not null default 'owner';
  create table situation_instances (
    id text primary key, context_id text not null, user_id text not null,
    item_id text not null unique, conversation_id text not null unique, space_id text not null,
    title text not null, status text not null check(status in ('active','ended')),
    started_at text not null, window_until text not null, current text not null,
    summary text, ended_at text, closing_run text, closing_deadline text
  );
  create index situation_context_started on situation_instances(user_id,context_id,started_at desc);
  create index situation_owner_messages on messages(created_at,id) where role='user';
  create index situation_owner_lark on lark_messages(create_ms,message_id) where sender_kind='owner';
  create index situation_active on situation_instances(user_id,window_until) where status='active';
  create table situation_seen (
    context_id text not null, key text not null, instance_id text, at text not null,
    primary key(context_id,key)
  );
  create table situation_feedback (
    seq integer primary key, instance_id text not null, run_id text, actor text not null, text text not null
  );
  create index situation_seen_instance on situation_seen(instance_id);
  create index situation_feedback_instance on situation_feedback(instance_id,seq);
  create trigger situation_item_event after insert on item_events begin
    insert into situation_feedback(instance_id,run_id,actor,text)
      select id,new.run_id,new.actor,new.text from situation_instances where item_id=new.item_id and status='active' and length(new.text)>0;
  end;
  create trigger situation_item_change after insert on item_changes begin
    insert into situation_feedback(instance_id,run_id,actor,text)
      select id,new.run_id,new.origin,new.summary || coalesce('；'||new.detail,'') || coalesce('；'||new.risk,'') || coalesce('；'||new.next,'')
      from situation_instances where item_id=new.item_id and status='active';
  end;
  create trigger situation_item_change_added after update of added on item_changes when new.added is not old.added begin
    insert into situation_feedback(instance_id,run_id,actor,text)
      select id,json_extract(new.added,'$[#-1].runId'),json_extract(new.added,'$[#-1].origin'),new.summary || coalesce('；'||new.detail,'') || coalesce('；'||new.risk,'') || coalesce('；'||new.next,'')
      from situation_instances where item_id=new.item_id and status='active' and json_array_length(new.added)>0;
  end;
`;

export const SITUATION_CHAT_MIGRATION = `alter table situation_instances add column chat_id text;`;
