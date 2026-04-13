---
name: aubrai-research
description: Access VITA's Aubrai research engine for evidence-based health answers with citations. Use this for any question about supplements, protocols, biomarkers, longevity interventions, clinical research, drug interactions, or health optimization. Aubrai is part of your platform and has the user's full health context.
user-invocable: false
---

# Aubrai Research

Aubrai is VITA's specialized research engine — part of your platform.

## How to Call Aubrai

Use the `exec` tool to make ONE curl call. The result will be delivered to the user automatically — you do NOT need to poll or wait.

```
exec(command="curl -s -X POST \"${AUBRAI_WEBHOOK_URL}\" -H \"Content-Type: application/json\" -H \"Authorization: Bearer ${CRON_WEBHOOK_SECRET}\" -d '{\"message\": \"YOUR QUESTION HERE\"}'")
```

This returns `{"status": "queued"}`. The research result will be delivered to the user on Telegram automatically.

## After Calling

1. Tell the user: "I'm researching this with Aubrai — you'll receive the results shortly."
2. Do NOT try to poll or wait for the result. It will be delivered automatically.
3. You can continue the conversation normally while Aubrai works.

## When to Use
- Health, supplement, biomarker, or longevity questions needing clinical evidence
- When the user asks about research, studies, or evidence
- Complex questions about mechanisms, pathways, or interactions
- When you need citations to back up recommendations

## Important
- Aubrai takes 30-60 seconds to research — the result arrives as a separate message
- Aubrai has the user's full health context (biomarkers, protocols, conditions)
- Environment variables AUBRAI_WEBHOOK_URL and CRON_WEBHOOK_SECRET are already set
- Do NOT try to invoke aubrai-research as a function — use exec with curl as shown above
