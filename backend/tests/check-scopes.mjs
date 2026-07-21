import fs from 'node:fs';
const token = fs.readFileSync(process.env.HOME + '/Documents/shopify_token.txt', 'utf8').trim();
const resp = await fetch('https://q1udf0-1s.myshopify.com/admin/oauth/access_scopes.json', {
  headers: { 'X-Shopify-Access-Token': token }
});
const data = await resp.json().catch(() => ({}));
console.log('status:', resp.status);
console.log('scopes:', JSON.stringify(data, null, 2));
