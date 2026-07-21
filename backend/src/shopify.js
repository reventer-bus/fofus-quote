// ════════════════════════════════════════════════════════════════════
// Shopify product + cart checkout integration for fofus-quote
// Creates a hidden product from the job and returns a Shopify cart URL.
// Uses write_products scope (available) instead of write_draft_orders.
// ════════════════════════════════════════════════════════════════════

export async function createCheckoutFromJob(job) {
  const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || 'q1udf0-1s.myshopify.com';
  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_TOKEN || '';
  const SHOPIFY_API_VERSION  = process.env.SHOPIFY_API_VERSION || '2024-07';

  function shopifyApiUrl(path) {
    return `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  }

  if (!SHOPIFY_ADMIN_TOKEN) {
    throw new Error('SHOPIFY_ADMIN_TOKEN not configured');
  }

  const quote = job.final_quote || job.client_quote || {};
  const total = Math.max(50, Math.round(quote.total_inr || quote.total || 0));
  const weightG = quote.weight_g || 0;
  const hours = quote.hours || (quote.minutes ? quote.minutes / 60 : 0);
  const materialName = (job.material || 'PLA').toUpperCase();
  const printerName = (
    job.printer === 'a1' ? 'Bambu Lab A1' :
    job.printer === 'x1c' ? 'Bambu Lab X1 Carbon' :
    'Creality K1 Max'
  );

  const title = `Custom 3D Print — ${job.file_name || 'model'}`;
  const description = `
    <p><strong>File:</strong> ${job.file_name || '—'}</p>
    <p><strong>Printer:</strong> ${printerName}</p>
    <p><strong>Material:</strong> ${materialName}</p>
    <p><strong>Infill:</strong> ${job.infill}%</p>
    <p><strong>Layer height:</strong> ${job.layer_height} mm</p>
    <p><strong>Supports:</strong> ${job.supports || 'auto'}</p>
    <p><strong>Estimated weight:</strong> ${weightG.toFixed(1)} g</p>
    <p><strong>Estimated print time:</strong> ${hours.toFixed(1)} hrs</p>
    <p><strong>Customer:</strong> ${job.contact_name || '—'} · ${job.contact_phone || '—'} · ${job.pincode || '—'}</p>
    <p><strong>Job ID:</strong> ${job.id}</p>
  `.trim();

  const metafields = [
    { namespace: 'fofus_quote', key: 'job_id', value: job.id, type: 'single_line_text_field' },
    { namespace: 'fofus_quote', key: 'customer_phone', value: job.contact_phone || '', type: 'single_line_text_field' },
    { namespace: 'fofus_quote', key: 'customer_email', value: job.contact_email || '', type: 'single_line_text_field' },
    { namespace: 'fofus_quote', key: 'pincode', value: job.pincode || '', type: 'single_line_text_field' },
    { namespace: 'fofus_quote', key: 'material', value: materialName, type: 'single_line_text_field' },
    { namespace: 'fofus_quote', key: 'printer', value: printerName, type: 'single_line_text_field' },
  ];

  // Create hidden product
  const productPayload = {
    product: {
      title,
      body_html: description,
      vendor: 'FOFUS',
      product_type: 'Custom 3D Print',
      status: 'draft',  // hidden from store but available via cart permalink
      tags: 'fofus-quote, custom-3d-print',
      variants: [{
        price: String(total),
        sku: `FQ-${job.id.slice(0, 8)}`,
        inventory_policy: 'continue',
        inventory_quantity: 1,
        requires_shipping: true,
      }],
      metafields,
    },
  };

  const createResp = await fetch(shopifyApiUrl('/products.json'), {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(productPayload),
  });

  if (!createResp.ok) {
    const text = await createResp.text();
    throw new Error(`Shopify product create ${createResp.status}: ${text.slice(0, 500)}`);
  }

  const productData = await createResp.json();
  const product = productData.product;
  const variant = product.variants[0];

  return {
    product_id: product.id,
    variant_id: variant.id,
    checkout_url: `https://${SHOPIFY_SHOP_DOMAIN}/cart/${variant.id}:1`,
    admin_url: `https://${SHOPIFY_SHOP_DOMAIN}/admin/products/${product.id}`,
  };
}
