import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getCatalog,
  getProduct,
  createOrder,
  getOrderStatus,
  verifyWebhookSignature,
} from './api/foxreload';
import {
  createCryptoInvoice,
  handleCryptoWebhook,
  createStarsInvoice,
  sendTelegramMessage,
} from './api/payments';
import { adminRouter } from './admin';

type Env = {
  DB: D1Database;
  FOXRELOAD_API_KEY: string;
  FOXRELOAD_WEBHOOK_SECRET: string;
  CRYPTO_PAY_TOKEN: string;
  ADMIN_PASSWORD: string;
  TELEGRAM_BOT_TOKEN: string;
  MARKUP_PERCENT: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// ============================================================
// ВАЛИДАЦИЯ TELEGRAM INIT DATA
// ============================================================
async function validateTelegram(c: any): Promise<number | null> {
  const initData = c.req.header('X-Telegram-Init-Data') || '';
  if (!initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const encoder = new TextEncoder();

    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secret = await crypto.subtle.sign(
      'HMAC',
      secretKey,
      encoder.encode(c.env.TELEGRAM_BOT_TOKEN)
    );

    const dataKey = await crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      dataKey,
      encoder.encode(dataCheckString)
    );

    const hashHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (hashHex !== hash) return null;

    const user = JSON.parse(params.get('user') || '{}');
    return user.id || null;
  } catch {
    return null;
  }
}

// ============================================================
// КАТАЛОГ
// ============================================================
app.get('/api/catalog/categories', async (c) => {
  try {
    return c.json(await getCatalog(c.env));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/catalog/products', async (c) => {
  try {
    const category = c.req.query('category') || '';
    return c.json(await getCatalog(c.env, category));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/catalog/product/:id', async (c) => {
  try {
    return c.json(await getProduct(c.env, c.req.param('id')));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ============================================================
// КОРЗИНА
// ============================================================
app.post('/api/cart/add', async (c) => {
  const userId = await validateTelegram(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const { productId, quantity } = await c.req.json();
  await c.env.DB.prepare(
    `INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)
     ON CONFLICT(user_id, product_id) DO UPDATE SET quantity = quantity + ?`
  )
    .bind(userId, productId, quantity, quantity)
    .run();

  return c.json({ ok: true });
});

app.get('/api/cart', async (c) => {
  const userId = await validateTelegram(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const items = await c.env.DB.prepare(
    'SELECT * FROM cart WHERE user_id = ?'
  )
    .bind(userId)
    .all();

  return c.json(items.results);
});

// ============================================================
// ОПЛАТА
// ============================================================
app.post('/api/pay/crypto', async (c) => {
  const userId = await validateTelegram(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const { productId, quantity } = await c.req.json();
  const product: any = await getProduct(c.env, productId);
  const markup = parseInt(c.env.MARKUP_PERCENT) / 100;
  const amount = parseFloat(product.price) * (1 + markup) * quantity;

  const invoice = await createCryptoInvoice(c.env, {
    amount: amount.toFixed(2),
    currency: 'USDT',
    description: `Order: ${product.name}`,
    payload: JSON.stringify({ userId, productId, quantity }),
  });

  return c.json({
    payUrl: invoice.mini_app_invoice_url || invoice.bot_invoice_url,
  });
});

app.post('/api/pay/stars', async (c) => {
  const userId = await validateTelegram(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const { productId, quantity } = await c.req.json();
  const product: any = await getProduct(c.env, productId);
  const markup = parseInt(c.env.MARKUP_PERCENT) / 100;
  const priceUsd = parseFloat(product.price) * (1 + markup) * quantity;
  // 1 Star ≈ $0.013 (грубая оценка)
  const starsAmount = Math.max(1, Math.ceil(priceUsd / 0.013));

  const invoiceLink = await createStarsInvoice(c.env, {
    amount: starsAmount,
    title: product.name,
    payload: JSON.stringify({ userId, productId, quantity }),
  });

  return c.json({ invoiceLink });
});

// ============================================================
// ВЕБХУК: CryptoBot (USDT)
// ============================================================
app.post('/webhook/crypto', async (c) => {
  try {
    const body = await c.req.json();
    const result = await handleCryptoWebhook(c.env, body);
    if (!result.success) return c.json({ ok: true });

    const { userId, productId, quantity } = JSON.parse(result.payload);
    const product: any = await getProduct(c.env, productId);
    const markup = parseInt(c.env.MARKUP_PERCENT) / 100;
    const amount = parseFloat(product.price) * (1 + markup) * quantity;

    // Создаём заказ у FoxReload
    const order: any = await createOrder(c.env, productId, quantity);

    await c.env.DB.prepare(
      `INSERT INTO orders (user_id, product_id, quantity, supplier_order_id, status, amount)
       VALUES (?, ?, ?, ?, 'paid', ?)`
    )
      .bind(userId, productId, quantity, order.id, amount)
      .run();

    // Если FoxReload уже вернул код — отдаём сразу
    await deliverIfReady(c.env, order);

    return c.json({ ok: true });
  } catch (e: any) {
    console.error('Crypto webhook error:', e);
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ============================================================
// ВЕБХУК: Telegram Stars
// ============================================================
app.post('/webhook/telegram', async (c) => {
  try {
    const update: any = await c.req.json();
    if (update.message?.successful_payment) {
      const payload = JSON.parse(
        update.message.successful_payment.invoice_payload
      );
      const { userId, productId, quantity } = payload;
      const product: any = await getProduct(c.env, productId);
      const markup = parseInt(c.env.MARKUP_PERCENT) / 100;
      const amount = parseFloat(product.price) * (1 + markup) * quantity;

      const order: any = await createOrder(c.env, productId, quantity);

      await c.env.DB.prepare(
        `INSERT INTO orders (user_id, product_id, quantity, supplier_order_id, status, amount)
         VALUES (?, ?, ?, ?, 'paid', ?)`
      )
        .bind(userId, productId, quantity, order.id, amount)
        .run();

      await deliverIfReady(c.env, order);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    console.error('Telegram webhook error:', e);
    return c.json({ ok: true });
  }
});

// ============================================================
// ВЕБХУК: FoxReload (заказ выполнен)
// ============================================================
app.post('/webhook/foxreload', async (c) => {
  try {
    const rawBody = await c.req.text();
    const signature = c.req.header('X-Webhook-Signature') || '';

    const valid = await verifyWebhookSignature(
      c.env,
      rawBody,
      signature
    );
    if (!valid) {
      console.error('Invalid FoxReload webhook signature');
      return c.json({ ok: false }, 401);
    }

    const event = JSON.parse(rawBody);

    if (event.type === 'order.completed') {
      await deliverIfReady(c.env, event.data);
    }

    return c.json({ ok: true });
  } catch (e: any) {
    console.error('FoxReload webhook error:', e);
    return c.json({ ok: true });
  }
});

// ============================================================
// ДОСТАВКА КОДА ПОЛЬЗОВАТЕЛЮ
// ============================================================
async function deliverIfReady(env: Env, supplierOrder: any) {
  if (!supplierOrder || !supplierOrder.items) return;

  const codes: string[] = [];
  for (const item of supplierOrder.items) {
    if (item.fulfillmentStatus === 'completed' && item.externalData?.length) {
      codes.push(...item.externalData);
    }
  }

  if (codes.length === 0) return;

  // Находим заказ в нашей БД
  const row: any = await env.DB.prepare(
    'SELECT id, user_id, delivered_at FROM orders WHERE supplier_order_id = ? LIMIT 1'
  )
    .bind(supplierOrder.id)
    .first();

  if (!row || row.delivered_at) return; // уже доставлено

  const message =
    `✅ <b>Ваш заказ выполнен!</b>\n\n` +
    `Код(ы):\n<code>${codes.join('\n')}</code>\n\n` +
    `Спасибо за покупку! 🎮`;

  await sendTelegramMessage(env, row.user_id, message);

  await env.DB.prepare(
    'UPDATE orders SET delivery_code = ?, delivered_at = CURRENT_TIMESTAMP WHERE id = ?'
  )
    .bind(codes.join('\n'), row.id)
    .run();
}

// ============================================================
// ЗАКАЗЫ ПОЛЬЗОВАТЕЛЯ
// ============================================================
app.get('/api/orders', async (c) => {
  const userId = await validateTelegram(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const orders = await c.env.DB.prepare(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC'
  )
    .bind(userId)
    .all();

  return c.json(orders.results);
});

// ============================================================
// АДМИН
// ============================================================
app.post('/admin/login', async (c) => {
  const { password } = await c.req.json();
  if (password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: 'Invalid password' }, 403);
  }
  return c.json({ ok: true, token: btoa(c.env.ADMIN_PASSWORD) });
});

app.route('/admin', adminRouter);

app.get('/', (c) => c.json({ status: 'ok', service: 'tg-shop' }));

export default app;
