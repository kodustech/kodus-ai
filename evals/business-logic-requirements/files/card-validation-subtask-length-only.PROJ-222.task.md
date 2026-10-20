# Task: Checkout hardening

Payments fail on bad card data.

## Acceptance criteria
- The card number is validated with the Luhn check before submitting
- An expiry date in the past is refused with "Card expired"
- A payment that times out is retried once
