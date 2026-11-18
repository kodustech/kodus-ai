const orders = new Map([
    ['1', { id: '1', totalCents: 1999, currency: 'USD', status: 'paid' }],
    ['2', { id: '2', totalCents: 500, currency: 'EUR', status: 'open' }],
]);

function findOrder(id) {
    return orders.get(String(id)) || null;
}

function addOrder(order) {
    const id = String(orders.size + 1);
    orders.set(id, { ...order, id });
    return orders.get(id);
}

module.exports = { findOrder, addOrder };
