import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCatalog, getProduct, createOrder, getOrderStatus } from './api/foxreload';
import { createCryptoInvoice, handleCryptoWebhook, createStarsInvoice } from './api/payments';
import { adminRouter } from './admin';

type Env = {
  DB: D1Database;
  FOXRELOAD_API_KEY: string;
  CRYPTO_PAY_TOKEN: string;
  ADMIN_PASSWORD: string;
  TELEGRAM_BOT_TOKEN: string;
  MARKUP_PERCENT: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// ============================================================
// ВАЛИДАЦИЯ TELEGRAM INIT DATA (нативный Web Crypto)
// ============================================================
async function validateTelegram(c: any): Promise<number | null> {
  const initData = c.req.header('X-Telegram-Init-Data') || '';
  if (!initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    // Формируем data-check-string
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const encoder = new TextEncoder();

    // secret_key = HMAC_SHA256("WebAppData", bot_token)
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

    // hash = HMAC_SHA256(secret_key, data_check_string)
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
  } catch (e) {
    console.error('InitData validation error:', e);
    return null;
  }
}

// ============================================================
// КАТАЛОГ
// ============================================================
app.get('/api/catalog/categories', async (c) => {
  try {
    const categories = await getCatalog(c.env);
    return c.json(categories);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/catalog/products', async (c) => {
  try {
    const category = c.req.query('category') || '';
    const products = await getCatalog(c.env, category);
    return c.json(products);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/catalog/product/:id', async (c) => {
  try {
    const product = await getProduct(c.env, c.req.param('id'));
    return c.json(product);
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

app.delete('/api/cart/:productId', async (c) => {
  const userId = await validateTelegram(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  await c.env.DB.prepare('DELETE FROM cart WHERE user_id = ? AND product_id = ?')
    .bind(userId, c.req.param('productId'))
    .run();

  return c.json({ ok: true });
});

// ============================================================
// ОПЛАТА
// ============================================================
app.post('/api/pay/crypto', async (c) => {
  const userId = await validateTelegram(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const { productId, quantity } = await c.req.json();
  const product = await getProduct(c.env, productId);
  const markup = parseInt(c.env.MARKUP_PERCENT) / 100;
  const amount = product.price * (1 + markup) * quantity;

  const invoice = await createCryptoInvoice(c.env, {
    amount: amount.toFixed(2),
    currency: 'USDT',
    description: `Order for ${product.name}`,
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
  const product = await getProduct(c.env, productId);
  const starsAmount = Math.ceil(product.price * quantity * 100);

  const invoiceLink = await createStarsInvoice(c.env, {
    amount: starsAmount,
    title: product.name,
    payload: JSON.stringify({ userId, productId, quantity }),
  });

  return c.json({ invoiceLink });
});

// ============================================================
// ВЕБХУКИ
// ============================================================
app.post('/webhook/crypto', async (c) => {
  try {
    const body = await c.req.json();
    const result = await handleCryptoWebhook(c.env, body);

    if (result.success) {
      const { userId, productId, quantity } = JSON.parse(result.payload);
      const order = await createOrder(c.env, productId, quantity);

      await c.env.DB.prepare(
        `INSERT INTO orders (user_id, product_id, quantity, supplier_order_id, status)
         VALUES (?, ?, ?, ?, 'paid')`
      )
        .bind(userId, productId, quantity, order.id)
        .run();
    }
    return c.json({ ok: true });
  } catch (e: any) {
    console.error('Crypto webhook error:', e);
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/webhook/telegram', async (c) => {
  try {
    const update: any = await c.req.json();
    if (update.message?.successful_payment) {
      const payload = JSON.parse(
        update.message.successful_payment.invoice_payload
      );
      const { userId, productId, quantity } = payload;

      const order = await createOrder(c.env, productId, quantity);
      await c.env.DB.prepare(
        `INSERT INTO orders (user_id, product_id, quantity, supplier_order_id, status)
         VALUES (?, ?, ?, ?, 'paid')`
      )
        .bind(userId, productId, quantity, order.id)
        .run();
    }
    return c.json({ ok: true });
  } catch (e: any) {
    console.error('Telegram webhook error:', e);
    return c.json({ ok: true });
  }
});

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
// АДМИН-ПАНЕЛЬ
// ============================================================
// Публичный маршрут логина — регистрируем ДО монтирования adminRouter
app.post('/admin/login', async (c) => {
  const { password } = await c.req.json();
  if (password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: 'Invalid password' }, 403);
  }
  return c.json({ ok: true, token: btoa(c.env.ADMIN_PASSWORD) });
});

// Защищённые админские маршруты
app.route('/admin', adminRouter);

// ============================================================
// HEALTHCHECK
// ============================================================
app.get('/', (c) => c.json({ status: 'ok', service: 'tg-shop' }));

export default app;
