import { useState, useEffect } from 'react';

const API_BASE = 'https://tg-shop.nazar-bronnikov22.workers.dev';

interface Product {
  id: string;
  name: string;
  price: string;
  currency?: string;
  quantity?: number;
  image?: string;
}

interface Category {
  id: string;
  slug: string;
  name: string;
}

function getInitData(): string {
  return window.Telegram?.WebApp?.initData || '';
}

export default function App() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [cart, setCart] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    if (activeCategory) loadProducts(activeCategory);
  }, [activeCategory]);

  async function loadCategories() {
    try {
      const res = await fetch(`${API_BASE}/api/catalog/categories`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.items || [];
      setCategories(list);
      if (list.length > 0) setActiveCategory(list[0].slug || list[0].id);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function loadProducts(category: string) {
    setLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/catalog/products?category=${encodeURIComponent(category)}`
      );
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.items || [];
      setProducts(list);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  function addToCart(productId: string) {
    setCart([...cart, productId]);
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  }

  async function checkout(method: 'crypto' | 'stars') {
    if (cart.length === 0 || busy) return;
    setBusy(true);

    try {
      const initData = getInitData();
      if (!initData) {
        alert('Откройте магазин через Telegram, а не в браузере');
        return;
      }

      const res = await fetch(`${API_BASE}/api/pay/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': initData,
        },
        body: JSON.stringify({ productId: cart[0], quantity: 1 }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert('Ошибка оплаты: ' + (data.error || res.status));
        return;
      }

      const url = data.payUrl || data.invoiceLink;
      if (!url) {
        alert('Сервер не вернул ссылку на оплату');
        return;
      }

      if (method === 'stars') {
        window.Telegram?.WebApp?.openInvoice(url, (status: string) => {
          if (status === 'paid') {
            alert('Оплата прошла. Товар придёт в чат с ботом.');
            setCart([]);
          } else if (status === 'failed') {
            alert('Платёж не прошёл');
          }
        });
      } else {
        window.Telegram?.WebApp?.openLink(url);
      }
    } catch (e: any) {
      alert('Ошибка: ' + (e.message || 'неизвестная'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header glass">
        <h1>🎮 Game Shop</h1>
        <div className="cart-badge">🛒 {cart.length}</div>
      </header>

      <div className="categories">
        {categories.map((cat) => (
          <button
            key={cat.slug || cat.id}
            className={`cat-btn ${activeCategory === (cat.slug || cat.id) ? 'active' : ''}`}
            onClick={() => setActiveCategory(cat.slug || cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loader">Загрузка...</div>
      ) : (
        <div className="products-grid">
          {products.map((product) => (
            <div key={product.id} className="product-card glass">
              <div className="product-image">
                {product.image ? (
                  <img src={product.image} alt={product.name} />
                ) : (
                  <div className="placeholder">🎁</div>
                )}
              </div>
              <div className="product-info">
                <h3>{product.name}</h3>
                <div className="price">
                  {parseFloat(product.price || '0').toFixed(2)}{' '}
                  {(product.currency || 'usd').toUpperCase()}
                </div>
              </div>
              <button className="buy-btn" onClick={() => addToCart(product.id)}>
                В корзину
              </button>
            </div>
          ))}
        </div>
      )}

      {cart.length > 0 && (
        <div className="checkout-bar glass">
          <div className="cart-info">🛒 {cart.length} товар(ов)</div>
          <div className="checkout-buttons">
            <button
              className="pay-btn crypto"
              disabled={busy}
              onClick={() => checkout('crypto')}
            >
              {busy ? '...' : 'USDT'}
            </button>
            <button
              className="pay-btn stars"
              disabled={busy}
              onClick={() => checkout('stars')}
            >
              {busy ? '...' : '⭐ Stars'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
