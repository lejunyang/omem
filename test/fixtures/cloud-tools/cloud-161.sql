create table if not exists cloud_tool_usage (
     run_id text primary key references runs(id) on delete cascade, calls integer not null, errors integer not null default 0,
     last_error text, at text not null
   );
   create index if not exists cloud_tool_usage_at on cloud_tool_usage(at);
