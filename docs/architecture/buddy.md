# The Buddy

The Buddy stays **purely cosmetic and optional — it never gates, slows, or competes with real
agent work** (the prototype's core invariant, kept). It's the *fun* layer, with two facets.

### A gacha companion

A collectible you **roll** for, with **rarity tiers** (common → rare → epic → legendary) and
**shiny** variants — a light chase to land something fun to have on screen. It **interjects at
key moments** to spice up the flow (a merge lands, a task completes, a legendary/shiny rolls).
Carried from the prototype: roll / reroll (rate-limited so the chase stays meaningful) / history
of past buddies. In the desktop app it can be richer than ASCII, but it stays lightweight.

### A "/btw" side-channel

A casual assistant channel — the operator asks **general or meta questions** (how do I do X in
`co`, a quick aside, general help) **without interrupting agent work.** It's the buddy's
"brain": a separate, lightweight conversation that **does not touch the mail bus, consume an
agent slot, or pull a Coordinator off-task** — like Claude Code's `/btw`, wearing the buddy's
personality.

### It must never compete with real work

Because the buddy is cosmetic, its brain (the `/btw` calls + personality copy) is the
**lowest-priority** consumer of provider capacity: cheap model, **yields to real agents**, and
throttled first under rate pressure ([DISPATCH](dispatch.md) / [COST](cost-and-usage.md)). Provider-backed when credentials exist,
static fallback otherwise (Codex-only projects can force fallback). The fun never costs you the
subscription budget your actual work needs.

### Optional, end to end

Fully disableable — off costs nothing and changes no orchestration behavior. It exists only to
make the app more enjoyable to sit in front of.
