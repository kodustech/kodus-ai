# Task: Expose the loan due date in the API

The mobile app needs the due date to show reminders.

## Acceptance criteria
- GET /loans/:id returns dueDate as an ISO-8601 string
- GET /loans returns dueDate on every item
- The OpenAPI spec documents dueDate
