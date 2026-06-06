import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ipaddr from 'ipaddr.js';
import { initDb, pool, closeDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const SHOP_ID = process.env.YOOKASSA_SHOP_ID || process.env.YOUKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || process.env.YOUKASSA_API_KEY;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || 'development';
const TRUST_PROXY = process.env.TRUST_PROXY || '1';
const CONTROL_PLANE_API_URL = process.env.CONTROL_PLANE_API_URL || 'http://host.docker.internal:8000';
const CONTROL_PLANE_INTERNAL_TOKEN = process.env.CONTROL_PLANE_INTERNAL_TOKEN;
const CONTROL_PLANE_SYNC_ENABLED = process.env.CONTROL_PLANE_SYNC_ENABLED !== 'false';
const ENFORCE_IP_FILTER =
  process.env.YOOKASSA_ENFORCE_IP_FILTER === 'true' ||
  (process.env.YOOKASSA_ENFORCE_IP_FILTER !== 'false' && NODE_ENV === 'production');

const app = express();
const parsedTrustProxy =
  TRUST_PROXY === 'true'
    ? true
    : TRUST_PROXY === 'false'
      ? false
      : /^\d+$/.test(TRUST_PROXY)
        ? Number(TRUST_PROXY)
        : TRUST_PROXY;
app.set('trust proxy', parsedTrustProxy);
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);

const YOOKASSA_WEBHOOK_CIDRS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.154.128/25',
  '2a02:5180::/32'
];

const YOOKASSA_WEBHOOK_SINGLE_IPS = ['77.75.156.11', '77.75.156.35'];

function requireYookassaConfig(res) {
  if (!SHOP_ID || !SECRET_KEY) {
    res.status(500).json({ error: 'YooKassa credentials are not configured' });
    return false;
  }
  return true;
}

function validateStartupConfig() {
  if (!SHOP_ID || !SECRET_KEY) {
    throw new Error('YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY are required');
  }

  if (NODE_ENV === 'production') {
    const base = new URL(BASE_URL);
    if (base.protocol !== 'https:') {
      throw new Error('BASE_URL must use HTTPS in production');
    }
  }

  if (CONTROL_PLANE_SYNC_ENABLED && !CONTROL_PLANE_INTERNAL_TOKEN) {
    throw new Error('CONTROL_PLANE_INTERNAL_TOKEN is required when control-plane sync is enabled');
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || '';
}

function normalizeIp(rawIp) {
  if (!rawIp) {
    return null;
  }

  if (rawIp.startsWith('::ffff:')) {
    return rawIp.slice(7);
  }
  return rawIp;
}

function isIpAllowed(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) {
    return false;
  }

  try {
    const parsedIp = ipaddr.parse(ip);

    for (const singleIp of YOOKASSA_WEBHOOK_SINGLE_IPS) {
      if (parsedIp.kind() === ipaddr.parse(singleIp).kind() && parsedIp.toString() === ipaddr.parse(singleIp).toString()) {
        return true;
      }
    }

    for (const cidr of YOOKASSA_WEBHOOK_CIDRS) {
      const [range, bits] = ipaddr.parseCIDR(cidr);
      if (parsedIp.kind() !== range.kind()) {
        continue;
      }
      if (parsedIp.match([range, bits])) {
        return true;
      }
    }

    return false;
  } catch (_error) {
    return false;
  }
}

function toAmountValue(amountRub) {
  const normalized = Number(amountRub);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  return normalized.toFixed(2);
}

function amountValueToKopecks(amountValue) {
  const normalized = Number(amountValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  return Math.round(normalized * 100);
}

function parseControlPlaneAccountId(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

function makeIdempotenceKey() {
  return crypto.randomUUID();
}

function makeAuthHeader() {
  return `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`;
}

function eventFingerprint(rawBody) {
  return crypto.createHash('sha256').update(rawBody || '').digest('hex');
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function mapPaymentRow(row) {
  return {
    payment_id: row.yookassa_payment_id,
    order_id: row.order_id,
    user_id: row.user_id,
    status: row.status,
    amount_value: row.amount_value,
    currency: row.currency,
    confirmation_url: row.confirmation_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_at: row.paid_at,
    canceled_at: row.canceled_at
  };
}

async function yookassaApiRequest({ method, apiPath, body, idempotenceKey }) {
  const headers = {
    Authorization: makeAuthHeader(),
    'Content-Type': 'application/json'
  };

  if (idempotenceKey) {
    headers['Idempotence-Key'] = idempotenceKey;
  }

  const response = await fetch(`https://api.yookassa.ru${apiPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }

  return { ok: response.ok, status: response.status, payload };
}

async function savePaymentRecord({
  payment,
  userId,
  orderId,
  planName,
  description,
  idempotenceKey
}) {
  const metadata = sanitizeMetadata(payment.metadata);
  const status = payment.status;

  const result = await pool.query(
    `
      INSERT INTO yookassa_payments (
        yookassa_payment_id,
        user_id,
        order_id,
        plan_name,
        amount_value,
        currency,
        status,
        description,
        idempotence_key,
        confirmation_url,
        yookassa_payload,
        metadata,
        paid_at,
        canceled_at
      ) VALUES (
        $1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
        CASE WHEN $7 = 'succeeded' THEN NOW() ELSE NULL END,
        CASE WHEN $7 = 'canceled' THEN NOW() ELSE NULL END
      )
      ON CONFLICT (yookassa_payment_id)
      DO UPDATE SET
        user_id = COALESCE(EXCLUDED.user_id, yookassa_payments.user_id),
        order_id = COALESCE(EXCLUDED.order_id, yookassa_payments.order_id),
        plan_name = COALESCE(EXCLUDED.plan_name, yookassa_payments.plan_name),
        amount_value = EXCLUDED.amount_value,
        currency = EXCLUDED.currency,
        status = EXCLUDED.status,
        description = COALESCE(EXCLUDED.description, yookassa_payments.description),
        idempotence_key = COALESCE(yookassa_payments.idempotence_key, EXCLUDED.idempotence_key),
        confirmation_url = COALESCE(EXCLUDED.confirmation_url, yookassa_payments.confirmation_url),
        yookassa_payload = EXCLUDED.yookassa_payload,
        metadata = EXCLUDED.metadata,
        paid_at = CASE WHEN EXCLUDED.status = 'succeeded' THEN COALESCE(yookassa_payments.paid_at, NOW()) ELSE yookassa_payments.paid_at END,
        canceled_at = CASE WHEN EXCLUDED.status = 'canceled' THEN COALESCE(yookassa_payments.canceled_at, NOW()) ELSE yookassa_payments.canceled_at END,
        updated_at = NOW()
      RETURNING *
    `,
    [
      payment.id,
      userId || null,
      orderId || metadata.order_id || null,
      planName || metadata.plan_name || null,
      payment.amount?.value || '0.00',
      payment.amount?.currency || 'RUB',
      status,
      description || payment.description || null,
      idempotenceKey || null,
      payment.confirmation?.confirmation_url || null,
      JSON.stringify(payment),
      JSON.stringify(metadata)
    ]
  );

  return result.rows[0];
}

async function getPaymentByIdempotenceKey(idempotenceKey) {
  const result = await pool.query(
    'SELECT * FROM yookassa_payments WHERE idempotence_key = $1 LIMIT 1',
    [idempotenceKey]
  );
  return result.rows[0] || null;
}

async function getPaymentByOrderId(orderId) {
  const result = await pool.query(
    'SELECT * FROM yookassa_payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
    [orderId]
  );
  return result.rows[0] || null;
}

async function getPaymentByYkId(paymentId) {
  const result = await pool.query(
    'SELECT * FROM yookassa_payments WHERE yookassa_payment_id = $1 LIMIT 1',
    [paymentId]
  );
  return result.rows[0] || null;
}

async function syncSucceededPaymentToControlPlane(payment) {
  if (!CONTROL_PLANE_SYNC_ENABLED || payment.status !== 'succeeded') {
    return { skipped: true };
  }

  const accountId = parseControlPlaneAccountId(payment.metadata?.user_id);
  const amountKopecks = amountValueToKopecks(payment.amount?.value);

  if (!accountId) {
    throw new Error('Payment metadata.user_id must be a numeric control-plane account id');
  }
  if (!amountKopecks) {
    throw new Error('Payment amount is invalid for control-plane top-up');
  }

  const response = await fetch(`${CONTROL_PLANE_API_URL}/v1/payments/external/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': CONTROL_PLANE_INTERNAL_TOKEN
    },
    body: JSON.stringify({
      telegram_id: accountId,
      amount_kopecks: amountKopecks,
      external_payment_id: payment.id,
      provider: 'yookassa'
    })
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }
    throw new Error(`Control-plane top-up failed (${response.status}): ${payload?.detail || payload?.error || 'unknown error'}`);
  }

  return response.json();
}

async function controlPlaneRequest({ method = 'GET', path: apiPath, body }) {
  if (!CONTROL_PLANE_INTERNAL_TOKEN) {
    const error = new Error('Control-plane token is not configured');
    error.status = 500;
    throw error;
  }

  const response = await fetch(`${CONTROL_PLANE_API_URL}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': CONTROL_PLANE_INTERNAL_TOKEN
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.detail || payload?.error || `Control-plane request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function getWebsitePaymentsForUser(userId) {
  const result = await pool.query(
    `SELECT *
     FROM yookassa_payments
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [String(userId)]
  );
  return result.rows.map(mapPaymentRow);
}

function sendApiError(res, error, fallback = 'Unexpected API error') {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return res.status(status).json({
    error: error instanceof Error ? error.message : fallback,
    detail: error?.payload || null
  });
}

app.get('/api/account/:userId', async (req, res) => {
  const accountId = parseControlPlaneAccountId(req.params.userId);
  if (!accountId) {
    return res.status(400).json({ error: 'Invalid account id' });
  }

  try {
    const profile = await controlPlaneRequest({
      method: 'POST',
      path: '/v1/users',
      body: {
        telegram_id: accountId,
        username: req.query.email ? String(req.query.email) : null,
        first_name: req.query.name ? String(req.query.name) : null
      }
    });

    const [balance, devices, payments] = await Promise.all([
      controlPlaneRequest({ path: `/v1/users/${accountId}/balance` }),
      controlPlaneRequest({ path: `/v1/users/${accountId}/devices` }),
      getWebsitePaymentsForUser(accountId)
    ]);

    return res.json({ profile, balance, devices, payments });
  } catch (error) {
    console.error('account load failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to load account');
  }
});

app.post('/api/devices', async (req, res) => {
  const accountId = parseControlPlaneAccountId(req.body?.user_id);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!accountId) {
    return res.status(400).json({ error: 'Invalid account id' });
  }
  if (!name) {
    return res.status(400).json({ error: 'Device name is required' });
  }

  try {
    const created = await controlPlaneRequest({
      method: 'POST',
      path: '/v1/devices',
      body: { telegram_id: accountId, name }
    });
    return res.json(created);
  } catch (error) {
    console.error('device create failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to create device');
  }
});

app.delete('/api/devices/:deviceId', async (req, res) => {
  const accountId = parseControlPlaneAccountId(req.query.user_id);
  const deviceId = Number(req.params.deviceId);
  if (!accountId || !Number.isSafeInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid delete request' });
  }

  try {
    const deleted = await controlPlaneRequest({
      method: 'DELETE',
      path: `/v1/devices/${deviceId}?telegram_id=${encodeURIComponent(accountId)}`
    });
    return res.json(deleted);
  } catch (error) {
    console.error('device delete failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to delete device');
  }
});

app.post('/api/create-payment', async (req, res) => {
  if (!requireYookassaConfig(res)) {
    return;
  }

  const {
    user_id,
    amount_rub = 100,
    description,
    plan_name = null,
    order_id: providedOrderId = null
  } = req.body || {};

  const amountValue = toAmountValue(amount_rub);
  if (!amountValue) {
    return res.status(400).json({ error: 'amount_rub must be a positive number' });
  }

  const orderId = providedOrderId || crypto.randomUUID();
  const incomingIdempotenceKey = req.header('Idempotence-Key');
  const idempotenceKey = incomingIdempotenceKey || makeIdempotenceKey();

  try {
    const existingByKey = await getPaymentByIdempotenceKey(idempotenceKey);
    if (existingByKey?.confirmation_url) {
      return res.json({
        ...mapPaymentRow(existingByKey),
        confirmation_url: existingByKey.confirmation_url
      });
    }

    const existingByOrder = await getPaymentByOrderId(orderId);
    if (
      existingByOrder &&
      ['pending', 'waiting_for_capture'].includes(existingByOrder.status) &&
      existingByOrder.confirmation_url
    ) {
      return res.json({
        ...mapPaymentRow(existingByOrder),
        confirmation_url: existingByOrder.confirmation_url
      });
    }

    const createResponse = await yookassaApiRequest({
      method: 'POST',
      apiPath: '/v3/payments',
      idempotenceKey,
      body: {
        amount: { value: amountValue, currency: 'RUB' },
        capture: true,
        confirmation: {
          type: 'redirect',
          return_url: `${BASE_URL}/payment-return?order_id=${encodeURIComponent(orderId)}`
        },
        description: description || `VPN payment ${orderId}`,
        metadata: {
          user_id: user_id ? String(user_id) : '',
          order_id: orderId,
          plan_name: plan_name ? String(plan_name) : ''
        }
      }
    });

    if (!createResponse.ok || !createResponse.payload?.id) {
      return res.status(createResponse.status || 502).json({
        error: 'Failed to create YooKassa payment'
      });
    }

    const row = await savePaymentRecord({
      payment: createResponse.payload,
      userId: user_id ? String(user_id) : null,
      orderId,
      planName: plan_name ? String(plan_name) : null,
      description: description || null,
      idempotenceKey
    });

    return res.json({
      ...mapPaymentRow(row),
      confirmation_url: row.confirmation_url
    });
  } catch (error) {
    console.error('create-payment failed', { message: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ error: 'Unexpected error during payment creation' });
  }
});

app.post('/api/yookassa-webhook', async (req, res) => {
  if (!requireYookassaConfig(res)) {
    return;
  }

  const requestIp = getClientIp(req);

  if (ENFORCE_IP_FILTER && !isIpAllowed(requestIp)) {
    console.warn('webhook rejected by ip filter', { requestIp });
    return res.sendStatus(403);
  }

  const event = req.body;
  const rawBody = req.rawBody || '';
  const fingerprint = eventFingerprint(rawBody);

  if (!event || event.type !== 'notification' || !event.event || !event.object?.id) {
    console.warn('webhook malformed payload');
    return res.sendStatus(400);
  }

  const paymentId = event.object.id;

  try {
    const insertEvent = await pool.query(
      `
      INSERT INTO yookassa_webhook_events (
        event_fingerprint,
        event_type,
        payment_id,
        payload,
        ip_address,
        verification_status
      ) VALUES ($1, $2, $3, $4::jsonb, $5, 'received')
      ON CONFLICT (event_fingerprint) DO NOTHING
      RETURNING id
      `,
      [fingerprint, event.event, paymentId, JSON.stringify(event), normalizeIp(requestIp)]
    );

    if (insertEvent.rowCount === 0) {
      const localPayment = await getPaymentByYkId(paymentId);
      if (localPayment?.status === 'succeeded') {
        await syncSucceededPaymentToControlPlane({
          id: localPayment.yookassa_payment_id,
          status: localPayment.status,
          amount: { value: localPayment.amount_value, currency: localPayment.currency },
          metadata: localPayment.metadata || {}
        });
      }
      return res.sendStatus(200);
    }

    const verifyResponse = await yookassaApiRequest({
      method: 'GET',
      apiPath: `/v3/payments/${encodeURIComponent(paymentId)}`
    });

    if (!verifyResponse.ok || !verifyResponse.payload?.id) {
      await pool.query(
        `UPDATE yookassa_webhook_events
         SET verification_status = 'verification_failed'
         WHERE event_fingerprint = $1`,
        [fingerprint]
      );
      return res.sendStatus(500);
    }

    const verifiedPayment = verifyResponse.payload;
    await savePaymentRecord({
      payment: verifiedPayment,
      userId: verifiedPayment.metadata?.user_id ? String(verifiedPayment.metadata.user_id) : null,
      orderId: verifiedPayment.metadata?.order_id ? String(verifiedPayment.metadata.order_id) : null,
      planName: verifiedPayment.metadata?.plan_name ? String(verifiedPayment.metadata.plan_name) : null,
      description: verifiedPayment.description || null,
      idempotenceKey: null
    });
    await syncSucceededPaymentToControlPlane(verifiedPayment);

    await pool.query(
      `UPDATE yookassa_webhook_events
       SET verification_status = 'verified'
       WHERE event_fingerprint = $1`,
      [fingerprint]
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error('webhook processing failed', { message: error instanceof Error ? error.message : String(error) });
    return res.sendStatus(500);
  }
});

app.get('/api/payment-status/:paymentId', async (req, res) => {
  if (!requireYookassaConfig(res)) {
    return;
  }

  const paymentId = req.params.paymentId;

  try {
    const [localPayment, remotePayment] = await Promise.all([
      getPaymentByYkId(paymentId),
      yookassaApiRequest({
        method: 'GET',
        apiPath: `/v3/payments/${encodeURIComponent(paymentId)}`
      })
    ]);

    if (!remotePayment.ok || !remotePayment.payload?.id) {
      return res.status(remotePayment.status || 502).json({
        error: 'Failed to get YooKassa payment status',
        local: localPayment ? mapPaymentRow(localPayment) : null
      });
    }

    const synced = await savePaymentRecord({
      payment: remotePayment.payload,
      userId: remotePayment.payload.metadata?.user_id ? String(remotePayment.payload.metadata.user_id) : null,
      orderId: remotePayment.payload.metadata?.order_id ? String(remotePayment.payload.metadata.order_id) : null,
      planName: remotePayment.payload.metadata?.plan_name ? String(remotePayment.payload.metadata.plan_name) : null,
      description: remotePayment.payload.description || null,
      idempotenceKey: null
    });
    await syncSucceededPaymentToControlPlane(remotePayment.payload);

    return res.json({
      payment_id: remotePayment.payload.id,
      status: remotePayment.payload.status,
      paid: remotePayment.payload.paid,
      metadata: remotePayment.payload.metadata,
      local: mapPaymentRow(synced)
    });
  } catch (error) {
    console.error('payment-status failed', { message: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ error: 'Unexpected error during payment status check' });
  }
});

app.get('/api/payment-status-by-order/:orderId', async (req, res) => {
  if (!requireYookassaConfig(res)) {
    return;
  }

  const orderId = req.params.orderId;

  try {
    const localPayment = await getPaymentByOrderId(orderId);
    if (!localPayment?.yookassa_payment_id) {
      return res.status(404).json({ error: 'Payment order was not found' });
    }

    const remotePayment = await yookassaApiRequest({
      method: 'GET',
      apiPath: `/v3/payments/${encodeURIComponent(localPayment.yookassa_payment_id)}`
    });

    if (!remotePayment.ok || !remotePayment.payload?.id) {
      return res.status(remotePayment.status || 502).json({
        error: 'Failed to get YooKassa payment status',
        local: mapPaymentRow(localPayment)
      });
    }

    const synced = await savePaymentRecord({
      payment: remotePayment.payload,
      userId: remotePayment.payload.metadata?.user_id ? String(remotePayment.payload.metadata.user_id) : null,
      orderId: remotePayment.payload.metadata?.order_id ? String(remotePayment.payload.metadata.order_id) : null,
      planName: remotePayment.payload.metadata?.plan_name ? String(remotePayment.payload.metadata.plan_name) : null,
      description: remotePayment.payload.description || null,
      idempotenceKey: null
    });
    await syncSucceededPaymentToControlPlane(remotePayment.payload);

    return res.json({
      payment_id: remotePayment.payload.id,
      status: remotePayment.payload.status,
      paid: remotePayment.payload.paid,
      metadata: remotePayment.payload.metadata,
      local: mapPaymentRow(synced)
    });
  } catch (error) {
    console.error('payment-status-by-order failed', { message: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ error: 'Unexpected error during payment status check' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (error) {
    res.status(500).json({ ok: false, db: 'down' });
  }
});

app.get('/payment-return', (_req, res) => {
  const returnPath = path.join(__dirname, 'dist', 'index.html');
  return res.sendFile(returnPath);
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

async function start() {
  validateStartupConfig();
  await initDb();

  app.listen(PORT, () => {
    console.log(`VPN website server is running on port ${PORT}`);
  });
}

process.on('SIGINT', async () => {
  await closeDb();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDb();
  process.exit(0);
});

start().catch(async (error) => {
  console.error('Failed to start server', { message: error instanceof Error ? error.message : String(error) });
  await closeDb().catch(() => undefined);
  process.exit(1);
});
