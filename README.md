# Project Planner

Dependency-aware project planning tool for Kite. Plans live in `~/projects/<project>/PLAN.json` + auto-generated `PLAN.md`.

## Features

- Persistent dependency graph (task B can't start until task A is done)
- Impact analysis before changes
- Acceptance criteria defined upfront
- Rollback paths per task
- Parallel task identification
- Critical path calculation (DP forward/backward pass)
- PLAN.md auto-regenerated on every change

## Usage

```bash
# Create a plan
node plan.cjs new --project my-project --description "What this delivers"

# Import tasks from JSON (preferred for big projects)
node plan.cjs import --project my-project --file tasks.json

# Check status + what's ready
node plan.cjs status --project my-project
node plan.cjs next --project my-project
node plan.cjs parallel --project my-project

# Work on tasks
node plan.cjs start --task task-01 --project my-project
node plan.cjs done --task task-01 --project my-project --confirm

# Analysis
node plan.cjs impact --task task-01 --project my-project
node plan.cjs graph --project my-project

# Reports
node plan.cjs report --project my-project --send

# Validation
node validate.cjs --project my-project
```

## All commands

| Command | Description |
|---------|-------------|
| `new` | Create project plan |
| `add` | Add single task |
| `import` | Bulk import tasks from JSON |
| `status` | Show project status + critical path |
| `next` | Show tasks ready to start now |
| `impact` | Show downstream impact of a task |
| `start` | Mark task running |
| `done` | Mark task complete (shows unblocked tasks) |
| `fail` | Mark task failed + show rollback |
| `block` | Mark task blocked |
| `unblock` | Clear blocker |
| `retry` | Reset failed task to pending |
| `note` | Append note to task |
| `update` | Update mutable task fields |
| `graph` | ASCII dependency graph |
| `parallel` | Show parallel execution waves |
| `report` | Generate markdown status report |
| `list` | List all projects with plans |

## Telegram reports

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars to enable `--send`.
