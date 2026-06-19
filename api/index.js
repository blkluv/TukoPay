const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');
const StellarSdk = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Database setup for Vercel (using in-memory for serverless)
let db;
const initDB = () => {
  if (db) return db;
  
  db = new sqlite3.Database(':memory:');
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE,
        name TEXT,
        public_key TEXT,
        amount TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
  return db;
};

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const HORIZON = new StellarSdk.Horizon.Server(HORIZON_URL);

function slugify(name) {
  const base = (name || 'tukopay').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${base}-${rand}`;
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create a new payment link
app.post('/api/links', async (req, res) => {
  try {
    const db = initDB();
    const { name, amount, message, publicKey, slug } = req.body;
    if (!name || !publicKey) return res.status(400).json({ error: 'name and publicKey required' });
    const finalSlug = slug || slugify(name);
    const stmt = db.prepare('INSERT INTO links (slug, name, public_key, amount, message) VALUES (?, ?, ?, ?, ?)');
    stmt.run(finalSlug, name, publicKey, amount || null, message || null, function (err) {
      if (err) {
        return res.status(500).json({ error: 'could not create link', details: err.message });
      }
      return res.json({ slug: finalSlug, url: `/pay/${finalSlug}` });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get link metadata
app.get('/api/links/:slug', async (req, res) => {
  try {
    const db = initDB();
    const { slug } = req.params;
    db.get('SELECT * FROM links WHERE slug = ?', [slug], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json(row);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard: pull payments to the creator address from Horizon
app.get('/api/dashboard/:publicKey', async (req, res) => {
  try {
    const { publicKey } = req.params;
    const url = `${HORIZON_URL}/accounts/${encodeURIComponent(publicKey)}/payments?order=desc&limit=200`;
    const resp = await fetch(url);
    const data = await resp.json();
    // Filter relevant payment records (type "payment" to this account)
    const payments = (data._embedded && data._embedded.records || [])
      .filter(r => r.type === 'payment' && r.to === publicKey)
      .map(r => ({ id: r.id, created_at: r.created_at, amount: r.amount, asset_type: r.asset_type, asset_code: r.asset_code, from: r.from, tx_hash: r.transaction_hash }));
    res.json({ payments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ error: 'endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const serverless = require('serverless-http');

module.exports = serverless(app);
