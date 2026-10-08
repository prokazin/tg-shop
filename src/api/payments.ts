const CRYPTO_PAY_BASE = 'https://pay.crypt.bot/api';

export async function createCryptoInvoice(
  env: any,
  params: {
    amount: string;
    currency: string;
    description: string;
    payload: string;
  }
) {
  const res = await fetch(`${CRYPTO_PAY_BASE}/createInvoice`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': env.CRYPTO_PAY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      currency_type: 'crypto',
      asset: params.currency,
      amount: params.amount,
      description: params.description,
      payload: params.payload,
      allow_comments: false,
      allow_anonymous: false,
      expires_in: 3600,
    }),
  });

  const data: any = await res.json();
  if (!data.ok) {
    throw new Error(data.error?.message || 'Crypto invoice failed');
  }
  return data.result;
}

export async function handleCryptoWebhook(env: any, body: any) {
  const { update_type, payload } = body;

  if (update_type === 'invoice_paid') {
    return {
      success: true,
      payload: payload.payload,
      amount: payload.amount,
    };
  }
  return { success: false };
}

export async function createStarsInvoice(
  env: any,
  params: { amount: number; title: string; payload: string }
) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: params.title,
        description: 'Digital goods purchase',
        payload: params.payload,
        currency: 'XTR',
        prices: [{ label: params.title, amount: params.amount }],
      }),
    }
  );

  const data: any = await res.json();
  if (!data.ok) {
    throw new Error(data.description || 'Stars invoice failed');
  }
  return data.result;
}
