import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
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
const PUBLIC_BASE_URL = new URL(BASE_URL);
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || PUBLIC_BASE_URL.hostname;
const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME || 'VPN-GO';
const WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || PUBLIC_BASE_URL.origin;
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

const REFERRAL_BONUS_KOPECKS = 1000;
const ACCOUNT_COOKIE_NAME = 'vpngo_account_id';
const ACCOUNT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const REFERRAL_GUARD_COOKIE_NAME = 'vpngo_referral_guard';
const REFERRAL_GUARD_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

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
  if (req.ip) {
    return req.ip;
  }

  return req.socket.remoteAddress || '';
}

function normalizeIp(rawIp) {
  if (!rawIp) {
    return null;
  }

  if (rawIp.startsWith('::ffff:')) {
    return rawIp.slice(7);
  }
  if (rawIp === '::1') {
    return '127.0.0.1';
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

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
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

function createControlPlaneAccountId() {
  return String(Date.now() + crypto.randomInt(100_000, 999_999));
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    return 'Пользователь VPN-GO';
  }
  const trimmed = value.trim();
  return trimmed || 'Пользователь VPN-GO';
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) {
        return cookies;
      }
      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1);
      try {
        cookies[name] = decodeURIComponent(value);
      } catch (_error) {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function getAccountCookie(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return parseControlPlaneAccountId(cookies[ACCOUNT_COOKIE_NAME]);
}

function setCookie(res, name, value, maxAgeSeconds) {
  if (!name || !value) {
    return;
  }

  const attrs = [
    `${name}=${encodeURIComponent(String(value))}`,
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (NODE_ENV === 'production') {
    attrs.push('Secure');
  }
  const cookie = attrs.join('; ');
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

function setAccountCookie(res, userId) {
  const accountId = parseControlPlaneAccountId(userId);
  if (!accountId) {
    return;
  }
  setCookie(res, ACCOUNT_COOKIE_NAME, String(accountId), ACCOUNT_COOKIE_MAX_AGE_SECONDS);
}

function getReferralGuardCookie(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return typeof cookies[REFERRAL_GUARD_COOKIE_NAME] === 'string' ? cookies[REFERRAL_GUARD_COOKIE_NAME] : '';
}

function setReferralGuardCookie(res, token) {
  setCookie(res, REFERRAL_GUARD_COOKIE_NAME, token, REFERRAL_GUARD_COOKIE_MAX_AGE_SECONDS);
}

function referralVisitorKey(req, referrerId) {
  const ip = normalizeIp(getClientIp(req)) || '';
  const userAgent = String(req.headers['user-agent'] || '').trim().toLowerCase().slice(0, 500);
  return sha256Hex(`${referrerId}|${ip}|${userAgent}`);
}

async function getPasskeyAccount(userId) {
  const accountId = parseControlPlaneAccountId(userId);
  if (!accountId) {
    return null;
  }

  const result = await pool.query(
    'SELECT * FROM passkey_accounts WHERE user_id = $1 LIMIT 1',
    [String(accountId)]
  );
  return result.rows[0] || null;
}

async function getDeviceCookieAccount(req) {
  const accountId = getAccountCookie(req);
  return getPasskeyAccount(accountId);
}

async function resolveExistingReferralAccount(req, claimedUserId = null) {
  const cookieAccount = await getDeviceCookieAccount(req);
  if (cookieAccount) {
    return cookieAccount;
  }
  return getPasskeyAccount(claimedUserId);
}

async function prepareReferralVisitor({ req, res, referrerUserId, existingUserId = null }) {
  const referrerId = parseControlPlaneAccountId(referrerUserId);
  if (!referrerId) {
    const error = new Error('Invalid referral link');
    error.status = 400;
    throw error;
  }

  const referrer = await getPasskeyAccount(referrerId);
  if (!referrer) {
    const error = new Error('Referral account was not found');
    error.status = 404;
    throw error;
  }

  const token = crypto.randomUUID();
  const visitorKey = referralVisitorKey(req, referrerId);
  const existingAccount = await resolveExistingReferralAccount(req, existingUserId);
  await pool.query(
    `
      INSERT INTO referral_visitors (referrer_user_id, visitor_key, guard_token_hash, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (referrer_user_id, visitor_key)
      DO UPDATE SET
        guard_token_hash = EXCLUDED.guard_token_hash,
        user_id = COALESCE(referral_visitors.user_id, EXCLUDED.user_id),
        last_seen_at = NOW()
    `,
    [String(referrerId), visitorKey, sha256Hex(token), existingAccount?.user_id ? String(existingAccount.user_id) : null]
  );
  setReferralGuardCookie(res, token);
  if (existingAccount) {
    setAccountCookie(res, existingAccount.user_id);
  }
  return { ok: true, known_account: Boolean(existingAccount) };
}

async function getReferralVisitor({ req, referrerUserId }) {
  const referrerId = parseControlPlaneAccountId(referrerUserId);
  if (!referrerId) {
    return null;
  }

  const visitorKey = referralVisitorKey(req, referrerId);
  const result = await pool.query(
    `
      SELECT rv.*, a.display_name
      FROM referral_visitors rv
      LEFT JOIN passkey_accounts a ON a.user_id = rv.user_id
      WHERE rv.referrer_user_id = $1
        AND rv.visitor_key = $2
      LIMIT 1
    `,
    [String(referrerId), visitorKey]
  );
  return result.rows[0] || null;
}

async function requireReferralGuard({ req, referrerUserId }) {
  const referrerId = parseControlPlaneAccountId(referrerUserId);
  const token = getReferralGuardCookie(req);
  if (!referrerId || !token) {
    const error = new Error('Для регистрации по приглашению нужно включить cookies.');
    error.status = 403;
    throw error;
  }

  const tokenHash = sha256Hex(token);
  const result = await pool.query(
    `
      UPDATE referral_visitors
      SET last_seen_at = NOW()
      WHERE referrer_user_id = $1
        AND visitor_key = $2
        AND guard_token_hash = $3
      RETURNING *
    `,
    [String(referrerId), referralVisitorKey(req, referrerId), tokenHash]
  );
  const visitor = result.rows[0];
  if (!visitor) {
    const error = new Error('Для регистрации по приглашению нужно включить cookies.');
    error.status = 403;
    throw error;
  }
  return visitor;
}

async function attachExistingAccountToReferralVisitor({ req, referrerUserId, existingUserId = null }) {
  const existingAccount = await resolveExistingReferralAccount(req, existingUserId);
  if (!existingAccount) {
    return null;
  }

  await setReferralVisitorUser({
    req,
    referrerUserId,
    userId: existingAccount.user_id
  });
  return existingAccount;
}

async function setReferralVisitorUser({ req, referrerUserId, userId }) {
  const referrerId = parseControlPlaneAccountId(referrerUserId);
  const accountId = parseControlPlaneAccountId(userId);
  if (!referrerId || !accountId) {
    return;
  }

  await pool.query(
    `
      UPDATE referral_visitors
      SET user_id = $3, last_seen_at = NOW()
      WHERE referrer_user_id = $1
        AND visitor_key = $2
    `,
    [String(referrerId), referralVisitorKey(req, referrerId), String(accountId)]
  );
}

async function applyReferralActivation({ referrerUserId, invitedUserId, existingDeviceUserId = null, existingReferralUserId = null }) {
  const referrerId = parseControlPlaneAccountId(referrerUserId);
  const invitedId = parseControlPlaneAccountId(invitedUserId);
  const existingDeviceId = parseControlPlaneAccountId(existingDeviceUserId);
  const existingReferralId = parseControlPlaneAccountId(existingReferralUserId);
  if (!referrerId || !invitedId || referrerId === invitedId) {
    return { applied: false, reason: 'invalid_referral' };
  }
  if (existingDeviceId) {
    return { applied: false, reason: 'same_device_cookie' };
  }
  if (existingReferralId) {
    return { applied: false, reason: 'same_referral_visitor' };
  }

  const referrer = await pool.query(
    'SELECT user_id FROM passkey_accounts WHERE user_id = $1 LIMIT 1',
    [String(referrerId)]
  );
  if (!referrer.rows[0]) {
    return { applied: false, reason: 'referrer_not_found' };
  }

  const inserted = await pool.query(
    `
      INSERT INTO referral_activations (referrer_user_id, invited_user_id, bonus_kopecks)
      VALUES ($1, $2, $3)
      ON CONFLICT (invited_user_id)
      DO UPDATE SET status = 'pending', error_text = NULL
      WHERE referral_activations.status = 'failed'
      RETURNING id
    `,
    [String(referrerId), String(invitedId), REFERRAL_BONUS_KOPECKS]
  );
  const activation = inserted.rows[0];
  if (!activation) {
    return { applied: false, reason: 'already_activated' };
  }

  try {
    await Promise.all([
      controlPlaneRequest({
        method: 'POST',
        path: '/v1/payments/external/confirm',
        body: {
          telegram_id: referrerId,
          amount_kopecks: REFERRAL_BONUS_KOPECKS,
          external_payment_id: `referral-${invitedId}-referrer`,
          provider: 'referral'
        }
      }),
      controlPlaneRequest({
        method: 'POST',
        path: '/v1/payments/external/confirm',
        body: {
          telegram_id: invitedId,
          amount_kopecks: REFERRAL_BONUS_KOPECKS,
          external_payment_id: `referral-${invitedId}-invited`,
          provider: 'referral'
        }
      })
    ]);

    await pool.query(
      `
        UPDATE referral_activations
        SET status = 'awarded', awarded_at = NOW(), error_text = NULL
        WHERE id = $1
      `,
      [activation.id]
    );
    return { applied: true, bonus_kopecks: REFERRAL_BONUS_KOPECKS };
  } catch (error) {
    await pool.query(
      `
        UPDATE referral_activations
        SET status = 'failed', error_text = $2
        WHERE id = $1
      `,
      [activation.id, error instanceof Error ? error.message : String(error)]
    );
    throw error;
  }
}

async function savePasskeyChallenge({ type, challenge, userId = null }) {
  const challengeId = crypto.randomUUID();
  await pool.query(
    `
      INSERT INTO passkey_challenges (challenge_id, challenge, type, user_id)
      VALUES ($1, $2, $3, $4)
    `,
    [challengeId, challenge, type, userId ? String(userId) : null]
  );
  return challengeId;
}

async function consumePasskeyChallenge({ challengeId, type }) {
  const result = await pool.query(
    `
      DELETE FROM passkey_challenges
      WHERE challenge_id = $1
        AND type = $2
        AND expires_at > NOW()
      RETURNING *
    `,
    [challengeId, type]
  );
  return result.rows[0] || null;
}

function passkeyProfile(row) {
  return {
    name: row?.display_name || 'Пользователь VPN-GO',
    email: ''
  };
}

function transportsFromResponse(response) {
  const transports = response?.response?.transports;
  if (!Array.isArray(transports)) {
    return null;
  }
  return transports.filter((transport) => typeof transport === 'string');
}

function profileFromControlPlaneUser(user) {
  return {
    name: user?.first_name || user?.username || 'Пользователь VPN-GO',
    email: ''
  };
}

function sendApiError(res, error, fallback = 'Unexpected API error') {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return res.status(status).json({
    error: error instanceof Error ? error.message : fallback,
    detail: error?.payload || null
  });
}

app.post('/api/referral/prepare', async (req, res) => {
  try {
    const referral = await prepareReferralVisitor({
      req,
      res,
      referrerUserId: req.body?.referrer_user_id,
      existingUserId: req.body?.current_user_id
    });
    return res.json(referral);
  } catch (error) {
    console.error('referral prepare failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Не удалось подготовить регистрацию по приглашению');
  }
});

app.post('/api/referral/status', async (req, res) => {
  try {
    const visitor = await requireReferralGuard({
      req,
      referrerUserId: req.body?.referrer_user_id
    });
    const existingAccount = visitor.user_id
      ? null
      : await attachExistingAccountToReferralVisitor({
          req,
          referrerUserId: req.body?.referrer_user_id,
          existingUserId: req.body?.current_user_id
        });
    return res.json({
      ok: true,
      known_account: Boolean(visitor.user_id || existingAccount)
    });
  } catch (error) {
    return sendApiError(res, error, 'Для регистрации по приглашению нужно включить cookies.');
  }
});

app.post('/api/passkeys/authentication/options', async (_req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      userVerification: 'preferred'
    });
    const challengeId = await savePasskeyChallenge({
      type: 'authentication',
      challenge: options.challenge
    });
    return res.json({ challenge_id: challengeId, options });
  } catch (error) {
    console.error('passkey authentication options failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to start passkey authentication');
  }
});

app.post('/api/passkeys/authentication/verify', async (req, res) => {
  const challengeId = typeof req.body?.challenge_id === 'string' ? req.body.challenge_id : '';
  const response = req.body?.response;
  if (!challengeId || !response?.id) {
    return res.status(400).json({ error: 'Invalid passkey authentication request' });
  }

  try {
    const challenge = await consumePasskeyChallenge({
      challengeId,
      type: 'authentication'
    });
    if (!challenge) {
      return res.status(400).json({ error: 'Passkey challenge expired' });
    }

    const credentialResult = await pool.query(
      `
        SELECT c.*, a.display_name
        FROM passkey_credentials c
        JOIN passkey_accounts a ON a.user_id = c.user_id
        WHERE c.credential_id = $1
        LIMIT 1
      `,
      [response.id]
    );
    const credentialRow = credentialResult.rows[0];
    if (!credentialRow) {
      return res.status(404).json({ error: 'Passkey was not found' });
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: {
        id: credentialRow.credential_id,
        publicKey: Buffer.from(credentialRow.public_key, 'base64url'),
        counter: Number(credentialRow.counter || 0),
        transports: credentialRow.transports || undefined
      },
      requireUserVerification: false
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Passkey verification failed' });
    }

    await pool.query(
      `
        UPDATE passkey_credentials
        SET counter = $2, last_used_at = NOW()
        WHERE credential_id = $1
      `,
      [credentialRow.credential_id, verification.authenticationInfo.newCounter]
    );
    const deviceCookieAccount = await getDeviceCookieAccount(req);
    if (deviceCookieAccount && String(deviceCookieAccount.user_id) !== String(credentialRow.user_id)) {
      await pool.query(
        'UPDATE passkey_accounts SET last_login_at = NOW() WHERE user_id = $1',
        [deviceCookieAccount.user_id]
      );
      setAccountCookie(res, deviceCookieAccount.user_id);
      return res.json({
        user_id: deviceCookieAccount.user_id,
        profile: passkeyProfile(deviceCookieAccount),
        device_cookie_account: true
      });
    }

    await pool.query(
      'UPDATE passkey_accounts SET last_login_at = NOW() WHERE user_id = $1',
      [credentialRow.user_id]
    );
    setAccountCookie(res, credentialRow.user_id);
    return res.json({
      user_id: credentialRow.user_id,
      profile: passkeyProfile(credentialRow)
    });
  } catch (error) {
    console.error('passkey authentication verify failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to verify passkey authentication');
  }
});

app.post('/api/passkeys/registration/options', async (req, res) => {
  try {
    const requestedReferrerId = parseControlPlaneAccountId(req.body?.referrer_user_id);
    let referralVisitor = null;
    if (requestedReferrerId) {
      referralVisitor = await requireReferralGuard({
        req,
        referrerUserId: requestedReferrerId
      });
      if (!referralVisitor.user_id) {
        const existingAccount = await attachExistingAccountToReferralVisitor({
          req,
          referrerUserId: requestedReferrerId,
          existingUserId: req.body?.current_user_id
        });
        if (existingAccount) {
          referralVisitor.user_id = existingAccount.user_id;
        }
      }
    }

    const deviceCookieAccount = await getDeviceCookieAccount(req);
    const referralVisitorAccount = referralVisitor?.user_id ? await getPasskeyAccount(referralVisitor.user_id) : null;
    const userId = Number(deviceCookieAccount?.user_id || referralVisitorAccount?.user_id || parseControlPlaneAccountId(req.body?.user_id) || createControlPlaneAccountId());
    const displayName = normalizeDisplayName(req.body?.display_name);
    const shouldUpdateDisplayName = !deviceCookieAccount && !referralVisitorAccount;

    await pool.query(
      `
        INSERT INTO passkey_accounts (user_id, display_name)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET display_name = CASE
          WHEN $3 THEN EXCLUDED.display_name
          ELSE passkey_accounts.display_name
        END
      `,
      [String(userId), displayName, shouldUpdateDisplayName]
    );

    const existingCredentials = await pool.query(
      'SELECT credential_id, transports FROM passkey_credentials WHERE user_id = $1',
      [String(userId)]
    );

    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userID: Buffer.from(String(userId)),
      userName: `vpn-go-${userId}`,
      userDisplayName: displayName,
      attestationType: 'none',
      preferredAuthenticatorType: 'localDevice',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required'
      },
      excludeCredentials: existingCredentials.rows.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports || undefined
      }))
    });

    const challengeId = await savePasskeyChallenge({
      type: 'registration',
        challenge: options.challenge,
        userId
      });
    return res.json({
      challenge_id: challengeId,
      user_id: String(userId),
      options,
      referral_known_account: Boolean(referralVisitorAccount)
    });
  } catch (error) {
    console.error('passkey registration options failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to start passkey registration');
  }
});

app.post('/api/passkeys/registration/verify', async (req, res) => {
  const challengeId = typeof req.body?.challenge_id === 'string' ? req.body.challenge_id : '';
  const response = req.body?.response;
  if (!challengeId || !response?.id) {
    return res.status(400).json({ error: 'Invalid passkey registration request' });
  }

  try {
    const challenge = await consumePasskeyChallenge({
      challengeId,
      type: 'registration'
    });
    if (!challenge?.user_id) {
      return res.status(400).json({ error: 'Passkey challenge expired' });
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: false
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Passkey registration failed' });
    }

    const credential = verification.registrationInfo.credential;
    const transports = transportsFromResponse(response) || credential.transports || null;
    await pool.query(
      `
        INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (credential_id)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          public_key = EXCLUDED.public_key,
          counter = EXCLUDED.counter,
          transports = EXCLUDED.transports,
          last_used_at = NOW()
      `,
      [
        credential.id,
        challenge.user_id,
        Buffer.from(credential.publicKey).toString('base64url'),
        credential.counter,
        transports
      ]
    );

    const accountResult = await pool.query(
      'UPDATE passkey_accounts SET last_login_at = NOW() WHERE user_id = $1 RETURNING *',
      [challenge.user_id]
    );
    const account = accountResult.rows[0];

    await controlPlaneRequest({
      method: 'POST',
      path: '/v1/users',
      body: {
        telegram_id: Number(challenge.user_id),
        username: null,
        first_name: account.display_name
      }
    });

    const requestedReferrerId = parseControlPlaneAccountId(req.body?.referrer_user_id);
    let referralVisitor = null;
    if (requestedReferrerId) {
      referralVisitor = await requireReferralGuard({
        req,
        referrerUserId: requestedReferrerId
      });
    }

    let referral = null;
    try {
      referral = await applyReferralActivation({
        referrerUserId: requestedReferrerId,
        invitedUserId: challenge.user_id,
        existingDeviceUserId: getAccountCookie(req),
        existingReferralUserId: referralVisitor?.user_id
      });
    } catch (referralError) {
      console.error('passkey referral activation failed', { message: referralError instanceof Error ? referralError.message : String(referralError) });
      referral = { applied: false, reason: 'activation_failed' };
    }

    await setReferralVisitorUser({
      req,
      referrerUserId: requestedReferrerId,
      userId: challenge.user_id
    });
    setAccountCookie(res, challenge.user_id);
    return res.json({
      user_id: challenge.user_id,
      profile: passkeyProfile(account),
      referral
    });
  } catch (error) {
    console.error('passkey registration verify failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to verify passkey registration');
  }
});

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

app.post('/api/devices/:deviceId/regenerate', async (req, res) => {
  const accountId = parseControlPlaneAccountId(req.body?.user_id);
  const deviceId = Number(req.params.deviceId);
  if (!accountId || !Number.isSafeInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid regenerate request' });
  }

  try {
    const regenerated = await controlPlaneRequest({
      method: 'POST',
      path: `/v1/devices/${deviceId}/regenerate?telegram_id=${encodeURIComponent(accountId)}`,
      body: {}
    });
    return res.json(regenerated);
  } catch (error) {
    console.error('device regenerate failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to regenerate device config');
  }
});

app.get('/api/devices/:deviceId/config', async (req, res) => {
  const accountId = parseControlPlaneAccountId(req.query.user_id);
  const deviceId = Number(req.params.deviceId);
  if (!accountId || !Number.isSafeInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'Invalid config request' });
  }

  try {
    const devices = await controlPlaneRequest({ path: `/v1/users/${accountId}/devices` });
    const device = devices.find((item) => item.id === deviceId);
    if (!device || device.status !== 'active') {
      return res.status(404).json({ error: 'Active device was not found' });
    }

    const response = await fetch(`${CONTROL_PLANE_API_URL}/internal/devices/${deviceId}/config`, {
      method: 'POST',
      headers: {
        'X-Internal-Token': CONTROL_PLANE_INTERNAL_TOKEN
      }
    });

    const confText = await response.text();
    if (!response.ok) {
      let payload = null;
      try {
        payload = JSON.parse(confText);
      } catch (_error) {
        payload = null;
      }
      const error = new Error(payload?.detail || payload?.error || `Config request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return res.json({
      device_id: deviceId,
      conf_filename: `device-${deviceId}-amneziawg.conf`,
      conf_text: confText
    });
  } catch (error) {
    console.error('device config failed', { message: error instanceof Error ? error.message : String(error) });
    return sendApiError(res, error, 'Failed to load device config');
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
