-- The zero-scan push ("nobody checked in") reuses SessionReminderSent as its once-per-session
-- guard, so it needs its own kind. See ai-usage/attendance-tracking_plan.md decision 10.
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'zero_scan';
