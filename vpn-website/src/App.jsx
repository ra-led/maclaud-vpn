import { useEffect, useMemo, useState } from 'react';

const STORAGE_PROFILE_KEY = 'vpngo_profile';
const STORAGE_CUSTOMER_KEY = 'vpngo_customer_id';
const DAILY_PRICE_RUB = 2;

const previewDevices = [
  { name: 'iPhone', location: 'Москва', status: 'Активен', traffic: '12.4 ГБ' },
  { name: 'MacBook', location: 'Амстердам', status: 'Активен', traffic: '38.1 ГБ' },
  { name: 'Планшет', location: 'Франкфурт', status: 'Пауза', traffic: '4.8 ГБ' }
];

const cabinetDevices = [
  { name: 'iPhone', location: 'Москва', status: 'Активен', next: 'сегодня' },
  { name: 'MacBook', location: 'Амстердам', status: 'Активен', next: 'сегодня' }
];

const payments = [
  { id: 'VG-1042', date: '05.05.2026', amount: '300 ₽', status: 'Зачислено' },
  { id: 'VG-1018', date: '18.04.2026', amount: '150 ₽', status: 'Зачислено' }
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

export default function VPNLandingPage() {
  const [authMode, setAuthMode] = useState(null);
  const [profile, setProfile] = useState(() => getStoredProfile());
  const [form, setForm] = useState({
    name: getStoredProfile()?.name || '',
    email: getStoredProfile()?.email || ''
  });
  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [paymentReturn, setPaymentReturn] = useState(null);
  const [topUpAmount, setTopUpAmount] = useState('300');

  const customerId = useMemo(() => createCustomerId(), []);
  const balanceDays = Math.floor(486 / DAILY_PRICE_RUB);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order_id');
    if (window.location.pathname !== '/payment-return' || !orderId) {
      return;
    }

    let cancelled = false;
    setPaymentReturn({ state: 'checking', message: 'Проверяем статус платежа...' });

    fetch(`/api/payment-status-by-order/${encodeURIComponent(orderId)}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error || 'Не удалось проверить платеж');
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (payload.paid || payload.status === 'succeeded') {
          setPaymentReturn({
            state: 'success',
            message: 'Платеж прошел. Баланс будет обновлен в личном кабинете.'
          });
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

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'Не удалось создать платеж');
      }
      if (!payload?.confirmation_url) {
        throw new Error('ЮKassa не вернула ссылку на оплату');
      }

      window.location.href = payload.confirmation_url;
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : 'Неожиданная ошибка оплаты');
    } finally {
      setIsPaying(false);
    }
  }

  if (profile) {
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

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="text-sm text-slate-500">Баланс</div>
              <div className="mt-2 text-5xl font-black tracking-tight">486 ₽</div>
              <div className="mt-3 text-sm leading-6 text-slate-600">
                Списание: {DAILY_PRICE_RUB} ₽ в сутки за активный VPN-доступ.
                Баланса хватит примерно на {balanceDays} {dayLabel(balanceDays)}.
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-black">Пополнить баланс</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Введите сумму, после оплаты деньги будут зачислены на баланс.
              </p>

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
                    Здесь будут устройства, конфиги WireGuard и история списаний.
                  </p>
                </div>
                <button className="rounded-lg bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800">
                  Добавить устройство
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-black">Устройства</h2>
                <span className="text-sm font-semibold text-slate-500">
                  {cabinetDevices.length} активных
                </span>
              </div>
              <div className="mt-5 rounded-lg border border-slate-200">
                <div className="hidden grid-cols-[1.2fr_1fr_0.8fr_0.8fr] bg-slate-50 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 md:grid">
                  <div>Устройство</div>
                  <div>Нода</div>
                  <div>Статус</div>
                  <div>Списание</div>
                </div>
                {cabinetDevices.map((device) => (
                  <div
                    key={device.name}
                    className="grid gap-2 border-t border-slate-200 px-4 py-4 text-sm first:border-t-0 md:grid-cols-[1.2fr_1fr_0.8fr_0.8fr]"
                  >
                    <div className="font-bold">{device.name}</div>
                    <div className="text-slate-600">{device.location}</div>
                    <div className="font-semibold text-emerald-700">{device.status}</div>
                    <div className="text-slate-600">Списание: {device.next}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-black">История оплат</h2>
              <div className="mt-5 grid gap-3">
                {payments.map((payment) => (
                  <div
                    key={payment.id}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                  >
                    <div>
                      <div className="font-bold">{payment.id}</div>
                      <div className="text-sm text-slate-500">{payment.date}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-black">{payment.amount}</div>
                      <div className="text-sm text-emerald-700">{payment.status}</div>
                    </div>
                  </div>
                ))}
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

          <nav className="hidden items-center gap-7 text-sm font-semibold text-slate-600 md:flex">
            <a href="#price" className="transition hover:text-slate-950">
              Цена
            </a>
            <a href="#how" className="transition hover:text-slate-950">
              Как работает
            </a>
            <a href="#preview" className="transition hover:text-slate-950">
              Личный кабинет
            </a>
          </nav>

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
          <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#f7f8fb] to-transparent" />
          <div className="relative mx-auto grid max-w-7xl gap-12 px-6 py-16 lg:grid-cols-[0.92fr_1.08fr] lg:py-24">
            <div className="max-w-2xl self-center">
              <h1 className="text-5xl font-black leading-none tracking-tight text-slate-950 sm:text-6xl lg:text-7xl">
                VPN-GO
              </h1>
              <p className="mt-6 text-2xl font-black leading-tight text-slate-900 sm:text-3xl">
                Быстрый VPN с оплатой по балансу: 2 ₽ в сутки.
              </p>
              <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">
                Зарегистрируйтесь, пополните баланс в личном кабинете и подключайте
                устройства через WireGuard. Без пакетов, подписок и сложных условий.
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

              <div className="mt-10 grid gap-3 sm:grid-cols-3">
                {[
                  ['2 ₽', 'сутки доступа'],
                  ['WireGuard', 'официальный клиент'],
                  ['Баланс', 'пополнение в ЛК']
                ].map(([value, label]) => (
                  <div key={value} className="rounded-lg border border-slate-200 bg-[#f7f8fb] p-4">
                    <div className="text-2xl font-black">{value}</div>
                    <div className="mt-1 text-sm text-slate-500">{label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative">
              <div className="absolute -right-8 top-8 h-40 w-40 rounded-full bg-lime-300/50 blur-3xl" />
              <div className="absolute -bottom-6 left-4 h-36 w-36 rounded-full bg-sky-300/40 blur-3xl" />
              <div className="relative rounded-lg border border-slate-200 bg-slate-950 p-4 shadow-2xl shadow-slate-300">
                <div className="rounded-lg bg-white p-5">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <div>
                      <div className="text-sm font-semibold text-slate-500">Личный кабинет</div>
                      <div className="mt-1 text-2xl font-black">486 ₽ на балансе</div>
                    </div>
                    <div className="rounded-lg bg-lime-400 px-3 py-2 text-sm font-black">
                      243 дня
                    </div>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div className="rounded-lg bg-[#f7f8fb] p-4">
                      <div className="text-sm text-slate-500">Цена</div>
                      <div className="mt-2 text-3xl font-black">2 ₽/сутки</div>
                    </div>
                    <div className="rounded-lg bg-[#f7f8fb] p-4">
                      <div className="text-sm text-slate-500">Устройства</div>
                      <div className="mt-2 text-3xl font-black">2 активных</div>
                    </div>
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
          </div>
        </section>

        <section id="price" className="mx-auto max-w-7xl px-6 py-20">
          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
                Одна цена по балансу
              </h2>
              <p className="mt-4 max-w-xl text-lg leading-8 text-slate-600">
                Никаких пакетов и сложных условий. Вы пополняете баланс, а сервис
                списывает 2 ₽ в сутки за активный доступ.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                ['150 ₽', 'примерно 50 дней'],
                ['300 ₽', 'примерно 100 дней'],
                ['900 ₽', 'примерно 300 дней']
              ].map(([amount, days]) => (
                <div key={amount} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="text-3xl font-black">{amount}</div>
                  <div className="mt-2 text-sm text-slate-500">{days}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="border-y border-slate-200 bg-white">
          <div className="mx-auto max-w-7xl px-6 py-20">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
              Как начать пользоваться
            </h2>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {[
                ['1', 'Зарегистрируйтесь', 'Создайте аккаунт VPN-GO и войдите в личный кабинет.'],
                ['2', 'Пополните баланс', 'Оплата находится внутри личного кабинета и проходит через ЮKassa.'],
                ['3', 'Подключите устройство', 'Получите конфиг WireGuard и включите VPN в официальном приложении.']
              ].map(([step, title, text]) => (
                <div key={step} className="rounded-lg border border-slate-200 bg-[#f7f8fb] p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-sm font-black text-white">
                    {step}
                  </div>
                  <h3 className="mt-5 text-xl font-black">{title}</h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="preview" className="mx-auto max-w-7xl px-6 py-20">
          <div className="mb-8 max-w-3xl">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
              Превью личного кабинета
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              На лендинге это только пример интерфейса. Реальные действия, устройства
              и оплата доступны после входа.
            </p>
          </div>

          <div
            className="pointer-events-none select-none rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            aria-hidden="true"
          >
            <div className="grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
              <div className="rounded-lg bg-slate-950 p-5 text-white">
                <div className="text-sm text-slate-400">Баланс</div>
                <div className="mt-2 text-4xl font-black">486 ₽</div>
                <div className="mt-3 text-sm text-slate-300">
                  2 ₽/сутки, хватит примерно на 243 дня
                </div>
                <button
                  disabled
                  tabIndex={-1}
                  className="mt-6 w-full rounded-lg bg-lime-400 px-4 py-3 font-black text-slate-950"
                >
                  Пополнить баланс
                </button>
              </div>

              <div className="rounded-lg border border-slate-200">
                <div className="hidden grid-cols-[1fr_1fr_0.8fr_0.8fr] bg-[#f7f8fb] px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 md:grid">
                  <div>Устройство</div>
                  <div>Нода</div>
                  <div>Статус</div>
                  <div>Трафик</div>
                </div>
                {previewDevices.map((device) => (
                  <div
                    key={device.name}
                    className="grid gap-2 border-t border-slate-200 px-4 py-4 text-sm first:border-t-0 md:grid-cols-[1fr_1fr_0.8fr_0.8fr]"
                  >
                    <div className="font-black">{device.name}</div>
                    <div className="text-slate-600">{device.location}</div>
                    <div className="font-semibold text-emerald-700">{device.status}</div>
                    <div className="text-slate-600">{device.traffic}</div>
                  </div>
                ))}
              </div>
            </div>
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
                ×
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
