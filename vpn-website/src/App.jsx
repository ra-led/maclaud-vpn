import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';

const STORAGE_PROFILE_KEY = 'vpngo_profile';
const STORAGE_CUSTOMER_KEY = 'vpngo_customer_id';
const DAILY_PRICE_RUB = 2;

const previewDevices = [
  { name: 'iPhone', location: 'Москва', status: 'Активен', traffic: '12.4 ГБ' },
  { name: 'MacBook', location: 'Амстердам', status: 'Активен', traffic: '38.1 ГБ' },
  { name: 'Планшет', location: 'Франкфурт', status: 'Пауза', traffic: '4.8 ГБ' }
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
  const existingId = window.localStorage.getItem(STORAGE_CUSTOMER_KEY);
  if (existingId && /^\d+$/.test(existingId)) {
    return existingId;
  }
  const created = String(Math.floor(Date.now() + Math.random() * 1_000_000));
  window.localStorage.setItem(STORAGE_CUSTOMER_KEY, created);
  return created;
}

function formatRubFromKopecks(value) {
  return `${Math.floor((value || 0) / 100)} ₽`;
}

function formatBytes(value) {
  if (!value) {
    return '0 Б';
  }
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
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

export default function VPNLandingPage() {
  const [authMode, setAuthMode] = useState(null);
  const [profile, setProfile] = useState(() => getStoredProfile());
  const [form, setForm] = useState({
    name: getStoredProfile()?.name || '',
    email: getStoredProfile()?.email || ''
  });
  const [dashboard, setDashboard] = useState(null);
  const [isLoadingAccount, setIsLoadingAccount] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [paymentReturn, setPaymentReturn] = useState(null);
  const [topUpAmount, setTopUpAmount] = useState('300');
  const [deviceName, setDeviceName] = useState('');
  const [isCreatingDevice, setIsCreatingDevice] = useState(false);
  const [loadingConfigDeviceId, setLoadingConfigDeviceId] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [createdConfig, setCreatedConfig] = useState(null);
  const [isConfigTextVisible, setIsConfigTextVisible] = useState(false);

  const customerId = useMemo(() => createCustomerId(), []);

  async function loadAccount(currentProfile = profile) {
    if (!currentProfile) {
      return;
    }

    setIsLoadingAccount(true);
    setAccountError('');
    try {
      const params = new URLSearchParams({
        name: currentProfile.name || '',
        email: currentProfile.email || ''
      });
      const payload = await fetch(`/api/account/${customerId}?${params}`).then(readJson);
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

  function openAuth(mode) {
    setPaymentError('');
    setAuthMode(mode);
  }

  function submitAuth(event) {
    event.preventDefault();
    const nextProfile = {
      name: form.name.trim() || 'Пользователь VPN-GO',
      email: form.email.trim() || 'user@example.com'
    };
    window.localStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(nextProfile));
    setProfile(nextProfile);
    setAuthMode(null);
  }

  function logout() {
    window.localStorage.removeItem(STORAGE_PROFILE_KEY);
    setProfile(null);
    setDashboard(null);
    setCreatedConfig(null);
  }

  async function createPayment() {
    const amountRub = Number(String(topUpAmount).replace(',', '.'));
    if (!Number.isFinite(amountRub) || amountRub <= 0) {
      setPaymentError('Введите сумму пополнения больше 0 ₽');
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
      setIsConfigTextVisible(false);
      setDeviceName('');
      await loadAccount();
    } catch (error) {
      setDeviceError(userMessage(error, 'Не удалось добавить устройство'));
    } finally {
      setIsCreatingDevice(false);
    }
  }

  async function deleteDevice(deviceId) {
    setDeviceError('');
    try {
      await fetch(`/api/devices/${deviceId}?user_id=${encodeURIComponent(customerId)}`, {
        method: 'DELETE'
      }).then(readJson);
      setCreatedConfig(null);
      setIsConfigTextVisible(false);
      await loadAccount();
    } catch (error) {
      setDeviceError(userMessage(error, 'Не удалось удалить устройство'));
    }
  }

  async function openDeviceConfig(device) {
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
      setIsConfigTextVisible(false);
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

  if (profile) {
    const balance = dashboard?.balance;
    const devices = dashboard?.devices || [];
    const payments = dashboard?.payments || [];
    const daysLeft = balance?.days_left;

    return (
      <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <a href="#cabinet" className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-lime-400 text-base font-black text-slate-950">
                GO
              </div>
              <div>
                <div className="text-lg font-black tracking-tight">VPN-GO</div>
                <div className="text-xs text-slate-500">Личный кабинет</div>
              </div>
            </a>
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-slate-500 sm:inline">{profile.email}</span>
              <button
                onClick={() => loadAccount()}
                disabled={isLoadingAccount}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
              >
                Обновить
              </button>
              <button
                onClick={logout}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
              >
                Выйти
              </button>
            </div>
          </div>
        </header>

        <main id="cabinet" className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[0.72fr_1.28fr]">
          <section className="space-y-6">
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

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
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
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-black">Пополнить баланс</h2>
              <div className="mt-5 grid grid-cols-3 gap-2">
                {['150', '300', '900'].map((amount) => (
                  <button
                    key={amount}
                    onClick={() => setTopUpAmount(amount)}
                    className={`rounded-lg border px-3 py-3 text-sm font-bold transition ${
                      topUpAmount === amount
                        ? 'border-slate-950 bg-slate-950 text-white'
                        : 'border-slate-200 bg-white hover:border-slate-400'
                    }`}
                  >
                    {amount} ₽
                  </button>
                ))}
              </div>

              <label className="mt-5 block text-sm font-semibold text-slate-700">
                Сумма пополнения
              </label>
              <div className="mt-2 flex rounded-lg border border-slate-300 bg-white focus-within:border-slate-950">
                <input
                  value={topUpAmount}
                  onChange={(event) => setTopUpAmount(event.target.value)}
                  inputMode="decimal"
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
          </section>

          <section className="space-y-6">
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <h1 className="text-2xl font-black">Здравствуйте, {profile.name}</h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                    Аккаунт #{customerId}. Здесь отображаются реальные баланс, устройства и платежи.
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto]">
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

            {createdConfig && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-black text-emerald-950">
                      Конфиг {createdConfig.device_name ? `для ${createdConfig.device_name}` : 'готов'}
                    </h2>
                    <p className="mt-1 text-sm text-emerald-800">
                      Отсканируйте QR-код или скачайте файл для импорта в AmneziaWG/WireGuard-клиент.
                    </p>
                  </div>
                  <button
                    onClick={downloadConfig}
                    className="rounded-lg bg-emerald-700 px-4 py-3 text-sm font-bold text-white transition hover:bg-emerald-800"
                  >
                    Скачать конфиг
                  </button>
                </div>
                <div className="mt-5 grid gap-5 md:grid-cols-[auto_1fr] md:items-center">
                  <div className="rounded-lg border border-emerald-200 bg-white p-4">
                    <img
                      src={createdConfig.qrDataUrl}
                      alt="QR-код конфигурации VPN"
                      className="h-64 w-64 max-w-full"
                    />
                  </div>
                  <div className="text-sm leading-7 text-emerald-900">
                    <div className="font-bold">Файл: {createdConfig.conf_filename}</div>
                    {createdConfig.vpn_ip && <div>VPN IP: {createdConfig.vpn_ip}</div>}
                    <div className="mt-3 text-emerald-800">
                      Текст конфига скрыт по умолчанию. Его можно раскрыть ниже, если нужно скопировать вручную.
                    </div>
                  </div>
                </div>
                <div className="mt-5 border-t border-emerald-200 pt-5">
                  <button
                    onClick={() => setIsConfigTextVisible((current) => !current)}
                    className="rounded-lg border border-emerald-300 bg-white px-4 py-3 text-sm font-bold text-emerald-900 transition hover:border-emerald-500"
                  >
                    {isConfigTextVisible ? 'Скрыть текст конфига' : 'Показать текст конфига'}
                  </button>
                  {isConfigTextVisible && (
                    <textarea
                      readOnly
                      value={createdConfig.conf_text}
                      className="mt-4 h-64 w-full resize-y rounded-lg border border-emerald-200 bg-white p-4 font-mono text-xs outline-none"
                    />
                  )}
                </div>
              </div>
            )}

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-black">Устройства</h2>
                <span className="text-sm font-semibold text-slate-500">{devices.length} активных</span>
              </div>
              <div className="mt-5 rounded-lg border border-slate-200">
                <div className="hidden grid-cols-[1fr_1fr_0.75fr_0.8fr_1fr] bg-slate-50 px-4 py-3 text-xs font-bold uppercase text-slate-500 md:grid">
                  <div>Устройство</div>
                  <div>Нода</div>
                  <div>Статус</div>
                  <div>Трафик</div>
                  <div>Конфиг</div>
                </div>
                {devices.length === 0 ? (
                  <div className="px-4 py-8 text-sm text-slate-500">
                    Устройств пока нет. Пополните баланс и добавьте первое устройство.
                  </div>
                ) : (
                  devices.map((device) => (
                    <div
                      key={device.id}
                      className="grid gap-2 border-t border-slate-200 px-4 py-4 text-sm first:border-t-0 md:grid-cols-[1fr_1fr_0.75fr_0.8fr_1fr] md:items-center"
                    >
                      <div>
                        <div className="font-bold">{device.name}</div>
                        <div className="text-xs text-slate-500">{device.vpn_ip}</div>
                      </div>
                      <div className="text-slate-600">
                        {device.node_name}
                        {device.city ? `, ${device.city}` : ''}
                      </div>
                      <div className="font-semibold text-emerald-700">{statusLabel(device.status)}</div>
                      <div className="text-slate-600">
                        {formatBytes((device.rx_bytes || 0) + (device.tx_bytes || 0))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => openDeviceConfig(device)}
                          disabled={loadingConfigDeviceId === device.id}
                          className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:border-slate-500"
                        >
                          {loadingConfigDeviceId === device.id ? 'Загрузка...' : 'Показать конфиг'}
                        </button>
                        <button
                          onClick={() => deleteDevice(device.id)}
                          className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:border-red-300 hover:text-red-700"
                        >
                          Удалить
                        </button>
                      </div>
                    </div>
                  ))
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
                      className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                    >
                      <div>
                        <div className="font-bold">{payment.order_id || payment.payment_id}</div>
                        <div className="text-sm text-slate-500">{dateLabel(payment.created_at)}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-black">{payment.amount_value} ₽</div>
                        <div className="text-sm text-emerald-700">{payment.status}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </main>
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => openAuth('login')}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 transition hover:border-slate-500"
            >
              Войти
            </button>
            <button
              onClick={() => openAuth('register')}
              className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-bold text-white transition hover:bg-slate-800"
            >
              Регистрация
            </button>
          </div>
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
                Быстрый VPN с оплатой по балансу: 2 ₽ в сутки.
              </p>
              <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">
                Зарегистрируйтесь, пополните баланс в личном кабинете и подключайте устройства через AmneziaWG.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <button
                  onClick={() => openAuth('register')}
                  className="rounded-lg bg-lime-400 px-6 py-4 text-base font-black text-slate-950 transition hover:bg-lime-300"
                >
                  Зарегистрироваться
                </button>
                <button
                  onClick={() => openAuth('login')}
                  className="rounded-lg border border-slate-300 px-6 py-4 text-base font-black text-slate-800 transition hover:border-slate-500 hover:bg-slate-50"
                >
                  Войти в личный кабинет
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-950 p-4 shadow-2xl shadow-slate-300">
              <div className="rounded-lg bg-white p-5">
                <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-500">Превью кабинета</div>
                    <div className="mt-1 text-2xl font-black">Реальные данные после входа</div>
                  </div>
                  <div className="rounded-lg bg-lime-400 px-3 py-2 text-sm font-black">2 ₽/сутки</div>
                </div>
                <div className="mt-5 rounded-lg border border-slate-200">
                  {previewDevices.slice(0, 2).map((device) => (
                    <div
                      key={device.name}
                      className="flex items-center justify-between border-b border-slate-200 px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <div className="font-black">{device.name}</div>
                        <div className="text-sm text-slate-500">{device.location}</div>
                      </div>
                      <div className="text-sm font-bold text-emerald-700">{device.status}</div>
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
              ['3', 'Подключите устройство', 'Получите конфиг AmneziaWG и включите VPN в приложении.']
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

      {authMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black">
                  {authMode === 'register' ? 'Регистрация' : 'Вход'}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  После входа откроется личный кабинет с оплатой и устройствами.
                </p>
              </div>
              <button
                onClick={() => setAuthMode(null)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-black"
                aria-label="Закрыть"
              >
                x
              </button>
            </div>

            <form onSubmit={submitAuth} className="mt-6 grid gap-4">
              <div>
                <label className="text-sm font-bold text-slate-700">Имя</label>
                <input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-slate-950"
                  placeholder="Юрий"
                />
              </div>
              <div>
                <label className="text-sm font-bold text-slate-700">Email</label>
                <input
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  type="email"
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-slate-950"
                  placeholder="you@example.com"
                />
              </div>
              <button className="rounded-lg bg-lime-400 px-5 py-4 font-black text-slate-950 transition hover:bg-lime-300">
                {authMode === 'register' ? 'Создать аккаунт' : 'Войти'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
