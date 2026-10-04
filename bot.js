import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  DisconnectReason,
  areJidsSameUser,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { GlobalFonts } from '@napi-rs/canvas';
import { bratGen } from 'brat-canvas';
import dotenv from 'dotenv';
import pino from 'pino';
import sharp from 'sharp';

const projectDir = dirname(fileURLToPath(import.meta.url));
const bratCanvasEntry = fileURLToPath(import.meta.resolve('brat-canvas'));
const fontPath = resolve(dirname(bratCanvasEntry), '../../assets/arialnarrow.ttf');
const sessionPath = resolve(projectDir, 'session');
const logger = pino({ level: 'silent' });

dotenv.config({ path: resolve(projectDir, '.env') });

const originalConsoleError = console.error;
const originalConsoleInfo = console.info;
let pendingDecryptError;

function flushDecryptError() {
  if (!pendingDecryptError) return;

  const { entries } = pendingDecryptError;
  pendingDecryptError = undefined;
  const realErrors = entries.filter(
    (args) => !args.some(
      (value) => String(value).includes('MessageCounterError: Key used already or never filled'),
    ),
  );
  if (realErrors.length > 0) {
    originalConsoleError.call(console, 'Failed to decrypt message with any known session...');
  }
  for (const args of realErrors) {
    originalConsoleError.apply(console, args);
  }
}

console.error = (...args) => {
  if (args[0] === 'Failed to decrypt message with any known session...') {
    flushDecryptError();
    pendingDecryptError = { entries: [] };
    setImmediate(flushDecryptError);
    return;
  }

  if (pendingDecryptError && String(args[0]).startsWith('Session error:')) {
    pendingDecryptError.entries.push(args);
    return;
  }

  flushDecryptError();
  originalConsoleError.apply(console, args);
};

console.info = (...args) => {
  const message = args[0];
  if (
    typeof message === 'string' &&
    /^(Closing session:|Opening session:|Removing old closed session:)/.test(message)
  ) {
    return;
  }
  originalConsoleInfo.apply(console, args);
};

if (existsSync(fontPath)) {
  try {
    if (!GlobalFonts.registerFromPath(fontPath, 'ArialNarrow')) {
      console.warn(`Font ArialNarrow gagal dimuat dari ${fontPath}; memakai font fallback.`);
    }
  } catch (error) {
    console.warn(`Font ArialNarrow gagal dimuat dari ${fontPath}; memakai font fallback.`, error);
  }
} else {
  console.warn(`Font ${fontPath} belum tersedia; memakai font fallback.`);
}

const pairingNumber = process.env.PAIRING_NUMBER;
if (!pairingNumber || !/^\d+$/.test(pairingNumber)) {
  throw new Error('PAIRING_NUMBER wajib diisi dengan nomor WhatsApp berupa angka saja di file .env.');
}

function getContent(message) {
  return normalizeMessageContent(message);
}

function getText(message) {
  const content = getContent(message);
  return (
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    content?.documentMessage?.caption ??
    ''
  );
}

function getQuotedMessage(content) {
  return (
    content?.extendedTextMessage?.contextInfo?.quotedMessage ??
    content?.imageMessage?.contextInfo?.quotedMessage ??
    content?.videoMessage?.contextInfo?.quotedMessage ??
    content?.documentMessage?.contextInfo?.quotedMessage
  );
}

async function sendTextReply(sock, jid, originalMessage, text) {
  await sock.sendMessage(jid, { text }, { quoted: originalMessage });
}

async function handleMessage(sock, message) {
  if (!message.message || !message.key.remoteJid) return;

  const jid = message.key.remoteJid;
  const ownJids = [sock.user?.id, sock.user?.jid, sock.user?.lid];
  const isSelfChat = ownJids.some(
    (ownJid) => ownJid && areJidsSameUser(jid, ownJid),
  );
  if (message.key.fromMe && !isSelfChat) return;

  const content = getContent(message.message);
  const commandText = getText(message.message).trim();
  if (/^[/!.]sticker?$/i.test(commandText)) {
    if (!content?.imageMessage) {
      await sendTextReply(sock, jid, message, 'Kirim gambar dengan caption .sticker');
      return;
    }

    try {
      const image = await downloadMediaMessage(message, 'buffer', {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      });
      const sticker = await sharp(image)
        .resize(512, 512, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .webp({ quality: 90 })
        .toBuffer();

      await sock.sendMessage(jid, { sticker }, { quoted: message });
    } catch (error) {
      console.error('Gagal mengubah gambar menjadi stiker:', error);
      try {
        await sendTextReply(sock, jid, message, 'Gagal bikin stiker');
      } catch (replyError) {
        console.error('Gagal mengirim pesan error stiker:', replyError);
      }
    }
    return;
  }

  const match = commandText.match(/^[/!.]brat(?:\s+([\s\S]*))?$/i);
  if (!match) return;

  let text = (match[1] ?? '').trim();
  if (!text) {
    const quotedMessage = getQuotedMessage(content);
    text = getText(quotedMessage).trim();
  }

  if (!text) {
    await sendTextReply(sock, jid, message, 'Contoh: /brat anjay alok');
    return;
  }

  if ([...text].length > 500) {
    await sendTextReply(sock, jid, message, 'Maks 500 karakter');
    return;
  }

  try {
    const png = await bratGen(text, {
      theme: 'white',
      C_BG: '#ffffff',
      C_BOX: '#ffffff',
      C_TEXT: '#000000',
      BLUR: 2,
      emojiStyle: 'apple',
      FONT_NAME: 'ArialNarrow',
      fontPaths: [fontPath],
    });
    const webp = await sharp(png)
      .resize(512, 512, { fit: 'fill' })
      .webp({ quality: 90 })
      .toBuffer();

    await sock.sendMessage(jid, { sticker: webp }, { quoted: message });
  } catch (error) {
    console.error('Gagal membuat stiker brat:', error);
    try {
      await sendTextReply(sock, jid, message, 'Gagal bikin stiker');
    } catch (replyError) {
      console.error('Gagal mengirim pesan error stiker:', replyError);
    }
  }
}

let reconnectTimer;
let reconnectAttempts = 0;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version, isLatest, error } = await fetchLatestBaileysVersion();
  if (error) {
    console.warn('Gagal mengambil versi WhatsApp Web terbaru; memakai versi bawaan Baileys.', error);
  } else if (isLatest) {
    console.log(`Memakai versi WhatsApp Web terbaru: ${version.join('.')}`);
  }

  const sock = makeWASocket({ auth: state, logger, version });
  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      sock.requestPairingCode(pairingNumber).then((code) => {
        const displayCode = /^\d{8}$/.test(code)
          ? `${code.slice(0, 4)}-${code.slice(4)}`
          : code;
        console.log(`Pairing code: ${displayCode}`);
        console.log('Masukkan kode ini di WhatsApp melalui Perangkat Tertaut.');
      }).catch((error) => {
        pairingRequested = false;
        console.error('Gagal meminta pairing code WhatsApp:', error);
      });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('Terhubung ke WhatsApp.');
      return;
    }

    if (connection !== 'close') return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    if (statusCode === DisconnectReason.loggedOut) {
      console.error('WhatsApp logout. Hapus folder session/ lalu pairing ulang.');
      return;
    }

    if (reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(2000 * 2 ** Math.min(reconnectAttempts - 1, 4), 30000);
    console.error(
      `Koneksi WhatsApp terputus (kode ${statusCode ?? 'tidak diketahui'}); mencoba lagi dalam ${delay / 1000} detik.`,
      lastDisconnect?.error,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      startBot().catch((error) => {
        console.error('Gagal menyambungkan kembali ke WhatsApp:', error);
      });
    }, delay);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        await handleMessage(sock, message);
      } catch (error) {
        console.error('Gagal memproses pesan WhatsApp:', error);
      }
    }
  });
}

startBot().catch((error) => {
  console.error('Bot gagal dijalankan:', error);
  process.exitCode = 1;
});
