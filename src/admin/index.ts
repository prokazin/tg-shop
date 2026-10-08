import { Hono } from 'hono';

const adminRouter = new Hono<{ Bindings: any }>();

// Middleware: проверка токена
adminRouter.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (token !== btoa(c.env.ADMIN_PASSWORD)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});

// Статистика
adminRouter.get('/stats', async (c) => {
  const totalOrders: any = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM orders'
  ).first();

  const totalRevenue: any = await c.env.DB.prepare(
    'SELECT SUM(amount) as sum FROM orders WHERE status = ?'
  )
    .bind('paid')
    .first();

  return c.json({
    totalOrders: totalOrders?.count || 0,
    totalRevenue: totalRevenue?.sum || 0,
  });
});

// Все заказы
adminRouter.get('/orders', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = 50;
  const offset = (page - 1) * limit;

  const orders = await c.env.DB.prepare(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?'
  )
    .bind(limit, offset)
    .all();

  return c.json(orders.results);
});

// HTML-страница админки
adminRouter.get('/', async (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Panel</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      color: #fff; min-height: 100vh; padding: 20px;
    }
    .glass {
      background: rgba(255,255,255,0.08);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 20px; padding: 24px; margin-bottom: 20px;
    }
    h1 { font-size: 24px; margin-bottom: 20px; }
    .stat { font-size: 32px; font-weight: 700; color: #a78bfa; }
    .label { font-size: 14px; color: rgba(255,255,255,0.6); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
    th { color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase; }
    .login-form { max-width: 320px; margin: 100px auto; }
    input {
      width: 100%; padding: 14px; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.1); color: #fff;
      font-size: 16px; margin-bottom: 12px;
    }
    button {
      width: 100%; padding: 14px; border-radius: 12px; border: none;
      background: linear-gradient(135deg, #a78bfa, #7c3aed);
      color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const token = localStorage.getItem('admin_token');
    const app = document.getElementById('app');

    function renderLogin() {
      app.innerHTML = \`
        <div class="login-form glass">
          <h1>🔐 Admin Login</h1>
          <input type="password" id="password" placeholder="Пароль" />
          <button onclick="login()">Войти</button>
        </div>
      \`;
    }

    async function login() {
      const password = document.getElementById('password').value;
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (data.ok) {
        localStorage.setItem('admin_token', data.token);
        renderDashboard();
      } else {
        alert('Неверный пароль');
      }
    }

    async function renderDashboard() {
      const res = await fetch('/admin/stats', {
        headers: { 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') }
      });
      if (res.status === 403) {
        localStorage.removeItem('admin_token');
        renderLogin();
        return;
      }
      const stats = await res.json();

      app.innerHTML = \`
        <div class="glass">
          <h1>📊 Статистика</h1>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
            <div><div class="stat">\${stats.totalOrders}</div><div class="label">Заказов</div></div>
            <div><div class="stat">\${stats.totalRevenue} USDT</div><div class="label">Выручка</div></div>
          </div>
        </div>
        <div class="glass">
          <h1>📦 Последние заказы</h1>
          <div id="orders"></div>
        </div>
      \`;
      loadOrders();
    }

    async function loadOrders() {
      const res = await fetch('/admin/orders', {
        headers: { 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') }
      });
      const orders = await res.json();
      document.getElementById('orders').innerHTML = \`
        <table>
          <tr><th>ID</th><th>Товар</th><th>Кол-во</th><th>Статус</th></tr>
          \${orders.map(o => \`<tr><td>\${o.id}</td><td>\${o.product_id}</td><td>\${o.quantity}</td><td>\${o.status}</td></tr>\`).join('')}
        </table>
      \`;
    }

    if (token) renderDashboard(); else renderLogin();
  </script>
</body>
</html>`);
});

export { adminRouter };
