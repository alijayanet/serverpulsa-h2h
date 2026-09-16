/**
 * Juragan Pulsa - Admin Settings Router
 * routes/admin/settings.js
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getAllSettings, setSettings, setSetting, getSetting } = require('../../config/settingsManager');
const { updateAdminPassword } = require('../../services/adminService');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const whatsappService = require('../../services/whatsappService');
const logger = require('../../utils/logger');

// Multer storage for QRIS Static Image Upload
const qrisStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../public/uploads/qris');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `qris-static-${Date.now()}${ext}`);
  }
});

const uploadQris = multer({
  storage: qrisStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar (JPG/PNG/WEBP) yang diperbolehkan'));
    }
  }
});

// GET /admin/settings
router.get('/settings', requireAdminLogin, (req, res) => {
  const settings = getAllSettings();
  const waStatus = whatsappService.getConnectionStatus();

  res.render('admin/settings', {
    title: 'Pengaturan Sistem',
    activeNav: 'settings',
    settings,
    waStatus,
  });
});

// POST /admin/settings
router.post('/settings', requireAdminLogin, (req, res) => {
  const {
    app_name,
    app_url,
    app_phone,
    app_address,
    whatsapp_admin_numbers,
    qris_static_enabled,
    qris_static_payload,
    qris_image_path,
    digiflazz_username,
    digiflazz_api_key,
    digiflazz_webhook_secret,
    digiflazz_markup,
    deposit_min_amount,
    whatsapp_enabled,
    app_version_code,
    app_version_name,
    app_download_url,
    app_release_notes,
    app_force_update
  } = req.body;

  try {
    setSettings({
      app_name: app_name || 'Juragan Pulsa',
      app_url: app_url ? app_url.trim().replace(/\/+$/, '') : '',
      app_phone: app_phone || '',
      app_address: app_address || '',
      whatsapp_admin_numbers: whatsapp_admin_numbers || '',
      qris_static_enabled: qris_static_enabled === '1' ? '1' : '0',
      qris_static_payload: qris_static_payload ? qris_static_payload.trim() : '',
      qris_image_path: qris_image_path || getSetting('qris_image_path', ''),
      digiflazz_username: digiflazz_username || '',
      digiflazz_api_key: digiflazz_api_key || '',
      digiflazz_webhook_secret: digiflazz_webhook_secret || '',
      digiflazz_markup: digiflazz_markup || '2000',
      deposit_min_amount: deposit_min_amount || '10000',
      whatsapp_enabled: whatsapp_enabled === '1' ? '1' : '0',
      app_version_code: app_version_code || '1',
      app_version_name: app_version_name || '1.0.0',
      app_download_url: app_download_url || '/downloads/juragan-pulsa.apk',
      app_release_notes: app_release_notes || '',
    });

    // Sinkronkan juga kredensial ke tabel providers
    const db = require('../../config/database');
    if (digiflazz_username || digiflazz_api_key) {
      db.prepare(`
        UPDATE providers SET
          username = ?,
          api_key = ?,
          webhook_secret = ?
        WHERE name = 'digiflazz'
      `).run(
        String(digiflazz_username || '').trim(),
        String(digiflazz_api_key || '').trim(),
        String(digiflazz_webhook_secret || '').trim()
      );
    }

    // Terapkan default margin ke seluruh produk di database
    const { applyGlobalMarkup } = require('../../services/productService');
    const safeMarkup = parseInt(digiflazz_markup || '2000', 10);
    const updatedCount = applyGlobalMarkup(safeMarkup);

    req.session.flash = { 
      type: 'success', 
      message: `Pengaturan berhasil disimpan. Margin Rp ${safeMarkup.toLocaleString('id-ID')} telah diterapkan ke ${updatedCount} produk.` 
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }

  res.redirect('/admin/settings');
});

// POST /admin/settings/qris/upload (Direct Image Upload)
router.post('/settings/qris/upload', requireAdminLogin, uploadQris.single('qris_image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Tidak ada file gambar yang diunggah' });
  }

  const filePath = `/uploads/qris/${req.file.filename}`;
  setSetting('qris_image_path', filePath);

  return res.json({
    success: true,
    message: 'Gambar QRIS berhasil diunggah ke server',
    filePath,
    filename: req.file.filename
  });
});

// POST /admin/settings/qris/preview (AJAX tester)
router.post('/settings/qris/preview', requireAdminLogin, async (req, res) => {
  const { payload, amount } = req.body;
  const qrisUtil = require('../../utils/qrisUtil');

  try {
    const amt = parseFloat(amount) || 50125;
    const cleanPayload = String(payload || '').trim();
    if (!cleanPayload) {
      return res.status(400).json({ success: false, error: 'Payload QRIS kosong' });
    }

    const { dynamicPayload, dataUrl } = await qrisUtil.generateDynamicQrisDataUrl(cleanPayload, amt);
    return res.json({
      success: true,
      amount: amt,
      dynamicPayload,
      dataUrl
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// POST /admin/settings/password
router.post('/settings/password', requireAdminLogin, (req, res) => {
  const { old_password, new_password, confirm_password } = req.body;
  const adminId = req.session.adminUser ? req.session.adminUser.id : 1;

  if (new_password !== confirm_password) {
    req.session.flash = { type: 'error', message: 'Konfirmasi password baru tidak cocok' };
    return res.redirect('/admin/settings');
  }

  try {
    updateAdminPassword(adminId, old_password, new_password);
    req.session.flash = { type: 'success', message: 'Password admin berhasil diperbarui.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }

  res.redirect('/admin/settings');
});

// POST /admin/settings/whatsapp/start
router.post('/settings/whatsapp/start', requireAdminLogin, async (req, res) => {
  try {
    await whatsappService.startBot();
    req.session.flash = { type: 'info', message: 'Inisialisasi WhatsApp bot dimulai. Silakan scan QR jika muncul.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/settings');
});

// POST /admin/settings/whatsapp/reset
router.post('/settings/whatsapp/reset', requireAdminLogin, async (req, res) => {
  try {
    await whatsappService.resetSession();
    req.session.flash = { type: 'success', message: 'Sesi WhatsApp berhasil dihapus. Bot sedang memulai ulang untuk menghasilkan QR Code baru.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: 'Gagal reset sesi WhatsApp: ' + err.message };
  }
  res.redirect('/admin/settings');
});

// POST /admin/settings/whatsapp/test
router.post('/settings/whatsapp/test', requireAdminLogin, async (req, res) => {
  try {
    const adminPhone = getSetting('app_phone', '');
    if (!adminPhone) {
      throw new Error('Nomor WhatsApp Admin (CS) belum diisi di Pengaturan Bisnis.');
    }

    const testMsg = `*🧪 TES NOTIFIKASI WHATSAPP BOT*\n\n✅ Koneksi WhatsApp Bot Juragan Pulsa aktif dan siap mengirim notifikasi transaksi & deposit!\n\n📅 Waktu: ${new Date().toLocaleString('id-ID')}`;
    const sent = await whatsappService.sendWhatsAppMessage(adminPhone, testMsg);

    if (sent) {
      req.session.flash = { type: 'success', message: 'Pesan tes berhasil dikirim ke nomor WhatsApp: ' + adminPhone };
    } else {
      req.session.flash = { type: 'warning', message: 'WhatsApp belum terhubung atau nomor tujuan tidak valid. Silakan scan QR Code terlebih dahulu.' };
    }
  } catch (err) {
    req.session.flash = { type: 'error', message: 'Gagal kirim pesan tes: ' + err.message };
  }
  res.redirect('/admin/settings');
});

// GET /admin/settings/whatsapp/status (AJAX polling)
router.get('/settings/whatsapp/status', requireAdminLogin, (req, res) => {
  const status = whatsappService.getConnectionStatus();
  return res.json({ success: true, ...status });
});

module.exports = router;

