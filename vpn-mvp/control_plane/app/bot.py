import asyncio
import base64
import logging
from dataclasses import dataclass

import httpx
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    BufferedInputFile,
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LabeledPrice,
    Message,
    PreCheckoutQuery,
    ReplyKeyboardMarkup,
)
from aiogram.utils.keyboard import ReplyKeyboardBuilder

from app.config import get_settings

settings = get_settings()
router = Router()


class AddDeviceState(StatesGroup):
    waiting_for_name = State()


@dataclass
class ApiClient:
    base_url: str
    internal_token: str

    def _headers(self) -> dict[str, str]:
        return {"X-Internal-Token": self.internal_token}

    async def post(self, path: str, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(f"{self.base_url}{path}", json=payload, headers=self._headers())
            response.raise_for_status()
            return response.json()

    async def get(self, path: str) -> dict | list:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(f"{self.base_url}{path}", headers=self._headers())
            response.raise_for_status()
            return response.json()

    async def patch(self, path: str, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.patch(
                f"{self.base_url}{path}",
                params=payload if "telegram_id" in payload else None,
                json=payload,
                headers=self._headers(),
            )
            response.raise_for_status()
            return response.json()

    async def delete(self, path: str, params: dict) -> dict:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.delete(f"{self.base_url}{path}", params=params, headers=self._headers())
            response.raise_for_status()
            return response.json()


api = ApiClient(settings.api_base_url, settings.internal_api_token)


def main_menu() -> ReplyKeyboardMarkup:
    kb = ReplyKeyboardBuilder()
    kb.button(text="Инструкция")
    kb.button(text="Баланс")
    kb.button(text="Пополнить баланс")
    kb.button(text="Мои устройства")
    kb.button(text="Добавить устройство")
    kb.button(text="Поддержка")
    kb.adjust(2, 2, 2)
    return kb.as_markup(resize_keyboard=True)


@router.message(CommandStart())
async def start_handler(message: Message) -> None:
    await api.post(
        "/v1/users",
        {
            "telegram_id": message.from_user.id,
            "username": message.from_user.username,
            "first_name": message.from_user.first_name,
        },
    )
    await message.answer(
        "VPN бот готов к работе.\nСтоимость: 5 ₽/день за устройство.",
        reply_markup=main_menu(),
    )


@router.message(F.text == "Инструкция")
async def instruction_handler(message: Message) -> None:
    text = (
        "1. Установите AmneziaVPN или клиент с поддержкой AmneziaWG:\n"
        "- iOS: https://apps.apple.com/app/amneziavpn/id1600529900\n"
        "- Android: https://play.google.com/store/apps/details?id=org.amnezia.vpn\n"
        "- Windows/macOS/Linux: https://amnezia.org\n\n"
        "2. В боте добавьте устройство.\n"
        "3. Импортируйте .conf или QR-код AmneziaWG.\n"
        "4. Подключитесь."
    )
    await message.answer(text)


@router.message(F.text == "Баланс")
async def balance_handler(message: Message) -> None:
    stats = await api.get(f"/v1/users/{message.from_user.id}/balance")
    rub = stats["balance_kopecks"] // 100
    daily = stats["daily_charge_kopecks"] // 100
    days_left = stats["days_left"] if stats["days_left"] is not None else "∞"
    await message.answer(
        f"Баланс: {rub} ₽\n"
        f"Активных устройств: {stats['active_devices']}\n"
        f"Списание: {daily} ₽/день\n"
        f"Хватит примерно на {days_left} дней"
    )


@router.message(F.text == "Пополнить баланс")
async def topup_menu(message: Message) -> None:
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="10 ₽", callback_data="topup:10")],
            [InlineKeyboardButton(text="50 ₽", callback_data="topup:50")],
            [InlineKeyboardButton(text="100 ₽", callback_data="topup:100")],
        ]
    )
    await message.answer("Выберите сумму пополнения:", reply_markup=keyboard)


@router.callback_query(F.data.startswith("topup:"))
async def topup_handler(callback: CallbackQuery) -> None:
    amount_rub = int(callback.data.split(":")[1])

    if settings.telegram_provider_token and settings.telegram_provider_token != "replace_me":
        await callback.message.answer_invoice(
            title="VPN Balance Top-up",
            description=f"Пополнение баланса на {amount_rub} ₽",
            provider_token=settings.telegram_provider_token,
            currency="RUB",
            prices=[LabeledPrice(label=f"{amount_rub} ₽", amount=amount_rub * 100)],
            payload=f"topup:{amount_rub}",
        )
    elif settings.allow_mock_payments:
        payment = await api.post(
            "/v1/payments/mock/confirm",
            {"telegram_id": callback.from_user.id, "amount_rub": amount_rub, "external_payment_id": f"mock-{callback.id}"},
        )
        await callback.message.answer(f"Платеж подтвержден. Баланс пополнен на {payment['amount_kopecks'] // 100} ₽.")
    else:
        await callback.message.answer("Пополнение временно недоступно: не настроен платежный провайдер.")
    await callback.answer()


@router.pre_checkout_query()
async def pre_checkout(pre_checkout_query: PreCheckoutQuery) -> None:
    await pre_checkout_query.answer(ok=True)


@router.message(F.successful_payment)
async def successful_payment(message: Message) -> None:
    payload = message.successful_payment.invoice_payload
    amount_rub = int(payload.split(":")[1]) if payload.startswith("topup:") else message.successful_payment.total_amount // 100
    payment = await api.post(
        "/v1/payments/mock/confirm",
        {
            "telegram_id": message.from_user.id,
            "amount_rub": amount_rub,
            "external_payment_id": message.successful_payment.telegram_payment_charge_id,
        },
    )
    await message.answer(f"Оплата успешна. Баланс пополнен на {payment['amount_kopecks'] // 100} ₽.")


@router.message(F.text == "Добавить устройство")
async def add_device_start(message: Message, state: FSMContext) -> None:
    await state.set_state(AddDeviceState.waiting_for_name)
    await message.answer("Введите имя устройства:")


@router.message(AddDeviceState.waiting_for_name)
async def add_device_finish(message: Message, state: FSMContext) -> None:
    await state.clear()
    try:
        created = await api.post("/v1/devices", {"telegram_id": message.from_user.id, "name": message.text.strip()})
    except httpx.HTTPStatusError as exc:
        if exc.response is not None:
            await message.answer(f"Ошибка создания устройства: {exc.response.text}")
        else:
            await message.answer("Ошибка создания устройства.")
        return

    conf_bytes = created["conf_text"].encode()
    conf_file = BufferedInputFile(conf_bytes, filename=created["conf_filename"])
    qr_bytes = base64.b64decode(created["qr_png_base64"])
    qr_file = BufferedInputFile(qr_bytes, filename=f"device-{created['device_id']}.png")

    await message.answer_document(conf_file, caption="Конфиг AmneziaWG (.conf)")
    await message.answer_photo(qr_file, caption="QR-код AmneziaWG")
    await message.answer("Импортируйте конфиг в AmneziaVPN через файл или QR.")


@router.message(F.text == "Мои устройства")
async def list_devices_handler(message: Message) -> None:
    try:
        devices = await api.get(f"/v1/users/{message.from_user.id}/devices")
    except httpx.HTTPStatusError:
        await message.answer("Пока нет устройств.")
        return

    if not devices:
        await message.answer("Пока нет устройств.")
        return

    for d in devices:
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="Получить конфиг заново", callback_data=f"regen:{d['id']}")],
                [InlineKeyboardButton(text="Удалить", callback_data=f"delete:{d['id']}")],
            ]
        )
        await message.answer(
            f"#{d['id']} {d['name']}\n"
            f"Статус: {d['status']}\n"
            f"Нода: {d['node_name']} ({d['country_code']})\n"
            f"Трафик: RX {d['rx_bytes']} / TX {d['tx_bytes']} байт",
            reply_markup=kb,
        )


@router.callback_query(F.data.startswith("regen:"))
async def regenerate_callback(callback: CallbackQuery) -> None:
    device_id = int(callback.data.split(":")[1])
    created = await api.post(f"/v1/devices/{device_id}/regenerate?telegram_id={callback.from_user.id}", {})
    conf_file = BufferedInputFile(created["conf_text"].encode(), filename=created["conf_filename"])
    qr_file = BufferedInputFile(base64.b64decode(created["qr_png_base64"]), filename=f"device-{device_id}.png")
    await callback.message.answer_document(conf_file, caption="Новый конфиг")
    await callback.message.answer_photo(qr_file, caption="Новый QR")
    await callback.answer("Конфиг перевыпущен")


@router.callback_query(F.data.startswith("delete:"))
async def delete_callback(callback: CallbackQuery) -> None:
    device_id = int(callback.data.split(":")[1])
    await api.delete(f"/v1/devices/{device_id}", {"telegram_id": callback.from_user.id})
    await callback.answer("Устройство удалено")
    await callback.message.answer("Устройство удалено.")


@router.message(F.text == "Поддержка")
async def support_handler(message: Message) -> None:
    await message.answer("Поддержка: @your_support")


async def main() -> None:
    if not settings.telegram_bot_token or settings.telegram_bot_token == "replace_me":
        raise RuntimeError("Set TELEGRAM_BOT_TOKEN in .env.control")
    if not settings.internal_api_token:
        raise RuntimeError("Set INTERNAL_API_TOKEN in .env.control")
    logging.basicConfig(level=logging.INFO)
    bot = Bot(
        token=settings.telegram_bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
