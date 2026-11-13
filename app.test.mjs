import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {createApplication} from '../server.mjs';

let app,base,temp,owner,other,admin,orderId,fileId,checkoutCalls=0;
const ORIGIN='http://smarttutors72.test';
const env={APP_ORIGIN:ORIGIN,NODE_ENV:'test',PAYMENTS_ENABLED:'false',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'};
const remoteFetch=async(url,options)=>{
  assert.equal(url,'https://api.stripe.com/v1/checkout/sessions');
  const params=options.body;assert.equal(params.get('line_items[0][price_data][unit_amount]'),'4500');
  assert.equal(params.get('line_items[0][price_data][currency]'),'usd');
  checkoutCalls++;
  return new Response(JSON.stringify({id:'cs_test_fixture',url:'https://checkout.stripe.com/c/pay/test_fixture',expires_at:Number(params.get('expires_at'))}),{status:200,headers:{'Content-Type':'application/json'}});
};
async function client(){
  let cookie='',csrf='';
  const call=async(route,{method='GET',body,headers={}}={})=>{
    const all={Origin:ORIGIN,Cookie:cookie,'X-CSRF-Token':csrf,...headers};
    if(body!==undefined && !Buffer.isBuffer(body)){all['Content-Type']='application/json';body=JSON.stringify(body);}
    const response=await fetch(base+route,{method,headers:all,body});
    const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
    const type=response.headers.get('content-type');
    const data=type?.includes('application/json')?await response.json():await response.text();
    if(data.csrf)csrf=data.csrf;
    return {status:response.status,data,headers:response.headers};
  };
  await call('/api/session');return {call};
}
async function signedEvent(event,signatureTime=Math.floor(Date.now()/1000)){
  const raw=JSON.stringify(event),sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${signatureTime}.${raw}`).digest('hex');
  return fetch(base+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${signatureTime},v1=${sig}`},body:raw});
}
before(async()=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'st72-test-'));
  app=await createApplication({dataDir:temp,env,fetch:remoteFetch});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  await app.createAdmin('Test Admin','admin@example.test','A test admin password 72!');
  owner=await client();other=await client();admin=await client();
});
after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();await rm(temp,{recursive:true,force:true});});

test('confirmed business information and safe configuration defaults',async()=>{
  const r=await owner.call('/api/config');assert.equal(r.status,200);assert.equal(r.data.email,'smarttutors72@gmail.com');assert.equal(r.data.services[0].rate,1000);assert.equal(r.data.wordsPerPage,null);assert.equal(r.data.paymentsAvailable,false);assert.equal(r.data.policiesPublished,false);assert.equal(r.data.STRIPE_SECRET_KEY,undefined);
  const home=await owner.call('/');assert.equal(home.status,200);assert.match(home.data,/SmartTutors72/);assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('CSRF and cross-origin requests are rejected',async()=>{
  assert.equal((await owner.call('/api/auth/register',{method:'POST',body:{},headers:{'X-CSRF-Token':'invalid'}})).status,403);
  assert.equal((await owner.call('/api/auth/register',{method:'POST',body:{},headers:{Origin:'https://attacker.example'}})).status,403);
});
test('registration validates passwords and stores a hash',async()=>{
  assert.equal((await owner.call('/api/auth/register',{method:'POST',body:{name:'Customer One',email:'one@example.test',password:'short'}})).status,400);
  const r=await owner.call('/api/auth/register',{method:'POST',body:{name:'Customer One',email:'one@example.test',password:'A customer password 72!',role:'admin'}});assert.equal(r.status,201);assert.equal(r.data.user.role,'customer');assert.equal(r.data.user.password,undefined);assert.notEqual(app.db.prepare('SELECT password FROM users WHERE email=?').get('one@example.test').password,'A customer password 72!');
  assert.equal((await other.call('/api/auth/register',{method:'POST',body:{name:'Customer Two',email:'two@example.test',password:'Another customer password 72!'}})).status,201);
  assert.equal((await admin.call('/api/auth/login',{method:'POST',body:{email:'admin@example.test',password:'A test admin password 72!'}})).status,200);
});
test('server calculates estimates and ignores client price or status overrides',async()=>{
  const estimate=await owner.call('/api/estimate',{method:'POST',body:{service:'editing',quantity:3,price:1}});assert.equal(estimate.data.estimate_cents,3000);
  assert.equal((await owner.call('/api/estimate',{method:'POST',body:{service:'editing',quantity:-1}})).status,400);
  const r=await owner.call('/api/orders',{method:'POST',body:{service:'editing',quantity:3,title:'Integration test project',instructions:'Please proofread my sample document.',timezone:'Africa/Nairobi',language:'UK English',estimate_cents:1,quoted_cents:1,status:'completed',payment_status:'paid'}});assert.equal(r.status,201);orderId=r.data.order.id;assert.equal(r.data.order.estimate_cents,3000);assert.equal(r.data.order.quoted_cents,null);assert.equal(r.data.order.payment_status,'unpaid');assert.equal(r.data.order.status,'awaiting_quote');
});
test('customers cannot access other orders or administrator data',async()=>{
  assert.equal((await other.call(`/api/orders/${orderId}`)).status,404);
  assert.equal((await owner.call('/api/admin')).status,403);
  assert.equal((await owner.call(`/api/admin/orders/${orderId}`,{method:'PATCH',body:{quoted_cents:1}})).status,403);
  assert.equal((await other.call('/api/orders')).data.orders.length,0);
});
test('private uploads enforce ownership, type validation and deliverable permission',async()=>{
  const uploaded=await owner.call(`/api/orders/${orderId}/files`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':'brief.txt'},body:Buffer.from('A private sample brief.')});assert.equal(uploaded.status,201);fileId=uploaded.data.id;
  assert.equal((await owner.call(`/api/files/${fileId}`)).data,'A private sample brief.');
  assert.equal((await other.call(`/api/files/${fileId}`)).status,404);
  assert.equal((await owner.call(`/api/orders/${orderId}/files`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':'bad.pdf'},body:Buffer.from('not a pdf')})).status,400);
  assert.equal((await owner.call(`/api/orders/${orderId}/files`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':'app.html'},body:Buffer.from('<script>alert(1)</script>')})).status,400);
  assert.equal((await owner.call(`/api/orders/${orderId}/files`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':'result.txt','X-File-Kind':'deliverable'},body:Buffer.from('test')})).status,403);
});
test('messages persist and invalid deadlines are rejected',async()=>{
  assert.equal((await owner.call(`/api/orders/${orderId}/messages`,{method:'POST',body:{message:'Please keep my original voice.'}})).status,201);
  const r=await owner.call(`/api/orders/${orderId}`);assert.equal(r.data.messages.length,1);assert.equal(r.data.files.length,1);
  assert.equal((await owner.call('/api/orders',{method:'POST',body:{service:'editing',quantity:1,title:'Invalid date',instructions:'test',deadline:'2020-01-01T00:00:00Z'}})).status,400);
});
test('quotes require a page definition and policies are validated',async()=>{
  assert.equal((await admin.call(`/api/admin/orders/${orderId}`,{method:'PATCH',body:{quoted_cents:4500}})).status,400);
  const s=(await admin.call('/api/admin')).data.settings;
  s.wordsPerPage=275;s.policiesPublished=true;
  assert.equal((await admin.call('/api/admin/settings',{method:'PUT',body:s})).status,400);
  for(const key of ['privacy','terms','refunds','revisions'])s.policies[key]='Test-only policy text for the isolated integration test database. This is not a business policy.';
  assert.equal((await admin.call('/api/admin/settings',{method:'PUT',body:s})).status,200);
  assert.equal((await admin.call(`/api/admin/orders/${orderId}`,{method:'PATCH',body:{quoted_cents:4500}})).status,200);
  const r=await owner.call(`/api/orders/${orderId}`);assert.equal(r.data.order.quoted_cents,4500);assert.equal(r.data.order.details.wordsPerPage,275);assert.equal(r.data.order.status,'awaiting_payment');
});
test('checkout stays disabled without configuration; return URL never marks paid',async()=>{
  assert.equal((await owner.call(`/api/orders/${orderId}/checkout`,{method:'POST',body:{acceptTerms:true}})).status,503);
  await owner.call(`/dashboard/${orderId}?payment=processing`);
  assert.equal((await owner.call(`/api/orders/${orderId}`)).data.order.payment_status,'unpaid');
  assert.equal((await owner.call(`/api/orders/${orderId}/receipt`)).status,409);
});
test('checkout uses the confirmed server quote and reuses an active session',async()=>{
  env.PAYMENTS_ENABLED='true';
  assert.equal((await owner.call(`/api/orders/${orderId}/checkout`,{method:'POST',body:{acceptTerms:false}})).status,400);
  const r=await owner.call(`/api/orders/${orderId}/checkout`,{method:'POST',body:{acceptTerms:true,amount:1}});assert.equal(r.status,200);assert.match(r.data.url,/checkout.stripe.com/);
  assert.equal((await owner.call(`/api/orders/${orderId}/checkout`,{method:'POST',body:{acceptTerms:true}})).status,200);assert.equal(checkoutCalls,1);
  assert.equal((await admin.call(`/api/admin/orders/${orderId}`,{method:'PATCH',body:{quoted_cents:9999}})).status,409);
});
test('webhook rejects forged, stale, and wrong-amount events; verified payment is idempotent',async()=>{
  const event={id:'evt_test_fixture',type:'checkout.session.completed',data:{object:{id:'cs_test_fixture',payment_status:'paid',currency:'usd',amount_total:4500,metadata:{order_id:orderId,quote_version:'1'}}}};
  const bad=await fetch(base+'/api/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':'t=1,v1=bad'},body:JSON.stringify(event)});assert.equal(bad.status,400);
  assert.equal((await signedEvent(event,Math.floor(Date.now()/1000)-600)).status,400);
  const wrong=structuredClone(event);wrong.data.object.amount_total=1;assert.equal((await signedEvent(wrong)).status,400);
  assert.equal((await signedEvent(event)).status,200);assert.equal((await signedEvent(event)).status,200);
  const r=await owner.call(`/api/orders/${orderId}`);assert.equal(r.data.order.payment_status,'paid');assert.equal(r.data.order.status,'received');assert.equal(r.data.events.filter(e=>e.label.startsWith('Payment received')).length,1);
  assert.equal((await owner.call(`/api/orders/${orderId}/receipt`)).status,200);
});
test('delivery, revision, and completion follow the order workflow',async()=>{
  assert.equal((await admin.call(`/api/admin/orders/${orderId}`,{method:'PATCH',body:{status:'ready_for_review'}})).status,400);
  assert.equal((await admin.call(`/api/orders/${orderId}/files`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':'edited.txt','X-File-Kind':'deliverable'},body:Buffer.from('Your edited document.')})).status,201);
  assert.equal((await admin.call(`/api/admin/orders/${orderId}`,{method:'PATCH',body:{status:'ready_for_review'}})).status,200);
  assert.equal((await owner.call(`/api/orders/${orderId}/revision`,{method:'POST',body:{message:'Please review the introduction.'}})).status,200);
  assert.equal((await owner.call(`/api/orders/${orderId}`)).data.order.status,'revision_requested');
  await admin.call(`/api/admin/orders/${orderId}`,{method:'PATCH',body:{status:'ready_for_review'}});
  assert.equal((await owner.call(`/api/orders/${orderId}/complete`,{method:'POST'})).status,200);
  assert.equal((await owner.call(`/api/orders/${orderId}`)).data.order.status,'completed');
});
test('contact inquiries persist without claiming an email was sent',async()=>{
  const r=await other.call('/api/contact',{method:'POST',body:{name:'Test Contact',email:'contact@example.test',subject:'A question',message:'I need help editing my document.',website:''}});assert.equal(r.status,201);assert.match(r.data.message,/received/);assert.equal((await admin.call('/api/admin')).data.inquiries.length,1);
});
test('password reset is explicit when email is not configured, logout removes access',async()=>{
  assert.equal((await other.call('/api/auth/forgot',{method:'POST',body:{email:'two@example.test'}})).status,503);
  assert.equal((await other.call('/api/auth/logout',{method:'POST'})).status,200);
  assert.equal((await other.call('/api/orders')).status,401);
});
test('source files, environment files and private storage are never served',async()=>{
  for(const route of ['/server.mjs','/.env','/data/smarttutors72.sqlite','/uploads/'+fileId])assert.equal((await owner.call(route)).status,404);
  assert.equal((await owner.call('/sitemap.xml')).status,200);
});
