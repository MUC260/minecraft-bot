# minecraft-bot

A Minecraft bot project powered by [mineflayer](https://github.com/PrismarineJS/mineflayer).

## Setup

```bash
npm install
cp config.example.json config.json
# edit config.json: host, port, username, auth
npm start
```

## Config

- `host`: Minecraft server address
- `port`: server port (default `25565`)
- `username`: bot account name
- `password`: optional; only needed for online-mode accounts
- `auth`: `offline` or `microsoft`

## Example

```json
{
  "host": "localhost",
  "port": 25565,
  "username": "MyBot",
  "password": "",
  "auth": "offline"
}
```
