const express = require('express');
const { findOrder, addOrder } = require('../store');

const router = express.Router();

router.get('/orders/:id', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    res.json({ id: order.id, total: (order.totalCents / 100).toFixed(2), currency: order.currency, status: order.status });
});

router.post('/orders', (req, res) => {
    const order = addOrder({ totalCents: req.body.totalCents, currency: req.body.currency, status: 'open' });
    res.status(201).json(order);
});

module.exports = router;
