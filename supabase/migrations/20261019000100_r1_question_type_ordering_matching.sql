-- R1: extend question_type enum.
alter type public.question_type add value if not exists 'ordering';
alter type public.question_type add value if not exists 'matching';
