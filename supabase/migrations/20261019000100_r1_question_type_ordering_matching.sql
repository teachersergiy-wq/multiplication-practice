-- R1: extend question_type enum.
-- New enum values cannot be used in the same transaction that adds them.
-- This migration only adds values; subsequent migrations may reference them.

alter type public.question_type add value if not exists 'ordering';
alter type public.question_type add value if not exists 'matching';
