# SysPulse WebSocket SSH Server

Server WebSocket untuk koneksi SSH yang aman dan efisien.

## Konfigurasi untuk Local dan Deployment

### Setup Lokal

1. Install dependencies:
```bash
npm install
```

2. Buat file `.env` dengan konfigurasi berikut:
```
# Pengaturan umum
NODE_ENV=development

# Konfigurasi server
SSH_SERVER_PORT=3001
SSH_SERVER_HOST=localhost

# CORS settings
CORS_ORIGIN=http://localhost:3000
```

3. Jalankan server:
```bash
npm run dev
```

### Setup untuk Deployment

1. Sesuaikan file `.env` untuk deployment:
```
# Pengaturan umum
NODE_ENV=production

# Konfigurasi server
SSH_SERVER_PORT=3001
SSH_SERVER_HOST=0.0.0.0

# CORS settings - Sesuaikan dengan URL frontend Anda
CORS_ORIGIN=https://your-frontend-domain.com
```

2. Untuk platform seperti Glitch, Render, atau Railway yang menyediakan PORT, tambahkan:
```
PORT=3000
```
Server akan menggunakan PORT yang disediakan platform jika ada.

## Endpoint Penting

- `/health` - Health check endpoint untuk memeriksa status server

## Fitur

- Manajemen koneksi SSH yang andal
- Dukungan untuk perintah batch
- Monitoring sesi untuk menghindari kebocoran memori
- Mekanisme reconnect yang tangguh
- Cross-Origin Resource Sharing (CORS) yang dapat dikonfigurasi
