const BASE_URL = 'https://public-api.foxreload.com';

async function request(env: any, path: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'X-API-Key': env.FOXRELOAD_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    throw new Error(`FoxReload error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getCatalog(env: any, categorySlug?: string) {
  if (!categorySlug) {
    return request(env, '/api/categories/?limit=50');
  }
  return request(
    env,
    `/api/products/?category_id_or_slug=${encodeURIComponent(
      categorySlug
    )}&limit=100`
  );
}

export async function getProduct(env: any, productId: string) {
  return request(env, `/api/products/${productId}`);
}

export async function createOrder(
  env: any,
  productId: string,
  quantity: number
) {
  return request(env, '/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ itemId: productId, quantity }],
    }),
  });
}

export async function getOrderStatus(env: any, orderId: string) {
  return request(env, `/api/orders/${orderId}`);
}
