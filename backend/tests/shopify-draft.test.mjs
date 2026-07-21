import { createCheckoutFromJob } from '../src/shopify.js';
import { buildFinalQuote } from '../src/quote.js';
import { notifyNewQuote } from '../src/notify.js';

const token = (await import('node:fs')).default.readFileSync(process.env.HOME + '/Documents/shopify_token.txt', 'utf8').trim();
process.env.SHOPIFY_ADMIN_TOKEN = token;
process.env.SHOPIFY_SHOP_DOMAIN = 'q1udf0-1s.myshopify.com';

const job = {
  id: 'test-' + Date.now(),
  file_name: 'test-cube.stl',
  material: 'pla',
  printer: 'x1c',
  infill: 20,
  layer_height: 0.28,
  supports: 'auto',
  contact_name: 'Test Customer',
  contact_phone: '+919999999999',
  contact_email: 'test@example.com',
  pincode: '680121',
  notes: 'Test order from fofus-quote',
  client_quote: buildFinalQuote({
    slicerResult: { weightG: 12.5, minutes: 45 },
    material: 'pla',
    printer: 'x1c',
  }),
};

console.log('Job quote:', job.client_quote);
const result = await createCheckoutFromJob(job);
console.log('Checkout created:', result);

// Test notification (will fail without token, that's ok)
const notify = await notifyNewQuote(job);
console.log('Notification:', notify);
