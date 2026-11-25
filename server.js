// Server sederhana tanpa dependensi: menyajikan index.html dan menyimpan data ke data.json
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const MASTER_FILE = path.join(__dirname, 'master_material.csv');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FOTO_BYTES = 10 * 1024 * 1024; // batas 10 MB per foto

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Antrian tulis supaya penyimpanan beruntun tidak saling menimpa
let writeChain = Promise.resolve();
function writeData(text) {
  writeChain = writeChain.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, DATA_FILE); // atomic: data tidak rusak jika terputus
  });
  return writeChain;
}


// ===== PENYIMPANAN FOTO SEBAGAI FILE =====
// Foto disimpan di folder /uploads dengan nama = SHA-256 isi file.
// Foto yang sama otomatis hanya tersimpan satu kali (deduplikasi).
const MIME_BY_EXT = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
const FOTO_URL_REGEX = /^\/uploads\/[a-f0-9]{64}\.(jpg|webp|png)$/;

// Deteksi tipe gambar dari isi file (bukan dari header yang bisa dipalsukan)
function deteksiTipeGambar(buf) {
  if (buf.length > 12 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  return null;
}

async function simpanFoto(buf) {
  const ext = deteksiTipeGambar(buf);
  if (!ext) throw new Error('File bukan gambar JPEG/WebP/PNG yang valid');
  const nama = crypto.createHash('sha256').update(buf).digest('hex') + '.' + ext;
  const file = path.join(UPLOAD_DIR, nama);
  if (!fs.existsSync(file)) {
    const tmp = file + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
  }
  return '/uploads/' + nama;
}

// Ubah foto berbentuk data URL (base64) di dalam daftar material menjadi file.
// Mengembalikan jumlah foto yang dipindahkan.
async function pindahkanFotoKeFile(list) {
  let jumlah = 0;
  const cache = new Map(); // data URL identik hanya diproses sekali
  for (const m of list) {
    if (!m || typeof m.foto !== 'string' || !m.foto.startsWith('data:image/')) continue;
    if (!cache.has(m.foto)) {
      const koma = m.foto.indexOf(',');
      const buf = Buffer.from(m.foto.slice(koma + 1), 'base64');
      cache.set(m.foto, await simpanFoto(buf));
    }
    m.foto = cache.get(m.foto);
    jumlah++;
  }
  return jumlah;
}

// Migrasi otomatis saat server dinyalakan (aman dijalankan berulang kali)
async function migrasiFotoDataJson() {
  const data = JSON.parse((await fs.promises.readFile(DATA_FILE, 'utf8')) || '[]');
  if (!data.some(m => m && typeof m.foto === 'string' && m.foto.startsWith('data:image/'))) return;
  const cadangan = DATA_FILE + '.sebelum-migrasi-foto.bak';
  if (!fs.existsSync(cadangan)) await fs.promises.copyFile(DATA_FILE, cadangan);
  const sebelum = (await fs.promises.stat(DATA_FILE)).size;
  const jumlah = await pindahkanFotoKeFile(data);
  await writeData(JSON.stringify(data));
  const sesudah = (await fs.promises.stat(DATA_FILE)).size;
  console.log('Migrasi foto: ' + jumlah + ' foto dipindah ke /uploads. data.json ' +
    (sebelum / 1024).toFixed(0) + ' KB -> ' + (sesudah / 1024).toFixed(0) + ' KB (cadangan: ' + path.basename(cadangan) + ')');
}

async function bacaBody(req, batas) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (batas && total > batas) throw new Error('Ukuran file melebihi batas');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// PENGHAPUSAN OTOMATIS RIWAYAT PINDAH LOKASI BIN
const daftarBinUntukHapus = [
  'SA 01','SA 02','SA 03','SA 04','SA 05','SA 06',
  'SA 07','SA 08','SA 09','SA 10','SA 11','SA 12',
  'SA 13','SA 14','SA 15','SA 16','SA 17','SA 18',
  'SA 19','SA 20','SA 21','SA 22','SA 23','SA 24',
  'SB 01','SB 02','SB 03','SB 04','SB 05','SB 06',
  'SB 07','SB 08','SB 09','SB 10','SB 11','SB 12',
  'SB 13','SB 14','SB 15','SB 16','SB 17','SB 18',
  'SB 19','SB 20','SB 21','SB 22','SB 23','SB 24',
  'SB 25','SB 26','SB 27','SB 28','SB 29','SB 30',
  'SX 01','UC 01',
  'UD 01','UD 02','UD 03','UD 04','UD 05','UD 06',
  'UD 07','UD 08','UD 09','UD 10','UD 11','UD 12',
  'UD 13','UD 14',
  'UX 02','FX 03',
  'FE 01','FE 02','FE 03','FE 04','FE 05',
  'FE 06','FE 07','FE 08','FE 09','FE 10',
  'FE 11','FE 12','FE 13','FE 14','FE 15',
  'IW','AVALAN BOX'
];

const binSetUntukHapus = new Set(
  daftarBinUntukHapus.map(bin => bin.toUpperCase())
);

let tanggalTerakhirHapusRiwayatBin = '';

async function hapusRiwayatPindahLokasiBin() {

  await writeChain;

  const data = JSON.parse(
    await fs.promises.readFile(DATA_FILE, 'utf8') || '[]'
  );

  data.forEach(material => {

    if (!Array.isArray(material.locationHistory)) return;

    material.locationHistory =
      material.locationHistory.filter(riwayat => {

        const tujuan = String(riwayat.ke || '')
          .trim()
          .toUpperCase();

        return !binSetUntukHapus.has(tujuan);

      });

  });

  await writeData(JSON.stringify(data));

  console.log('Riwayat Pindah Lokasi Bin berhasil dibersihkan.');
}

// PEMERIKSA JADWAL HAPUS OTOMATIS SETIAP HARI
let prosesHapusRiwayatSedangBerjalan = false;

async function periksaJadwalHapusRiwayatBin() {

  if (prosesHapusRiwayatSedangBerjalan) return;

  const waktu = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const ambil = jenis =>
    waktu.find(item => item.type === jenis).value;

  const tanggalHariIni =
    ambil('year') + '-' +
    ambil('month') + '-' +
    ambil('day');

  const jam = Number(ambil('hour'));
  const menit = Number(ambil('minute'));

  // Tunggu sampai pukul 06.30 WIB
  if (jam < 6 || (jam === 6 && menit < 30)) return;

  const filePenanda = path.join(
    __dirname,
    'tanggal_hapus_riwayat_bin.txt'
  );

  try {

    let tanggalSudahDihapus = '';

    if (fs.existsSync(filePenanda)) {
      tanggalSudahDihapus =
        (await fs.promises.readFile(filePenanda, 'utf8')).trim();
    }

    // Jangan menghapus dua kali pada tanggal yang sama
    if (tanggalSudahDihapus === tanggalHariIni) return;

    prosesHapusRiwayatSedangBerjalan = true;

    await hapusRiwayatPindahLokasiBin();

    await fs.promises.writeFile(
      filePenanda,
      tanggalHariIni
    );

    console.log('Jadwal hapus otomatis selesai: ' + tanggalHariIni);

  } catch (error) {

    console.error('Gagal menghapus riwayat BIN:', error);

  } finally {

    prosesHapusRiwayatSedangBerjalan = false;

  }
}



const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/api/materials' && req.method === 'GET') {
      return send(res, 200, 'application/json; charset=utf-8', await fs.promises.readFile(DATA_FILE, 'utf8') || '[]');
    }
    if (url === '/api/materials' && req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('Data harus berupa array');
      // Pengaman: jika ada halaman lain yang masih mengirim foto base64, ubah jadi file
      const dipindah = await pindahkanFotoKeFile(data);
      await writeData(dipindah ? JSON.stringify(data) : text);
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (url === '/api/foto' && req.method === 'POST') {
      const buf = await bacaBody(req, MAX_FOTO_BYTES);
      const fotoUrl = await simpanFoto(buf);
      return send(res, 200, 'application/json', JSON.stringify({ url: fotoUrl }));
    }
    if (req.method === 'GET' && FOTO_URL_REGEX.test(url)) {
      const ext = url.split('.').pop();
      const isi = await fs.promises.readFile(path.join(UPLOAD_DIR, path.basename(url)));
      // Nama file = hash isi, jadi aman di-cache selamanya oleh browser
      res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext], 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(isi);
    }
    if (url === '/master_material.csv' && req.method === 'GET') {
  return send(
    res,
    200,
    'text/csv; charset=utf-8',
    await fs.promises.readFile(MASTER_FILE, 'utf8')
  );
}
if (url === '/dashboard-gudang.png' && req.method === 'GET') {
  return send(
    res,
    200,
    'image/png',
    await fs.promises.readFile(
      path.join(__dirname, 'dashboard-gudang.png.jpeg')
    )
  );
}if ((url === '/' || url === '/index.html') && req.method === 'GET') {
  return send(res, 200, 'text/html; charset=utf-8', await fs.promises.readFile(INDEX_FILE));
}

if (url === '/index2.html' && req.method === 'GET') {
  const INDEX2_FILE = path.join(__dirname, 'index2.html');
  return send(res, 200, 'text/html; charset=utf-8', await fs.promises.readFile(INDEX2_FILE));
}
if (url === '/index3.html' && req.method === 'GET') {
  const INDEX3_FILE = path.join(__dirname, 'index3.html');
  return send(res, 200, 'text/html; charset=utf-8', await fs.promises.readFile(INDEX3_FILE));
}
send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    if (e.code === 'ENOENT' && FOTO_URL_REGEX.test(url)) return send(res, 404, 'text/plain', 'Foto tidak ditemukan');
    send(res, 500, 'application/json', JSON.stringify({ error: e.message }));
  }
});

migrasiFotoDataJson()
  .catch(e => console.error('Migrasi foto gagal (data.json tidak diubah):', e))
  .then(() => server.listen(PORT, '0.0.0.0', onListen));

function onListen() {
  console.log('Tracking Carton Box berjalan:');
  console.log('  http://localhost:' + PORT);
  Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log('  http://' + i.address + ':' + PORT + '  (perangkat lain di jaringan sama)'));
  console.log('Data tersimpan otomatis di: ' + DATA_FILE);

  // Buka browser otomatis SETELAH server siap (set NO_OPEN=1 untuk menonaktifkan)
  if (!process.env.NO_OPEN) {
    const target = 'http://localhost:' + PORT;
    const cmd = process.platform === 'win32' ? 'start "" "' + target + '"'
      : process.platform === 'darwin' ? 'open "' + target + '"'
      : 'xdg-open "' + target + '"';
    exec(cmd, () => {});
  }
}