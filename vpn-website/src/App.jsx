import QRCode from 'qrcode';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { userAgreementText } from './userAgreement.js';

const STORAGE_PROFILE_KEY = 'vpngo_profile';
const STORAGE_CUSTOMER_KEY = 'vpngo_customer_id';
const STORAGE_REFERRAL_KEY = 'vpngo_referrer_id';
const DAILY_PRICE_RUB = 5;

const appDownloadLinks = [
  { label: 'Android', icon: 'android', href: 'https://play.google.com/store/apps/details?id=org.amnezia.awg' },
  { label: 'iOS', icon: 'ios', href: 'https://apps.apple.com/us/app/amneziawg/id6478942365' },
  { label: 'Windows', icon: 'windows', href: 'https://github.com/amnezia-vpn/amnezia-client/releases/download/4.8.15.4/AmneziaVPN_4.8.15.4_x64.exe' },
  { label: 'MacOS', icon: 'macos', href: 'https://apps.apple.com/us/app/amneziawg/id6478942365?platform=mac' }
];

const heroBenefits = [
  'Дешевле, чем собственный сервер',
  'Повышенная конфиденциальность',
  'Оплата только за дни использования',
  'Конфиги для всех устройств'
];

function getStoredProfile() {
  try {
    const raw = window.localStorage.getItem(STORAGE_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function createCustomerId() {
  const created = String(Math.floor(Date.now() + Math.random() * 1_000_000));
  window.localStorage.setItem(STORAGE_CUSTOMER_KEY, created);
  return created;
}

function getStoredCustomerId() {
  const existingId = window.localStorage.getItem(STORAGE_CUSTOMER_KEY);
  return existingId && /^\d+$/.test(existingId) ? existingId : '';
}

function getStoredReferrerId() {
  const referrerId = window.localStorage.getItem(STORAGE_REFERRAL_KEY);
  return referrerId && /^\d+$/.test(referrerId) ? referrerId : '';
}

function formatRubFromKopecks(value) {
  return `${Math.floor((value || 0) / 100)} ₽`;
}

function dayLabel(days) {
  const mod10 = days % 10;
  const mod100 = days % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return 'день';
  }
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) {
    return 'дня';
  }
  return 'дней';
}

function statusLabel(status) {
  return {
    active: 'Активно',
    suspended: 'Пауза',
    banned: 'Заблокировано',
    deleted: 'Удалено'
  }[status] || status;
}

function PlatformIcon({ name }) {
  const commonProps = {
    className: 'h-4 w-4',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true'
  };

  if (name === 'android') {
    return (
      <svg {...commonProps}>
        <path d="M7 10h10v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-7Z" />
        <path d="M9 10V8a3 3 0 0 1 6 0v2" />
        <path d="M8 5 6.5 3.5" />
        <path d="m16 5 1.5-1.5" />
        <path d="M5 11v5" />
        <path d="M19 11v5" />
        <path d="M10 14h.01" />
        <path d="M14 14h.01" />
      </svg>
    );
  }

  if (name === 'ios') {
    return (
      <svg {...commonProps}>
        <rect x="8" y="3" width="8" height="18" rx="2" />
        <path d="M11 6h2" />
        <path d="M12 18h.01" />
      </svg>
    );
  }

  if (name === 'windows') {
    return (
      <svg {...commonProps}>
        <path d="M4 5.5 11 4v7H4V5.5Z" />
        <path d="M13 3.6 20 2v9h-7V3.6Z" />
        <path d="M4 13h7v7l-7-1.5V13Z" />
        <path d="M13 13h7v9l-7-1.6V13Z" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5V15H5V6.5Z" />
      <path d="M3 18h18" />
      <path d="M9 18h6" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

function paymentStatusClass(status) {
  if (status === 'succeeded') {
    return 'text-emerald-700';
  }
  if (status === 'pending' || status === 'waiting_for_capture') {
    return 'text-amber-700';
  }
  if (status === 'canceled') {
    return 'text-red-700';
  }
  return 'text-slate-500';
}

function dateLabel(value) {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(value));
}

async function readJson(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || payload?.detail || 'Не удалось выполнить запрос');
  }
  return payload;
}

function userMessage(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  if (message === 'Insufficient balance to add a device') {
    return 'Недостаточно баланса для добавления устройства';
  }
  return message || fallback;
}

async function withQrDataUrl(config) {
  const qrDataUrl = await QRCode.toDataURL(config.conf_text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320
  });
  return { ...config, qrDataUrl };
}

function renderAgreementLine(line, index) {
  if (line.startsWith('# ')) {
    return (
      <h1 key={index} className="text-3xl font-black text-slate-950">
        {line.slice(2)}
      </h1>
    );
  }
  if (line.startsWith('## ')) {
    return (
      <h2 key={index} className="pt-5 text-xl font-black text-slate-950">
        {line.slice(3)}
      </h2>
    );
  }
  if (!line.trim()) {
    return <div key={index} className="h-2" />;
  }
  return (
    <p key={index} className="text-sm leading-7 text-slate-700">
      {line}
    </p>
  );
}

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function makePasswordBackupSvg({ login, password }) {
  const safeLogin = escapeSvgText(login);
  const safePassword = escapeSvgText(password);
  const credentialFontSize = Math.max(16, Math.min(22, Math.floor(560 / Math.max(login.length, password.length, 1))));

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
  <rect width="720" height="420" rx="28" fill="#f7f8fb"/>
  <rect x="52" y="44" width="616" height="332" rx="18" fill="#ffffff" stroke="#dce2ea" stroke-width="2"/>
  <rect x="84" y="76" width="56" height="56" rx="14" fill="#bef264"/>
  <text x="112" y="112" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="900" fill="#020617">GO</text>
  <text x="156" y="96" font-family="Arial, sans-serif" font-size="28" font-weight="900" fill="#020617">VPN-GO</text>
  <text x="156" y="124" font-family="Arial, sans-serif" font-size="16" fill="#64748b">Доступ к личному кабинету</text>
  <text x="84" y="176" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#475569">Логин</text>
  <rect x="84" y="190" width="552" height="58" rx="12" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
  <text x="108" y="226" font-family="Arial, sans-serif" font-size="${credentialFontSize}" font-weight="800" fill="#0f172a">${safeLogin}</text>
  <text x="84" y="282" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#475569">Пароль</text>
  <rect x="84" y="296" width="552" height="58" rx="12" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
  <text x="108" y="332" font-family="Arial, sans-serif" font-size="${credentialFontSize}" font-weight="800" fill="#0f172a">${safePassword}</text>
</svg>`.trim();
}

export default function VPNLandingPage() {
  const [profile, setProfile] = useState(() => getStoredProfile());
  const [customerId, setCustomerId] = useState(() => getStoredCustomerId());
  const [referrerId, setReferrerId] = useState(() => getStoredReferrerId());
  const [isReferralCopied, setIsReferralCopied] = useState(false);
  const [loginConsentVisible, setLoginConsentVisible] = useState(false);
  const [loginMethodVisible, setLoginMethodVisible] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authStatus, setAuthStatus] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [passwordAuthVisible, setPasswordAuthVisible] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ login: '', password: '' });
  const [passwordAuthError, setPasswordAuthError] = useState('');
  const [passwordCanCreate, setPasswordCanCreate] = useState(false);
  const [isPasswordSubmitting, setIsPasswordSubmitting] = useState(false);
  const [passwordBackup, setPasswordBackup] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [isLoadingAccount, setIsLoadingAccount] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [paymentReturn, setPaymentReturn] = useState(null);
  const [topUpAmount, setTopUpAmount] = useState('150');
  const [deviceName, setDeviceName] = useState('');
  const [isCreatingDevice, setIsCreatingDevice] = useState(false);
  const [loadingConfigDeviceId, setLoadingConfigDeviceId] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [devicePendingDelete, setDevicePendingDelete] = useState(null);
  const [isDeletingDevice, setIsDeletingDevice] = useState(false);
  const [devicePendingRegenerate, setDevicePendingRegenerate] = useState(null);
  const [isRegeneratingDevice, setIsRegeneratingDevice] = useState(false);
  const [createdConfig, setCreatedConfig] = useState(null);
  const [heroBenefitIndex, setHeroBenefitIndex] = useState(0);

  if (window.location.pathname === '/agreement') {
    return (
      <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
            <a href="/" className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-lime-400 text-base font-black">
                GO
              </div>
              <div>
                <div className="text-lg font-black tracking-tight">VPN-GO</div>
                <div className="text-xs text-slate-500">Пользовательское соглашение</div>
              </div>
            </a>
            <a
              href="/"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 transition hover:border-slate-500"
            >
              Назад
            </a>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-10">
          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid gap-2">{userAgreementText.split('\n').map(renderAgreementLine)}</div>
          </div>
        </main>
      </div>
    );
  }

  async function loadAccount(currentProfile = profile, currentCustomerId = customerId) {
    if (!currentProfile || !currentCustomerId) {
      return;
    }

    setIsLoadingAccount(true);
    setAccountError('');
    try {
      const params = new URLSearchParams({
        name: currentProfile.name || '',
        email: currentProfile.email || ''
      });
      const payload = await fetch(`/api/account/${currentCustomerId}?${params}`).then(readJson);
      setDashboard(payload);
    } catch (error) {
      setAccountError(userMessage(error, 'Не удалось загрузить личный кабинет'));
    } finally {
      setIsLoadingAccount(false);
    }
  }

  useEffect(() => {
    if (profile) {
      loadAccount(profile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, customerId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const referral = params.get('ref');
    if (referral && /^\d+$/.test(referral)) {
      window.localStorage.setItem(STORAGE_REFERRAL_KEY, referral);
      setReferrerId(referral);
    }

    if (!profile && params.get('login') === '1') {
      openLoginConsent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHeroBenefitIndex((current) => (current + 1) % heroBenefits.length);
    }, 3200);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order_id');
    if (window.location.pathname !== '/payment-return' || !orderId) {
      return;
    }

    let cancelled = false;
    setPaymentReturn({ state: 'checking', message: 'Проверяем статус платежа...' });

    fetch(`/api/payment-status-by-order/${encodeURIComponent(orderId)}`)
      .then(readJson)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (payload.paid || payload.status === 'succeeded') {
          setPaymentReturn({ state: 'success', message: 'Платеж прошел. Баланс обновлен.' });
          loadAccount();
          return;
        }
        if (payload.status === 'canceled') {
          setPaymentReturn({ state: 'error', message: 'Платеж отменен.' });
          return;
        }
        setPaymentReturn({
          state: 'pending',
          message: 'Платеж еще обрабатывается. Обновите страницу через несколько секунд.'
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setPaymentReturn({
            state: 'error',
            message: error instanceof Error ? error.message : 'Не удалось проверить платеж'
          });
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finishPasskeySession(session) {
    const nextProfile = {
      name: session?.profile?.name || 'Пользователь VPN-GO',
      email: session?.profile?.email || ''
    };
    const nextCustomerId = String(session.user_id);
    window.localStorage.setItem(STORAGE_CUSTOMER_KEY, nextCustomerId);
    window.localStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(nextProfile));
    setCustomerId(nextCustomerId);
    setProfile(nextProfile);
    setAuthError('');
    if (referrerId && (referrerId === nextCustomerId || session?.referral)) {
      window.localStorage.removeItem(STORAGE_REFERRAL_KEY);
      setReferrerId('');
    }
    await loadAccount(nextProfile, nextCustomerId);
  }

  function openPasswordFallback(message = '') {
    setAuthError('');
    setAuthStatus('');
    setLoginMethodVisible(false);
    setPasswordAuthError(message);
    setPasswordCanCreate(false);
    setPasswordAuthVisible(true);
  }

  function openLoginConsent() {
    setAuthError('');
    setLoginConsentVisible(true);
  }

  function acceptLoginConsent() {
    setLoginConsentVisible(false);
    setLoginMethodVisible(true);
  }

  function usePasskeyLogin() {
    setLoginMethodVisible(false);
    loginWithPasskey();
  }

  async function loginWithPasskey() {
    setPaymentError('');
    setAuthError('');
    setIsAuthenticating(true);
    try {
      setAuthStatus('Поиск устройства в сети');
      const ipSession = await fetch('/api/session/by-ip', {
        method: 'POST'
      }).then(readJson);
      if (ipSession.matched) {
        await finishPasskeySession(ipSession);
        return;
      }

      setAuthStatus('Ожидаем подтверждение на устройстве');
      if (!browserSupportsWebAuthn()) {
        openPasswordFallback('Этот браузер не поддерживает passkey. Войдите через логин и пароль.');
        return;
      }

      const authOptions = await fetch('/api/passkeys/authentication/options', {
        method: 'POST'
      }).then(readJson);
      const authResponse = await startAuthentication({ optionsJSON: authOptions.options });
      const verifiedSession = await fetch('/api/passkeys/authentication/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: authOptions.challenge_id,
          response: authResponse
        })
      }).then(readJson);
      await finishPasskeySession(verifiedSession);
    } catch (_loginError) {
      try {
        setAuthStatus('Создаем вход через устройство');
        const registrationOptions = await fetch('/api/passkeys/registration/options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: createCustomerId(),
            display_name: 'Пользователь VPN-GO'
          })
        }).then(readJson);
        const registrationResponse = await startRegistration({ optionsJSON: registrationOptions.options });
        const registeredSession = await fetch('/api/passkeys/registration/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: registrationOptions.challenge_id,
          response: registrationResponse,
          referrer_user_id: referrerId
        })
      }).then(readJson);
        await finishPasskeySession(registeredSession);
      } catch (registrationError) {
        openPasswordFallback(userMessage(registrationError, 'Не удалось войти через passkey'));
      }
    } finally {
      setIsAuthenticating(false);
      setAuthStatus('');
    }
  }

  async function submitPasswordLogin(event) {
    event.preventDefault();
    const login = passwordForm.login.trim().toLowerCase();
    const password = passwordForm.password;
    setPasswordAuthError('');
    setPasswordCanCreate(false);
    setIsPasswordSubmitting(true);

    try {
      const session = await fetch('/api/password-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password })
      }).then(readJson);

      if (session.matched) {
        setPasswordAuthVisible(false);
        setPasswordForm({ login: '', password: '' });
        await finishPasskeySession(session);
        return;
      }

      if (session.can_create) {
        setPasswordCanCreate(true);
        setPasswordAuthError('Аккаунт с таким логином не найден. Можно создать новый аккаунт с этим логином и паролем.');
      }
    } catch (error) {
      setPasswordAuthError(userMessage(error, 'Не удалось войти по логину и паролю'));
    } finally {
      setIsPasswordSubmitting(false);
    }
  }

  async function createPasswordAccount() {
    const login = passwordForm.login.trim().toLowerCase();
    const password = passwordForm.password;
    setPasswordAuthError('');
    setIsPasswordSubmitting(true);

    try {
      const session = await fetch('/api/password-auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login,
          password,
          user_id: createCustomerId(),
          referrer_user_id: referrerId
        })
      }).then(readJson);

      setPasswordAuthVisible(false);
      setPasswordBackup({ login, password });
      setPasswordForm({ login: '', password: '' });
      setPasswordCanCreate(false);
      await finishPasskeySession(session);
    } catch (error) {
      setPasswordAuthError(userMessage(error, 'Не удалось создать аккаунт'));
    } finally {
      setIsPasswordSubmitting(false);
    }
  }

  function logout() {
    window.localStorage.removeItem(STORAGE_PROFILE_KEY);
    window.localStorage.removeItem(STORAGE_CUSTOMER_KEY);
    setProfile(null);
    setCustomerId('');
    setDashboard(null);
    setCreatedConfig(null);
    setPasswordBackup(null);
  }

  async function createPayment() {
    const amountRub = Number(String(topUpAmount).replace(',', '.'));
    if (!Number.isFinite(amountRub) || amountRub < 30) {
      setPaymentError('Минимальная сумма пополнения 30 ₽');
      return;
    }

    setPaymentError('');
    setIsPaying(true);
    const requestId = window.crypto?.randomUUID?.();

    try {
      const response = await fetch('/api/create-payment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(requestId ? { 'Idempotence-Key': requestId } : {})
        },
        body: JSON.stringify({
          amount_rub: amountRub,
          plan_name: 'Пополнение баланса VPN-GO',
          description: `Пополнение баланса VPN-GO на ${amountRub} ₽`,
          user_id: customerId
        })
      });

      const payload = await readJson(response);
      if (!payload?.confirmation_url) {
        throw new Error('ЮKassa не вернула ссылку на оплату');
      }

      window.location.href = payload.confirmation_url;
    } catch (error) {
      setPaymentError(userMessage(error, 'Неожиданная ошибка оплаты'));
    } finally {
      setIsPaying(false);
    }
  }

  async function createDevice() {
    const name = deviceName.trim();
    if (!name) {
      setDeviceError('Введите название устройства');
      return;
    }

    setDeviceError('');
    setCreatedConfig(null);
    setIsCreatingDevice(true);
    try {
      const payload = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: customerId, name })
      }).then(readJson);

      setCreatedConfig(await withQrDataUrl({ ...payload, device_name: name }));
      setDeviceName('');
      await loadAccount();
    } catch (error) {
      setDeviceError(userMessage(error, 'Не удалось добавить устройство'));
    } finally {
      setIsCreatingDevice(false);
    }
  }

  function requestDeleteDevice(device) {
    setDeviceError('');
    setDevicePendingDelete(device);
  }

  async function confirmDeleteDevice() {
    if (!devicePendingDelete) {
      return;
    }

    setDeviceError('');
    setIsDeletingDevice(true);
    try {
      await fetch(`/api/devices/${devicePendingDelete.id}?user_id=${encodeURIComponent(customerId)}`, {
        method: 'DELETE'
      }).then(readJson);
      setDevicePendingDelete(null);
      setCreatedConfig(null);
      await loadAccount();
    } catch (error) {
      setDeviceError(userMessage(error, 'Не удалось удалить устройство'));
    } finally {
      setIsDeletingDevice(false);
    }
  }

  function requestRegenerateDevice(device) {
    setDeviceError('');
    setDevicePendingRegenerate(device);
  }

  async function confirmRegenerateDevice() {
    if (!devicePendingRegenerate) {
      return;
    }

    setDeviceError('');
    setIsRegeneratingDevice(true);
    try {
      const payload = await fetch(`/api/devices/${devicePendingRegenerate.id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: customerId })
      }).then(readJson);
      setCreatedConfig(await withQrDataUrl({
        ...payload,
        device_name: devicePendingRegenerate.name
      }));
      setDevicePendingRegenerate(null);
      await loadAccount();
    } catch (error) {
      setDeviceError(userMessage(error, 'Не удалось обновить конфиг'));
    } finally {
      setIsRegeneratingDevice(false);
    }
  }

  async function openDeviceConfig(device) {
    if (createdConfig?.device_id === device.id) {
      setCreatedConfig(null);
      return;
    }

    setDeviceError('');
    setLoadingConfigDeviceId(device.id);
    try {
      const payload = await fetch(
        `/api/devices/${device.id}/config?user_id=${encodeURIComponent(customerId)}`
      ).then(readJson);
      setCreatedConfig(await withQrDataUrl({
        ...payload,
        device_name: device.name,
        vpn_ip: device.vpn_ip
      }));
    } catch (error) {
      setDeviceError(userMessage(error, 'Не удалось загрузить конфиг'));
    } finally {
      setLoadingConfigDeviceId(null);
    }
  }

  function downloadConfig() {
    if (!createdConfig?.conf_text) {
      return;
    }
    const blob = new Blob([createdConfig.conf_text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = createdConfig.conf_filename || 'vpn-go-amneziawg.conf';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copyReferralLink() {
    if (!customerId) {
      return;
    }

    const referralUrl = `${window.location.origin}/?ref=${encodeURIComponent(customerId)}&login=1`;
    try {
      await navigator.clipboard.writeText(referralUrl);
      setIsReferralCopied(true);
      window.setTimeout(() => setIsReferralCopied(false), 1800);
    } catch (_error) {
      setIsReferralCopied(false);
    }
  }

  const passwordBackupImageSrc = passwordBackup
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(makePasswordBackupSvg(passwordBackup))}`
    : '';
  const referralLink = customerId
    ? `${window.location.origin}/?ref=${encodeURIComponent(customerId)}&login=1`
    : '';

  async function downloadPasswordBackupImage() {
    if (!passwordBackup) {
      return;
    }

    const image = await new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'sync';
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = passwordBackupImageSrc;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 420;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.drawImage(image, 0, 0);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'vpn-go-login-password.png';
    link.click();
    URL.revokeObjectURL(url);
  }

  const loginConsentModal = loginConsentVisible && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <div className="text-2xl font-black leading-tight text-slate-950">
          Без почты. Без телефона. Без имени.
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Вход — по passkey или логину с паролем. Не шлём письма, SMS и пуши, не собираем личные данные.
        </p>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Продолжая, вы принимаете{' '}
          <a
            href="/agreement"
            target="_blank"
            rel="noreferrer"
            className="font-bold text-slate-950 underline decoration-lime-400 decoration-2 underline-offset-4"
          >
            Пользовательское соглашение
          </a>
          .
        </p>
        <button
          onClick={acceptLoginConsent}
          className="mt-6 w-full rounded-lg bg-lime-400 px-5 py-4 text-base font-black text-slate-950 transition hover:bg-lime-300"
        >
          Закрыть эту хрень, согашаюсь со всем
        </button>
      </div>
    </div>
  );

  const loginMethodModal = loginMethodVisible && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black">Способ входа</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Выберите устройство с passkey или войдите по логину и паролю.
            </p>
          </div>
          <button
            onClick={() => setLoginMethodVisible(false)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-black"
            aria-label="Закрыть"
          >
            x
          </button>
        </div>
        <div className="mt-6 grid gap-3">
          <button
            onClick={usePasskeyLogin}
            disabled={isAuthenticating}
            className="inline-flex items-center justify-center gap-3 rounded-lg bg-lime-400 px-5 py-4 font-black text-slate-950 transition hover:bg-lime-300 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isAuthenticating && (
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-950/30 border-t-slate-950" />
            )}
            Использовать устройство (passkey)
          </button>
          <button
            onClick={() => openPasswordFallback()}
            className="rounded-lg border border-slate-300 px-5 py-4 font-black text-slate-700 transition hover:border-slate-500"
          >
            Логин/пароль
          </button>
        </div>
      </div>
    </div>
  );

  const passwordFallbackModal = passwordAuthVisible && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black">Вход по логину</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Используйте этот способ, если passkey недоступен на устройстве.
            </p>
          </div>
          <button
            onClick={() => setPasswordAuthVisible(false)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-black"
            aria-label="Закрыть"
          >
            x
          </button>
        </div>

        <form onSubmit={submitPasswordLogin} className="mt-6 grid gap-4">
          <div>
            <label className="text-sm font-bold text-slate-700">Логин</label>
            <input
              value={passwordForm.login}
              onChange={(event) => {
                setPasswordForm((current) => ({ ...current, login: event.target.value }));
                setPasswordCanCreate(false);
              }}
              autoCapitalize="none"
              autoComplete="username"
              className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-slate-950"
              placeholder="my-login"
            />
          </div>
          <div>
            <label className="text-sm font-bold text-slate-700">Пароль</label>
            <input
              value={passwordForm.password}
              onChange={(event) => {
                setPasswordForm((current) => ({ ...current, password: event.target.value }));
                setPasswordCanCreate(false);
              }}
              type="text"
              autoComplete="off"
              className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-slate-950"
              placeholder="Минимум 8 символов"
            />
          </div>

          {passwordAuthError && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {passwordAuthError}
            </div>
          )}

          <button
            type="submit"
            disabled={isPasswordSubmitting}
            className="rounded-lg bg-slate-950 px-5 py-4 font-black text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isPasswordSubmitting ? 'Проверяем...' : 'Войти'}
          </button>

          {passwordCanCreate && (
            <button
              type="button"
              onClick={createPasswordAccount}
              disabled={isPasswordSubmitting}
              className="rounded-lg bg-lime-400 px-5 py-4 font-black text-slate-950 transition hover:bg-lime-300 disabled:cursor-not-allowed disabled:opacity-70"
            >
              Создать такой аккаунт
            </button>
          )}
        </form>
      </div>
    </div>
  );

  const passwordBackupModal = passwordBackup && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <h2 className="text-2xl font-black">Сохраните логин и пароль</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Мы не храним персональные данные для восстановления доступа. Если забыть логин или пароль,
          восстановить их не получится, поэтому лучше сохранить картинку сейчас.
        </p>
        <img
          src={passwordBackupImageSrc}
          alt="Логин и пароль VPN-GO"
          className="mt-5 w-full rounded-lg border border-slate-200 bg-slate-50"
        />
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <button
            onClick={downloadPasswordBackupImage}
            className="rounded-lg bg-lime-400 px-5 py-4 text-center font-black text-slate-950 transition hover:bg-lime-300"
          >
            Скачать картинку
          </button>
          <button
            onClick={() => setPasswordBackup(null)}
            className="rounded-lg border border-slate-300 px-5 py-4 font-black text-slate-700 transition hover:border-slate-500"
          >
            Я сохранил
          </button>
        </div>
      </div>
    </div>
  );

  const deleteDeviceModal = devicePendingDelete && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
        <h2 className="text-2xl font-black">Удалить устройство?</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Конфиг для устройства <span className="font-bold text-slate-950">{devicePendingDelete.name}</span> перестанет работать.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            onClick={confirmDeleteDevice}
            disabled={isDeletingDevice}
            className="rounded-lg bg-red-600 px-5 py-4 text-center font-black text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isDeletingDevice ? 'Удаляем...' : 'Удалить'}
          </button>
          <button
            onClick={() => setDevicePendingDelete(null)}
            disabled={isDeletingDevice}
            className="rounded-lg border border-slate-300 px-5 py-4 font-black text-slate-700 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );

  const regenerateDeviceModal = devicePendingRegenerate && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
        <h2 className="text-2xl font-black">Обновить конфиг?</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Для устройства <span className="font-bold text-slate-950">{devicePendingRegenerate.name}</span> будет создан новый конфиг на доступной ноде. Старый конфиг перестанет работать.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            onClick={confirmRegenerateDevice}
            disabled={isRegeneratingDevice}
            className="rounded-lg bg-lime-400 px-5 py-4 text-center font-black text-slate-950 transition hover:bg-lime-300 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isRegeneratingDevice ? 'Обновляем...' : 'Обновить конфиг'}
          </button>
          <button
            onClick={() => setDevicePendingRegenerate(null)}
            disabled={isRegeneratingDevice}
            className="rounded-lg border border-slate-300 px-5 py-4 font-black text-slate-700 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );

  if (profile) {
    const balance = dashboard?.balance;
    const devices = dashboard?.devices || [];
    const payments = dashboard?.payments || [];
    const daysLeft = balance?.days_left;

    return (
      <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <a href="#cabinet" className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-lime-400 text-base font-black text-slate-950">
                GO
              </div>
              <div className="min-w-0">
                <div className="text-lg font-black tracking-tight">VPN-GO</div>
                <div className="text-xs text-slate-500">Личный кабинет</div>
              </div>
            </a>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button
                onClick={logout}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 sm:px-4"
              >
                Выйти
              </button>
            </div>
          </div>
        </header>

        <main id="cabinet" className="mx-auto grid max-w-7xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[0.72fr_1.28fr]">
          <section className="min-w-0 space-y-6">
            {paymentReturn && (
              <div
                className={`rounded-lg border p-4 text-sm font-semibold ${
                  paymentReturn.state === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : paymentReturn.state === 'error'
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : 'border-amber-200 bg-amber-50 text-amber-800'
                }`}
              >
                {paymentReturn.message}
              </div>
            )}

            {accountError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {accountError}
              </div>
            )}

            <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="text-sm text-slate-500">Баланс</div>
              <div className="mt-2 text-5xl font-black tracking-tight">
                {isLoadingAccount && !balance ? '...' : formatRubFromKopecks(balance?.balance_kopecks)}
              </div>
              <div className="mt-3 text-sm leading-6 text-slate-600">
                Активных устройств: {balance?.active_devices || 0}. Списание:{' '}
                {formatRubFromKopecks(balance?.daily_charge_kopecks || 0)} в сутки.
                {daysLeft !== null && daysLeft !== undefined
                  ? ` Баланса хватит примерно на ${daysLeft} ${dayLabel(daysLeft)}.`
                  : ' Добавьте устройство, чтобы увидеть срок работы.'}
              </div>

              <div className="mt-6 border-t border-slate-200 pt-5">
                <h2 className="text-lg font-black">Пополнить баланс</h2>
                <label className="mt-4 block text-sm font-semibold text-slate-700">
                  Сумма пополнения
                </label>
                <div className="mt-2 flex min-w-0 rounded-lg border border-slate-300 bg-white focus-within:border-slate-950">
                  <input
                    type="number"
                    value={topUpAmount}
                    onChange={(event) => setTopUpAmount(event.target.value)}
                    onBlur={() => {
                      const amountRub = Number(String(topUpAmount).replace(',', '.'));
                      if (!Number.isFinite(amountRub) || amountRub < 30) {
                        setTopUpAmount('30');
                      }
                    }}
                    min="30"
                    step="1"
                    inputMode="numeric"
                    className="min-w-0 flex-1 rounded-lg px-4 py-3 text-lg font-bold outline-none"
                  />
                  <div className="px-4 py-3 text-lg font-bold text-slate-500">₽</div>
                </div>

                {paymentError && (
                  <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {paymentError}
                  </div>
                )}

                <button
                  onClick={createPayment}
                  disabled={isPaying}
                  className={`mt-5 w-full rounded-lg bg-lime-400 px-5 py-4 text-base font-black text-slate-950 transition hover:bg-lime-300 ${
                    isPaying ? 'cursor-not-allowed opacity-70' : ''
                  }`}
                >
                  {isPaying ? 'Переходим к оплате...' : 'Оплатить через ЮKassa'}
                </button>
              </div>

              <div className="mt-6 border-t border-slate-200 pt-5">
                <h2 className="text-lg font-black">Пригласить</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Отправьте эту ссылку другу и при активации нового аккаунта вы оба{' '}
                  <span className="dark-rainbow-text font-black">получите 50 ₽ на баланс</span>.
                </p>
                <div className="mt-4 flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                  <div className="min-w-0 flex-1 truncate px-4 py-3 font-mono text-xs text-slate-700">
                    {referralLink}
                  </div>
                  <button
                    onClick={copyReferralLink}
                    className="border-l border-slate-200 bg-white px-4 py-3 text-xs font-black text-slate-800 transition hover:bg-slate-100"
                  >
                    {isReferralCopied ? 'Скопировано' : 'Копировать'}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="min-w-0 space-y-6">
            <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <input
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  placeholder="Например, iPhone"
                  className="rounded-lg border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-950"
                />
                <button
                  onClick={createDevice}
                  disabled={isCreatingDevice}
                  className={`rounded-lg bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 ${
                    isCreatingDevice ? 'cursor-not-allowed opacity-70' : ''
                  }`}
                >
                  {isCreatingDevice ? 'Создаем...' : 'Добавить устройство'}
                </button>
              </div>

              {deviceError && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {deviceError}
                </div>
              )}
            </div>

            <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-black">Устройства</h2>
                <span className="text-sm font-semibold text-slate-500">{devices.length} активных</span>
              </div>
              <div className="mt-5 min-w-0 rounded-lg border border-slate-200">
                <div className="hidden grid-cols-[1fr_0.8fr_1.1fr] bg-slate-50 px-4 py-3 text-xs font-bold uppercase text-slate-500 md:grid">
                  <div>Устройство</div>
                  <div>Статус</div>
                  <div>Действия</div>
                </div>
                {devices.length === 0 ? (
                  <div className="px-4 py-8 text-sm text-slate-500">
                    Устройств пока нет. Пополните баланс и добавьте первое устройство.
                  </div>
                ) : (
                  devices.map((device) => {
                    const isConfigOpen = createdConfig?.device_id === device.id;
                    return (
                      <div key={device.id} className="border-t border-slate-200 first:border-t-0">
                        <div
                          onClick={() => openDeviceConfig(device)}
                          className={`grid min-w-0 cursor-pointer gap-2 px-4 py-4 text-base transition md:grid-cols-[1fr_0.8fr_1.1fr] md:items-center ${
                            isConfigOpen ? 'bg-emerald-50 ring-1 ring-inset ring-emerald-200' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-lg font-black leading-6">{device.name}</div>
                            <div className="truncate text-sm text-slate-500">{device.vpn_ip}</div>
                          </div>
                          <div className="font-bold text-emerald-700">{statusLabel(device.status)}</div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                openDeviceConfig(device);
                              }}
                              disabled={loadingConfigDeviceId === device.id}
                              className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${
                                isConfigOpen
                                  ? 'border-emerald-300 bg-white text-emerald-900'
                                  : 'border-slate-300 text-slate-700 hover:border-slate-500'
                              }`}
                            >
                              {loadingConfigDeviceId === device.id
                                ? 'Загрузка...'
                                : isConfigOpen
                                  ? 'Скрыть конфиг'
                                  : 'Показать конфиг'}
                            </button>
                            <details
                              onClick={(event) => event.stopPropagation()}
                              className="relative"
                            >
                              <summary className="list-none rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-500 [&::-webkit-details-marker]:hidden">
                                Действия
                              </summary>
                              <div className="absolute right-0 z-20 mt-2 grid min-w-44 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-xs font-bold shadow-xl">
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    requestRegenerateDevice(device);
                                    event.currentTarget.closest('details').open = false;
                                  }}
                                  className="px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50"
                                >
                                  Обновить конфиг
                                </button>
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    requestDeleteDevice(device);
                                    event.currentTarget.closest('details').open = false;
                                  }}
                                  className="px-3 py-2 text-left text-red-700 transition hover:bg-red-50"
                                >
                                  Удалить
                                </button>
                              </div>
                            </details>
                          </div>
                        </div>

                        {isConfigOpen && (
                          <div className="border-t border-emerald-200 bg-emerald-50 px-4 py-5">
                            <ol className="grid gap-5 text-sm text-emerald-950">
                              <li className="grid gap-3 md:grid-cols-[2rem_1fr]">
                                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-700 text-sm font-black text-white">
                                  1
                                </div>
                                <div>
                                  <div className="font-black">Скачайте приложение AmneziaWG</div>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {appDownloadLinks.map((link) => (
                                      <a
                                        key={link.label}
                                        href={link.href}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-black text-emerald-900 transition hover:border-emerald-400"
                                      >
                                        <span className="flex h-7 w-7 items-center justify-center rounded bg-emerald-100 text-emerald-800">
                                          <PlatformIcon name={link.icon} />
                                        </span>
                                        {link.label}
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              </li>

                              <li className="grid gap-3 md:grid-cols-[2rem_1fr]">
                                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-700 text-sm font-black text-white">
                                  2
                                </div>
                                <div>
                                  <div className="font-black">
                                    Откройте приложение и отсканируйте QR или импортируйте файл .conf
                                  </div>
                                  <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr] md:items-center">
                                    <div className="rounded-lg border border-emerald-200 bg-white p-3">
                                      <img
                                        src={createdConfig.qrDataUrl}
                                        alt="QR-код конфигурации VPN"
                                        className="h-56 w-56 max-w-full"
                                      />
                                    </div>
                                    <div>
                                      <button
                                        onClick={downloadConfig}
                                        className="rounded-lg bg-emerald-700 px-4 py-3 text-sm font-bold text-white transition hover:bg-emerald-800"
                                      >
                                        Скачать .conf
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </li>
                            </ol>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-black">История оплат</h2>
              <div className="mt-5 grid gap-3">
                {payments.length === 0 ? (
                  <div className="rounded-lg border border-slate-200 px-4 py-6 text-sm text-slate-500">
                    Оплат пока нет.
                  </div>
                ) : (
                  payments.map((payment) => (
                    <div
                      key={payment.payment_id}
                      className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-sm"
                    >
                      <div>
                        <div className="font-normal text-slate-700">{payment.order_id || payment.payment_id}</div>
                        <div className="text-xs text-slate-500">{dateLabel(payment.created_at)}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-normal text-slate-700">{payment.amount_value} ₽</div>
                        <div className={`text-xs font-normal ${paymentStatusClass(payment.status)}`}>{payment.status}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </main>
        {loginMethodModal}
        {passwordFallbackModal}
        {passwordBackupModal}
        {deleteDeviceModal}
        {regenerateDeviceModal}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <a href="#top" className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-lime-400 text-base font-black">
              GO
            </div>
            <div>
              <div className="text-lg font-black tracking-tight">VPN-GO</div>
              <div className="text-xs text-slate-500">WireGuard VPN</div>
            </div>
          </a>
          <button
            onClick={openLoginConsent}
            disabled={isAuthenticating}
            className={`inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-bold text-white transition hover:bg-slate-800 ${
              isAuthenticating ? 'cursor-not-allowed opacity-70' : ''
            }`}
          >
            {isAuthenticating && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {isAuthenticating ? 'Открываем...' : 'Вход'}
          </button>
        </div>
      </header>

      <main id="top">
        <section className="relative overflow-hidden border-b border-slate-200 bg-white">
          <div className="relative mx-auto grid max-w-7xl gap-12 px-6 py-16 lg:grid-cols-[0.92fr_1.08fr] lg:py-24">
            <div className="max-w-2xl self-center">
              <h1 className="text-5xl font-black leading-none tracking-tight text-slate-950 sm:text-6xl lg:text-7xl">
                VPN-GO
              </h1>
              <p className="mt-6 text-2xl font-black leading-tight text-slate-900 sm:text-3xl">
                Быстрый VPN с оплатой по балансу: 5 ₽ в сутки.
              </p>
              <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">
                Зарегистрируйтесь, пополните баланс в личном кабинете и подключайте устройства через AmneziaWG.
              </p>
              <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-[10.75rem_minmax(0,1fr)] sm:items-center">
                <button
                  onClick={openLoginConsent}
                  disabled={isAuthenticating}
                  className="inline-flex h-14 w-full items-center justify-center gap-3 rounded-lg bg-lime-400 px-5 text-base font-black text-slate-950 transition hover:bg-lime-300 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isAuthenticating && (
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-950/30 border-t-slate-950" />
                  )}
                  {isAuthenticating ? 'Открываем...' : 'Подключить'}
                </button>
                <div className="flex min-h-12 min-w-0 items-center text-sm font-black uppercase leading-5 text-slate-700 sm:h-14">
                  <span
                    key={heroBenefits[heroBenefitIndex]}
                    className="hero-benefit-text block max-w-full"
                  >
                    {heroBenefits[heroBenefitIndex]}
                  </span>
                </div>
              </div>
              {authStatus && (
                <div className="mt-4 text-sm font-semibold text-slate-600">{authStatus}...</div>
              )}
              {authError && (
                <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {authError}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-950 p-4 shadow-2xl shadow-slate-300">
              <div className="rounded-lg bg-white p-5">
                <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-500">Личный кабинет</div>
                    <div className="mt-1 text-2xl font-black">Следите за балансом и расходами</div>
                  </div>
                  <div className="rounded-lg bg-lime-400 px-3 py-2 text-sm font-black">5 ₽/сутки</div>
                </div>
                <div className="mt-5 rounded-lg border border-slate-200">
                  {[
                    ['Баланс', 'Списание по активным устройствам', '5 ₽/сутки'],
                    ['Устройства', 'Конфиги и QR-коды в одном месте', 'AmneziaWG']
                  ].map(([title, text, value]) => (
                    <div
                      key={title}
                      className="flex items-center justify-between border-b border-slate-200 px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <div className="font-black">{title}</div>
                        <div className="text-sm text-slate-500">{text}</div>
                      </div>
                      <div className="text-sm font-bold text-emerald-700">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 py-20">
          <div className="grid gap-5 md:grid-cols-3">
            {[
              ['1', 'Зарегистрируйтесь', 'Создайте аккаунт VPN-GO и войдите в личный кабинет.'],
              ['2', 'Пополните баланс', 'Оплата находится внутри личного кабинета и проходит через ЮKassa.'],
              ['3', 'Подключите устройство', 'Получите конфиг и включите VPN в AmneziaWG.']
            ].map(([step, title, text]) => (
              <div key={step} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-sm font-black text-white">
                  {step}
                </div>
                <h3 className="mt-5 text-xl font-black">{title}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-600">{text}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto grid max-w-7xl gap-4 px-6 py-8 text-sm text-slate-600 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="font-black text-slate-950">VPN-GO</div>
            <div className="mt-1">
              ИП Токмаков Юрий Константинович · ОГРНИП 322265100121349 · ИНН 263408820400
            </div>
          </div>
          <div className="text-slate-500">© 2026 VPN-GO</div>
        </div>
      </footer>
      {loginConsentModal}
      {loginMethodModal}
      {passwordFallbackModal}
    </div>
  );
}
