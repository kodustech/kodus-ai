# Task: Reject negative quantities on invoice lines

Users typed -1 as a quantity and the invoice total went negative. A line with a quantity below 1 must be rejected with "Quantity must be at least 1", and an invoice total must never be negative.
