// The orders page: lists GET /orders and posts the new-order form to POST /orders.
const list = document.getElementById('orders');
const empty = document.getElementById('empty');
const status = document.getElementById('status');

function render(orders) {
    const shown = orders.filter((o) => o.quantity > 0);
    list.replaceChildren(
        ...shown.map((o) => {
            const li = document.createElement('li');
            li.dataset.id = String(o.id);
            const item = document.createElement('span');
            item.className = 'item';
            item.textContent = o.item;
            const qty = document.createElement('span');
            qty.className = 'qty';
            qty.textContent = `× ${o.quantity}`;
            li.append(item, qty);
            return li;
        }),
    );
    list.hidden = shown.length === 0;
    empty.hidden = shown.length > 0;
}

async function load() {
    const res = await fetch('/orders');
    render(await res.json());
    // The page has drawn its data: a probe waits for body[data-state=ready] before it looks.
    document.body.dataset.state = 'ready';
}

document.getElementById('new-order').addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = document.getElementById('item').value.trim();
    const quantity = Number(document.getElementById('quantity').value);
    const res = await fetch('/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item, quantity }) });
    status.textContent = res.ok ? `Order for ${item} placed` : 'Could not place the order';
    await load();
});

load();
