# Itemku × FFZ Store Bridge

Proyek dashboard baru untuk Vercel: sinkron katalog Itemku dan FFZ, mapping SKU, antrean pesanan, dan pencatatan status.

## Setup
1. Buat PostgreSQL (mis. Neon), lalu jalankan `db/schema.sql`.
2. Upload seluruh folder ini ke repository GitHub baru dan import ke Vercel.
3. Tambahkan Environment Variables:
   - `FFZ_API_KEY`: Standard API key FFZ Store
   - `ITEMKU_API_KEY`, `ITEMKU_SECRET_KEY`: kredensial Tokoku Open API
   - `DATABASE_URL`: connection string PostgreSQL
   - `APP_URL`: URL deployment
   - `APP_SECRET`: random secret panjang untuk dashboard
   - `CRON_SECRET`: secret cron (opsional; default APP_SECRET)
   - `ITEMKU_SHOP_ID`: shop ID pada header X-itemku (opsional)
4. Jangan pernah commit secret atau file `.env`.
5. URL callback Itemku: `https://DOMAIN-KAMU/api/itemku-callback`. Itemku meminta verifikasi DNS TXT `v-api-itemku-{SHOPNAME}=1`; ikuti format persis dari dashboard/support Itemku.

## Pengujian aman
- `/api/health` menunjukkan apakah environment telah diisi.
- Masukkan `APP_SECRET` ketika dashboard meminta.
- Sinkronkan produk Itemku dan katalog FFZ.
- Mapping SKU harus dicek manual; mapping baru nonaktif.
- Aktifkan mapping hanya setelah nama, nominal, harga, User ID/Server ID diuji.

## Catatan penting
- FFZ Standard API tetap mensyaratkan IP whitelist. Vercel egress dapat berubah; bila FFZ menolak IP Vercel, gunakan backend ber-IP keluar statis.
- Itemku API memakai X-Api-Key, Nonce, dan Authorization Bearer JWT sesuai Tokoku docs. Uji token dan izin endpoint di akunmu sebelum transaksi live.
- Callback diverifikasi ulang melalui Itemku order list dan dideduplikasi berdasarkan order_id.
- Jika supplier gagal, aplikasi tidak auto-REJECT/refund Itemku; order ditandai untuk pemeriksaan manual.
- DELIVER hanya dicoba setelah supplier sukses. Format `delivery_info` berbeda antar jenis produk; uji sesuai dokumentasi Itemku.
- Vercel Cron memeriksa antrean tiap menit. Pastikan akun Vercel mendukung Cron Jobs.
