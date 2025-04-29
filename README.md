# SysPulse WebSocket Server

WebSocket SSH server untuk aplikasi SysPulse.

## Deploy ke Heroku

Berikut langkah-langkah untuk melakukan deploy aplikasi WebSocket server ini ke Heroku:

### Cara Manual

1. Pastikan Anda sudah menginstall [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli)
2. Login ke Heroku CLI:
   ```
   heroku login
   ```
3. Buat aplikasi baru di Heroku:
   ```
   heroku create syspulse-websocket
   ```
4. Deploy aplikasi ke Heroku:
   ```
   git push heroku main
   ```
5. Pastikan bahwa minimal 1 instance aplikasi berjalan:
   ```
   heroku ps:scale web=1
   ```
6. Buka aplikasi:
   ```
   heroku open
   ```

### Menggunakan GitHub Actions

1. Pada repository GitHub, tambahkan secrets berikut:
   - `HEROKU_API_KEY`: API key dari akun Heroku Anda
   - `HEROKU_EMAIL`: Email yang digunakan untuk akun Heroku

2. Push kode ke branch main, dan GitHub Actions akan otomatis melakukan deploy ke Heroku.

## Variabel Lingkungan

Tambahkan variabel lingkungan berikut di Heroku:

- `CORS_ORIGIN`: URL aplikasi frontend Anda
- `NODE_ENV`: `production` untuk environment produksi

Untuk menambahkan variabel lingkungan:
```
heroku config:set CORS_ORIGIN=https://your-frontend-app.com
heroku config:set NODE_ENV=production
```

## Memeriksa Log

Untuk melihat log aplikasi yang berjalan di Heroku:
```
heroku logs --tail
```

## Catatan Penting

- Heroku mematikan aplikasi setelah 30 menit tidak aktif. Gunakan layanan seperti [Kaffeine](https://kaffeine.herokuapp.com/) untuk menjaga aplikasi tetap aktif.
- WebSocket di Heroku memiliki batas waktu koneksi 55 detik. Pastikan implementasi reconnect di client untuk mengatasi ini.

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
