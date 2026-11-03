# pi-termux-notify

A [Pi](https://pi.dev) **extension** that combines Pi lifecycle hooks with the
Termux API (`termux-notification`):

- `agent_settled` - notify when the agent finishes running (waiting for input).
- `ui_prompt_start` - notify when Pi shows an interactive dialog (approve/confirm/input).
- `tool_execution_end` - notify when a tool runs longer than a threshold.
- `tool_call` - route dangerous-command approvals to notification buttons (approve/reject),
  so you don't need to switch back to the terminal.

## Approval alerts (sound + vibration)

The approval/confirmation notifications (dangerous-command approval via `Pi needs approval`
buttons, and `confirm`-type UI prompts) play a sound and vibrate, so you don't miss a
pending approval. Other notifications (task done, long tool) stay silent.

## Install

```bash
pi install git:https://github.com/pingdongyi/pi-termux-notify.git@v1
```

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TERMUX_NOTIFY` | `on` | Set `off` to disable notifications entirely. |
| `PI_TERMUX_NOTIFY_THRESHOLD_MS` | `60000` | Long-task threshold in ms. |
| `PI_TERMUX_NOTIFY_PRIORITY` | `high` | Notification priority. |
| `PI_TERMUX_NOTIFY_ID` | `pi` | Notification id. |
| `PI_APPROVE` | `on` | Enable notification-button approval (`off` disables). |
| `PI_APPROVE_PATTERNS` | - | Approval match regexes (`|` separated), default dangerous-command set. |
| `PI_APPROVE_TIMEOUT_MS` | `120000` | Approval timeout; on timeout it rejects (fail-closed). |
