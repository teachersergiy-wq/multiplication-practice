-- Teacher provisioning will be exposed through an authenticated Edge Function.
-- Keep this SECURITY DEFINER RPC unavailable to browser roles until that flow exists.
revoke execute on function public.register_teacher(text, text, text) from public, anon, authenticated;
