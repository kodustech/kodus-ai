const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());
// The orders page (public/): a list of GET /orders and the new-order form.
app.use(express.static(require('path').join(__dirname, 'public')));

app.get('/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ ok: true });
    } catch (e) {
        res.status(503).json({ ok: false });
    }
});

app.get('/orders', async (_req, res) => {
    const { rows } = await pool.query('SELECT id, item, quantity FROM orders ORDER BY id');
    res.json(rows);
});

app.get('/orders/:id', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, item, quantity FROM orders WHERE id = $1', [Number(req.params.id)]);
        if (!rows.length) return res.status(404).json({ error: 'not found' });
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'internal error' });
    }
});

app.post('/orders', async (req, res) => {
    const { item, quantity } = req.body ?? {};
    if (!item || !Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: 'item and quantity are required' });
    const { rows } = await pool.query('INSERT INTO orders (item, quantity) VALUES ($1, $2) RETURNING id, item, quantity', [item, quantity]);
    res.status(201).json(rows[0]);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`sample-app listening on ${port}`));
