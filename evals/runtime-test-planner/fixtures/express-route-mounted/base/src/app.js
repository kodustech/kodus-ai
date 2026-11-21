const express = require('express');
const orders = require('./routes/orders');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', orders);

app.listen(3000, () => console.log('orders-api on 3000'));
