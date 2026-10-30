# Task: Validate discount codes at checkout

Customers reuse codes and apply them to tiny orders.

## Acceptance criteria
- An expired code is refused with "This code has expired"
- A code can be used only once per customer
- A code on an order below its minimum value is refused with "Order below the minimum for this code"
