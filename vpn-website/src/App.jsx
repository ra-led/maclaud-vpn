import QRCode from 'qrcode';
import FingerprintJS from '@fingerprintjs/fingerprintjs';
import '@chatscope/chat-ui-kit-styles/dist/default/styles.min.css';
import {
  ChatContainer,
  Conversation,
  ConversationHeader,
  ConversationList,
  MainContainer,
  Message,
  MessageInput,
  MessageList,
  Sidebar
} from '@chatscope/chat-ui-kit-react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useRef, useState } from 'react';
import { userAgreementText } from './userAgreement.js';

const STORAGE_PROFILE_KEY = 'vpngo_profile';
const STORAGE_CUSTOMER_KEY = 'vpngo_customer_id';
const STORAGE_REFERRAL_KEY = 'vpngo_referrer_id';
const STORAGE_REFERRAL_TOKEN_KEY = 'vpngo_referral_token';
const STORAGE_REFERRAL_GATE_KEY = 'vpngo_referral_gate';
const DAILY_PRICE_RUB = 5;
let fingerprintPromise = null;

const appDownloadLinks = [
  { label: 'Android', icon: 'android', href: 'https://play.google.com/store/apps/details?id=org.amnezia.awg' },
  { label: 'iOS', icon: 'ios', href: 'https://apps.apple.com/us/app/amneziawg/id6478942365' },
  { label: 'Windows', icon: 'windows', href: 'https://github.com/amnezia-vpn/amnezia-client/releases/download/4.8.15.4/AmneziaVPN_4.8.15.4_x64.exe' },
  { label: 'MacOS', icon: 'macos', href: 'https://apps.apple.com/us/app/amneziawg/id6478942365?platform=mac' }
];

const instructionSections = [
  {
    os: 'Android',
    icon: 'android',
    downloadLabel: 'Скачать AmneziaWG для Android',
    downloadHref: appDownloadLinks[0].href,
    steps: [
      { text: 'Скачайте AmneziaWG по ссылке и установите.', download: true },
      { text: 'В личном кабинете добавьте/выберите нужное устройство в списке и скачайте файл .conf.', accountLink: true },
      { text: 'Откройте установленное AmneziaWG.' },
      { text: 'В AmneziaWG выберите импорт или создание туннеля из файла.' },
      { text: 'Выберите скачанный .conf файл и включите туннель.' }
    ]
  },
  {
    os: 'iOS',
    icon: 'ios',
    downloadLabel: 'Скачать AmneziaWG для iOS',
    downloadHref: appDownloadLinks[1].href,
    steps: [
      { text: 'Скачайте AmneziaWG по ссылке и установите.', download: true },
      { text: 'В личном кабинете добавьте/выберите нужное устройство в списке и скачайте файл .conf.', accountLink: true },
      {
        text: 'Откройте установленное AmneziaWG.',
        screenshot: { src: '/instructions/create-tunnel/ios/2.jpg', label: 'Откройте AmneziaWG' }
      },
      {
        text: 'Нажмите +, чтобы создать новый туннель.',
        screenshot: { src: '/instructions/create-tunnel/ios/3.jpg', label: 'Создание туннеля' }
      },
      {
        text: 'Выберите импорт из файла.',
        screenshot: { src: '/instructions/create-tunnel/ios/4a.jpg', label: 'Импорт из файла' }
      },
      {
        text: 'Выберите скачанный .conf файл.'
      },
      {
        text: 'Подтвердите импорт и включите туннель.',
        screenshot: { src: '/instructions/create-tunnel/ios/5.jpg', label: 'Готовый туннель' }
      }
    ]
  },
  {
    os: 'Windows',
    icon: 'windows',
    downloadLabel: 'Скачать AmneziaWG для Windows',
    downloadHref: appDownloadLinks[2].href,
    steps: [
      { text: 'Скачайте AmneziaWG по ссылке и установите.', download: true },
      { text: 'В личном кабинете добавьте/выберите нужное устройство в списке и скачайте файл .conf.', accountLink: true },
      { text: 'Откройте установленное AmneziaWG.' },
      { text: 'В AmneziaWG выберите импорт или создание туннеля из файла.' },
      { text: 'Выберите скачанный .conf файл и включите туннель.' }
    ]
  },
  {
    os: 'macOS',
    icon: 'macos',
    downloadLabel: 'Скачать AmneziaWG для macOS',
    downloadHref: appDownloadLinks[3].href,
    steps: [
      { text: 'Скачайте AmneziaWG по ссылке и установите.', download: true },
      { text: 'В личном кабинете добавьте/выберите нужное устройство в списке и скачайте файл .conf.', accountLink: true },
      {
        text: 'Запустите AmneziaWG.',
        screenshot: { src: '/instructions/create-tunnel/macos/2.jpg', label: 'Запуск AmneziaWG' }
      },
      {
        text: 'Нажмите на значок AmneziaWG в правом верхнем углу.',
        screenshot: { src: '/instructions/create-tunnel/macos/3.jpg', label: 'Значок AmneziaWG' }
      },
      {
        text: 'Выберите "Импорт туннелей из файла".',
        screenshot: { src: '/instructions/create-tunnel/macos/4.jpg', label: 'Импорт из файла' }
      },
      {
        text: 'Выберите скачанный .conf файл, подтвердите импорт и включите туннель.',
        screenshot: { src: '/instructions/create-tunnel/macos/5.jpg', label: 'Готовый туннель' }
      }
    ]
  }
];

const accountConfigScreenshot = {
  src: '/instructions/create-tunnel/dl_conf.jpg',
  label: 'Скачайте .conf в личном кабинете'
};

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

function getStoredReferralToken() {
  const referralToken = window.localStorage.getItem(STORAGE_REFERRAL_TOKEN_KEY);
  return referralToken && /^[A-Za-z0-9_-]{12,80}$/.test(referralToken) ? referralToken : '';
}

async function getVisitorId() {
  try {
    if (!fingerprintPromise) {
      fingerprintPromise = FingerprintJS.load()
        .then((agent) => agent.get())
        .then((result) => result.visitorId);
    }
    return await fingerprintPromise;
  } catch (_error) {
    return '';
  }
}

function createReferralGateMarker() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

async function isLikelyPrivateBrowsing() {
  try {
    const dbName = `vpngo-private-probe-${Date.now()}`;
    await new Promise((resolve, reject) => {
      const request = window.indexedDB?.open(dbName, 1);
      if (!request) {
        resolve();
        return;
      }
      request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
      request.onsuccess = () => {
        request.result.close();
        window.indexedDB.deleteDatabase(dbName);
        resolve();
      };
    });
  } catch (_error) {
    return true;
  }

  try {
    const estimate = await navigator.storage?.estimate?.();
    const quota = Number(estimate?.quota || 0);
    if (quota > 0 && quota < 120 * 1024 * 1024) {
      return true;
    }
  } catch (_error) {
    return false;
  }

  return false;
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
    className: 'h-5 w-5',
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
      <svg {...commonProps} fill="currentColor" stroke="none">
        <path d="M7.3 9.2h9.4v7.2a2.3 2.3 0 0 1-2.3 2.3h-.4v2a.9.9 0 0 1-1.8 0v-2h-1v2a.9.9 0 0 1-1.8 0v-2h-.4a2.3 2.3 0 0 1-2.3-2.3V9.2Z" />
        <path d="M5 10.2a.9.9 0 0 1 .9.9v4.7a.9.9 0 0 1-1.8 0v-4.7a.9.9 0 0 1 .9-.9Z" />
        <path d="M19 10.2a.9.9 0 0 1 .9.9v4.7a.9.9 0 0 1-1.8 0v-4.7a.9.9 0 0 1 .9-.9Z" />
        <path d="M8.2 7.8a4.6 4.6 0 0 1 7.6 0H8.2Z" />
        <path d="M8.5 3.2a.7.7 0 0 1 1 .2l1 1.6a.7.7 0 1 1-1.2.8l-1-1.6a.7.7 0 0 1 .2-1Z" />
        <path d="M15.5 3.2a.7.7 0 0 1 .2 1l-1 1.6a.7.7 0 1 1-1.2-.8l1-1.6a.7.7 0 0 1 1-.2Z" />
        <circle cx="10.2" cy="6.6" r=".55" fill="#ecfdf5" />
        <circle cx="13.8" cy="6.6" r=".55" fill="#ecfdf5" />
      </svg>
    );
  }

  if (name === 'ios') {
    return (
      <svg {...commonProps} fill="currentColor" stroke="none">
        <path d="M15.4 3.1c.2 1.4-.5 2.7-1.2 3.4-.8.8-1.8 1.2-2.8 1.1-.1-1.3.5-2.6 1.2-3.3.8-.8 2.1-1.4 2.8-1.2Z" />
        <path d="M18.2 16.7c-.4 1-1 2-1.8 2.9-.8 1-1.6 1.9-2.7 1.9-.5 0-.9-.1-1.4-.4-.5-.2-1-.4-1.5-.4s-1 .2-1.6.4c-.5.2-1 .4-1.4.4-1 0-1.9-.9-2.7-1.9-1.5-1.9-2.7-5.3-1.1-7.7.8-1.2 2.2-2 3.7-2 .6 0 1.2.2 1.7.4.5.2 1 .4 1.4.4s.9-.2 1.5-.4c.6-.2 1.3-.5 2-.4 1.1.1 2.3.6 3 1.6-2.6 1.5-2.2 5.1.5 6.2Z" />
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

  if (name === 'macos') {
    return (
      <svg {...commonProps}>
        <path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h10a2.5 2.5 0 0 1 2.5 2.5V14a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 14V5.5Z" />
        <path d="M8 20h8" />
        <path d="M12 16.5V20" />
        <path d="M10.5 6h3" />
      </svg>
    );
  }

  return null;
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
    const error = new Error(payload?.error || payload?.detail || 'Не удалось выполнить запрос');
    error.status = response.status;
    throw error;
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

const ADMIN_TOKEN_KEY = 'vpngo_admin_token';

function numberValue(value) {
  const normalized = Number(value || 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(numberValue(value));
}

function formatRubPrecise(value) {
  return `${new Intl.NumberFormat('ru-RU').format(Math.round(numberValue(value) / 100))} ₽`;
}

function formatBytes(value) {
  const bytes = numberValue(value);
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} ТБ`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${Math.round(bytes)} Б`;
}

function MetricCard({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-xs font-black uppercase text-slate-500">{label}</div>
      <div className="mt-3 text-3xl font-black tracking-tight text-slate-950">{value}</div>
      {sub && <div className="mt-2 text-sm text-slate-500">{sub}</div>}
    </div>
  );
}

function BarChart({ rows, labelKey = 'date', valueKey = 'count', valueFormatter = formatCompactNumber }) {
  const maxValue = Math.max(1, ...rows.map((row) => numberValue(row[valueKey])));
  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">Нет данных</div>
      ) : rows.map((row) => {
        const value = numberValue(row[valueKey]);
        return (
          <div key={`${row[labelKey]}-${valueKey}`} className="grid grid-cols-[5.5rem_1fr_5rem] items-center gap-3 text-xs">
            <div className="truncate font-bold text-slate-600">{row[labelKey]}</div>
            <div className="h-3 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-lime-400"
                style={{ width: `${Math.max(2, (value / maxValue) * 100)}%` }}
              />
            </div>
            <div className="text-right font-bold text-slate-700">{valueFormatter(value)}</div>
          </div>
        );
      })}
    </div>
  );
}

function incidentStatusLabel(status) {
  return {
    open: 'Открыт',
    answered: 'Ответ поддержки',
    closed: 'Закрыт'
  }[status] || status || 'Открыт';
}

function incidentStatusClass(status) {
  if (status === 'answered') {
    return 'bg-emerald-50 text-emerald-700';
  }
  if (status === 'closed') {
    return 'bg-slate-100 text-slate-500';
  }
  return 'bg-amber-50 text-amber-700';
}

function supportMessageDirection(message, ownAuthorType) {
  return message.author_type === ownAuthorType ? 'outgoing' : 'incoming';
}

function sanitizeOutgoingMessage(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const container = document.createElement('div');
  container.innerHTML = value;
  return (container.textContent || value).trim();
}

function SupportThreadChat({
  title,
  subtitle,
  incidents,
  selectedIncidentId,
  messages,
  ownAuthorType,
  emptyText,
  isLoading,
  isSending,
  error,
  canCreateIncident = false,
  embedded = false,
  onSelectIncident,
  onSendMessage
}) {
  const selectedIncident = incidents.find((incident) => incident.id === selectedIncidentId) || null;
  const inputDisabled = isSending || (!selectedIncident && !canCreateIncident);

  return (
    <div className={`vpngo-support-chat min-w-0 ${embedded ? 'p-5 sm:p-6' : 'rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6'}`}>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-black">{title}</h2>
          {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
        </div>
        {isLoading && <div className="text-sm font-bold text-slate-500">Загрузка...</div>}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="support-chat-frame">
        <MainContainer responsive>
          <Sidebar position="left" scrollable>
            <ConversationList>
              {incidents.length === 0 ? (
                <div className="p-4 text-sm leading-6 text-slate-500">{emptyText}</div>
              ) : incidents.map((incident) => (
                <Conversation
                  key={incident.id}
                  name={incident.incident_number}
                  info={incident.subject || 'Обращение в поддержку'}
                  lastSenderName={incident.last_message_author_type === 'support' ? 'Поддержка' : 'Клиент'}
                  lastActivityTime={dateLabel(incident.last_message_at)}
                  active={incident.id === selectedIncidentId}
                  onClick={() => onSelectIncident(incident.id)}
                >
                  <Conversation.Content>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-black text-slate-950">{incident.incident_number}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${incidentStatusClass(incident.status)}`}>
                          {incidentStatusLabel(incident.status)}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs font-semibold text-slate-500">
                        {incident.subject || 'Обращение в поддержку'}
                      </div>
                    </div>
                  </Conversation.Content>
                </Conversation>
              ))}
            </ConversationList>
          </Sidebar>

          <ChatContainer>
            <ConversationHeader>
              <ConversationHeader.Content
                userName={selectedIncident ? selectedIncident.incident_number : 'Новое обращение'}
                info={selectedIncident ? selectedIncident.subject : emptyText}
              />
            </ConversationHeader>
            <MessageList>
              {selectedIncident || messages.length ? (
                messages.map((message) => (
                  <Message
                    key={message.id}
                    model={{
                      message: message.body,
                      sentTime: new Date(message.created_at).toLocaleString('ru-RU'),
                      sender: message.author_type === 'support' ? 'Поддержка' : 'Клиент',
                      direction: supportMessageDirection(message, ownAuthorType),
                      position: 'single'
                    }}
                  />
                ))
              ) : (
                <MessageList.Content>
                  <div className="flex h-full items-center justify-center p-6 text-center text-sm leading-6 text-slate-500">
                    {emptyText}
                  </div>
                </MessageList.Content>
              )}
            </MessageList>
            <MessageInput
              attachButton={false}
              disabled={inputDisabled}
              placeholder={inputDisabled && !isSending ? 'Выберите инцидент' : isSending ? 'Отправляем...' : 'Напишите сообщение...'}
              onSend={(innerHtml, textContent) => {
                const message = sanitizeOutgoingMessage(textContent || innerHtml);
                if (message) {
                  onSendMessage(message);
                }
              }}
            />
          </ChatContainer>
        </MainContainer>
      </div>
    </div>
  );
}

function upsertIncident(incidents, incident) {
  const next = incidents.some((item) => item.id === incident.id)
    ? incidents.map((item) => (item.id === incident.id ? { ...item, ...incident } : item))
    : [incident, ...incidents];
  return next.sort((left, right) => new Date(right.last_message_at || right.updated_at) - new Date(left.last_message_at || left.updated_at));
}

function OtrsDashboard() {
  const [token, setToken] = useState(() => window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [draftToken, setDraftToken] = useState(() => window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [incidents, setIncidents] = useState([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [hasAccess, setHasAccess] = useState(false);

  async function loadIncidents(nextToken = token) {
    if (!nextToken) {
      setError('Введите admin token');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const payload = await fetch('/api/otrs/incidents', {
        headers: { 'X-Admin-Token': nextToken }
      }).then(readJson);
      window.sessionStorage.setItem(ADMIN_TOKEN_KEY, nextToken);
      setToken(nextToken);
      setHasAccess(true);
      setIncidents(payload.incidents || []);
      const nextSelectedId = selectedIncidentId || payload.incidents?.[0]?.id || null;
      setSelectedIncidentId(nextSelectedId);
      if (nextSelectedId) {
        await loadMessages(nextSelectedId, nextToken);
      } else {
        setMessages([]);
      }
    } catch (loadError) {
      setHasAccess(false);
      setError(userMessage(loadError, 'Не удалось загрузить инциденты'));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadMessages(incidentId, nextToken = token) {
    setError('');
    const payload = await fetch(`/api/otrs/incidents/${incidentId}/messages`, {
      headers: { 'X-Admin-Token': nextToken }
    }).then(readJson);
    setMessages(payload.messages || []);
    if (payload.incident) {
      setIncidents((current) => upsertIncident(current, payload.incident));
    }
  }

  async function selectIncident(incidentId) {
    setSelectedIncidentId(incidentId);
    setIsLoading(true);
    try {
      await loadMessages(incidentId);
    } catch (loadError) {
      setError(userMessage(loadError, 'Не удалось загрузить диалог'));
    } finally {
      setIsLoading(false);
    }
  }

  async function sendMessage(message) {
    if (!selectedIncidentId) {
      return;
    }
    setIsSending(true);
    setError('');
    try {
      const payload = await fetch(`/api/otrs/incidents/${selectedIncidentId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': token
        },
        body: JSON.stringify({ body: message })
      }).then(readJson);
      setMessages((current) => [...current, payload.message]);
      setIncidents((current) => upsertIncident(current, payload.incident));
    } catch (sendError) {
      setError(userMessage(sendError, 'Не удалось отправить ответ'));
    } finally {
      setIsSending(false);
    }
  }

  useEffect(() => {
    if (token) {
      loadIncidents(token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-2xl font-black">VPN-GO OTRS</div>
            <div className="text-sm text-slate-500">Инциденты поддержки со всех аккаунтов</div>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              loadIncidents(draftToken);
            }}
          >
            <input
              value={draftToken}
              onChange={(event) => setDraftToken(event.target.value)}
              placeholder="Admin token"
              className="h-11 min-w-0 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-slate-950 md:w-80"
            />
            <button className="h-11 rounded-lg bg-slate-950 px-4 text-sm font-black text-white" disabled={isLoading}>
              {isLoading ? '...' : 'Открыть'}
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {!hasAccess ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xl font-black">Вход в поддержку</div>
            <div className="mt-2 text-sm leading-6 text-slate-500">
              Введите admin token вверху страницы, чтобы открыть список инцидентов.
            </div>
            {error && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>
        ) : (
          <SupportThreadChat
            title="Поддержка"
            subtitle={`${incidents.length} инцидентов`}
            incidents={incidents}
            selectedIncidentId={selectedIncidentId}
            messages={messages}
            ownAuthorType="support"
            emptyText="Инцидентов пока нет."
            isLoading={isLoading}
            isSending={isSending}
            error={error}
            canCreateIncident={false}
            onSelectIncident={selectIncident}
            onSendMessage={sendMessage}
          />
        )}
      </main>
    </div>
  );
}

function InstructionsPage() {
  return (
    <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <a href="/" className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-lime-400 text-base font-black">
              GO
            </div>
            <div className="min-w-0">
              <div className="text-lg font-black tracking-tight">VPN-GO</div>
              <div className="text-xs text-slate-500">Инструкции подключения</div>
            </div>
          </a>
          <nav className="flex items-center gap-2 text-sm font-bold">
            <a
              href="/"
              className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 transition hover:border-slate-500 hover:bg-slate-50"
            >
              На главную
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h1 className="text-4xl font-black tracking-tight sm:text-5xl">Как подключить VPN</h1>
          <div className="mt-6 flex flex-wrap gap-2">
            {instructionSections.map((section) => (
              <a
                key={section.os}
                href={`#${section.os.toLowerCase()}`}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-black text-slate-900 transition hover:border-emerald-400 hover:bg-emerald-50"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded bg-emerald-100 text-emerald-800">
                  <PlatformIcon name={section.icon} />
                </span>
                {section.os}
              </a>
            ))}
          </div>
        </section>

        <div className="mt-6 grid gap-6">
          {instructionSections.map((section) => (
            <section
              key={section.os}
              id={section.os.toLowerCase()}
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-100 text-emerald-800">
                    <PlatformIcon name={section.icon} />
                  </span>
                  <div>
                    <h2 className="text-2xl font-black">{section.os}</h2>
                    <div className="text-sm text-slate-500">Подключение через файл .conf</div>
                  </div>
                </div>
                <a
                  href={section.downloadHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex rounded-lg bg-slate-950 px-4 py-3 text-sm font-black text-white transition hover:bg-slate-800"
                >
                  {section.downloadLabel}
                </a>
              </div>

              <ol className="mt-6 grid gap-3">
                {section.steps.map((step, index) => {
                  const screenshot = step.accountLink ? accountConfigScreenshot : step.screenshot;
                  return (
                    <li key={`${section.os}-${index}`} className="grid grid-cols-[2rem_1fr] gap-3 text-sm leading-6 text-slate-700">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-lime-400 text-sm font-black text-slate-950">
                        {index + 1}
                      </span>
                      <div>
                        <div className="font-black text-slate-950">
                          {step.download ? (
                            <>
                              Скачайте{' '}
                              <a
                                href={section.downloadHref}
                                target="_blank"
                                rel="noreferrer"
                                className="underline decoration-lime-400 decoration-2 underline-offset-4 hover:text-slate-700"
                              >
                                AmneziaWG по ссылке
                              </a>{' '}
                              и установите.
                            </>
                          ) : step.accountLink ? (
                            <>
                              В{' '}
                              <a
                                href="/?login=1"
                                className="underline decoration-lime-400 decoration-2 underline-offset-4 hover:text-slate-700"
                              >
                                личном кабинете
                              </a>{' '}
                              добавьте/выберите нужное устройство в списке и скачайте файл .conf.
                            </>
                          ) : step.text}
                        </div>
                        {screenshot && (
                          <figure className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                            <img
                              src={screenshot.src}
                              alt={`${section.os}: ${screenshot.label}`}
                              loading="lazy"
                              className="max-h-96 w-full object-contain"
                            />
                            <figcaption className="border-t border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600">
                              {screenshot.label}
                            </figcaption>
                          </figure>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function AdminDashboard() {
  const [token, setToken] = useState(() => window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [draftToken, setDraftToken] = useState(() => window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function loadAdmin(nextToken = token) {
    if (!nextToken) {
      setError('Введите admin token');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/overview', {
        headers: { 'X-Admin-Token': nextToken }
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(payload?.error || 'Не удалось загрузить админку');
      }
      window.sessionStorage.setItem(ADMIN_TOKEN_KEY, nextToken);
      setToken(nextToken);
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить админку');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (token) {
      loadAdmin(token);
    }
  }, []);

  const control = data?.control;
  const website = data?.website;
  const accountTotals = control?.accounts || {};
  const balances = control?.balances || {};
  const devices = control?.devices || {};
  const payments = control?.payments || {};
  const referrals = website?.referrals || {};
  const passkeys = website?.passkeys || {};
  const authTotals = website?.auth_events?.totals || [];
  const authByDay = website?.auth_events?.by_day || [];
  const loginClicks = authTotals.find((row) => row.event_type === 'login_click')?.count || 0;
  const recentPaymentRows = (payments.by_day || []).slice(-14);
  const recentYookassaRows = (website?.yookassa?.by_day || []).slice(-14);

  return (
    <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-2xl font-black">VPN-GO Admin</div>
            <div className="text-sm text-slate-500">
              {data?.generated_at ? `Обновлено ${new Date(data.generated_at).toLocaleString('ru-RU')}` : 'Мониторинг сервиса'}
            </div>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              loadAdmin(draftToken);
            }}
          >
            <input
              value={draftToken}
              onChange={(event) => setDraftToken(event.target.value)}
              placeholder="Admin token"
              className="h-11 min-w-0 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-slate-950 md:w-80"
            />
            <button className="h-11 rounded-lg bg-slate-950 px-4 text-sm font-black text-white" disabled={isLoading}>
              {isLoading ? '...' : 'Обновить'}
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>}

        {data && (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Активировано аккаунтов"
                value={formatCompactNumber(passkeys.total || accountTotals.total)}
                sub={`Сегодня: ${formatCompactNumber(passkeys.created_today)} · Неделя: ${formatCompactNumber(passkeys.created_week)} · Месяц: ${formatCompactNumber(passkeys.created_month)}`}
              />
              <MetricCard label="Нажатий на вход" value={formatCompactNumber(loginClicks)} sub="С момента включения трекинга" />
              <MetricCard label="По рефералке" value={formatCompactNumber(referrals.awarded)} sub={`Бонусы: ${formatRubPrecise(referrals.awarded_bonus_kopecks)}`} />
              <MetricCard label="Устройств" value={formatCompactNumber(devices.non_deleted)} sub={`Активных: ${formatCompactNumber(devices.active)}`} />
              <MetricCard label="Общий баланс" value={formatRubPrecise(balances.total_kopecks)} sub={`${formatCompactNumber(accountTotals.with_positive_balance)} аккаунтов с балансом`} />
              <MetricCard label="Бонусный баланс" value={formatRubPrecise(balances.bonus_balance_kopecks)} sub="Оценка остатка referral-бонусов" />
              <MetricCard label="Средний баланс" value={formatRubPrecise(balances.average_kopecks)} sub={`Положительный avg: ${formatRubPrecise(balances.average_positive_kopecks)}`} />
              <MetricCard label="Оплаты" value={formatRubPrecise(payments.confirmed_amount_kopecks)} sub={`${formatCompactNumber(payments.confirmed_count)} подтвержденных`} />
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-xl font-black">Edge-ноды</h2>
                  <div className="text-sm text-slate-500">Доступность с main-ноды</div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="text-xs uppercase text-slate-500">
                      <tr className="border-b border-slate-200">
                        <th className="py-3">Нода</th>
                        <th>Доступ</th>
                        <th>Heartbeat</th>
                        <th>Устройства</th>
                        <th>Трафик</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(control.nodes || []).map((node) => {
                        const deviceRow = (devices.by_node || []).find((row) => row.node_id === node.node_id) || {};
                        const trafficRow = (control.traffic?.by_node || []).find((row) => row.node_id === node.node_id) || {};
                        return (
                          <tr key={node.node_id} className="border-b border-slate-100 last:border-b-0">
                            <td className="py-3">
                              <div className="font-black">{node.node_name}</div>
                              <div className="text-xs text-slate-500">{node.api_url}</div>
                            </td>
                            <td>
                              <span className={`rounded-full px-2 py-1 text-xs font-black ${node.available ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                                {node.available ? `OK ${node.latency_ms || 0} ms` : 'down'}
                              </span>
                            </td>
                            <td className="text-slate-600">{node.last_heartbeat_at ? new Date(node.last_heartbeat_at).toLocaleString('ru-RU') : '-'}</td>
                            <td className="font-bold">{formatCompactNumber(deviceRow.active)} active / {formatCompactNumber(deviceRow.total)} total</td>
                            <td className="font-bold">{formatBytes(trafficRow.total_bytes)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-xl font-black">Устройства по нодам</h2>
                <BarChart rows={devices.by_node || []} labelKey="node_name" valueKey="active" />
              </div>
            </section>

            <section className="grid gap-6 xl:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-xl font-black">Оплаты control-plane</h2>
                <BarChart rows={recentPaymentRows} valueKey="amount_kopecks" valueFormatter={formatRubPrecise} />
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-xl font-black">YooKassa</h2>
                <BarChart rows={recentYookassaRows} valueKey="succeeded_kopecks" valueFormatter={formatRubPrecise} />
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-xl font-black">Попытки входа</h2>
                <BarChart rows={authByDay.filter((row) => row.event_type === 'login_click').slice(-14)} valueKey="count" />
              </div>
            </section>

            <section className="grid gap-6 xl:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-xl font-black">Платежи по статусам</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(website?.yookassa?.by_status || []).map((row) => (
                    <div key={row.status} className="rounded-lg border border-slate-200 p-4">
                      <div className="text-sm font-black">{row.status}</div>
                      <div className="mt-2 text-2xl font-black">{formatCompactNumber(row.count)}</div>
                      <div className="text-sm text-slate-500">{formatRubPrecise(row.amount_kopecks)}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-xl font-black">Auth события</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {authTotals.map((row) => (
                    <div key={row.event_type} className="rounded-lg border border-slate-200 p-4">
                      <div className="text-sm font-black">{row.event_type}</div>
                      <div className="mt-2 text-2xl font-black">{formatCompactNumber(row.count)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default function VPNLandingPage() {
  const [profile, setProfile] = useState(() => getStoredProfile());
  const [customerId, setCustomerId] = useState(() => getStoredCustomerId());
  const [referrerId, setReferrerId] = useState(() => getStoredReferrerId());
  const [referralToken, setReferralToken] = useState(() => getStoredReferralToken());
  const [isReferralCopied, setIsReferralCopied] = useState(false);
  const [loginConsentVisible, setLoginConsentVisible] = useState(false);
  const [cookieAccessModalVisible, setCookieAccessModalVisible] = useState(false);
  const [referralLinkUsedModalVisible, setReferralLinkUsedModalVisible] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authStatus, setAuthStatus] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [isLoadingAccount, setIsLoadingAccount] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [paymentReturn, setPaymentReturn] = useState(null);
  const [topUpAmount, setTopUpAmount] = useState('150');
  const [receiptEmail, setReceiptEmail] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [isCreatingDevice, setIsCreatingDevice] = useState(false);
  const [loadingConfigDeviceId, setLoadingConfigDeviceId] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [devicePendingDelete, setDevicePendingDelete] = useState(null);
  const [isDeletingDevice, setIsDeletingDevice] = useState(false);
  const [devicePendingRegenerate, setDevicePendingRegenerate] = useState(null);
  const [isRegeneratingDevice, setIsRegeneratingDevice] = useState(false);
  const [createdConfig, setCreatedConfig] = useState(null);
  const [supportIncidents, setSupportIncidents] = useState([]);
  const [selectedSupportIncidentId, setSelectedSupportIncidentId] = useState(null);
  const [supportMessages, setSupportMessages] = useState([]);
  const [supportError, setSupportError] = useState('');
  const [isLoadingSupport, setIsLoadingSupport] = useState(false);
  const [isSendingSupport, setIsSendingSupport] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const configRevealTimerRef = useRef(null);
  const [heroBenefitIndex, setHeroBenefitIndex] = useState(0);
  const normalizedTopUpAmount = Number(String(topUpAmount).replace(',', '.'));
  const isTopUpAmountValid = Number.isFinite(normalizedTopUpAmount) && normalizedTopUpAmount >= 30;
  const topUpAmountHint = topUpAmount.trim() && !isTopUpAmountValid ? 'Минимум 30 рублей' : '';
  const normalizedReceiptEmail = receiptEmail.trim();
  const isReceiptEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedReceiptEmail);
  const receiptEmailHint = normalizedReceiptEmail && !isReceiptEmailValid ? 'Введите email для чека' : '';
  const isPaymentFormValid = isTopUpAmountValid && isReceiptEmailValid;

  const currentPath = window.location.pathname.replace(/\/$/, '') || '/';

  if (currentPath === '/admin') {
    return <AdminDashboard />;
  }

  if (currentPath === '/otrs') {
    return <OtrsDashboard />;
  }

  if (currentPath === '/instructions') {
    return <InstructionsPage />;
  }

  if (currentPath === '/agreement') {
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
            <div className="flex items-center gap-2">
              <a
                href="/instructions/"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 transition hover:border-slate-500 hover:bg-slate-50"
              >
                Инструкции
              </a>
              <a
                href="/"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 transition hover:border-slate-500 hover:bg-slate-50"
              >
                Назад
              </a>
            </div>
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
      const visitorId = await getVisitorId();
      const params = new URLSearchParams({
        name: currentProfile.name || '',
        email: currentProfile.email || '',
        ...(visitorId ? { visitor_id: visitorId } : {})
      });
      const payload = await fetch(`/api/account/${currentCustomerId}?${params}`).then(readJson);
      setDashboard(payload);
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        window.localStorage.removeItem(STORAGE_PROFILE_KEY);
        window.localStorage.removeItem(STORAGE_CUSTOMER_KEY);
        setProfile(null);
        setCustomerId('');
        setDashboard(null);
        return;
      }
      setAccountError(userMessage(error, 'Не удалось загрузить личный кабинет'));
    } finally {
      setIsLoadingAccount(false);
    }
  }

  async function loadSupportIncidents() {
    if (!profile || !customerId) {
      return;
    }

    setIsLoadingSupport(true);
    setSupportError('');
    try {
      const payload = await fetch('/api/support/incidents').then(readJson);
      const incidents = payload.incidents || [];
      setSupportIncidents(incidents);
      const nextSelectedId = selectedSupportIncidentId || incidents[0]?.id || null;
      setSelectedSupportIncidentId(nextSelectedId);
      if (nextSelectedId) {
        await loadSupportMessages(nextSelectedId);
      } else {
        setSupportMessages([]);
      }
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        return;
      }
      setSupportError(userMessage(error, 'Не удалось загрузить поддержку'));
    } finally {
      setIsLoadingSupport(false);
    }
  }

  async function loadSupportMessages(incidentId) {
    const payload = await fetch(`/api/support/incidents/${incidentId}/messages`).then(readJson);
    setSupportMessages(payload.messages || []);
    if (payload.incident) {
      setSupportIncidents((current) => upsertIncident(current, payload.incident));
    }
  }

  useEffect(() => {
    if (profile) {
      loadAccount(profile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, customerId]);

  useEffect(() => {
    if (profile && customerId) {
      loadSupportIncidents();
    } else {
      setSupportIncidents([]);
      setSelectedSupportIncidentId(null);
      setSupportMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, customerId]);

  useEffect(() => {
    let cancelled = false;

    async function handleReferralEntry() {
      const params = new URLSearchParams(window.location.search);
      const referral = params.get('ref');
      const token = params.get('rt');
      if (referral && /^\d+$/.test(referral) && token && /^[A-Za-z0-9_-]{12,80}$/.test(token)) {
        const isGatePage = params.get('referral_gate') === '1';
        const isReadyPage = params.get('referral_ready') === '1';
        const marker = params.get('referral_marker') || '';
        window.localStorage.setItem(STORAGE_REFERRAL_KEY, referral);
        window.localStorage.setItem(STORAGE_REFERRAL_TOKEN_KEY, token);
        setReferrerId(referral);
        setReferralToken(token);

        if (!profile) {
          if (isGatePage && !isReadyPage) {
            try {
              if (await isLikelyPrivateBrowsing()) {
                showCookieAccessModal();
                return;
              }
              const gateMarker = createReferralGateMarker();
              const visitorId = await getVisitorId();
              window.localStorage.setItem(STORAGE_REFERRAL_GATE_KEY, gateMarker);
              await fetch('/api/referral/prepare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  referrer_user_id: referral,
                  referral_token: token,
                  visitor_id: visitorId || undefined,
                  current_user_id: getStoredCustomerId() || undefined
                })
              }).then(readJson);
              if (cancelled) {
                return;
              }
              const nextParams = new URLSearchParams(params);
              nextParams.delete('referral_gate');
              nextParams.set('referral_ready', '1');
              nextParams.set('referral_marker', gateMarker);
              nextParams.set('login', '1');
              const nextUrl = `${window.location.origin}${window.location.pathname}?${nextParams.toString()}`;
              const opened = window.open(nextUrl, '_blank', 'noopener,noreferrer');
              if (opened) {
                window.location.replace('/');
              } else {
                window.location.replace(nextUrl);
              }
            } catch (error) {
              if (error?.status === 409) {
                showReferralLinkUsedModal();
                return;
              }
              showCookieAccessModal();
            }
            return;
          }

          if (!isReadyPage) {
            const gateParams = new URLSearchParams(params);
            gateParams.set('referral_gate', '1');
            window.location.replace(`${window.location.pathname}?${gateParams.toString()}`);
            return;
          }

          if (!marker || window.localStorage.getItem(STORAGE_REFERRAL_GATE_KEY) !== marker || await isLikelyPrivateBrowsing()) {
            showCookieAccessModal();
            return;
          }

          try {
            const visitorId = await getVisitorId();
            await fetch('/api/referral/status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                referrer_user_id: referral,
                referral_token: token,
                visitor_id: visitorId || undefined,
                current_user_id: getStoredCustomerId() || undefined
              })
            }).then(readJson);
          } catch (error) {
            if (error?.status === 409) {
              showReferralLinkUsedModal();
              return;
            }
            showCookieAccessModal();
            return;
          }
        }
      }

      if (!profile && params.get('login') === '1') {
        openLoginConsent();
      }
    }

    handleReferralEntry();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHeroBenefitIndex((current) => (current + 1) % heroBenefits.length);
    }, 3200);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => (
    () => {
      if (configRevealTimerRef.current) {
        window.clearTimeout(configRevealTimerRef.current);
      }
    }
  ), []);

  function clearPendingConfigReveal() {
    if (configRevealTimerRef.current) {
      window.clearTimeout(configRevealTimerRef.current);
      configRevealTimerRef.current = null;
    }
  }

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
      window.localStorage.removeItem(STORAGE_REFERRAL_TOKEN_KEY);
      window.localStorage.removeItem(STORAGE_REFERRAL_GATE_KEY);
      setReferrerId('');
      setReferralToken('');
    }
    await loadAccount(nextProfile, nextCustomerId);
  }

  function openLoginConsent() {
    setAuthError('');
    getVisitorId()
      .then((visitorId) => fetch('/api/auth-events/login-click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitor_id: visitorId,
          referrer_id: referrerId || undefined,
          referral_token: referralToken || undefined,
          path: window.location.pathname + window.location.search
        })
      }))
      .catch(() => undefined);
    setLoginConsentVisible(true);
  }

  function showCookieAccessModal() {
    window.localStorage.removeItem(STORAGE_REFERRAL_KEY);
    window.localStorage.removeItem(STORAGE_REFERRAL_TOKEN_KEY);
    window.localStorage.removeItem(STORAGE_REFERRAL_GATE_KEY);
    setReferrerId('');
    setReferralToken('');
    setLoginConsentVisible(false);
    setCookieAccessModalVisible(true);
    window.history.replaceState({}, '', '/');
  }

  function showReferralLinkUsedModal() {
    window.localStorage.removeItem(STORAGE_REFERRAL_KEY);
    window.localStorage.removeItem(STORAGE_REFERRAL_TOKEN_KEY);
    window.localStorage.removeItem(STORAGE_REFERRAL_GATE_KEY);
    setReferrerId('');
    setReferralToken('');
    setLoginConsentVisible(false);
    setReferralLinkUsedModalVisible(true);
    window.history.replaceState({}, '', '/');
  }

  function acceptLoginConsent() {
    setLoginConsentVisible(false);
    loginWithPasskey();
  }

  async function loginWithPasskey() {
    setPaymentError('');
    setAuthError('');
    setIsAuthenticating(true);
    try {
      setAuthStatus('Ожидаем подтверждение на устройстве');
      if (!browserSupportsWebAuthn()) {
        setAuthError('Этот браузер не поддерживает passkey.');
        return;
      }

      const visitorId = await getVisitorId();
      const authOptions = await fetch('/api/passkeys/authentication/options', {
        method: 'POST'
      }).then(readJson);
      const authResponse = await startAuthentication({ optionsJSON: authOptions.options });
      const verifiedSession = await fetch('/api/passkeys/authentication/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: authOptions.challenge_id,
          response: authResponse,
          visitor_id: visitorId || undefined
        })
      }).then(readJson);
      await finishPasskeySession(verifiedSession);
    } catch (_loginError) {
      try {
        setAuthStatus('Создаем вход через устройство');
        const existingCustomerId = getStoredCustomerId();
        const passkeyUserId = existingCustomerId || createCustomerId();
        const visitorId = await getVisitorId();
        const registrationOptions = await fetch('/api/passkeys/registration/options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: passkeyUserId,
            display_name: 'Пользователь VPN-GO',
            referrer_user_id: referrerId || undefined,
            referral_token: referralToken || undefined,
            visitor_id: visitorId || undefined,
            current_user_id: existingCustomerId || undefined
          })
        }).then(readJson);
        const registrationResponse = await startRegistration({ optionsJSON: registrationOptions.options });
        const registeredSession = await fetch('/api/passkeys/registration/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: registrationOptions.challenge_id,
          response: registrationResponse,
          referrer_user_id: referrerId,
          referral_token: referralToken || undefined,
          visitor_id: visitorId || undefined
        })
      }).then(readJson);
        await finishPasskeySession(registeredSession);
      } catch (registrationError) {
        setAuthError(userMessage(registrationError, 'Не удалось войти через passkey'));
      }
    } finally {
      setIsAuthenticating(false);
      setAuthStatus('');
    }
  }

  function logout() {
    fetch('/api/logout', { method: 'POST' }).catch(() => {});
    window.localStorage.removeItem(STORAGE_PROFILE_KEY);
    window.localStorage.removeItem(STORAGE_CUSTOMER_KEY);
    window.localStorage.removeItem(STORAGE_REFERRAL_TOKEN_KEY);
    window.localStorage.removeItem(STORAGE_REFERRAL_GATE_KEY);
    clearPendingConfigReveal();
    setProfile(null);
    setCustomerId('');
    setDashboard(null);
    setCreatedConfig(null);
    setSupportIncidents([]);
    setSelectedSupportIncidentId(null);
    setSupportMessages([]);
    setSupportError('');
    setIsSupportOpen(false);
  }

  async function createPayment() {
    if (!isPaymentFormValid) {
      if (!isReceiptEmailValid) {
        setPaymentError('Введите email для чека');
      }
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
          amount_rub: normalizedTopUpAmount,
          receipt_email: normalizedReceiptEmail,
          plan_name: 'Пополнение баланса VPN-GO',
          description: `Пополнение баланса VPN-GO на ${normalizedTopUpAmount} ₽`
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
    clearPendingConfigReveal();
    setCreatedConfig(null);
    setIsCreatingDevice(true);
    try {
      const payload = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
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

  async function selectSupportIncident(incidentId) {
    setSelectedSupportIncidentId(incidentId);
    setIsLoadingSupport(true);
    setSupportError('');
    try {
      await loadSupportMessages(incidentId);
    } catch (error) {
      setSupportError(userMessage(error, 'Не удалось загрузить диалог'));
    } finally {
      setIsLoadingSupport(false);
    }
  }

  async function sendSupportMessage(message) {
    setIsSendingSupport(true);
    setSupportError('');
    try {
      if (!selectedSupportIncidentId) {
        const payload = await fetch('/api/support/incidents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: message })
        }).then(readJson);
        setSupportIncidents((current) => upsertIncident(current, payload.incident));
        setSelectedSupportIncidentId(payload.incident.id);
        setSupportMessages(payload.messages || []);
        return;
      }

      const payload = await fetch(`/api/support/incidents/${selectedSupportIncidentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: message })
      }).then(readJson);
      setSupportMessages((current) => [...current, payload.message]);
      setSupportIncidents((current) => upsertIncident(current, payload.incident));
    } catch (error) {
      setSupportError(userMessage(error, 'Не удалось отправить сообщение'));
    } finally {
      setIsSendingSupport(false);
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
      await fetch(`/api/devices/${devicePendingDelete.id}`, {
        method: 'DELETE'
      }).then(readJson);
      setDevicePendingDelete(null);
      clearPendingConfigReveal();
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
        body: JSON.stringify({})
      }).then(readJson);
      const nextConfig = await withQrDataUrl({
        ...payload,
        device_name: devicePendingRegenerate.name
      });

      clearPendingConfigReveal();
      setDevicePendingRegenerate(null);
      setCreatedConfig(null);
      await loadAccount();
      configRevealTimerRef.current = window.setTimeout(() => {
        setCreatedConfig(nextConfig);
        configRevealTimerRef.current = null;
      }, 650);
    } catch (error) {
      setDeviceError(userMessage(error, 'Не удалось обновить конфиг'));
    } finally {
      setIsRegeneratingDevice(false);
    }
  }

  async function openDeviceConfig(device) {
    clearPendingConfigReveal();

    if (createdConfig?.device_id === device.id) {
      setCreatedConfig(null);
      return;
    }

    setDeviceError('');
    setLoadingConfigDeviceId(device.id);
    try {
      const payload = await fetch(`/api/devices/${device.id}/config`).then(readJson);
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
    if (!referralLink) {
      return;
    }

    try {
      await navigator.clipboard.writeText(referralLink);
      setIsReferralCopied(true);
      window.setTimeout(() => setIsReferralCopied(false), 1800);
    } catch (_error) {
      setIsReferralCopied(false);
    }
  }

  const activeReferral = dashboard?.referral;
  const referralBonusRub = Math.floor((activeReferral?.bonus_kopecks || 5000) / 100);
  const referralLink = customerId && activeReferral?.available && activeReferral?.token
    ? `${window.location.origin}/?ref=${encodeURIComponent(customerId)}&rt=${encodeURIComponent(activeReferral.token)}&referral_gate=1`
    : '';

  const loginConsentModal = loginConsentVisible && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <div className="text-2xl font-black leading-tight text-slate-950">
          Без почты. Без телефона. Без имени.
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Вход — по passkey. Не шлём письма, SMS и пуши, не собираем личные данные.
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
          Закрыть эту хрень, я соглашаюсь
        </button>
      </div>
    </div>
  );

  const cookieAccessModal = cookieAccessModalVisible && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <div className="text-2xl font-black leading-tight text-slate-950">
          Для регистрации по приглашению нужно включить cookies.
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Они используются для защиты от повторных регистраций и начисления бонусов.
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Включите cookies и обновите страницу.
        </p>
        <button
          onClick={() => setCookieAccessModalVisible(false)}
          className="mt-6 w-full rounded-lg bg-lime-400 px-5 py-4 text-base font-black text-slate-950 transition hover:bg-lime-300"
        >
          Понятно
        </button>
      </div>
    </div>
  );

  const referralLinkUsedModal = referralLinkUsedModalVisible && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <div className="text-2xl font-black leading-tight text-slate-950">
          По этой ссылке уже была регистрация.
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Попросите новую ссылку-приглашение.
        </p>
        <button
          onClick={() => setReferralLinkUsedModalVisible(false)}
          className="mt-6 w-full rounded-lg bg-lime-400 px-5 py-4 text-base font-black text-slate-950 transition hover:bg-lime-300"
        >
          Понятно
        </button>
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

  const isReferralGateScreen = !profile && new URLSearchParams(window.location.search).get('referral_gate') === '1';

  if (isReferralGateScreen) {
    return (
      <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
        <main className="mx-auto flex min-h-screen max-w-xl items-center px-6 py-12">
          <div className="w-full rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-lime-400 text-base font-black">
              GO
            </div>
            <h1 className="mt-5 text-2xl font-black">Готовим приглашение</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Откроем вход в новой вкладке и проверим, что cookies доступны для начисления бонуса.
            </p>
          </div>
        </main>
        {cookieAccessModal}
        {referralLinkUsedModal}
      </div>
    );
  }

  if (profile) {
    const balance = dashboard?.balance;
    const devices = dashboard?.devices || [];
    const payments = dashboard?.payments || [];
    const daysLeft = balance?.days_left;
    const paymentHistoryCard = (
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
    );

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
              <a
                href="/instructions/"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 sm:px-4"
              >
                Инструкции
              </a>
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
          <section className="order-2 min-w-0 space-y-6 lg:order-1">
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
                    type="text"
                    value={topUpAmount}
                    onChange={(event) => {
                      setTopUpAmount(event.target.value);
                      setPaymentError('');
                    }}
                    inputMode="numeric"
                    autoComplete="off"
                    autoCorrect="off"
                    className="min-w-0 flex-1 rounded-lg px-4 py-3 text-lg font-bold outline-none"
                  />
                  <div className="px-4 py-3 text-lg font-bold text-slate-500">₽</div>
                </div>
                {topUpAmountHint && (
                  <div className="mt-2 text-xs font-semibold text-red-600">{topUpAmountHint}</div>
                )}

                <label className="mt-4 block text-sm font-semibold text-slate-700">
                  Email для чека
                </label>
                <input
                  type="email"
                  value={receiptEmail}
                  onChange={(event) => {
                    setReceiptEmail(event.target.value);
                    setPaymentError('');
                  }}
                  inputMode="email"
                  autoComplete="email"
                  autoCorrect="off"
                  placeholder="mail@example.com"
                  className="mt-2 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-4 py-3 text-lg font-bold outline-none focus:border-slate-950"
                />
                <div className="mt-2 text-xs leading-5 text-slate-500">
                  Нужен только для фискального чека YooKassa.
                </div>
                {receiptEmailHint && (
                  <div className="mt-2 text-xs font-semibold text-red-600">{receiptEmailHint}</div>
                )}

                {paymentError && (
                  <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {paymentError}
                  </div>
                )}

                <button
                  onClick={createPayment}
                  disabled={isPaying || !isPaymentFormValid}
                  className={`mt-5 w-full rounded-lg bg-lime-400 px-5 py-4 text-base font-black text-slate-950 transition hover:bg-lime-300 ${
                    isPaying || !isPaymentFormValid ? 'cursor-not-allowed opacity-50 hover:bg-lime-400' : ''
                  }`}
                >
                  {isPaying ? 'Переходим к оплате...' : 'Оплатить через ЮKassa'}
                </button>
              </div>

              {referralLink && (
              <div className="mt-6 border-t border-slate-200 pt-5">
                <h2 className="text-lg font-black">Пригласить</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Отправьте эту ссылку другу и при активации нового аккаунта вы оба{' '}
                  <span className="dark-rainbow-text font-black">получите {referralBonusRub} ₽ на баланс</span>.
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
              )}
            </div>
          </section>

          <section className="order-1 min-w-0 space-y-6 lg:order-2">
            <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <label className="block min-w-0">
                  <span className="text-sm font-semibold text-slate-700">Имя устройства</span>
                  <input
                    value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value)}
                    placeholder="Например, iPhone Феди"
                    className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-950"
                  />
                </label>
                <button
                  onClick={createDevice}
                  disabled={isCreatingDevice}
                  className={`rounded-lg bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 sm:min-h-[46px] ${
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
                                        <span className="flex h-8 w-8 items-center justify-center rounded bg-emerald-100 text-emerald-800">
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
                                    Скачайте файл .conf, откройте AmneziaWG, выберите "Импорт туннелей из файла" или "Создать из файла" и укажите скачанный .conf
                                  </div>
                                  <button
                                    onClick={downloadConfig}
                                    className="mt-4 rounded-lg bg-emerald-700 px-4 py-3 text-sm font-bold text-white transition hover:bg-emerald-800"
                                  >
                                    Скачать .conf
                                  </button>
                                  <div className="mt-5 font-black">
                                    Или отсканируйте этот QR-код, если в AmneziaWG на устройстве есть опция "Создать из QR-кода"
                                  </div>
                                  <a
                                    href="/instructions/"
                                    className="mt-3 inline-flex text-sm font-black text-emerald-800 underline decoration-emerald-300 underline-offset-4 hover:text-emerald-950"
                                  >
                                    Подробная инструкция со скриншотами
                                  </a>
                                  <div className="mt-4">
                                    <div className="rounded-lg border border-emerald-200 bg-white p-3">
                                      <img
                                        src={createdConfig.qrDataUrl}
                                        alt="QR-код конфигурации VPN"
                                        className="h-56 w-56 max-w-full"
                                      />
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

            <div className="hidden lg:block">
              {paymentHistoryCard}
            </div>
          </section>

          <section className="order-last min-w-0 lg:hidden">
            {paymentHistoryCard}
          </section>

          <section className="order-last min-w-0 lg:col-span-2">
            <div className="min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => setIsSupportOpen((current) => !current)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left sm:px-6"
                aria-expanded={isSupportOpen}
              >
                <div className="min-w-0">
                  <div className="text-xl font-black">Поддержка</div>
                  <div className="mt-1 text-sm text-slate-500">
                    {supportIncidents.length
                      ? `${supportIncidents.length} ${supportIncidents.length === 1 ? 'инцидент' : 'инцидентов'}`
                      : 'Напишите нам, если что-то пошло не так'}
                  </div>
                </div>
                <span className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-xs font-black text-slate-700">
                  {isSupportOpen ? 'Свернуть' : 'Открыть'}
                </span>
              </button>

              {isSupportOpen && (
                <div className="border-t border-slate-200 p-0">
                  <SupportThreadChat
                    title="Пишите, если столкнулись с проблемой"
                    subtitle="Ответим в ближайшее время."
                    incidents={supportIncidents}
                    selectedIncidentId={selectedSupportIncidentId}
                    messages={supportMessages}
                    ownAuthorType="user"
                    emptyText="Напишите сообщение, чтобы создать новый инцидент."
                    isLoading={isLoadingSupport}
                    isSending={isSendingSupport}
                    error={supportError}
                    canCreateIncident
                    embedded
                    onSelectIncident={selectSupportIncident}
                    onSendMessage={sendSupportMessage}
                  />
                </div>
              )}
            </div>
          </section>
        </main>
        {deleteDeviceModal}
        {regenerateDeviceModal}
        {referralLinkUsedModal}
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
            <a
              href="/instructions/"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700 transition hover:border-slate-400 hover:bg-white sm:px-4"
            >
              Инструкции
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
                    <div className="mt-1 text-2xl font-black">Добавляйте несколько устройств</div>
                  </div>
                  <div className="rounded-lg bg-lime-400 px-3 py-2 text-sm font-black">5 ₽/сутки</div>
                </div>
                <div className="mt-5 rounded-lg border border-slate-200">
                  {[
                    ['iPhone', 'QR-код и .conf для AmneziaWG', 'Активно'],
                    ['Ноутбук', 'Отдельный конфиг для второго устройства', 'Активно']
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
      {cookieAccessModal}
      {referralLinkUsedModal}
    </div>
  );
}
