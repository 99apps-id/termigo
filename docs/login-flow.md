# Alur Login User

```mermaid
flowchart TD
    A[Mulai: User membuka halaman login] --> B[Form login ditampilkan]
    B --> C[User mengisi email & password]
    C --> D{Validasi client-side<br>format email, min. panjang password}
    D -- Tidak valid --> E[Tampilkan pesan error di form]
    E --> C
    D -- Valid --> F[Submit: kirim POST /api/auth/login]
    F --> G{Validasi server-side<br>reCAPTCHA & input}
    G -- Gagal --> H[Log gagal validasi]
    H --> E
    G -- Lolos --> I{Apakah user terdaftar?}
    I -- Tidak --> J[Gagal: pesan generik<br>email/password salah]
    J --> K{Log percobaan gagal<br>rate limiting / lockout?}
    K -- Ya --> L[Tampilkan: terlalu banyak percobaan<br>tunggu beberapa saat]
    L --> C
    K -- Tidak --> E
    I -- Ya --> M{Password benar?<br>bcrypt/argon2 verify}
    M -- Salah --> N[J: pesan generik email/password salah]
    N --> K
    M -- Benar --> O{Akun aktif?}
    O -- Banned/Suspended --> P[Tampilkan: akun dinonaktifkan]
    P --> C
    O -- Aktif --> Q{2FA diaktifkan?}
    Q -- Ya --> R[Tampilkan halaman verifikasi 2FA]
    R --> S{Input OTP benar?}
    S -- Salah --> T[Tampilkan: kode OTP salah]
    T --> R
    S -- Benar --> U[2FA verified]
    Q -- Tidak --> U
    U --> V[Buat session/token JWT + refresh token]
    V --> W[Simpan session di database<br>set cookie/httpOnly + Secure]
    W --> X[Redirect ke dashboard]
    X --> Y[Selamat datang: user berhasil login]
    Y --> Z[Selesai]
```

## Keterangan alur

1. **Validasi client-side**: pemeriksaan cepat (format email, field wajib) untuk UX, bukan pengaman.
2. **Validasi server-side**: pemeriksaan otoritatif. Selalu dilakukan ulang di server, jangan percaya client.
3. **Pesan generik**: jangan membocorkan apakah email terdaftar; gunakan pesan yang sama untuk "email tidak ada" dan "password salah" agar tidak terjadi enumerasi user.
4. **Rate limiting / lockout**: setiap percobaan gagal dicatat; setelah N percobaan (mis. 5), akun/IP dikunci sementara.
5. **2FA**: dilewati jika user tidak mengaktifkannya; jika aktif, OTP wajib sebelum session dibuat.
6. **Session**: gunakan token berumur pendek (JWT access token) + refresh token; cookie diberi flag `HttpOnly`, `Secure`, dan `SameSite` untuk keamanan.
