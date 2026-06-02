# VanillaSMP Store Backend

Это первая рабочая заготовка:
- `public/index.html` — сайт VanillaSMP Store.
- `server.js` — backend на Node.js.
- `products.json` — товары и команды выдачи.
- `.env.example` — настройки RCON.

## 1. Установка

```bash
npm install
copy .env.example .env
npm start
```

Открыть:
```text
http://localhost:3000
```

## 2. RCON на Minecraft сервере

В `server.properties`:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=СЛОЖНЫЙ_ПАРОЛЬ
```

В `.env`:

```env
TEST_MODE=false
RCON_HOST=127.0.0.1
RCON_PORT=25575
RCON_PASSWORD=СЛОЖНЫЙ_ПАРОЛЬ
```

## 3. Тест покупки

Пока настоящая платёжка не подключена:
1. нажми BUY NOW на сайте;
2. введи ник;
3. тебя перекинет на тестовую страницу;
4. нажми TEST PAY & ISSUE;
5. backend отправит команды в Minecraft через RCON.

## 4. Товары

Редактируй `products.json`.

Пример:

```json
"knight": {
  "name": "Knight rank",
  "price": 250,
  "commands": [
    "lp user {player} parent add knight"
  ]
}
```

## 5. Важно

Нельзя принимать команду напрямую с сайта. Команды должны быть только в `products.json`.
Иначе любой игрок сможет попытаться отправить `op nickname`.
