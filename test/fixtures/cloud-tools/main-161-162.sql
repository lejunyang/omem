create table outlet_deliveries (
    seq integer primary key, outlet text not null, object_id text not null, user_id text not null,
    op text not null, dedup text not null, urgency text not null, state text not null default 'pending', due integer not null,
    attempts integer not null default 0, updated text, error text, ref text, identities text,
    unique(outlet, object_id, op)
  );
  create index outlet_due on outlet_deliveries(state,due);
  create index outlet_history on outlet_deliveries(user_id,outlet,updated desc);
  create index outlet_dedup on outlet_deliveries(outlet,dedup,seq);
  create unique index outlet_ask_ref on outlet_deliveries(outlet,ref,user_id) where op='ask';
  create index outlet_object on outlet_deliveries(object_id,op);
create index notifications_pushed_at on notifications(user_id,json_extract(context,'$.pushed.channel'),json_extract(context,'$.pushed.at') desc)
    where json_extract(context,'$.pushed.channel') is not null;
