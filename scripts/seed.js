#!/usr/bin/env node
'use strict';
/**
 * Seed script for the Telegram mini-shop.
 *
 *   npm run seed            # seed only if the products table is empty
 *   npm run seed -- --force # remove SAMPLE rows and reseed
 *
 * Uses better-sqlite3 against data/shop.db. Tables are created with
 * CREATE TABLE IF NOT EXISTS using column names from the admin API
 * contract, so this is safe to run before or after backend/db.js exists.
 *
 * All seeded products are clearly marked SAMPLE items that the shop
 * owner is expected to replace before going live:
 *   - descriptions end with "(Sample listing — replace before going live.)"
 *   - license keys use the SAMPLE-XXXX-XXXX-XXXX format
 *   - download payloads point at https://example.com/…
 *   - subscription/text payloads say "Sample — replace with real fulfillment steps."
 */

const path = require('path');
const fs = require('fs');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 is not installed. Run `npm install` in the project root first.');
  process.exit(1);
}

const FORCE = process.argv.includes('--force');
const DB_PATH = process.env.DB_PATH ||
  path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'shop.db');
const SAMPLE_MARKER = '(Sample listing — replace before going live.)';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT,
  price_usd REAL NOT NULL,
  category TEXT,
  image_url TEXT,
  delivery_type TEXT NOT NULL DEFAULT 'text',
  delivery_payload TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  key_value TEXT NOT NULL,
  assigned_order_id INTEGER,
  UNIQUE(product_id, key_value)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id INTEGER,
  tg_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_usd REAL,
  currency TEXT,
  payway_tran_id TEXT,
  items TEXT,
  created_at TEXT,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------------------------------------------------------------------------
// Sample catalog: [name, category, price_usd, delivery_type, description]
// delivery_type ∈ key | download | subscription | text
// ---------------------------------------------------------------------------
const AI = 'AI Tools';
const SUB = 'Subscriptions';
const SW = 'Software';
const DES = 'Design Assets';
const EDU = 'E-Books & Courses';
const TPL = 'Templates';

const CATALOG = [
  // AI Tools (12)
  ['AI Prompt Pack: 500 Marketing Prompts', AI, 19.99, 'download', 'A curated library of 500 copy-paste marketing prompts for brainstorming, ad copy, email sequences and social content.'],
  ['AI Image Prompt Library: 2,000 Prompts', AI, 24.99, 'download', 'Two thousand field-tested image-generation prompts across 20 styles — photoreal, anime, product shots and more.'],
  ['ChatGPT Workflow Templates for Freelancers', AI, 14.99, 'key', 'Ready-made chat workflows for proposals, client onboarding, invoicing follow-ups and project scoping.'],
  ['AI Video Script Generator Toolkit', AI, 29.99, 'key', 'Script frameworks, hooks and CTA builders for YouTube, TikTok and course creators, with fill-in templates.'],
  ['AI Resume Builder Pro — 1 Year License', AI, 39.99, 'key', 'Build ATS-friendly resumes in minutes with AI bullet-point rewriting and 30 recruiter-approved layouts.'],
  ['SEO Content Optimizer — 1 Year License', AI, 49.99, 'key', 'Optimize articles for search with real-time scoring, keyword suggestions and competitor gap analysis.'],
  ['AI Meeting Notes App — Lifetime Deal', AI, 59.99, 'key', 'Automatic transcription, action-item extraction and meeting summaries that sync to your task manager.'],
  ['Social Caption AI — 6 Month Plan', AI, 17.99, 'subscription', 'Generate on-brand captions and hashtag sets for every platform, tuned to your tone of voice.'],
  ['AI Art Upscaler Pro — 1 Device License', AI, 34.99, 'key', 'Upscale AI and stock imagery up to 8K with detail-preserving enhancement and batch processing.'],
  ['Voice Cloning Starter Kit — Pro License', AI, 44.99, 'key', 'Clone your voice from a 3-minute sample and generate studio-quality narration in 29 languages.'],
  ['Prompt Engineering Prompts Bundle', AI, 9.99, 'text', '120 battle-tested prompt patterns for better outputs: chain-of-thought, few-shot, role and format controls.'],
  ['AI Chatbot Widget for Websites — Starter', AI, 79.99, 'key', 'Embed a no-code AI support widget on any site with FAQ training, lead capture and chat history.'],
  // Subscriptions (10)
  ['1-Year VPN Subscription', SUB, 49.99, 'key', 'Private, no-logs VPN with 3,000+ servers in 90 countries and apps for every device.'],
  ['Cloud Storage 2TB — 1 Year', SUB, 59.99, 'subscription', 'Two terabytes of encrypted cloud storage with automatic backup and easy file sharing.'],
  ['Music Streaming Family Plan — 3 Months', SUB, 14.99, 'subscription', 'Ad-free music for up to six family members with offline downloads and shared playlists.'],
  ['Password Manager Premium — 1 Year', SUB, 29.99, 'key', 'Unlimited password vault, breach alerts and secure sharing for the whole family.'],
  ['Project Management Pro — 6 Months', SUB, 39.99, 'subscription', 'Boards, timelines and automations for teams up to 25, with unlimited integrations.'],
  ['Email Marketing Tool — 5,000 Contacts Plan', SUB, 49.99, 'subscription', 'Drag-and-drop campaigns, automations and analytics for lists up to five thousand contacts.'],
  ['Stock Photo Pack — 100 Downloads', SUB, 19.99, 'key', 'One hundred premium stock photo downloads, royalty-free for commercial use.'],
  ['Online Backup 1TB — Annual', SUB, 34.99, 'key', 'Set-and-forget encrypted backup for one computer with unlimited version history.'],
  ['Language Learning App Premium — 1 Year', SUB, 44.99, 'key', 'Full access to 40 languages with speech coaching, offline lessons and progress tracking.'],
  ['Meditation & Sleep App — Lifetime', SUB, 69.99, 'key', 'Lifetime access to 500+ guided meditations, sleep stories and breathing programs.'],
  // Software (10)
  ['Video Editor Pro — Lifetime (Windows)', SW, 59.99, 'key', 'Full-featured 4K video editor with effects library, motion tracking and one-click exports.'],
  ['Photo Editor Suite — Lifetime (Mac)', SW, 69.99, 'key', 'Professional RAW photo editing with AI retouching, layers and batch workflows.'],
  ['Screen Recorder Pro — 1 PC', SW, 29.99, 'key', 'Record screen, webcam and audio in 4K with annotations, scheduled capture and cloud upload.'],
  ['PDF Toolkit Ultimate — Lifetime', SW, 39.99, 'key', 'Edit, merge, split, sign and convert PDFs with OCR in 25 languages.'],
  ['File Recovery Software — 1 Year', SW, 34.99, 'key', 'Recover deleted photos, documents and partitions from drives, SD cards and USB sticks.'],
  ['System Cleaner & Optimizer Pro', SW, 19.99, 'key', 'Speed up your PC with junk cleanup, startup management and privacy protection.'],
  ['Mind Mapping Software — Team of 5', SW, 49.99, 'key', 'Visual brainstorming with real-time collaboration, templates and presentation mode.'],
  ['Code Editor Theme Pack + Snippets', SW, 9.99, 'download', 'Twelve dark themes and 300 productivity snippets for popular code editors.'],
  ['FTP Client Pro License', SW, 24.99, 'key', 'Fast, secure file transfers with SFTP/FTPS support, sync and remote editing.'],
  ['Password Vault Desktop App', SW, 29.99, 'key', 'Offline-first encrypted password vault with auto-fill and hardware-key support.'],
  // Design Assets (8)
  ['UI Kit: 200 Mobile Screens (Figma)', DES, 39.99, 'download', 'Two hundred pixel-perfect mobile app screens with auto-layout, variants and a full design system.'],
  ['1,500 Icons Pack (SVG + PNG) — Commercial License', DES, 19.99, 'key', 'Fifteen hundred outline and filled icons in SVG and PNG, licensed for commercial projects.'],
  ['50 Social Media Templates', DES, 14.99, 'download', 'Fifty editable post and story templates for Instagram, TikTok and LinkedIn.'],
  ['Brand Identity Kit — Extended License', DES, 49.99, 'key', 'Complete identity package: logo suite, color system, typography and usage guidelines.'],
  ['3D Illustration Pack: 120 Renders', DES, 29.99, 'download', 'One hundred twenty royalty-free 3D renders in PNG and Blender source files.'],
  ['Font Bundle: 40 Premium Typefaces — Desktop License', DES, 34.99, 'key', 'Forty premium typefaces with full character sets, licensed for desktop use.'],
  ['Mockup Bundle: 300 Device Mockups', DES, 24.99, 'download', 'Three hundred photorealistic device and print mockups with smart-object layers.'],
  ['Lightroom Presets: Cinematic Collection — Creator License', DES, 12.99, 'key', 'Sixty cinematic Lightroom presets for desktop and mobile, licensed for client work.'],
  // E-Books & Courses (9)
  ['Python Automation Course (Video + Code)', EDU, 49.99, 'download', 'Eight hours of video plus all source code: automate spreadsheets, web scraping and reporting.'],
  ['Freelancing Playbook eBook', EDU, 19.99, 'download', 'A 220-page guide to landing clients, pricing projects and scaling a freelance business.'],
  ['Digital Marketing Mastery Course', EDU, 59.99, 'download', 'Twelve hours of video covering SEO, paid ads, email and analytics with worksheets.'],
  ['Excel to Expert Video Course', EDU, 39.99, 'download', 'From formulas to Power Query and dashboards — six hours of hands-on Excel training.'],
  ['Copywriting Formulas eBook Bundle', EDU, 24.99, 'download', 'Three ebooks with 150 copy frameworks for headlines, landing pages and emails.'],
  ['Crypto Basics for Beginners Course', EDU, 29.99, 'download', 'A jargon-free video course on wallets, exchanges and staying safe in crypto.'],
  ['Notion for Business Video Course', EDU, 34.99, 'download', 'Build CRMs, wikis and project systems in Notion with five hours of guided lessons.'],
  ['Photography Fundamentals eBook', EDU, 14.99, 'download', 'Master exposure, composition and editing with 180 pages of illustrated lessons.'],
  ['Side Hustle Ideas: 100 Playbooks', EDU, 9.99, 'text', 'One hundred validated side-hustle playbooks with startup costs, tools and first steps.'],
  // Templates (6)
  ['Notion Ultimate Creator Bundle', TPL, 29.99, 'download', 'Forty Notion templates for content planning, finance tracking and goal setting.'],
  ['Business Plan Template Pack (30 Docs)', TPL, 19.99, 'download', 'Thirty investor-ready business plan documents, pitch decks and financial models.'],
  ['Resume & CV Templates: 100 Designs', TPL, 12.99, 'download', 'One hundred ATS-friendly resume designs in Word, Google Docs and Canva formats.'],
  ['Invoice & Contract Templates for Freelancers', TPL, 9.99, 'download', 'Twenty-five lawyer-reviewed invoices, contracts and proposal templates.'],
  ['Excel Finance Dashboard Templates — Commercial License', TPL, 14.99, 'key', 'Fifteen plug-and-play finance dashboards for budgeting and reporting.'],
  ['Wedding Planner Notion Template — PLR License', TPL, 7.99, 'key', 'Complete wedding planning system in Notion with private-label rights.'],
];

const DOWNLOAD_PAYLOAD = JSON.stringify({ url: 'https://example.com/downloads/sample.zip' });
const FULFILLMENT_NOTE = 'Sample — replace with real fulfillment steps.';

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function sampleKey() {
  const seg = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  return `SAMPLE-${seg()}-${seg()}-${seg()}`;
}

function imageUrl(name) {
  return 'https://placehold.co/600x400?text=' + encodeURIComponent(name.slice(0, 40));
}

function deliveryPayload(type) {
  if (type === 'download') return DOWNLOAD_PAYLOAD;
  if (type === 'subscription' || type === 'text') return FULFILLMENT_NOTE;
  return '{}'; // key → empty; keys are managed in the Key pools tab
}

// --- idempotency ------------------------------------------------------------
const existing = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (existing > 0 && !FORCE) {
  console.log(`already seeded, skipping (${existing} products in DB at ${DB_PATH})`);
  process.exit(0);
}

const insertProduct = db.prepare(`
  INSERT INTO products (name, slug, description, price_usd, category, image_url, delivery_type, delivery_payload, active, created_at)
  VALUES (@name, @slug, @description, @price_usd, @category, @image_url, @delivery_type, @delivery_payload, 1, datetime('now'))
`);
const insertKey = db.prepare(`
  INSERT OR IGNORE INTO keys (product_id, key_value, assigned_order_id, created_at)
  VALUES (@product_id, @key_value, NULL, datetime('now'))
`);

const seedTx = db.transaction(() => {
  if (FORCE) {
    // Remove only SAMPLE rows so real catalog data is never wiped.
    db.prepare("DELETE FROM keys WHERE key_value LIKE 'SAMPLE-%'").run();
    db.prepare('DELETE FROM products WHERE description LIKE ?').run(`%${SAMPLE_MARKER}%`);
  }
  const usedSlugs = new Set();
  let productCount = 0;
  let keyCount = 0;
  for (const [name, category, price, type, desc] of CATALOG) {
    let slug = slugify(name);
    let i = 2;
    while (usedSlugs.has(slug)) slug = `${slugify(name)}-${i++}`;
    usedSlugs.add(slug);
    const { lastInsertRowid } = insertProduct.run({
      name,
      slug,
      description: `${desc} ${SAMPLE_MARKER}`,
      price_usd: price,
      category,
      image_url: imageUrl(name),
      delivery_type: type,
      delivery_payload: deliveryPayload(type),
    });
    productCount++;
    if (type === 'key') {
      for (let k = 0; k < 5; k++) {
        const r = insertKey.run({ product_id: lastInsertRowid, key_value: sampleKey() });
        keyCount += r.changes;
      }
    }
  }
  return { productCount, keyCount };
});

const { productCount, keyCount } = seedTx();

// --- settings defaults (never overwrite existing values) --------------------
const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const settingsTx = db.transaction(() => {
  setDefault.run('shop_name', 'Sample Mini Shop');
  setDefault.run('exchange_rate_usd_khr', '4100');
  setDefault.run('support_contact', '@sample_support');
  setDefault.run('note', 'Sample settings — secrets (PayWay keys, admin token) live in the server .env file, not here.');
});
settingsTx();

console.log(`seeded ${productCount} products and ${keyCount} sample keys into ${DB_PATH}`);
console.log('settings defaults ensured (existing values kept)');
