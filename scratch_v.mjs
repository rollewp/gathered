import pg from "pg";
const c=new pg.Client({connectionString:process.env.DATABASE_OWNER_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const q=async(s,p)=>(await c.query(s,p)).rows;
console.log("REQ",JSON.stringify(await q("select jr.request_id,jr.status,jr.requested_at,g.name,g.meeting_slot from app.join_request jr join app.grp g using(group_id) join app.person p using(person_id) where p.first_name='Marcus' order by requested_at desc limit 4")));
console.log("ESC",JSON.stringify(await q("select escalation_id,status,created_at,evidence->>'request_id' rid from app.escalation order by created_at desc limit 5")));
console.log("AUD",JSON.stringify(await q("select id,action,entity_id,at,detail from app.audit_log order by id desc limit 12").catch(async()=>await q("select * from app.audit_log order by id desc limit 12"))));
console.log("PF",JSON.stringify(await q("select busy_slots,serving_areas,computed_at from app.person_features pf join app.person p using(person_id) where p.first_name='Marcus' and p.last_name='Hale'")));
await c.end();
