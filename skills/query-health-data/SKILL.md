---
name: query-health-data
description: Query the user's historical health data from VITA when you need data not in the current workspace context (MEMORY.md/USER.md). Use this for specific time periods, historical comparisons, workout history, wearable data, sleep records, health scores, bio age, lab uploads, and any data beyond what's in the recent context.
user-invocable: false
---

# Query Health Data

Use this skill when the user asks about data you don't have in your current workspace files, especially:
- Historical biomarker readings ("what was my cholesterol in September?")
- Wearable data (sleep, HRV, recovery, strain, body composition)
- Workout sessions and exercise history
- Health scores, Bio Age, Aging Velocity over time
- Past protocols and their components
- Daily insights and recommendations
- Lab upload history

## Available Tables

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `biomarker_readings` | Lab values | name, value, unit, recorded_at |
| `wearable_readings` | Sleep, HRV, recovery, strain, body comp | category, metric_type, value, unit, source, recorded_at |
| `workout_sessions` | Exercise sessions | workout_type, duration_minutes, calories, avg_heart_rate, strain, started_at |
| `composite_health_scores` | Weekly health score | score, domain_scores, score_date |
| `bio_age_scores` | Biological age calculations | bio_age, chronological_age, age_difference, computed_at |
| `aging_velocity_scores` | Rate of biological aging | velocity, span_days, computed_at |
| `daily_insights` | AI daily briefings | summary, sleep_summary, training_summary, recommendations, insight_date |
| `user_protocols` | Health protocols | name, goal, start_date, end_date, status |
| `lab_uploads` | Uploaded lab reports | filename, uploaded_at, status |

## Usage

```bash
curl -s -X POST "${DATA_QUERY_URL}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CRON_WEBHOOK_SECRET}" \
  -d '{
    "table": "TABLE_NAME",
    "limit": 50,
    "order": "recorded_at.desc",
    "filters": {
      "name": "eq.Fasting Glucose",
      "recorded_at": "gte.2025-09-01"
    }
  }'
```

## Filter Operators
- `eq.VALUE` — equals
- `gt.VALUE` / `gte.VALUE` — greater than / greater or equal
- `lt.VALUE` / `lte.VALUE` — less than / less or equal
- `like.%VALUE%` — pattern match
- `ilike.%VALUE%` — case-insensitive pattern match

## Examples

**Get cholesterol readings from September 2025:**
```bash
curl -s -X POST "${DATA_QUERY_URL}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CRON_WEBHOOK_SECRET}" \
  -d '{"table": "biomarker_readings", "filters": {"name": "eq.Total Cholesterol", "recorded_at": "gte.2025-09-01"}, "order": "recorded_at.desc", "limit": 20}'
```

**Get last 2 weeks of sleep data:**
```bash
curl -s -X POST "${DATA_QUERY_URL}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CRON_WEBHOOK_SECRET}" \
  -d '{"table": "wearable_readings", "filters": {"category": "eq.sleep"}, "order": "recorded_at.desc", "limit": 30}'
```

**Get workout history:**
```bash
curl -s -X POST "${DATA_QUERY_URL}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CRON_WEBHOOK_SECRET}" \
  -d '{"table": "workout_sessions", "order": "started_at.desc", "limit": 20}'
```

**Get health score history:**
```bash
curl -s -X POST "${DATA_QUERY_URL}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CRON_WEBHOOK_SECRET}" \
  -d '{"table": "composite_health_scores", "order": "score_date.desc", "limit": 10}'
```

## Environment Variables
- `DATA_QUERY_URL` — the query endpoint URL (already set)
- `CRON_WEBHOOK_SECRET` — auth token (already set)

## Important
- The user_id is already included in the URL — you don't need to specify it
- Maximum 200 rows per query
- Always use filters to narrow results when possible
- Present data in a clear, organized format to the user
