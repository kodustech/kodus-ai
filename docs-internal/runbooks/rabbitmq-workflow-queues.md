# RabbitMQ Workflow Queues Runbook

This runbook covers Kodus workflow queues, delayed retries, DLQ routing, and
stuck `unacked` diagnostics.

## Expected Flow

1. A consumer receives a message and RabbitMQ marks it as `unacked`.
2. The handler processes the job/event.
3. On success, the handler returns and the library ACKs the delivery.
4. On failure, `RabbitMQErrorHandler` publishes a delayed retry or DLQ message.
5. After that publish succeeds, `RabbitMQErrorHandler` ACKs the original
   delivery.
6. If retry/DLQ publish fails, the original delivery stays unacked so RabbitMQ
   can redeliver it when the channel closes.

The application uses application-level retry through delayed exchanges. Do not
also enable broker-side hot requeue for these consumers.

## Queues And DLQs

Workflow job queues:

- `workflow.jobs.webhook.queue`
- `workflow.jobs.code_review.queue`
- `workflow.jobs.check_implementation.queue`
- `workflow.jobs.ast_graph_build.queue`
- `workflow.jobs.ast_graph_incremental.queue`

Workflow event queues:

- `workflow.events.stage.completed`
- `workflow.events.ast`

Feedback queue:

- `codeReviewFeedback.syncCodeReviewReactions.queue`

DLQ targets:

- Workflow jobs route to `workflow.jobs.dlq`.
- Workflow events route to `workflow.events.dlq`.
- Feedback routes to `orchestrator.dlq`.

## When `unacked` Is Normal

`unacked` means a consumer has the message in flight. It is normal while work is
running.

Expected upper bounds:

- AST graph build: up to 5 globally when single active consumer and prefetch are
  active.
- AST graph incremental: up to 5.
- Code review: can remain unacked for long-running reviews, up to the worker
  timeout.

Investigate when `unacked` stays flat at the prefetch limit while ack rate is
zero and worker logs show processing errors or no progress.

## Quick Checks

Use the RabbitMQ management UI or `rabbitmqctl` from a RabbitMQ node/container.

```bash
rabbitmqctl list_queues -p kodus-ai name messages_ready messages_unacknowledged messages consumers state arguments
```

Check delayed retry/DLQ topology:

```bash
rabbitmqctl list_exchanges -p kodus-ai name type durable arguments
rabbitmqctl list_bindings -p kodus-ai source_name destination_name routing_key
```

Check consumers:

```bash
rabbitmqctl list_consumers -p kodus-ai queue_name consumer_tag channel_pid ack_required prefetch_count active
```

## Diagnosis Guide

If a queue has high `messages_unacknowledged`:

1. Check worker logs for `workflow.job.consume`, `Failed to process workflow job`,
   and `Message processing failed, retrying`.
2. Confirm acks are happening after retries by looking for retry publishes and
   decreasing `unacked`.
3. Check the inbox table for locks:

```sql
SELECT "consumerId", status, count(*), min("lockedAt"), max("lockedAt")
FROM kodus_workflow.inbox_messages
WHERE status IN ('PROCESSING', 'READY')
GROUP BY "consumerId", status
ORDER BY count(*) DESC;
```

4. Check specific stuck jobs:

```sql
SELECT "messageId", "consumerId", job_id, status, "lockedBy", "lockedAt", attempts, "lastError"
FROM kodus_workflow.inbox_messages
WHERE status = 'PROCESSING'
ORDER BY "lockedAt" ASC
LIMIT 50;
```

5. Check DLQ depth and recent failures:

```bash
rabbitmqctl list_queues -p kodus-ai name messages_ready messages_unacknowledged | grep -E 'dlq|failed'
```

## Production Queue Arguments

Queue arguments are immutable after queue creation. Code changes to arguments
such as `x-single-active-consumer` or `x-consumer-timeout` will not update an
existing queue automatically.

For existing production queues, apply broker policies or recreate the queue
during a controlled maintenance window.

Recommended policies for AST queues:

```bash
rabbitmqctl set_policy -p kodus-ai ast-graph-build \
  '^workflow\.jobs\.ast_graph_build\.queue$' \
  '{"single-active-consumer":true,"consumer-timeout":1500000}' \
  --apply-to queues

rabbitmqctl set_policy -p kodus-ai ast-graph-incremental \
  '^workflow\.jobs\.ast_graph_incremental\.queue$' \
  '{"single-active-consumer":true,"consumer-timeout":900000}' \
  --apply-to queues
```

Validate policy application:

```bash
rabbitmqctl list_queues -p kodus-ai name policy arguments
```

## Recovery

Prefer restarting unhealthy worker tasks over manually moving messages. When a
worker channel closes, RabbitMQ redelivers unacked messages.

Use DLQ reprocessing only after the root cause is fixed. Preserve `messageId`
when reprocessing so inbox idempotency remains effective.

Avoid `purge_queue` on workflow queues unless the team explicitly accepts data
loss for those jobs.
