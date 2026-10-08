const BASE_URL = 'https://public-api.foxreload.com';

async function request(env: any, path: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'X-API-Key': env.FOXRELOAD_API_KEY,
      'X-Currency': 'usd',
      'X-Language': 'en',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    throw new Error(`FoxReload error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Каталог: если categorySlug не задан — отдаём корневые категории,
// где вообще есть товары (withStockOnly=true).
// Если задан — тянем товары из этой категории И всех подкатегорий
// (includeDescendants=true), только те, что в наличии.
export async function getCatalog(env: any, categorySlug?: string) {
  if (!categorySlug) {
    const data = await request(env, '/api/categories/?withStockOnly=true&limit=200');
    return data;
  }

  // includeDescendants=true включает cursor-пагинацию.
  // Для магазина берём первую страницу (до 200 товаров).
  const data = await request(
    env,
    `/api/products/?categoryId=${encodeURIComponent(categorySlug)}&includeDescendants=true&withStockOnly=true&limit=200`
  );
  return data;
}

export async function getProduct(env: any, productId: string) {
  return request(env, `/api/products/${productId}`);
}

export async function createOrder(
  env: any,
  productId: string,
  quantity: number
) {
  return request(env, '/api/orders/', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ itemId: productId, quantity }],
    }),
  });
}

export async function getOrderStatus(env: any, orderId: string) {
  return request(env, `/api/orders/${orderId}`);
}
